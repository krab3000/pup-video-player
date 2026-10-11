// Demux worker: owns one single-threaded wasm instance and reads the source
// synchronously (sync XHR / FileReaderSync), handing packets to the decode
// worker on request.

import {
  BlobSource,
  BlockCache,
  DemuxError,
  Demuxer,
  IORegistry,
  RangeSource,
  SourceError,
  loadCore,
  type Core,
  type StreamInfo,
} from '@krab3000/pup-wasm';
import {
  MediaErrorCode,
  type DecodeToDemux,
  type DemuxToDecode,
  type FromDemux,
  type MediaInfo,
  type Source,
  type ToDemux,
} from './protocol.js';

const BLOCK_SIZE = 1 << 20;
const BATCH_PACKETS = 48;
const BATCH_BYTES = 1 << 20;
const PROGRESS_INTERVAL_MS = 350;

let core: Core;
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

const post = (msg: FromDemux) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<ToDemux>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    port = msg.decodePort;
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
  try {
    if (source.kind === 'url') {
      const range = new RangeSource(source.url, source.withCredentials);
      const probe = range.open(BLOCK_SIZE * 2);
      cache = new BlockCache(range, BLOCK_SIZE);
      cache.seed(probe);
    } else {
      cache = new BlockCache(new BlobSource(source.blob), BLOCK_SIZE);
    }
    ioId = io.register(cache);
    demux = Demuxer.open(core, ioId);
    post({ type: 'opened', epoch, info: describe(demux) });
    progress(true);
  } catch (e) {
    fail(e, MediaErrorCode.SrcNotSupported);
  }
}

function playable(s: StreamInfo): boolean {
  if (s.type === 'video') return !s.attachedPic && (s.webcodecs !== '' || core.hasDecoder(s.codecId));
  if (s.type === 'audio') return core.hasDecoder(s.codecId);
  return false;
}

function pick(streams: StreamInfo[], type: 'video' | 'audio'): number {
  const candidates = streams.filter((s) => s.type === type && playable(s));
  return (candidates.find((s) => s.default) ?? candidates[0])?.index ?? -1;
}

function describe(d: Demuxer): MediaInfo {
  const streams = d.streams();
  const video = pick(streams, 'video');
  const audio = pick(streams, 'audio');
  if (video < 0 && audio < 0) {
    const codecs = streams.map((s) => `${s.type}:${s.codec}`).join(', ');
    throw new DemuxError(`no playable streams (${codecs || 'none'})`, 0);
  }
  let duration = d.duration;
  if (!Number.isFinite(duration)) {
    const known = streams.map((s) => s.duration).filter((x) => Number.isFinite(x));
    duration = known.length ? Math.max(...known) : Infinity;
  }
  return { format: d.formatName, duration, streams, video, audio };
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
