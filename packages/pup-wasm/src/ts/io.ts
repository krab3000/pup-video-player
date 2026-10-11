// Synchronous byte sources for FFmpeg's AVIO callbacks. These block, so they
// must only be used inside a worker (sync XHR and FileReaderSync are
// worker-only for array buffers anyway).

import type { CoreModule, IOHandler } from './bindings';

// Worker-only API, absent from the DOM lib.
declare const FileReaderSync: { new (): { readAsArrayBuffer(blob: Blob): ArrayBuffer } };

export interface ByteSource {
  /** Total size in bytes, or -1 if unknown. */
  readonly size: number;
  /** Reads up to `length` bytes at `pos`; returns fewer only at EOF. */
  fetch(pos: number, length: number): Uint8Array;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Reads a URL with HTTP Range requests via synchronous XHR. */
export class RangeSource implements ByteSource {
  size = -1;
  /** Set when the server ignored Range and returned the whole body. */
  private whole: Uint8Array | null = null;

  constructor(
    readonly url: string,
    private withCredentials = false,
  ) {}

  /** Issues the first request; learns the size and range support. */
  open(probeLength: number): Uint8Array {
    const xhr = this.request(0, probeLength);
    const body = new Uint8Array(xhr.response as ArrayBuffer);
    if (xhr.status === 200) {
      this.whole = body;
      this.size = body.length;
      return body.subarray(0, probeLength);
    }
    const total = /\/(\d+)\s*$/.exec(xhr.getResponseHeader('Content-Range') ?? '');
    if (total) {
      this.size = Number(total[1]);
    } else {
      // Content-Range may not be exposed cross-origin; Content-Length always is.
      const head = new XMLHttpRequest();
      head.open('HEAD', this.url, false);
      head.withCredentials = this.withCredentials;
      try {
        head.send();
        const len = Number(head.getResponseHeader('Content-Length'));
        if (head.status < 400 && len > 0) this.size = len;
      } catch {
        // size stays unknown; demuxing still works, seeking may not
      }
    }
    return body;
  }

  fetch(pos: number, length: number): Uint8Array {
    if (this.whole) return this.whole.subarray(pos, pos + length);
    if (this.size >= 0) {
      if (pos >= this.size) return new Uint8Array(0);
      length = Math.min(length, this.size - pos);
    }
    const xhr = this.request(pos, length);
    if (xhr.status === 416) return new Uint8Array(0);
    const body = new Uint8Array(xhr.response as ArrayBuffer);
    if (xhr.status === 200) {
      // The server stopped honouring Range: keep the full body.
      this.whole = body;
      this.size = body.length;
      return body.subarray(pos, pos + length);
    }
    return body;
  }

