// PupEngine runs one media pipeline: demux worker -> decode worker -> (canvas,
// audio worklet). It owns the HTMLMediaElement state machine and reports
// changes as standard media event names through `emit`.

import type { CodecSet } from '@krab3000/pup-wasm';
import { PupMediaError } from '../element/media-error.js';
import { loadAudioSink } from './audio-sink.js';
import { MediaClock } from './clock.js';
import {
  MediaErrorCode,
  type AudioMode,
  type FromDecode,
  type FromDemux,
  type FromWorklet,
  type MediaInfo,
  type Source,
  type ToDecode,
  type ToDemux,
  type ToWorklet,
} from './protocol.js';
import type { Renderer } from './renderer.js';

export const HAVE_NOTHING = 0;
export const HAVE_METADATA = 1;
export const HAVE_CURRENT_DATA = 2;
export const HAVE_FUTURE_DATA = 3;
export const HAVE_ENOUGH_DATA = 4;

export const NETWORK_EMPTY = 0;
export const NETWORK_IDLE = 1;
export const NETWORK_LOADING = 2;
export const NETWORK_NO_SOURCE = 3;

const TIMEUPDATE_MS = 250;
const PROGRESS_MS = 350;
const AUTOPLAY_PROBE_MS = 300;

export interface EngineOptions {
  /** Codec set of the wasm build to load. */
  set?: CodecSet;
  /** Decode video with FFmpeg even when WebCodecs could. */
  forceSoftware?: boolean;
  /** Decoder threads for mt builds (default: min(hardwareConcurrency, 8)). */
  threads?: number;
}

export interface EngineStats {
  threading: 'st' | 'mt' | null;
  videoDecoder: 'webcodecs' | 'software' | 'none';
  decodeFps: number;
  droppedFrames: number;
  presentedFrames: number;
  /** Bytes of the source fetched so far / total size (-1 if unknown). */
  bytesLoaded: number;
  bytesTotal: number;
}

type Deferred = { resolve: () => void; reject: (e: unknown) => void };

export class PupEngine {
  // HTMLMediaElement-visible state
  duration = NaN;
  paused = true;
  ended = false;
  seeking = false;
  readyState = HAVE_NOTHING;
  networkState = NETWORK_EMPTY;
  error: PupMediaError | null = null;
  videoWidth = 0;
  videoHeight = 0;
  volume = 1;
  muted = false;
  playbackRate = 1;
  loop = false;
  preload: 'none' | 'metadata' | 'auto' = 'auto';
  info: MediaInfo | null = null;
  readonly stats: EngineStats = {
    threading: null,
    videoDecoder: 'none',
    decodeFps: 0,
    droppedFrames: 0,
    presentedFrames: 0,
    bytesLoaded: 0,
    bytesTotal: -1,
  };

  private demux: Worker | null = null;
  private decode: Worker | null = null;
  private audioPort: MessagePort | null = null;
  private ctx: AudioContext | null = null;
  private sink: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private audioSetup: Promise<void> | null = null;

  private epoch = 0;
  private source: Source | null = null;
  private opened = false;
  private configured = false;
  private clock = new MediaClock();
  private pausedTime = 0;
  private pendingSeek: number | null = null;
  private seekTarget = 0;
  private internalSeek = false;
  private firstLoad = true;
  private audioMode: AudioMode = 'play';
  private hasAudio = false;
  private hasVideo = false;

  private frames: VideoFrame[] = [];
  private frameShown = false;
  private lastFrameEnd = 0;
  private frameDuration = 1 / 30;
  private videoEos = false;
  private audioEos = false;
  private audioAhead = 0;
  private bufferedStart = 0;
  private bufferedEnd = 0;
  private workletPos: FromWorklet | null = null;
  private waiting = false;
  /** The clock is running (set once startPlayback completes). */
  private started = false;
  private playPromises: Deferred[] = [];
  private playedRanges: Array<[number, number]> = [];
  private playedStart: number | null = null;
  private byteRanges: Array<[number, number]> = [];
  private byteSize = -1;

