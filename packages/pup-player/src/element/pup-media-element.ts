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
import { selectSource } from './source-selection.js';
import { activeCuesAt, PupTextTrack, PupTextTrackList, sameCues, type PupTextTrackKind } from './text-tracks.js';
import { PupTimeRanges } from './time-ranges.js';
import { parseWebVTT, type VttCue } from './webvtt.js';

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
  /** HLS: highest variant height to pick from a master playlist. Read at load. */
  @property({ type: Number, attribute: 'hls-max-height' }) hlsMaxHeight?: number;
  /** HLS: highest variant BANDWIDTH (bits/s) to pick from a master playlist. Read at load. */
  @property({ type: Number, attribute: 'hls-max-bandwidth' }) hlsMaxBandwidth?: number;

  private _engine: PupEngine | null = null;
  private _srcObject: Blob | MediaSource | MediaStream | null = null;
  private _defaultPlaybackRate = 1;
  private _currentSrc = '';
  private _loadQueued = false;
  private _autoplayArmed = false;
  private _mutedInitialized = false;
  /** <source> resource selection: the candidate being tried, and where the next search starts. */
  private _sourceElement: HTMLSourceElement | null = null;
  private _sourceNext = 0;
  private readonly _textTracks = new PupTextTrackList();
  private readonly _trackFor = new Map<HTMLTrackElement, PupTextTrack>();

  constructor() {
    super();
    new MutationObserver((records) => this.onChildrenChanged(records)).observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['kind', 'src'],
    });
    for (const type of ['timeupdate', 'seeking', 'seeked', 'emptied', 'loadeddata']) {
      this.addEventListener(type, () => this.updateCues());
    }
  }

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
    // Upgraded with children already in place: no mutation records for them.
    this.syncTextTracks();
    if (this.childSources().length && !this.src && !this._srcObject && this.networkState === NETWORK_EMPTY) this.queueLoad();
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
      source = this.urlSource(url);
      this._currentSrc = url;
    } else if (this.childSources().length) {
      // Not keyed on the src attribute: Lit reflects the empty default as src="".
      this._currentSrc = '';
      this._sourceElement = null;
      this._sourceNext = 0;
      engine.load(() => this.nextSource());
      return;
    } else {
      this._currentSrc = '';
    }
    engine.load(source);
  }

  private childSources(): HTMLSourceElement[] {
    return [...this.children].filter((c): c is HTMLSourceElement => c instanceof HTMLSourceElement);
  }

  /**
   * Engine source provider: fails the candidate being tried (if any) and
   * returns the next playable <source> after it, in document order.
   */
  private nextSource(): Source | null {
    const fireError = (el: Element) => queueMicrotask(() => el.dispatchEvent(new Event('error')));
    if (this._sourceElement) fireError(this._sourceElement);
    const sources = this.childSources();
    // Continue after the failed candidate, or at its old slot if it was removed.
    let from = this._sourceElement && sources.includes(this._sourceElement) ? sources.indexOf(this._sourceElement) + 1 : this._sourceNext;
    this._sourceElement = null;
    const candidates = sources.map((s) => ({ src: s.getAttribute('src'), type: s.getAttribute('type') }));
    for (;;) {
      const { index, rejected } = selectSource(candidates, from, (type) => this.canPlayType(type));
      for (const i of rejected) fireError(sources[i]);
      if (index < 0) {
        this._sourceNext = sources.length;
        return null;
      }
      from = this._sourceNext = index + 1;
      let url: string;
      try {
        url = new URL(candidates[index].src!, document.baseURI).href;
      } catch {
        fireError(sources[index]);
        continue;
      }
      this._sourceElement = sources[index];
      this._currentSrc = url;
      return this.urlSource(url, candidates[index].type ?? undefined);
    }
  }

  private urlSource(url: string, type?: string): Source {
    return {
      kind: 'url',
      url,
      withCredentials: this.crossOrigin === 'use-credentials',
      type,
      hls: { maxHeight: this.hlsMaxHeight || undefined, maxBandwidth: this.hlsMaxBandwidth || undefined },
    };
  }

  private onChildrenChanged(records: MutationRecord[]): void {
    let sourceAdded = false;
    let tracksChanged = false;
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target.parentNode !== this || !(r.target instanceof HTMLTrackElement)) continue;
        tracksChanged = true;
        // A new src resets the track; it reloads if it is in use.
        const track = this._trackFor.get(r.target);
        if (track && r.attributeName === 'src') this.resetTrack(track, r.target);
        continue;
      }
      if (r.target !== this) continue;
      for (const node of [...r.addedNodes, ...r.removedNodes]) {
        if (node instanceof HTMLTrackElement) tracksChanged = true;
      }
      if ([...r.addedNodes].some((n) => n instanceof HTMLSourceElement)) sourceAdded = true;
    }
    if (tracksChanged) this.syncTextTracks();
    if (sourceAdded && !this.src && !this._srcObject) {
      // Like native: inserting a <source> starts loading an empty element, or
      // resumes a selection that ran out of candidates.
      if (this.networkState === NETWORK_EMPTY) this.queueLoad();
      else if (this.networkState === NETWORK_NO_SOURCE) this._engine?.resumeSourceSelection();
    }
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
  // Text tracks (WebVTT subtitles/captions from <track> children)

  get textTracks(): PupTextTrackList {
    return this._textTracks;
  }

  /** Active cues of the 'showing' tracks, for subclasses that render captions. */
  protected get showingCues(): VttCue[] {
    return [...this._textTracks].filter((t) => t.mode === 'showing').flatMap((t) => [...t.activeCues]);
  }

  /** Rebuilds textTracks from the eligible <track> children, keeping existing TextTrack objects. */
  private syncTextTracks(): void {
    const tracks: PupTextTrack[] = [];
    const elements = new Set<HTMLTrackElement>();
    let hasDefault = [...this._trackFor.values()].some((t) => t.mode !== 'disabled');
    for (const el of this.children) {
      if (!(el instanceof HTMLTrackElement)) continue;
      const kind = (el.getAttribute('kind') || 'subtitles').toLowerCase();
      if (kind !== 'subtitles' && kind !== 'captions') continue;
      let track = this._trackFor.get(el);
      if (track && track.kind !== kind) {
        track.mode = 'disabled';
        track = undefined;
      }
      if (!track) {
        track = new PupTextTrack(kind as PupTextTrackKind, el, (t) => this.onTrackModeChange(t, el));
        this._trackFor.set(el, track);
        if (!hasDefault && el.hasAttribute('default')) {
          hasDefault = true;
          track.mode = 'showing';
        }
      }
      elements.add(el);
      tracks.push(track);
    }
    for (const [el, track] of this._trackFor) {
      if (elements.has(el) && tracks.includes(track)) continue;
      this._trackFor.delete(el);
      track._readyState = 0;
    }
    this._textTracks._set(tracks);
    this.updateCues();
  }

  private onTrackModeChange(track: PupTextTrack, el: HTMLTrackElement): void {
    queueMicrotask(() => this._textTracks.dispatchEvent(new Event('change')));
    if (track.mode !== 'disabled' && track._readyState === 0) void this.loadTrack(track, el);
    this.updateCues();
    this.requestUpdate();
  }

  private resetTrack(track: PupTextTrack, el: HTMLTrackElement): void {
    track._readyState = 0;
    track.cues._set([]);
    if (track.mode !== 'disabled') void this.loadTrack(track, el);
    this.updateCues();
  }

  private async loadTrack(track: PupTextTrack, el: HTMLTrackElement): Promise<void> {
    track._readyState = 1;
    const src = el.getAttribute('src');
    let cues: VttCue[] | null = null;
    try {
      if (!src) throw new Error('<track> has no src');
      const credentials = this.crossOrigin === 'use-credentials' ? 'include' : 'same-origin';
      const res = await fetch(new URL(src, document.baseURI), { credentials });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cues = parseWebVTT(await res.text());
    } catch (e) {
      console.warn(`[pup] text track ${src} failed:`, e);
    }
    // Reset (src changed or removed) while fetching.
    if (track._readyState !== 1 || el.getAttribute('src') !== src) return;
    track._readyState = cues ? 2 : 3;
    if (cues) track.cues._set(cues);
    el.dispatchEvent(new Event(cues ? 'load' : 'error'));
    this.updateCues();
  }

  /** Recomputes activeCues of every track, firing cuechange where the set changed. */
  private updateCues(): void {
    const time = this.currentTime;
    let changed = false;
    for (const [el, track] of this._trackFor) {
      const active = track.mode === 'disabled' ? [] : activeCuesAt([...track.cues], time);
      if (sameCues(active, track.activeCues)) continue;
      track.activeCues._set(active);
      changed = true;
      track.dispatchEvent(new Event('cuechange'));
      el.dispatchEvent(new Event('cuechange'));
    }
    if (changed) this.requestUpdate();
  }

  // -------------------------------------------------------------------------
  // Extras

  /** Pipeline diagnostics (decoder in use, threading, fps, dropped frames, HLS session). */
  getStats(): EngineStats & { format: string | null } {
    const stats = this._engine?.stats ?? {
      threading: null,
      videoDecoder: 'none',
      decodeFps: 0,
      droppedFrames: 0,
      presentedFrames: 0,
      bytesLoaded: 0,
      bytesTotal: -1,
      hls: null,
    };
    return { ...stats, format: this._engine?.info?.format ?? null };
  }

  /** Releases workers and the audio context. The element can load again afterwards. */
  destroy(): void {
    this._engine?.destroy();
    this._engine = null;
  }
}