  private request(pos: number, length: number): XMLHttpRequest {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', this.url, false);
    xhr.withCredentials = this.withCredentials;
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${pos}-${pos + length - 1}`);
    try {
      xhr.send();
    } catch (e) {
      throw new SourceError(`network error fetching ${this.url}: ${e}`);
    }
    if (xhr.status !== 200 && xhr.status !== 206 && xhr.status !== 416) {
      throw new SourceError(`HTTP ${xhr.status} fetching ${this.url}`, xhr.status);
    }
    return xhr;
  }
}

/** Reads a Blob/File with FileReaderSync. */
export class BlobSource implements ByteSource {
  private reader = new FileReaderSync();
  readonly size: number;

  constructor(private blob: Blob) {
    this.size = blob.size;
  }

  fetch(pos: number, length: number): Uint8Array {
    return new Uint8Array(this.reader.readAsArrayBuffer(this.blob.slice(pos, pos + length)));
  }
}

/** Reads from an in-memory buffer (tests, small files). */
export class MemorySource implements ByteSource {
  readonly size: number;

  constructor(private data: Uint8Array) {
    this.size = data.length;
  }

  fetch(pos: number, length: number): Uint8Array {
    return this.data.subarray(pos, pos + length);
  }
}

export interface CacheStats {
  /** Byte ranges currently cached, merged, as [start, end) pairs. */
  ranges: Array<[number, number]>;
  bytesFetched: number;
}

/**
 * Fixed-size block cache in front of a ByteSource. Sequential access triggers
 * read-ahead so a network source makes one request per `readAhead` blocks.
 */
export class BlockCache {
  private blocks = new Map<number, Uint8Array>();
  private lastBlock = -2;
  bytesFetched = 0;

  constructor(
    readonly source: ByteSource,
    readonly blockSize = 1 << 20,
    readonly maxBlocks = 32,
    readonly readAhead = 2,
  ) {}

  get size(): number {
    return this.source.size;
  }

  /** Seeds the cache with bytes starting at offset 0 (e.g. RangeSource.open's probe). */
  seed(data: Uint8Array): void {
    for (let off = 0; off < data.length; off += this.blockSize) {
      const part = data.subarray(off, off + this.blockSize);
      // A short block is only complete if it ends the file.
      if (part.length === this.blockSize || this.isLast(off, part.length)) this.put(off / this.blockSize, part);
    }
  }

  /** Copies bytes at `pos` into `dst`. Returns bytes copied (0 at EOF). */
  read(pos: number, dst: Uint8Array): number {
    let copied = 0;
    while (copied < dst.length) {
      const abs = pos + copied;
      const index = Math.floor(abs / this.blockSize);
      const block = this.block(index);
      const offset = abs - index * this.blockSize;
      if (offset >= block.length) break;
      const n = Math.min(block.length - offset, dst.length - copied);
      dst.set(block.subarray(offset, offset + n), copied);
      copied += n;
      if (block.length < this.blockSize) break; // last block
    }
    return copied;
  }

  stats(): CacheStats {
    const starts = [...this.blocks.entries()]
      .map(([i, b]) => [i * this.blockSize, i * this.blockSize + b.length] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const ranges: Array<[number, number]> = [];
    for (const r of starts) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] >= r[0]) last[1] = Math.max(last[1], r[1]);
      else ranges.push([...r]);
    }
    return { ranges, bytesFetched: this.bytesFetched };
  }

  private isLast(pos: number, length: number): boolean {
    return this.size >= 0 && pos + length >= this.size;
  }

  private block(index: number): Uint8Array {
    const hit = this.blocks.get(index);
    if (hit) {
      // refresh LRU position
      this.blocks.delete(index);
      this.blocks.set(index, hit);
      this.lastBlock = index;
      return hit;
    }
    const sequential = index === this.lastBlock + 1;
    let count = sequential ? this.readAhead : 1;
    // Don't re-fetch blocks we already hold.
    while (count > 1 && this.blocks.has(index + count - 1)) count--;
    const data = this.source.fetch(index * this.blockSize, count * this.blockSize);
    this.bytesFetched += data.length;
    for (let i = 0; i < count; i++) {
      const part = data.subarray(i * this.blockSize, (i + 1) * this.blockSize);
      if (part.length === 0 && i > 0) break;
      this.put(index + i, part);
    }
    this.lastBlock = index;
    return this.blocks.get(index)!;
  }

  private put(index: number, data: Uint8Array): void {
    this.blocks.delete(index);
    this.blocks.set(index, data);
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value as number;
      this.blocks.delete(oldest);
    }
  }
}

/** Installs Module.pupIO, dispatching io handles to registered caches. */
export class IORegistry implements IOHandler {
  private next = 1;
  private handles = new Map<number, BlockCache>();
  lastError: Error | null = null;

  constructor(m: CoreModule) {
    m.pupIO = this;
  }

  register(cache: BlockCache): number {
    const id = this.next++;
    this.handles.set(id, cache);
    return id;
  }

  unregister(id: number): void {
    this.handles.delete(id);
  }

  read(io: number, dst: Uint8Array, pos: number): number {
    const cache = this.handles.get(io);
    if (!cache) return -1;
    try {
      return cache.read(pos, dst);
    } catch (e) {
      this.lastError = e as Error;
      return -1;
    }
  }

  size(io: number): number {
    return this.handles.get(io)?.size ?? -1;
  }
}
