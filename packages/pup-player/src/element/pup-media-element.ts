// LitElement base implementing the HTMLMediaElement surface on top of
// PupEngine. Subclasses render the video surface (or nothing, for audio).

import type { CodecSet } from '@krab3000/pup-wasm';
import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';
import {
  HAVE_CURRENT_DATA,
  HAVE_ENOUGH_DATA,
  HAVE_FUTURE_DATA,
  HAVE_METADATA,
  HAVE_NOTHING,
  NETWORK_EMPTY,
  NETWORK_IDLE,
  NETWORK_LOADING,
  NETWORK_NO_SOURCE,
  PupEngine,
  type EngineStats,
} from '../engine/engine.js';
import type { Source } from '../engine/protocol.js';
import type { Renderer } from '../engine/renderer.js';
import { canPlayType } from './can-play-type.js';
import type { PupMediaError } from './media-error.js';
import { PupTimeRanges } from './time-ranges.js';

/** Events the controls (and subclasses) re-render on. */
export const MEDIA_EVENTS = [
  'loadstart', 'progress', 'suspend', 'abort', 'error', 'emptied', 'stalled', 'loadedmetadata', 'loadeddata',
  'canplay', 'canplaythrough', 'playing', 'waiting', 'seeking', 'seeked', 'ended', 'durationchange',
  'timeupdate', 'play', 'pause', 'ratechange', 'resize', 'volumechange',
] as const;

export abstract class PupMediaElement extends LitElement {
  static readonly NETWORK_EMPTY = NETWORK_EMPTY;
  static readonly NETWORK_IDLE = NETWORK_IDLE;
  static readonly NETWORK_LOADING = NETWORK_LOADING;
  static readonly NETWORK_NO_SOURCE = NETWORK_NO_SOURCE;
  static readonly HAVE_NOTHING = HAVE_NOTHING;
  static readonly HAVE_METADATA = HAVE_METADATA;
  static readonly HAVE_CURRENT_DATA = HAVE_CURRENT_DATA;
  static readonly HAVE_FUTURE_DATA = HAVE_FUTURE_DATA;
  static readonly HAVE_ENOUGH_DATA = HAVE_ENOUGH_DATA;
  readonly NETWORK_EMPTY = NETWORK_EMPTY;
  readonly NETWORK_IDLE = NETWORK_IDLE;
  readonly NETWORK_LOADING = NETWORK_LOADING;
  readonly NETWORK_NO_SOURCE = NETWORK_NO_SOURCE;
  readonly HAVE_NOTHING = HAVE_NOTHING;
  readonly HAVE_METADATA = HAVE_METADATA;
  readonly HAVE_CURRENT_DATA = HAVE_CURRENT_DATA;
  readonly HAVE_FUTURE_DATA = HAVE_FUTURE_DATA;
  readonly HAVE_ENOUGH_DATA = HAVE_ENOUGH_DATA;

  @property({ reflect: true }) src = '';
  @property({ type: Boolean, reflect: true }) autoplay = false;
  @property({ type: Boolean, reflect: true }) loop = false;
  @property({ type: Boolean, reflect: true }) controls = false;
  /** Reflects the `muted` content attribute (initial muted state). */
  @property({ type: Boolean, reflect: true, attribute: 'muted' }) defaultMuted = false;
  @property({ reflect: true }) preload: '' | 'none' | 'metadata' | 'auto' = 'auto';
  @property({ attribute: 'crossorigin', reflect: true }) crossOrigin: string | null = null;
  /** Wasm codec set: "full" (default) or "lite". Read at the first load. */
  @property({ attribute: 'codec-set' }) codecSet: CodecSet = 'full';
  /** Debug: decode video with FFmpeg even when WebCodecs could. */
  @property({ type: Boolean, attribute: 'force-software' }) forceSoftware = false;

  private _engine: PupEngine | null = null;
  private _srcObject: Blob | MediaSource | MediaStream | null = null;
  private _defaultPlaybackRate = 1;
  private _currentSrc = '';
  private _loadQueued = false;
  private _autoplayArmed = false;
  private _mutedInitialized = false;

  protected abstract get renderer(): Renderer | null;

  protected get engine(): PupEngine {
    if (!this._engine) {
      this._engine = new PupEngine((type) => this.onEngineEvent(type), this.rendererProxy, {
        set: this.codecSet,
        forceSoftware: this.forceSoftware || new URLSearchParams(location.search).has('forceSoftware'),
      });
      this._engine.loop = this.loop;
    }
    return this._engine;
  }

  /** Lets subclasses create their canvas after the engine exists. */
  private rendererProxy: Renderer = {
    draw: (frame) => this.renderer?.draw(frame),
    clear: () => this.renderer?.clear(),
  };

