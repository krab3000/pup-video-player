// Typed access to the flat pup_* C API. Slot layouts mirror src/c/pup.h.

export type CodecSet = 'full' | 'lite';
export type Threading = 'st' | 'mt';

export interface IOHandler {
  /** Fills `dst` from byte offset `pos`. Returns bytes read, 0 at EOF, <0 on error. */
  read(io: number, dst: Uint8Array, pos: number): number;
  /** Total size in bytes, or -1 if unknown. */
  size(io: number): number;
}

type Fn = (...args: number[]) => number;

export interface CoreModule {
  wasmMemory: WebAssembly.Memory;
  _malloc(size: number): number;
  _free(ptr: number): void;
  UTF8ToString(ptr: number, maxBytes?: number): string;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(str: string): number;
  pupIO?: IOHandler;
  [name: `_pup_${string}`]: Fn;
}

export interface LoadOptions {
  set?: CodecSet;
  threading?: Threading;
  /** Number of pthread workers to pre-spawn (mt builds only). */
  pthreadPoolSize?: number;
  /** Overrides where the emscripten glue looks for the .wasm file. */
  locateFile?: (path: string, prefix: string) => string;
}

const loaders: Record<string, () => Promise<{ default: (m?: object) => Promise<CoreModule> }>> = {
  'full-st': () => import('../../dist/pup-core-full-st.mjs' as string),
  'full-mt': () => import('../../dist/pup-core-full-mt.mjs' as string),
  'lite-st': () => import('../../dist/pup-core-lite-st.mjs' as string),
  'lite-mt': () => import('../../dist/pup-core-lite-mt.mjs' as string),
};