  private lastTimeupdate = 0;
  private lastProgress = 0;
  private loopHandle = 0;
  private destroyed = false;

  constructor(
    private emit: (type: string) => void,
    private renderer: Renderer | null,
    private options: EngineOptions = {},
  ) {}

  // -------------------------------------------------------------------------
  // Public API

  get currentTime(): number {
    if (this.seeking) return this.seekTarget;
    if (this.pendingSeek !== null) return this.pendingSeek;
    const t = this.paused || this.waiting ? this.pausedTime : this.clock.now();
    return Number.isFinite(this.duration) ? Math.min(Math.max(t, 0), this.duration) : Math.max(t, 0);
  }

  set currentTime(t: number) {
    this.seek(t);
  }

  /** Buffered media time ranges. */
  get buffered(): Array<[number, number]> {
    if (!this.configured) return [];
    const ranges: Array<[number, number]> = [[this.bufferedStart, this.bufferedEnd]];
    // A fully cached file is fully buffered.
    if (this.byteSize > 0 && this.byteRanges.length === 1 && this.byteRanges[0][0] === 0 && this.byteRanges[0][1] >= this.byteSize && Number.isFinite(this.duration)) {
      ranges.push([0, this.duration]);
    }
    return ranges;
  }

  get seekable(): Array<[number, number]> {
    if (!this.opened || !Number.isFinite(this.duration)) return [];
    return [[0, this.duration]];
  }

  get played(): Array<[number, number]> {
    const ranges = [...this.playedRanges];
    if (this.playedStart !== null) ranges.push([this.playedStart, this.currentTime]);
    return ranges;
  }

