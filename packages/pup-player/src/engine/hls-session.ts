// HLS in the demux worker. Playlists, keys and segments are fetched with
// fetch(), so the worker can wait for a growing playlist, reload, retry and
// prefetch without blocking. Each downloaded segment (with its EXT-X-MAP init
// segment in front, for fMP4) is opened as an in-memory file by the regular
// FFmpeg demuxer, and its packets are moved onto the playlist timeline.
//
// Timestamps: a *run* is a stretch of segments without a discontinuity. It
// starts at the first segment, after every seek and at every discontinuity
// (or timestamp jump). Within a run, packet times keep their raw spacing and
// are shifted so that the run's first segment starts at its playlist time:
// t = raw - runRawStart + runTimelineStart.

import {
  BlockCache,
  DemuxError,
  Demuxer,
  MemorySource,
  chooseVariant,
  findSegment,
  mergePlaylist,
  parsePlaylist,
  playlistEnd,
  segmentIv,
  unsupportedKey,
  type ByteRange,
  type Core,
  type HlsMap,
  type HlsSegment,
  type HlsVariant,
  type IORegistry,
  type MediaPlaylist,
  type Packet,
  type StreamInfo,
} from '@krab3000/pup-wasm';
import { MediaErrorCode, type HlsOptions, type HlsStats, type MediaInfo } from './protocol.js';

const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];

/** Segments fetched ahead of the one being demuxed. */
const PREFETCH = 2;
/** Backoff for a listed segment that fails (404, 5xx, network); then MEDIA_ERR_NETWORK. */
const RETRY_DELAYS_MS = [500, 1000, 2000];
/** Live playback starts this many segments before the end of the playlist. */
const LIVE_START_SEGMENTS = 3;
/** A segment starting this far before (or after) where its run left off starts a new run. */
const RUN_BACKWARD_US = 1e6;
const RUN_FORWARD_US = 30e6;
const BLOCK_SIZE = 1 << 20;
/**
 * Seeks within a segment aim this much earlier. MPEG-TS seeks by decode time,
 * and with B-frames a keyframe is shown up to a few frames after it is
 * decoded: aiming early makes the keyframe we resume from show at or before
 * the target, and the decode worker drops the frames before it.
 */
const SEEK_PREROLL = 0.25;

