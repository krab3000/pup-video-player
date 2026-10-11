// Demux worker: owns one single-threaded wasm instance and reads the source
// synchronously (sync XHR / FileReaderSync), handing packets to the decode
// worker on request. HLS sources are read asynchronously by an HlsSession.

import {
  BlobSource,
  BlockCache,
  Demuxer,
  IORegistry,
  RangeSource,
  SourceError,
  loadCore,
  type CodecSet,
  type Core,
} from '@krab3000/pup-wasm';
import { canPlayType } from '../element/can-play-type.js';
import { HlsError, HlsSession, isHlsSource, looksLikeHls } from './hls-session.js';
import { describe } from './media-info.js';
import {
  MediaErrorCode,
  type DecodeToDemux,
  type DemuxToDecode,
  type FromDemux,
  type Source,
  type ToDemux,
} from './protocol.js';

const BLOCK_SIZE = 1 << 20;
const BATCH_PACKETS = 48;
const BATCH_BYTES = 1 << 20;
const PROGRESS_INTERVAL_MS = 350;

let core: Core;
let codecSet: CodecSet = 'full';
let io: IORegistry;
let port: MessagePort;
let ready: Promise<void>;

let epoch = 0;
let demux: Demuxer | null = null;
let cache: BlockCache | null = null;
let ioId = 0;
let selected = new Set<number>();
let eof = false;
let lastProgress = 0;
let lastFetched = 0;
let hls: HlsSession | null = null;

const post = (msg: FromDemux) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<ToDemux>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    port = msg.decodePort;
    codecSet = msg.set;
    port.onmessage = (ev: MessageEvent<DecodeToDemux>) => void ready.then(() => onDecode(ev.data));
    ready = loadCore({ set: msg.set, threading: 'st' }).then((c) => {
      core = c;
      io = new IORegistry(c.m);
    });
    return;
  }
  void ready.then(() => {
    if (msg.type === 'open') open(msg.epoch, msg.source);
    else if (msg.type === 'close') close();
  });
};

function close(): void {
  hls?.close();
  hls = null;
  demux?.close();
  demux = null;
  if (ioId) io.unregister(ioId);
  ioId = 0;
  cache = null;
  eof = false;
}

function open(newEpoch: number, source: Source): void {
  close();
  epoch = newEpoch;
  if (source.kind === 'url' && isHlsSource(source.url, source.type)) {
    openHls(source);
    return;
  }
  try {
    if (source.kind === 'url') {
      const range = new RangeSource(source.url, source.withCredentials);
      const probe = range.open(BLOCK_SIZE * 2);
      if (looksLikeHls(probe)) {
        openHls(source);
        return;
      }
      cache = new BlockCache(range, BLOCK_SIZE);
      cache.seed(probe);
    } else {
      cache = new BlockCache(new BlobSource(source.blob), BLOCK_SIZE);
    }
    ioId = io.register(cache);
    demux = Demuxer.open(core, ioId);
    post({ type: 'opened', epoch, info: describe(core, demux) });
    progress(true);
  } catch (e) {
    fail(e, MediaErrorCode.SrcNotSupported);
  }
}

function openHls(source: Extract<Source, { kind: 'url' }>): void {
  const session = new HlsSession(
    {
      core,
      io,
      describe: (d) => describe(core, d),
      canPlay: (codecs) => canPlayType(`video/mp4; codecs="${codecs}"`, codecSet) !== '',
      onTimeline: (duration, seekableStart, seekableEnd) => post({ type: 'timeline', epoch, duration, seekableStart, seekableEnd }),
      onStats: (stats) => post({ type: 'hls', epoch, stats }),
      onBehind: (time) => post({ type: 'behind', epoch, time }),
      onProgress: (loaded) => hlsProgress(loaded),
    },
    source.url,
    source.withCredentials ? 'include' : 'same-origin',
    source.hls,
  );
  hls = session;
  session.open().then(
    (info) => hls === session && post({ type: 'opened', epoch, info }),
    (e) => hls === session && failHls(session, e, MediaErrorCode.SrcNotSupported),
  );
}