/** True when the mt builds can run (SharedArrayBuffer available). */
export function canUseThreads(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

export class Core {
  readonly EAGAIN: number;
  readonly EOF: number;
  private scratch: number;
  private views!: { buffer: ArrayBufferLike; u8: Uint8Array; i32: Int32Array; f64: Float64Array };

  constructor(readonly m: CoreModule, readonly threading: Threading) {
    this.refreshViews();
    this.EAGAIN = m._pup_err_eagain();
    this.EOF = m._pup_err_eof();
    this.scratch = m._malloc(256);
  }

  // Heap views. With pthreads, memory can grow on another thread and the
  // glue's HEAP* views go stale, so views are re-created whenever the
  // underlying buffer changes.
  private refreshViews(): void {
    const buffer = this.m.wasmMemory.buffer;
    this.views = { buffer, u8: new Uint8Array(buffer), i32: new Int32Array(buffer), f64: new Float64Array(buffer) };
  }

  get u8(): Uint8Array {
    if (this.views.buffer !== this.m.wasmMemory.buffer) this.refreshViews();
    return this.views.u8;
  }

  get i32(): Int32Array {
    void this.u8;
    return this.views.i32;
  }

  get f64(): Float64Array {
    void this.u8;
    return this.views.f64;
  }

  /** Reusable 256-byte scratch area for small outputs (slot arrays, ints). */
  get scratchPtr(): number {
    return this.scratch;
  }

  slots(ptr: number, count: number): Float64Array {
    return this.f64.subarray(ptr >> 3, (ptr >> 3) + count);
  }

  errorString(code: number): string {
    const buf = this.m._malloc(128);
    this.m._pup_error_string(code, buf, 128);
    const s = this.m.UTF8ToString(buf);
    this.m._free(buf);
    return s;
  }

  withString<T>(s: string, fn: (ptr: number) => T): T {
    const len = this.m.lengthBytesUTF8(s) + 1;
    const ptr = this.m._malloc(len);
    this.m.stringToUTF8(s, ptr, len);
    try {
      return fn(ptr);
    } finally {
      this.m._free(ptr);
    }
  }

  hasDemuxer(name: string): boolean {
    return this.withString(name, (p) => this.m._pup_has_demuxer(p)) !== 0;
  }

  hasDecoder(codecId: number): boolean {
    return this.m._pup_has_decoder(codecId) !== 0;
  }

  hasDecoderName(name: string): boolean {
    return this.withString(name, (p) => this.m._pup_has_decoder_name(p)) !== 0;
  }
}

export async function loadCore(opts: LoadOptions = {}): Promise<Core> {
  const set = opts.set ?? 'full';
  const threading = opts.threading ?? (canUseThreads() ? 'mt' : 'st');
  const factory = (await loaders[`${set}-${threading}`]()).default;
  const m = await factory({
    pthreadPoolSize: threading === 'mt' ? Math.max(1, opts.pthreadPoolSize ?? 4) : 0,
    ...(opts.locateFile ? { locateFile: opts.locateFile } : {}),
  });
  return new Core(m, threading);
}

// ---------------------------------------------------------------------------
// Demuxing

export const CODECPAR_SIZE = 17; // PUP_CP_COUNT

export interface StreamInfo {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  codecId: number;
  /** WebCodecs codec string, '' when WebCodecs can't handle the codec. */
  webcodecs: string;
  width: number;
  height: number;
  sarNum: number;
  sarDen: number;
  fps: number;
  pixelFormat: string;
  sampleRate: number;
  channels: number;
  profile: number;
  level: number;
  bitRate: number;
  attachedPic: boolean;
  default: boolean;
  /** Seconds, NaN if unknown. */
  duration: number;
  /** Serialized codec parameters for Decoder.open. */
  codecpar: Int32Array;
  extradata: Uint8Array;
}

export interface Packet {
  stream: number;
  key: boolean;
  data: Uint8Array;
  /** Microseconds on the media timeline; NaN when unknown. */
  pts: number;
  dts: number;
  duration: number;
}

export class DemuxError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

export class Demuxer {
  private out: number;

  private constructor(private core: Core, private ptr: number) {
    this.out = core.m._malloc(8 * 8);
  }

  static open(core: Core, io: number): Demuxer {
    const errPtr = core.scratchPtr;
    core.i32[errPtr >> 2] = 0;
    const ptr = core.m._pup_demux_open(io, errPtr);
    if (!ptr) {
      const code = core.i32[errPtr >> 2];
      throw new DemuxError(`cannot open media: ${core.errorString(code)}`, code);
    }
    return new Demuxer(core, ptr);
  }

  get formatName(): string {
    return this.core.m.UTF8ToString(this.core.m._pup_demux_format_name(this.ptr));
  }

  /** Seconds, NaN if unknown. */
  get duration(): number {
    return this.core.m._pup_demux_duration(this.ptr) / 1e6;
  }

  streams(): StreamInfo[] {
    const { m } = this.core;
    const count = m._pup_demux_stream_count(this.ptr);
    const buf = m._malloc(2048);
    const cp = m._malloc(CODECPAR_SIZE * 4);
    const result: StreamInfo[] = [];
    try {
      for (let i = 0; i < count; i++) {
        m._pup_demux_stream_info(this.ptr, i, buf, 2048);
        const info = JSON.parse(m.UTF8ToString(buf)) as StreamInfo;
        info.duration = m._pup_demux_stream_duration(this.ptr, i) / 1e6;
        m._pup_demux_codecpar(this.ptr, i, cp);
        info.codecpar = this.core.i32.slice(cp >> 2, (cp >> 2) + CODECPAR_SIZE);
        const sizePtr = this.core.scratchPtr;
        const ed = m._pup_demux_extradata(this.ptr, i, sizePtr);
        const edSize = this.core.i32[sizePtr >> 2];
        info.extradata = ed && edSize > 0 ? this.core.u8.slice(ed, ed + edSize) : new Uint8Array(0);
        result.push(info);
      }
    } finally {
      m._free(buf);
      m._free(cp);
    }
    return result;
  }

  /** Reads the next packet (data is copied out of wasm memory); null at EOF. */
  read(): Packet | null {
    const { m } = this.core;
    const ret = m._pup_demux_read(this.ptr, this.out);
    if (ret === 1) return null;
    if (ret < 0) throw new DemuxError(`read failed: ${this.core.errorString(ret)}`, ret);
    const o = this.core.slots(this.out, 7);
    const data = this.core.u8.slice(o[3], o[3] + o[2]);
    return { stream: o[0], key: o[1] === 1, data, pts: o[4], dts: o[5], duration: o[6] };
  }

  /**
   * Seeks to a keyframe at or before `seconds`. With `videoStream`, makes sure
   * reading resumes on a keyframe of that stream (needed for MPEG-TS & co).
   */
  seek(seconds: number, videoStream = -1): void {
    const ret = this.core.m._pup_demux_seek(this.ptr, Math.max(0, seconds) * 1e6, videoStream);
    if (ret < 0) throw new DemuxError(`seek failed: ${this.core.errorString(ret)}`, ret);
  }

  close(): void {
    if (!this.ptr) return;
    this.core.m._pup_demux_close(this.ptr);
    this.core.m._free(this.out);
    this.ptr = 0;
  }
}

// ---------------------------------------------------------------------------
// Decoding

export interface DecodedVideo {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  /** Microseconds. */
  pts: number;
  duration: number;
  /** Tightly packed I420; a view into wasm memory valid until the next call. */
  data: Uint8Array;
  fullRange: boolean;
  /** AVColorSpace value. */
  matrix: number;
}

export interface DecodedAudio {
  frames: number;
  channels: number;
  sampleRate: number;
  /** Media time of the first sample, microseconds. */
  pts: number;
  /** Planar float32 [channel][frame]; a view valid until the next call. */
  data: Float32Array;
}

export interface DecoderOptions {
  threads?: number;
  /** Output sample rate for audio decoders. */
  sampleRate?: number;
}

export class Decoder {
  private out: number;
  private inBuf = 0;
  private inCap = 0;

  private constructor(private core: Core, private ptr: number) {
    this.out = core.m._malloc(10 * 8);
  }

  static open(core: Core, codecpar: Int32Array, extradata: Uint8Array, opts: DecoderOptions = {}): Decoder {
    const { m } = core;
    const cp = m._malloc(codecpar.byteLength);
    core.i32.set(codecpar, cp >> 2);
    const ed = extradata.length ? m._malloc(extradata.length) : 0;
    if (ed) core.u8.set(extradata, ed);
    const errPtr = core.scratchPtr;
    core.i32[errPtr >> 2] = 0;
    const ptr = m._pup_dec_open(cp, ed, extradata.length, opts.threads ?? 1, opts.sampleRate ?? 48000, errPtr);
    const code = core.i32[errPtr >> 2];
    m._free(cp);
    if (ed) m._free(ed);
    if (!ptr) throw new DemuxError(`cannot open decoder: ${core.errorString(code)}`, code);
    return new Decoder(core, ptr);
  }

  /**
   * Sends a packet (null drains). Returns false when output must be drained
   * first (EAGAIN); throws on decoder errors.
   */
  send(pkt: Packet | null): boolean {
    const { m } = this.core;
    let ret: number;
    if (!pkt) {
      ret = m._pup_dec_send(this.ptr, 0, 0, NaN, NaN, NaN, 0);
    } else {
      if (pkt.data.length > this.inCap) {
        if (this.inBuf) m._free(this.inBuf);
        this.inCap = pkt.data.length * 2;
        this.inBuf = m._malloc(this.inCap);
      }
      this.core.u8.set(pkt.data, this.inBuf);
      ret = m._pup_dec_send(this.ptr, this.inBuf, pkt.data.length, pkt.pts, pkt.dts, pkt.duration, pkt.key ? 1 : 0);
    }
    if (ret === this.core.EAGAIN) return false;
    if (ret === this.core.EOF) return true;
    if (ret < 0) throw new DemuxError(`decode failed: ${this.core.errorString(ret)}`, ret);
    return true;
  }

  /** Next decoded video frame, 'again' if more input is needed, null at end. */
  video(): DecodedVideo | 'again' | null {
    const ret = this.core.m._pup_dec_video_frame(this.ptr, this.out);
    if (ret === this.core.EAGAIN) return 'again';
    if (ret === this.core.EOF) return null;
    if (ret < 0) throw new DemuxError(`decode failed: ${this.core.errorString(ret)}`, ret);
    const o = this.core.slots(this.out, 10);
    return {
      width: o[0],
      height: o[1],
      displayWidth: o[2],
      displayHeight: o[3],
      pts: o[4],
      duration: o[5],
      data: this.core.u8.subarray(o[6], o[6] + o[7]),
      fullRange: o[8] === 1,
      matrix: o[9],
    };
  }

  /** Next chunk of resampled (and tempo-adjusted) audio. */
  audio(): DecodedAudio | 'again' | null {
    const ret = this.core.m._pup_dec_audio_frame(this.ptr, this.out);
    if (ret === this.core.EAGAIN) return 'again';
    if (ret === this.core.EOF) return null;
    if (ret < 0) throw new DemuxError(`decode failed: ${this.core.errorString(ret)}`, ret);
    const o = this.core.slots(this.out, 5);
    const frames = o[0];
    const channels = o[1];
    const ptr = o[4];
    return {
      frames,
      channels,
      sampleRate: o[2],
      pts: o[3],
      data: new Float32Array(this.core.u8.buffer, ptr, frames * channels),
    };
  }

  setTempo(tempo: number): void {
    this.core.m._pup_dec_set_tempo(this.ptr, tempo);
  }

  flush(): void {
    this.core.m._pup_dec_flush(this.ptr);
  }

  close(): void {
    if (!this.ptr) return;
    const { m } = this.core;
    m._pup_dec_close(this.ptr);
    m._free(this.out);
    if (this.inBuf) m._free(this.inBuf);
    this.ptr = 0;
  }
}