  /** Starts loading `source` (null unloads), mirroring the media element load algorithm. */
  load(source: Source | null): void {
    this.rejectPlay(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'));
    if (this.networkState === NETWORK_LOADING || this.networkState === NETWORK_IDLE) this.emit('abort');
    const hadMedia = this.networkState !== NETWORK_EMPTY;
    this.reset();
    if (hadMedia) this.emit('emptied');

    this.source = source;
    if (!source) {
      this.networkState = NETWORK_EMPTY;
      return;
    }
    this.networkState = NETWORK_LOADING;
    this.emit('loadstart');
    if (this.preload === 'none') {
      this.networkState = NETWORK_IDLE;
      this.emit('suspend');
      return;
    }
    this.open();
  }

  play(): Promise<void> {
    if (this.error?.code === MediaErrorCode.SrcNotSupported) {
      return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'));
    }
    const promise = new Promise<void>((resolve, reject) => this.playPromises.push({ resolve, reject }));
    // Must run synchronously inside the user gesture to unlock audio.
    this.unlockAudio();
    if (this.source && !this.opened && this.networkState === NETWORK_IDLE) {
      this.networkState = NETWORK_LOADING;
      this.open();
    }
    if (this.ended || (Number.isFinite(this.duration) && this.configured && this.currentTime >= this.duration)) {
      this.seek(0);
    }
    if (this.paused) {
      this.paused = false;
      this.ended = false;
      this.emit('play');
      if (this.readyState >= HAVE_FUTURE_DATA && !this.seeking) {
        void this.startPlayback();
      } else if (this.configured && !this.seeking) {
        this.waiting = true;
        this.emit('waiting');
      }
    } else if (this.readyState >= HAVE_FUTURE_DATA && !this.seeking && !this.waiting) {
      this.resolvePlay();
    }
    return promise;
  }

  pause(): void {
    if (this.source && !this.opened && this.networkState === NETWORK_IDLE) {
      this.networkState = NETWORK_LOADING;
      this.open();
    }
    if (this.paused) return;
    this.stopPlayback();
    this.paused = true;
    this.waiting = false;
    this.emit('timeupdate');
    this.emit('pause');
    this.rejectPlay(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
  }

  seek(time: number, internal = false): void {
    if (!Number.isFinite(time)) return;
    if (!this.configured) {
      this.pendingSeek = Math.max(0, time);
      return;
    }
    if (Number.isFinite(this.duration)) time = Math.min(time, this.duration);
    time = Math.max(0, time);
    this.closePlayedRange();
    if (this.started) this.stopPlayback();
    this.epoch++;
    this.seeking = true;
    this.internalSeek = internal;
    this.seekTarget = this.pausedTime = time;
    this.clock.set(time);
    this.ended = false;
    this.waiting = false;
    this.clearFrames();
    this.frameShown = false;
    this.videoEos = this.audioEos = false;
    this.audioAhead = 0;
    this.workletPos = null;
    this.bufferedStart = this.bufferedEnd = time;
    if (this.readyState > HAVE_METADATA) this.readyState = HAVE_METADATA;
    this.audioMode = this.chooseAudioMode();
    this.toWorklet({ type: 'flush', epoch: this.epoch });
    if (!internal) {
      this.emit('seeking');
    }
    this.toDecode({ type: 'seek', epoch: this.epoch, time, audioMode: this.audioMode });
  }

  setVolume(volume: number, muted: boolean): void {
    const changed = volume !== this.volume || muted !== this.muted;
    const unmuted = this.muted && !muted;
    this.volume = volume;
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : volume;
    if (changed) this.emit('volumechange');
    // Muted autoplay played without audio; bring it back once allowed.
    if (unmuted && this.hasAudio && this.audioMode === 'discard') {
      this.unlockAudio();
      void this.ctx?.resume().then(() => {
        if (this.ctx?.state === 'running' && this.audioMode === 'discard' && this.configured) this.seek(this.currentTime, true);
      });
    }
  }

  setPlaybackRate(rate: number): void {
    if (rate === this.playbackRate) return;
    this.playbackRate = rate;
    this.clock.setRate(rate);
    if (rate > 0) this.toDecode({ type: 'rate', rate, time: this.currentTime });
    if (!this.paused && !this.seeking) this.toWorklet({ type: rate > 0 ? 'play' : 'pause' });
    this.emit('ratechange');
  }

  destroy(): void {
    this.destroyed = true;
    this.reset();
    cancelAnimationFrame(this.loopHandle);
    clearTimeout(this.loopHandle);
    this.demux?.terminate();
    this.decode?.terminate();
    this.demux = this.decode = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  // -------------------------------------------------------------------------
  // Loading

  private reset(): void {
    this.epoch++;
    this.toDemux({ type: 'close' });
    this.toDecode({ type: 'reset' });
    this.toWorklet({ type: 'flush', epoch: this.epoch });
    this.toWorklet({ type: 'pause' });
    this.clearFrames();
    this.renderer?.clear();
    this.clock = new MediaClock();
    this.clock.setRate(this.playbackRate);
    this.source = null;
    this.opened = this.configured = false;
    this.info = null;
    this.duration = NaN;
    this.paused = true;
    this.ended = this.seeking = this.waiting = this.started = false;
    this.readyState = HAVE_NOTHING;
    this.error = null;
    this.videoWidth = this.videoHeight = 0;
    this.pausedTime = this.seekTarget = 0;
    this.pendingSeek = null;
    this.firstLoad = true;
    this.hasAudio = this.hasVideo = false;
    this.frameShown = false;
    this.videoEos = this.audioEos = false;
    this.bufferedStart = this.bufferedEnd = 0;
    this.playedRanges = [];
    this.playedStart = null;
    this.byteRanges = [];
    this.byteSize = -1;
    this.workletPos = null;
    this.stats.videoDecoder = 'none';
    this.stats.bytesLoaded = 0;
    this.stats.bytesTotal = -1;
  }

  private open(): void {
    this.ensureWorkers();
    this.toDemux({ type: 'open', epoch: this.epoch, source: this.source! });
  }

  private ensureWorkers(): void {
    if (this.demux) return;
    const demuxDecode = new MessageChannel();
    const audio = new MessageChannel();
    this.audioPort = audio.port2;
    const set = this.options.set ?? 'full';
    this.demux = new Worker(new URL('./demux.worker.ts', import.meta.url), { type: 'module', name: 'pup-demux' });
    this.decode = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module', name: 'pup-decode' });
    this.demux.onmessage = (e: MessageEvent<FromDemux>) => this.onDemux(e.data);
    this.decode.onmessage = (e: MessageEvent<FromDecode>) => this.onDecode(e.data);
    const workerError = (e: ErrorEvent) => this.fail(MediaErrorCode.Decode, `worker failed: ${e.message}`);
    this.demux.onerror = workerError;
    this.decode.onerror = workerError;
    this.demux.postMessage({ type: 'init', set, decodePort: demuxDecode.port1 } satisfies ToDemux, [demuxDecode.port1]);
    const threads = this.options.threads ?? Math.min(navigator.hardwareConcurrency || 4, 8);
    this.decode.postMessage(
      {
        type: 'init',
        set,
        threads,
        forceSoftware: this.options.forceSoftware ?? false,
        demuxPort: demuxDecode.port2,
        audioPort: audio.port1,
      } satisfies ToDecode,
      [demuxDecode.port2, audio.port1],
    );
    this.scheduleTick();
  }

  private ensureAudio(): Promise<void> {
    if (this.audioSetup) return this.audioSetup;
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    const ctx = this.ctx;
    this.audioSetup = loadAudioSink(ctx).then(() => {
      this.sink = new AudioWorkletNode(ctx, 'pup-audio-sink', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.gain = ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : this.volume;
      this.sink.connect(this.gain).connect(ctx.destination);
      this.sink.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onWorklet(e.data);
      this.sink.port.postMessage({ type: 'port', port: this.audioPort! } satisfies ToWorklet, [this.audioPort!]);
      this.toWorklet({ type: 'flush', epoch: this.epoch });
    });
    return this.audioSetup;
  }

  private unlockAudio(): void {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  private chooseAudioMode(): AudioMode {
    if (!this.hasAudio || !this.ctx) return 'discard';
    if (this.ctx.state === 'running') return 'play';
    // Can't produce sound yet: muted media plays silently on the wall clock.
    return this.muted ? 'discard' : 'play';
  }

  // -------------------------------------------------------------------------
  // Worker messages

  private onDemux(msg: FromDemux): void {
    if (msg.epoch !== this.epoch && msg.type !== 'progress') return;
    switch (msg.type) {
      case 'opened':
        void this.onOpened(msg.info, msg.epoch);
        break;
      case 'progress':
        this.byteRanges = msg.ranges;
        this.byteSize = msg.size;
        this.stats.bytesLoaded = msg.loaded;
        this.stats.bytesTotal = msg.size;
        this.progress();
        break;
      case 'error':
        this.fail(msg.code, msg.message);
        break;
    }
  }

  private async onOpened(info: MediaInfo, epoch: number): Promise<void> {
    this.info = info;
    this.opened = true;
    const video = info.video >= 0 ? info.streams[info.video] : null;
    const audio = info.audio >= 0 ? info.streams[info.audio] : null;
    this.hasVideo = video !== null;
    this.hasAudio = audio !== null;
    if (video) {
      this.frameDuration = video.fps > 0 ? 1 / video.fps : 1 / 30;
      const sar = video.sarNum > 0 && video.sarDen > 0 ? video.sarNum / video.sarDen : 1;
      this.videoWidth = Math.round(video.width * sar);
      this.videoHeight = video.height;
    }
    if (audio) {
      try {
        await this.ensureAudio();
      } catch (e) {
        console.warn('[pup] audio output unavailable:', e);
        this.hasAudio = false;
      }
      if (epoch !== this.epoch) return;
    }
    this.toDecode({
      type: 'configure',
      epoch,
      config: {
        video,
        audio: this.hasAudio ? audio : null,
        sampleRate: this.ctx?.sampleRate ?? 48000,
        rate: this.playbackRate > 0 ? this.playbackRate : 1,
      },
    });
  }

  private onDecode(msg: FromDecode): void {
    switch (msg.type) {
      case 'ready':
        this.stats.threading = msg.threading;
        return;
      case 'stats':
        this.stats.decodeFps = msg.decodeFps;
        return;
      case 'frame':
        if (msg.epoch !== this.epoch) msg.frame.close();
        else this.onFrame(msg.frame);
        return;
    }
    if (msg.epoch !== this.epoch) return;
    switch (msg.type) {
      case 'configured':
        this.onConfigured(msg.videoDecoder);
        break;
      case 'seekReady':
        this.onSeekReady();
        break;
      case 'levels':
        this.audioAhead = msg.audioAhead;
        this.videoEos = msg.videoEos;
        this.audioEos = msg.audioEos;
        this.bufferedEnd = Math.max(this.bufferedEnd, msg.bufferedEnd);
        if (this.videoEos && this.audioEos && this.networkState === NETWORK_LOADING) {
          this.networkState = NETWORK_IDLE;
          this.emit('suspend');
        }
        this.updateReadyState();
        break;
      case 'fallback':
        this.stats.videoDecoder = 'software';
        this.seek(this.currentTime, true);
        break;
      case 'error':
        this.fail(msg.code, msg.message);
        break;
    }
  }

  private onConfigured(videoDecoder: EngineStats['videoDecoder']): void {
    this.configured = true;
    this.stats.videoDecoder = videoDecoder;
    if (videoDecoder === 'none') {
      this.hasVideo = false;
      this.videoWidth = this.videoHeight = 0;
    }
    this.duration = this.info!.duration;
    this.readyState = HAVE_METADATA;
    this.emit('durationchange');
    if (this.hasVideo) this.emit('resize');
    this.emit('loadedmetadata');
    const start = this.pendingSeek ?? 0;
    this.pendingSeek = null;
    this.seek(start, true);
  }

  private onSeekReady(): void {
    const internal = this.internalSeek;
    this.seeking = false;
    this.internalSeek = false;
    if (this.firstLoad) {
      this.firstLoad = false;
      this.readyState = HAVE_CURRENT_DATA;
      this.emit('loadeddata');
    } else {
      this.readyState = HAVE_CURRENT_DATA;
      if (!internal) {
        this.emit('timeupdate');
        this.emit('seeked');
      }
    }
    this.updateReadyState();
    if (!this.paused) {
      if (this.readyState >= HAVE_FUTURE_DATA) void this.startPlayback();
      else this.waiting = true;
    }
  }

  private onFrame(frame: VideoFrame): void {
    if (frame.displayWidth !== this.videoWidth || frame.displayHeight !== this.videoHeight) {
      this.videoWidth = frame.displayWidth;
      this.videoHeight = frame.displayHeight;
      this.emit('resize');
    }
    if (!this.frameShown) {
      // First frame after a load/seek is shown right away (paused preview).
      this.frameShown = true;
      this.present(frame);
      this.toDecode({ type: 'consumed', epoch: this.epoch, frames: 1 });
    } else {
      this.frames.push(frame);
    }
    this.updateReadyState();
  }

  private onWorklet(msg: FromWorklet): void {
    if (msg.epoch !== this.epoch) return;
    this.workletPos = msg;
    this.clock.onAudioPosition(msg);
  }

  private fail(code: MediaErrorCode, message: string): void {
    console.error(`[pup] media error ${code}: ${message}`);
    this.error = new PupMediaError(code, message);
    this.stopPlayback();
    if (code === MediaErrorCode.SrcNotSupported && this.readyState === HAVE_NOTHING) {
      this.networkState = NETWORK_NO_SOURCE;
    } else {
      this.networkState = NETWORK_IDLE;
    }
    this.epoch++; // ignore anything still in flight
    this.emit('error');
    this.rejectPlay(new DOMException(message, 'NotSupportedError'));
  }

  // -------------------------------------------------------------------------
  // Playback

  private async startPlayback(): Promise<void> {
    const epoch = this.epoch;
    if (this.hasAudio && this.audioMode === 'play' && this.ctx && this.ctx.state !== 'running') {
      await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, AUTOPLAY_PROBE_MS))]);
      if (epoch !== this.epoch || this.paused) return;
      // resume() may have changed the state since the check above.
      if ((this.ctx.state as AudioContextState) !== 'running') {
        if (this.muted) {
          // Allowed to play silently: restart without audio.
          this.seek(this.currentTime, true);
          return;
        }
        this.paused = true;
        this.emit('pause');
        this.rejectPlay(new DOMException("play() failed because the user didn't interact with the document first.", 'NotAllowedError'));
        return;
      }
    }
    if (this.paused || this.seeking) return;
    this.waiting = false;
    this.clock.useAudio(this.audioMode === 'play' && this.hasAudio ? this.ctx : null);
    this.clock.set(this.pausedTime);
    this.clock.start();
    this.started = true;
    if (this.playbackRate > 0) this.toWorklet({ type: 'play' });
    this.playedStart = this.pausedTime;
    this.emit('playing');
    this.resolvePlay();
  }

  private stopPlayback(): void {
    this.pausedTime = this.currentTimeRaw();
    this.started = false;
    this.clock.stop();
    this.clock.set(this.pausedTime);
    this.toWorklet({ type: 'pause' });
    this.closePlayedRange();
  }

  private currentTimeRaw(): number {
    if (this.seeking) return this.seekTarget;
    if (this.paused || this.waiting) return this.pausedTime;
    return this.clock.now();
  }

  private closePlayedRange(): void {
    if (this.playedStart === null) return;
    this.playedRanges.push([this.playedStart, this.currentTimeRaw()]);
    this.playedStart = null;
  }

  private resolvePlay(): void {
    const pending = this.playPromises;
    this.playPromises = [];
    for (const p of pending) p.resolve();
  }

  private rejectPlay(err: DOMException): void {
    const pending = this.playPromises;
    this.playPromises = [];
    for (const p of pending) p.reject(err);
  }

  private updateReadyState(): void {
    if (!this.configured || this.seeking || this.firstLoad) return;
    const videoOk = (n: number) => !this.hasVideo || this.videoEos || this.frames.length >= n;
    const audioOk = (s: number) => this.audioMode !== 'play' || !this.hasAudio || this.audioEos || this.audioAhead >= s;
    let state = HAVE_CURRENT_DATA;
    if (videoOk(2) && audioOk(0.15)) state = HAVE_FUTURE_DATA;
    if (videoOk(4) && audioOk(0.35)) state = HAVE_ENOUGH_DATA;
    // Once playing, keep FUTURE_DATA as long as playback isn't actually stalled.
    if (!this.paused && !this.waiting && state < HAVE_FUTURE_DATA && this.readyState >= HAVE_FUTURE_DATA) state = HAVE_FUTURE_DATA;
    const prev = this.readyState;
    if (state === prev) return;
    this.readyState = state;
    if (prev < HAVE_FUTURE_DATA && state >= HAVE_FUTURE_DATA) {
      this.emit('canplay');
      if (!this.paused && this.waiting) void this.startPlayback();
    }
    if (prev < HAVE_ENOUGH_DATA && state === HAVE_ENOUGH_DATA) this.emit('canplaythrough');
  }

  private progress(): void {
    const now = performance.now();
    if (now - this.lastProgress < PROGRESS_MS) return;
    this.lastProgress = now;
    this.emit('progress');
  }

  // -------------------------------------------------------------------------
  // Render loop

  private scheduleTick(): void {
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.hidden) {
      this.loopHandle = window.setTimeout(() => this.tick(), 100);
    } else {
      this.loopHandle = requestAnimationFrame(() => this.tick());
    }
  }