/** True when a MIME type or the URL's extension says HLS. */
export function isHlsSource(url: string, type?: string): boolean {
  const mime = type?.split(';')[0].trim().toLowerCase();
  if (mime && HLS_TYPES.includes(mime)) return true;
  try {
    return /\.m3u8?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** True when probed bytes start like a playlist (#EXTM3U, after an optional BOM). */
export function looksLikeHls(probe: Uint8Array): boolean {
  const start = probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf ? 3 : 0;
  return new TextDecoder().decode(probe.subarray(start, start + 7)) === '#EXTM3U';
}

export class HlsError extends Error {
  constructor(
    message: string,
    readonly code: MediaErrorCode,
  ) {
    super(message);
  }
}

/** A seek or close replaced the operation that was waiting. */
class Superseded extends Error {}

export interface HlsHost {
  core: Core;
  io: IORegistry;
  /** Picks the streams of the first segment (see media-info.ts). */
  describe(demux: Demuxer): MediaInfo;
  /** True when every codec of a CODECS attribute can be played. */
  canPlay(codecs: string): boolean;
  onTimeline(duration: number, seekableStart: number, seekableEnd: number): void;
  onStats(stats: HlsStats): void;
  /** Live playback fell out of the window: seek to `time`. */
  onBehind(time: number): void;
  onProgress(bytesLoaded: number): void;
  fetch?: typeof fetch;
}

export interface HlsBatch {
  packets: Packet[];
  eof: boolean;
}

interface Loaded {
  seg: HlsSegment;
  demux: Demuxer;
  ioId: number;
  /** Segment stream index -> session stream index. */
  streams: Map<number, number>;
  /** Segment index of the session's video stream, -1 if none. */
  video: number;
  /** Raw start time of the segment, microseconds. */
  rawStart: number;
  /** Added to packet times (relative to rawStart) to put them on the timeline, microseconds. */
  offset: number;
  fresh: boolean;
}

interface Run {
  discontinuitySeq: number;
  /** Raw time, microseconds, mapped to `timelineStart`. */
  rawStart: number;
  timelineStart: number;
  /** Latest raw decode time seen, to spot timestamp jumps without a discontinuity tag. */
  lastRaw: number;
}

interface Fetch {
  promise: Promise<Uint8Array>;
  controller: AbortController;
  done: boolean;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export class HlsSession {
  readonly stats: HlsStats = { kind: 'vod', variant: null, segmentsLoaded: 0, reloads: 0 };
  bytesLoaded = 0;

  private playlist!: MediaPlaylist;
  private info: MediaInfo | null = null;
  private current: Loaded | null = null;
  private nextSeq = 0;
  private run: Run | null = null;
  private seekLocal: number | null = null;
  private ended = false;
  private selected = new Set<number>();
  /** Bumped by seek and close; awaiting code checks it to notice it was superseded. */
  private gen = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private fetches = new Map<number, Fetch>();
  private keys = new Map<string, Promise<Uint8Array>>();
  private maps = new Map<string, Promise<Uint8Array>>();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadChanged = true;
  private waiters: Array<() => void> = [];
  private lastTimeline = '';
  private readonly fetchFn: typeof fetch;

  constructor(
    private host: HlsHost,
    private url: string,
    private credentials: RequestCredentials = 'same-origin',
    private options: HlsOptions = {},
  ) {
    this.fetchFn = host.fetch ?? fetch.bind(globalThis);
  }

  /** Loads the playlist (and variant) and the first segment; returns its streams. */
  async open(): Promise<MediaInfo> {
    let pl = parsePlaylist(await this.fetchText(this.url, true), this.url);
    let variant: HlsVariant | null = null;
    if (pl.type === 'master') {
      const choice = chooseVariant(pl, {
        canPlay: (codecs) => this.host.canPlay(codecs),
        maxHeight: this.options.maxHeight,
        maxBandwidth: this.options.maxBandwidth,
      });
      if (!choice) throw new HlsError('no playable variant in the HLS master playlist', MediaErrorCode.SrcNotSupported);
      if (choice.audioDropped) console.warn('[pup hls] separate audio renditions are not supported: playing video only');
      variant = choice.variant;
      pl = parsePlaylist(await this.fetchText(variant.uri, true), variant.uri);
      if (pl.type !== 'media') throw new HlsError('HLS variant is not a media playlist', MediaErrorCode.SrcNotSupported);
    }
    this.check(0);
    this.playlist = pl;
    this.stats.kind = pl.kind;
    this.stats.variant = variant && {
      bandwidth: variant.bandwidth,
      resolution: variant.resolution ? `${variant.resolution.width}x${variant.resolution.height}` : null,
      codecs: variant.codecs ?? null,
    };
    for (const s of pl.segments) {
      const why = unsupportedKey(s.key);
      if (why) throw new HlsError(why, MediaErrorCode.SrcNotSupported);
    }
    this.scheduleReload();

    const startIndex = pl.kind === 'live' ? Math.max(0, pl.segments.length - LIVE_START_SEGMENTS) : 0;
    const seq = pl.segments.length ? pl.segments[startIndex].seq : pl.mediaSequence;
    const gen = this.gen;
    const seg = await this.waitListed(seq, gen);
    if (typeof seg === 'string') throw new HlsError('the HLS playlist has no segments', MediaErrorCode.SrcNotSupported);
    const bytes = await this.segmentBytes(seg, gen);
    const loaded = this.openSegment(seg, bytes);
    let info: MediaInfo;
    try {
      info = this.host.describe(loaded.demux);
    } catch (e) {
      this.release(loaded);
      throw e;
    }
    this.info = { ...info, format: 'hls', duration: this.timeline().duration, startTime: seg.start };
    loaded.streams = new Map(info.streams.map((s) => [s.index, s.index]));
    loaded.video = info.video;
    this.current = loaded;
    this.nextSeq = seg.seq + 1;
    this.prefetch(seg.seq);
    this.publish();
    return this.info;
  }

  /** Repositions at `time` (playlist seconds); `streams` are the session stream indices to deliver. */
  seek(time: number, streams: number[]): void {
    this.gen++;
    this.wake();
    this.selected = new Set(streams);
    this.ended = false;
    this.run = null;
    const seg = findSegment(this.playlist, time);
    if (!seg) {
      this.release(this.current);
      this.current = null;
      this.nextSeq = this.playlist.mediaSequence;
      return;
    }
    this.seekLocal = Math.max(0, time - seg.start);
    for (const [seq, f] of this.fetches) {
      if (seq >= seg.seq && seq <= seg.seq + PREFETCH) continue;
      f.controller.abort();
      this.fetches.delete(seq);
    }
    if (this.current?.seg.seq === seg.seq) {
      this.begin(this.current);
      this.nextSeq = seg.seq + 1;
    } else {
      this.release(this.current);
      this.current = null;
      this.nextSeq = seg.seq;
    }
  }

  /**
   * Reads the next packets. Waits for the next segment (fetch, playlist
   * reloads) only when it has nothing to return yet. Resolves null when a
   * seek or close superseded it, or when live playback fell behind.
   */
  async read(maxPackets: number, maxBytes: number): Promise<HlsBatch | null> {
    const gen = this.gen;
    const packets: Packet[] = [];
    let bytes = 0;
    try {
      while (packets.length < maxPackets && bytes < maxBytes) {
        if (!this.current) {
          if (this.ended) break;
          if (packets.length && !this.fetches.get(this.nextSeq)?.done) break;
          const next = await this.load(this.nextSeq, gen);
          if (next === 'end') {
            this.ended = true;
            break;
          }
          if (next === 'behind') {
            this.host.onBehind(this.playlist.segments[0]?.start ?? 0);
            return null;
          }
          if (next === 'skip') {
            this.nextSeq++;
            continue;
          }
          this.current = next;
          this.nextSeq = next.seg.seq + 1;
          this.begin(next);
          continue;
        }
        const cur = this.current;
        let pkt: Packet | null;
        try {
          pkt = cur.demux.read();
        } catch (e) {
          // Corrupt tail: go on with the next segment.
          console.warn('[pup hls]', (e as Error).message);
          pkt = null;
        }
        cur.fresh = false;
        if (!pkt) {
          this.release(cur);
          this.current = null;
          continue;
        }
        const stream = cur.streams.get(pkt.stream);
        if (stream === undefined || !this.selected.has(stream)) continue;
        const raw = cur.rawStart + (Number.isFinite(pkt.dts) ? pkt.dts : pkt.pts);
        if (this.run && raw > this.run.lastRaw) this.run.lastRaw = raw;
        pkt.stream = stream;
        pkt.pts += cur.offset;
        pkt.dts += cur.offset;
        packets.push(pkt);
        bytes += pkt.data.length;
      }
    } catch (e) {
      if (e instanceof Superseded) return null;
      throw e;
    }
    return { packets, eof: this.ended && !this.current };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gen++;
    this.lifetime.abort();
    for (const f of this.fetches.values()) f.controller.abort();
    this.fetches.clear();
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.wake();
    this.release(this.current);
    this.current = null;
  }

  // -------------------------------------------------------------------------
  // Segments

  private check(gen: number): void {
    if (this.closed || gen !== this.gen) throw new Superseded();
  }

  private async load(seq: number, gen: number): Promise<Loaded | 'end' | 'behind' | 'skip'> {
    const seg = await this.waitListed(seq, gen);
    if (typeof seg === 'string') return seg;
    const bytes = await this.segmentBytes(seg, gen);
    this.prefetch(seq);
    try {
      return this.openSegment(seg, bytes);
    } catch (e) {
      if (!(e instanceof DemuxError)) throw e;
      console.warn(`[pup hls] skipping segment ${seg.seq}: ${e.message}`);
      return 'skip';
    }
  }

  /** Waits (through playlist reloads) until segment `seq` is listed. */
  private async waitListed(seq: number, gen: number): Promise<HlsSegment | 'end' | 'behind'> {
    for (;;) {
      this.check(gen);
      const { segments, endList } = this.playlist;
      const first = segments[0];
      const seg = first ? segments[seq - first.seq] : undefined;
      if (seg) return seg;
      if (first && seq < first.seq) return 'behind';
      if (endList) return 'end';
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private prefetch(seq: number): void {
    const first = this.playlist.segments[0];
    if (!first) return;
    for (let i = 1; i <= PREFETCH; i++) {
      const seg = this.playlist.segments[seq + i - first.seq];
      if (seg && !this.fetches.has(seg.seq)) this.startFetch(seg);
    }
  }

  private async segmentBytes(seg: HlsSegment, gen: number): Promise<Uint8Array> {
    const f = this.fetches.get(seg.seq) ?? this.startFetch(seg);
    let bytes: Uint8Array;
    try {
      bytes = await f.promise;
    } catch (e) {
      this.check(gen);
      throw e;
    }
    this.check(gen);
    this.fetches.delete(seg.seq);
    return bytes;
  }

  private startFetch(seg: HlsSegment): Fetch {
    const controller = new AbortController();
    const promise = this.fetchSegment(seg, controller.signal);
    const f: Fetch = { promise, controller, done: false };
    promise.then(
      () => (f.done = true),
      () => (f.done = true),
    );
    this.fetches.set(seg.seq, f);
    return f;
  }

  private async fetchSegment(seg: HlsSegment, signal: AbortSignal): Promise<Uint8Array> {
    const why = unsupportedKey(seg.key);
    if (why) throw new HlsError(why, MediaErrorCode.SrcNotSupported);
    let data = await this.fetchBytes(seg.uri, seg.byteRange, signal);
    if (seg.key) {
      const key = await this.key(seg.key.uri!);
      try {
        data = this.host.core.decryptAes128(key, segmentIv(seg.key, seg.seq), data);
      } catch (e) {
        throw new HlsError(`segment ${seg.seq}: ${(e as Error).message}`, MediaErrorCode.Decode);
      }
    }
    if (seg.map) {
      const init = await this.map(seg.map);
      const joined = new Uint8Array(init.length + data.length);
      joined.set(init);
      joined.set(data, init.length);
      data = joined;
    }
    this.stats.segmentsLoaded++;
    this.publish();
    return data;
  }

  private key(uri: string): Promise<Uint8Array> {
    let key = this.keys.get(uri);
    if (!key) {
      key = this.fetchBytes(uri, undefined, this.lifetime.signal).then((k) => {
        if (k.length !== 16) throw new HlsError(`HLS key ${uri} is ${k.length} bytes, not 16`, MediaErrorCode.Decode);
        return k;
      });
      key.catch(() => this.keys.delete(uri));
      this.keys.set(uri, key);
    }
    return key;
  }

  private map(map: HlsMap): Promise<Uint8Array> {
    const id = `${map.uri}@${map.byteRange?.offset ?? ''}-${map.byteRange?.length ?? ''}`;
    let init = this.maps.get(id);
    if (!init) {
      init = this.fetchBytes(map.uri, map.byteRange, this.lifetime.signal);
      init.catch(() => this.maps.delete(id));
      this.maps.set(id, init);
    }
    return init;
  }

  private openSegment(seg: HlsSegment, bytes: Uint8Array): Loaded {
    const { core, io } = this.host;
    const ioId = io.register(new BlockCache(new MemorySource(bytes), BLOCK_SIZE, Math.ceil(bytes.length / BLOCK_SIZE) + 1));
    let demux: Demuxer;
    try {
      demux = Demuxer.open(core, ioId);
    } catch (e) {
      io.unregister(ioId);
      throw e;
    }
    const loaded: Loaded = { seg, demux, ioId, streams: new Map(), video: -1, rawStart: demux.startTime * 1e6, offset: 0, fresh: true };
    if (this.info) {
      try {
        this.matchStreams(loaded, demux.streams());
      } catch (e) {
        this.release(loaded);
        throw e;
      }
    }
    return loaded;
  }

  /** Maps a later segment's streams onto the session's by type and codec. */
  private matchStreams(loaded: Loaded, streams: StreamInfo[]): void {
    const info = this.info!;
    const used = new Set<number>();
    for (const s of info.streams) {
      const candidates = streams.filter((l) => l.type === s.type && !used.has(l.index));
      const match = candidates.find((l) => l.codecId === s.codecId && l.index === s.index) ?? candidates.find((l) => l.codecId === s.codecId);
      const active = s.index === info.video || s.index === info.audio;
      if (active && (match ? !compatible(s, match) : candidates.length > 0)) {
        const now = match ?? candidates[0];
        throw new HlsError(
          `HLS segment ${loaded.seg.seq}: the ${s.type} stream changed (${describeStream(s)} -> ${describeStream(now)}); ` +
            'switching codec parameters mid-stream is not supported',
          MediaErrorCode.Decode,
        );
      }
      if (!match) continue;
      used.add(match.index);
      loaded.streams.set(match.index, s.index);
      if (s.index === info.video) loaded.video = match.index;
    }
  }

  /** Makes `loaded` the segment being read: joins or starts a run, applies a pending seek. */
  private begin(loaded: Loaded): void {
    const { seg } = loaded;
    const run = this.run;
    const continues =
      run !== null &&
      run.discontinuitySeq === seg.discontinuitySeq &&
      loaded.rawStart > run.lastRaw - RUN_BACKWARD_US &&
      loaded.rawStart < run.lastRaw + RUN_FORWARD_US;
    if (!continues) {
      this.run = { discontinuitySeq: seg.discontinuitySeq, rawStart: loaded.rawStart, timelineStart: seg.start * 1e6, lastRaw: loaded.rawStart };
    }
    loaded.offset = loaded.rawStart - this.run!.rawStart + this.run!.timelineStart;
    const local = this.seekLocal;
    this.seekLocal = null;
    if (local === null || (local < 0.001 && loaded.fresh)) return;
    try {
      loaded.demux.seek(Math.max(0, local - SEEK_PREROLL), loaded.video);
    } catch (e) {
      console.warn('[pup hls]', (e as Error).message);
    }
  }

  private release(loaded: Loaded | null): void {
    if (!loaded) return;
    loaded.demux.close();
    this.host.io.unregister(loaded.ioId);
  }

  // -------------------------------------------------------------------------
  // Network

  /** GET with retries for 404, 5xx and network errors (a listed segment may be late). */
  private async fetchBytes(url: string, range: ByteRange | undefined, signal: AbortSignal): Promise<Uint8Array> {
    const headers: Record<string, string> = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
    for (let attempt = 0; ; attempt++) {
      let reason: string;
      try {
        const res = await this.fetchFn(url, { credentials: this.credentials, signal, headers });
        if (res.ok) {
          let data = new Uint8Array(await res.arrayBuffer());
          // The server ignored Range and sent the whole resource.
          if (range && res.status === 200) data = data.slice(range.offset, range.offset + range.length);
          this.bytesLoaded += data.length;
          this.host.onProgress(this.bytesLoaded);
          return data;
        }
        reason = `HTTP ${res.status}`;
        if (res.status !== 404 && res.status !== 408 && res.status !== 429 && res.status < 500) {
          throw new HlsError(`${reason} fetching ${url}`, MediaErrorCode.Network);
        }
      } catch (e) {
        if (signal.aborted) throw new Superseded();
        if (e instanceof HlsError) throw e;
        reason = `network error (${(e as Error).message})`;
      }
      if (attempt >= RETRY_DELAYS_MS.length) throw new HlsError(`${reason} fetching ${url}`, MediaErrorCode.Network);
      await sleep(RETRY_DELAYS_MS[attempt], signal);
    }
  }

  /**
   * Fetches a playlist. When opening, an HTTP error status means "not
   * supported" (like native media elements) and a network failure is a
   * network error.
   */
  private async fetchText(url: string, opening: boolean): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { credentials: this.credentials, cache: 'no-cache', signal: this.lifetime.signal });
    } catch (e) {
      if (this.lifetime.signal.aborted) throw new Superseded();
      throw new HlsError(`network error fetching ${url}: ${(e as Error).message}`, MediaErrorCode.Network);
    }
    if (!res.ok) throw new HlsError(`HTTP ${res.status} fetching ${url}`, opening ? MediaErrorCode.SrcNotSupported : MediaErrorCode.Network);
    const text = await res.text();
    this.bytesLoaded += text.length;
    return text;
  }

  // -------------------------------------------------------------------------
  // Playlist reloads (EVENT and live playlists, until ENDLIST)

  /**
   * Reloads every target duration, or half of it after a reload that changed
   * nothing (RFC 8216 6.3.4). Keeps going while the session is open so that
   * `seekable` grows even when playback is far behind the end.
   */
  private scheduleReload(): void {
    if (this.closed || this.playlist.endList || this.reloadTimer !== null) return;
    const target = this.playlist.targetDuration > 0 ? this.playlist.targetDuration : 6;
    this.reloadTimer = setTimeout(() => void this.reload(), (this.reloadChanged ? target : target / 2) * 1000);
  }

  private async reload(): Promise<void> {
    try {
      const pl = parsePlaylist(await this.fetchText(this.playlist.url, false), this.playlist.url);
      if (pl.type !== 'media') throw new Error('not a media playlist');
      const prev = this.playlist;
      const merged = mergePlaylist(prev, pl);
      const last = (p: MediaPlaylist) => p.segments[p.segments.length - 1]?.seq;
      this.reloadChanged =
        merged.segments.length !== prev.segments.length || last(merged) !== last(prev) || merged.endList !== prev.endList;
      if (!this.closed) this.playlist = merged;
      this.stats.reloads++;
      this.stats.kind = merged.kind;
    } catch (e) {
      if (e instanceof Superseded || this.closed) return;
      console.warn('[pup hls] playlist reload failed:', (e as Error).message);
      this.reloadChanged = false;
    }
    this.reloadTimer = null;
    if (this.closed) return;
    this.publish();
    // Newly listed segments right after the one being read start downloading now.
    if (this.info) this.prefetch(this.current ? this.current.seg.seq : this.nextSeq - 1);
    this.wake();
    this.scheduleReload();
  }

  // -------------------------------------------------------------------------
  // Reporting

  private timeline(): { duration: number; seekableStart: number; seekableEnd: number } {
    const pl = this.playlist;
    const end = playlistEnd(pl);
    return {
      duration: pl.kind === 'vod' ? end : Infinity,
      seekableStart: pl.segments[0]?.start ?? 0,
      seekableEnd: end,
    };
  }

  private publish(): void {
    if (!this.info) return;
    const t = this.timeline();
    const key = `${t.duration}|${t.seekableStart}|${t.seekableEnd}`;
    if (key !== this.lastTimeline) {
      this.lastTimeline = key;
      this.host.onTimeline(t.duration, t.seekableStart, t.seekableEnd);
    }
    this.host.onStats({ ...this.stats });
  }
}

function compatible(a: StreamInfo, b: StreamInfo): boolean {
  if (a.codecId !== b.codecId) return false;
  if (a.type === 'audio') return a.sampleRate === b.sampleRate && a.channels === b.channels;
  // Length-prefixed video (avcC/hvcC, fMP4) is configured with its parameter sets.
  if (a.type === 'video' && a.extradata[0] === 1) return sameBytes(a.extradata, b.extradata);
  return true;
}

function describeStream(s: StreamInfo): string {
  return s.type === 'audio' ? `${s.codec} ${s.sampleRate} Hz ${s.channels} ch` : s.codec;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Superseded());
      },
      { once: true },
    );
  });
}