/** Reports a failed session and stops its reloads and downloads. */
function failHls(session: HlsSession, e: unknown, fallback: MediaErrorCode): void {
  session.close();
  const code = e instanceof HlsError ? e.code : fallback;
  post({ type: 'error', epoch, code, message: (e as Error).message });
}

function hlsProgress(loaded: number): void {
  const now = performance.now();
  if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
  lastProgress = now;
  post({ type: 'progress', epoch, size: -1, loaded, ranges: [] });
}

/**
 * Network failures win over `fallback`, since FFmpeg only sees them as EIO.
 * Like native media elements, an HTTP error status (404...) when opening is
 * "source not supported" rather than a network error.
 */
function fail(e: unknown, fallback: MediaErrorCode): void {
  const err = e as Error;
  const source = e instanceof SourceError ? e : io?.lastError instanceof SourceError ? io.lastError : null;
  let code: MediaErrorCode = fallback;
  if (source && !(fallback === MediaErrorCode.SrcNotSupported && source.status >= 400)) code = MediaErrorCode.Network;
  const message = io?.lastError ? `${err.message} (${io.lastError.message})` : err.message;
  if (io) io.lastError = null;
  post({ type: 'error', epoch, code, message });
}

function onDecode(msg: DecodeToDemux): void {
  if (hls) {
    onDecodeHls(hls, msg);
    return;
  }
  if (!demux) return;
  if (msg.type === 'seek') {
    epoch = msg.epoch;
    selected = new Set(msg.streams);
    eof = false;
    try {
      demux.seek(msg.time, msg.video);
    } catch (e) {
      // Unseekable input: restarting from 0 right after open is harmless.
      if (msg.time > 0) console.warn('[pup demux]', (e as Error).message);
    }
    return;
  }
  if (msg.epoch !== epoch) return;
  readBatch();
}

function onDecodeHls(session: HlsSession, msg: DecodeToDemux): void {
  if (msg.type === 'seek') {
    epoch = msg.epoch;
    session.seek(msg.time, msg.streams);
    return;
  }
  if (msg.epoch !== epoch) return;
  const batchEpoch = epoch;
  session.read(BATCH_PACKETS, BATCH_BYTES).then(
    (batch) => {
      if (!batch || hls !== session || batchEpoch !== epoch) return;
      const reply: DemuxToDecode = { type: 'packets', epoch, packets: batch.packets, eof: batch.eof };
      port.postMessage(
        reply,
        batch.packets.map((p) => p.data.buffer as ArrayBuffer),
      );
    },
    (e) => hls === session && batchEpoch === epoch && failHls(session, e, MediaErrorCode.Decode),
  );
}

function readBatch(): void {
  const packets: DemuxToDecode['packets'] = [];
  let bytes = 0;
  let reads = 0;
  try {
    while (!eof && packets.length < BATCH_PACKETS && bytes < BATCH_BYTES && reads < 512) {
      reads++;
      const pkt = demux!.read();
      if (!pkt) {
        eof = true;
        break;
      }
      if (!selected.has(pkt.stream)) continue;
      packets.push(pkt);
      bytes += pkt.data.length;
    }
  } catch (e) {
    if (io.lastError) {
      fail(e, MediaErrorCode.Network);
      return;
    }
    // Corrupt tail: treat as the end of the stream.
    console.warn('[pup demux]', (e as Error).message);
    eof = true;
  }
  const msg: DemuxToDecode = { type: 'packets', epoch, packets, eof };
  port.postMessage(
    msg,
    packets.map((p) => p.data.buffer as ArrayBuffer),
  );
  progress(false);
}

/** Reports fetched byte ranges, only when new bytes arrived (like `progress`). */
function progress(force: boolean): void {
  const now = performance.now();
  if (!cache || (!force && (now - lastProgress < PROGRESS_INTERVAL_MS || cache.bytesFetched === lastFetched))) return;
  lastProgress = now;
  lastFetched = cache.bytesFetched;
  post({ type: 'progress', epoch, size: cache.size, loaded: cache.bytesFetched, ranges: cache.stats().ranges });
}