  private tick(): void {
    try {
      this.renderFrames();
      if (this.started) this.advance();
    } finally {
      this.scheduleTick();
    }
  }

  private renderFrames(): void {
    if (!this.frames.length) return;
    const t = this.currentTimeRaw();
    let pick: VideoFrame | null = null;
    let consumed = 0;
    // Present the newest frame that is due; drop the ones it supersedes.
    while (this.frames.length && this.frames[0].timestamp / 1e6 <= t + 0.005) {
      if (pick) {
        pick.close();
        this.stats.droppedFrames++;
      }
      pick = this.frames.shift()!;
      consumed++;
    }
    if (pick) this.present(pick);
    if (consumed) {
      this.toDecode({ type: 'consumed', epoch: this.epoch, frames: consumed });
      this.updateReadyState();
    }
  }

  private present(frame: VideoFrame): void {
    const duration = frame.duration ? frame.duration / 1e6 : this.frameDuration;
    this.lastFrameEnd = frame.timestamp / 1e6 + duration;
    this.renderer?.draw(frame);
    this.stats.presentedFrames++;
    frame.close();
  }

  private advance(): void {
    if (this.waiting) return;
    let t = this.clock.now();
    let audioDriven = this.clock.audioDriven;

    // End of stream. Without the audio clock, audio isn't being played.
    const audioDone = !audioDriven || (this.workletPos?.ended ?? false);
    const videoDone =
      !this.hasVideo || (this.videoEos && this.frames.length === 0 && (audioDriven || t >= this.lastFrameEnd));
    if (audioDone && videoDone) {
      this.onEnded(t);
      return;
    }
    if (audioDriven && audioDone) {
      // Audio ended before video: keep going on the wall clock.
      this.clock.stop();
      this.clock.useAudio(null);
      this.clock.set(t);
      this.clock.start();
      audioDriven = false;
      t = this.clock.now();
    }

    // Stalls: audio underrun (audio clock) or no video to show (wall clock).
    const audioStarved = audioDriven && (this.workletPos?.starved ?? false) && !this.audioEos;
    const videoStarved = !audioDriven && this.hasVideo && !this.videoEos && this.frames.length === 0 && t > this.lastFrameEnd + this.frameDuration;
    if (audioStarved || videoStarved) {
      this.pausedTime = t;
      this.started = false;
      this.clock.stop();
      this.toWorklet({ type: 'pause' });
      this.waiting = true;
      this.readyState = HAVE_CURRENT_DATA;
      this.emit('timeupdate');
      this.emit('waiting');
      return;
    }

    const now = performance.now();
    if (now - this.lastTimeupdate >= TIMEUPDATE_MS) {
      this.lastTimeupdate = now;
      this.emit('timeupdate');
    }
  }