  connectedCallback(): void {
    super.connectedCallback();
    if (!this._mutedInitialized) {
      this._mutedInitialized = true;
      if (this.hasAttribute('muted')) this.engine.muted = true;
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    // Like a media element removed from the document: pause, keep state.
    if (this._engine && !this._engine.paused) this._engine.pause();
  }

  protected willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('src') && (this.src || changed.get('src'))) this.queueLoad();
    if (changed.has('loop') && this._engine) this._engine.loop = this.loop;
    if (changed.has('preload') && this._engine) this._engine.preload = this.normalizedPreload;
  }

  private get normalizedPreload(): 'none' | 'metadata' | 'auto' {
    return this.preload === 'none' || this.preload === 'metadata' ? this.preload : 'auto';
  }

  private queueLoad(): void {
    if (this._loadQueued) return;
    this._loadQueued = true;
    queueMicrotask(() => {
      this._loadQueued = false;
      this.load();
    });
  }

  private onEngineEvent(type: string): void {
    if (type === 'loadstart') this._autoplayArmed = this.autoplay;
    this.dispatchEvent(new Event(type));
    if (type === 'canplay' && this._autoplayArmed) {
      this._autoplayArmed = false;
      if (this.paused) this.play().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Source

  get srcObject(): Blob | MediaSource | MediaStream | null {
    return this._srcObject;
  }

  set srcObject(value: Blob | MediaSource | MediaStream | null) {
    this._srcObject = value;
    this.queueLoad();
  }

  get currentSrc(): string {
    return this._currentSrc;
  }

  load(): void {
    const engine = this.engine;
    engine.preload = this.autoplay ? 'auto' : this.normalizedPreload;
    engine.setPlaybackRate(this._defaultPlaybackRate);
    let source: Source | null = null;
    if (this._srcObject instanceof Blob) {
      source = { kind: 'blob', blob: this._srcObject };
      this._currentSrc = '';
    } else if (this._srcObject) {
      throw new DOMException('Only Blob/File srcObject values are supported', 'NotSupportedError');
    } else if (this.src) {
      const url = new URL(this.src, document.baseURI).href;
      source = { kind: 'url', url, withCredentials: this.crossOrigin === 'use-credentials' };
      this._currentSrc = url;
    } else {
      this._currentSrc = '';
    }
    engine.load(source);
  }

  canPlayType(type: string): CanPlayTypeResult {
    return canPlayType(type, this.codecSet);
  }

  // -------------------------------------------------------------------------
  // Playback

  play(): Promise<void> {
    return this.engine.play();
  }

  pause(): void {
    this.engine.pause();
  }

  fastSeek(time: number): void {
    this.engine.seek(time);
  }

  get currentTime(): number {
    return this._engine?.currentTime ?? 0;
  }

  set currentTime(time: number) {
    if (!Number.isFinite(time)) throw new TypeError('currentTime must be a finite number');
    this.engine.seek(time);
  }

  get duration(): number {
    return this._engine?.duration ?? NaN;
  }

  get paused(): boolean {
    return this._engine?.paused ?? true;
  }

  get ended(): boolean {
    return (this._engine?.ended ?? false) && !this.loop;
  }

  get seeking(): boolean {
    return this._engine?.seeking ?? false;
  }

  get readyState(): number {
    return this._engine?.readyState ?? HAVE_NOTHING;
  }

  get networkState(): number {
    return this._engine?.networkState ?? NETWORK_EMPTY;
  }

  get error(): PupMediaError | null {
    return this._engine?.error ?? null;
  }

  get buffered(): TimeRanges {
    return new PupTimeRanges(this._engine?.buffered ?? []);
  }

  get seekable(): TimeRanges {
    return new PupTimeRanges(this._engine?.seekable ?? []);
  }

  get played(): TimeRanges {
    return new PupTimeRanges(this._engine?.played ?? []);
  }

  // -------------------------------------------------------------------------
  // Volume and rate

  get volume(): number {
    return this._engine?.volume ?? 1;
  }

  set volume(volume: number) {
    if (!(volume >= 0 && volume <= 1)) {
      throw new DOMException(`The volume provided (${volume}) is outside the range [0, 1].`, 'IndexSizeError');
    }
    this.engine.setVolume(volume, this.muted);
  }

  get muted(): boolean {
    return this._engine?.muted ?? this.hasAttribute('muted');
  }

  set muted(muted: boolean) {
    this._mutedInitialized = true;
    this.engine.setVolume(this.volume, Boolean(muted));
  }

  get playbackRate(): number {
    return this._engine?.playbackRate ?? this._defaultPlaybackRate;
  }

  set playbackRate(rate: number) {
    this.checkRate(rate);
    this.engine.setPlaybackRate(rate);
  }

  get defaultPlaybackRate(): number {
    return this._defaultPlaybackRate;
  }

  set defaultPlaybackRate(rate: number) {
    this.checkRate(rate);
    if (rate === this._defaultPlaybackRate) return;
    this._defaultPlaybackRate = rate;
    this.dispatchEvent(new Event('ratechange'));
  }

  private checkRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < 0 || (rate > 0 && (rate < 0.0625 || rate > 16))) {
      throw new DOMException(`The provided playback rate (${rate}) is not in the supported playback range.`, 'NotSupportedError');
    }
  }

  // -------------------------------------------------------------------------
  // Extras

  /** Pipeline diagnostics (decoder in use, threading, fps, dropped frames). */
  getStats(): EngineStats & { format: string | null } {
    const stats = this._engine?.stats ?? {
      threading: null,
      videoDecoder: 'none',
      decodeFps: 0,
      droppedFrames: 0,
      presentedFrames: 0,
      bytesLoaded: 0,
      bytesTotal: -1,
    };
    return { ...stats, format: this._engine?.info?.format ?? null };
  }

  /** Releases workers and the audio context. The element can load again afterwards. */
  destroy(): void {
    this._engine?.destroy();
    this._engine = null;
  }
}