  private onEnded(t: number): void {
    if (this.loop) {
      this.seek(0, true);
      return;
    }
    this.pausedTime = Number.isFinite(this.duration) ? Math.max(t, Math.min(this.lastFrameEnd, this.duration)) : t;
    if (Number.isFinite(this.duration) && this.pausedTime > this.duration - 0.25) {
      this.pausedTime = this.duration;
    } else {
      // The container's duration was missing or estimated (raw RealAudio, VBR
      // MP3 without a TOC, ...): like native elements, correct it at the end.
      this.duration = this.pausedTime;
      this.emit('durationchange');
    }
    this.started = false;
    this.clock.stop();
    this.clock.set(this.pausedTime);
    this.toWorklet({ type: 'pause' });
    this.closePlayedRange();
    this.paused = true;
    this.ended = true;
    this.emit('timeupdate');
    this.emit('pause');
    this.emit('ended');
  }

  private clearFrames(): void {
    for (const f of this.frames) f.close();
    this.frames = [];
  }

  private toDemux(msg: ToDemux): void {
    this.demux?.postMessage(msg);
  }

  private toDecode(msg: ToDecode): void {
    this.decode?.postMessage(msg);
  }

  private toWorklet(msg: ToWorklet): void {
    this.sink?.port.postMessage(msg);
  }
}
