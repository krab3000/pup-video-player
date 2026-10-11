// Minimal TextTrackList / TextTrack / TextTrackCueList for subtitles and
// captions from <track> children. The owning element builds and loads them;
// these classes only hold state and dispatch events.

import type { VttCue } from './webvtt.js';

export type PupTextTrackMode = 'disabled' | 'hidden' | 'showing';
export type PupTextTrackKind = 'subtitles' | 'captions';

type Handler<T> = ((this: T, ev: Event) => unknown) | null;

/** Cues active at `time`: start <= time < end, in file order. */
export function activeCuesAt(cues: readonly VttCue[], time: number): VttCue[] {
  return cues.filter((c) => c.startTime <= time && time < c.endTime);
}

export function sameCues(a: ArrayLike<VttCue>, b: ArrayLike<VttCue>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Array-like list with numeric index access, like the native track/cue lists. */
class ArrayLikeList<T> {
  [index: number]: T;
  private items: T[] = [];

  get length(): number {
    return this.items.length;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }

  /** @internal */
  _set(items: T[]): void {
    for (let i = items.length; i < this.items.length; i++) delete this[i];
    this.items = items;
    items.forEach((item, i) => (this[i] = item));
  }
}

export class PupTextTrackCueList extends ArrayLikeList<VttCue> {
  getCueById(id: string): VttCue | null {
    for (const cue of this) if (cue.id === id) return cue;
    return null;
  }
}

export class PupTextTrack extends EventTarget {
  oncuechange: Handler<PupTextTrack> = null;
  readonly cues = new PupTextTrackCueList();
  readonly activeCues = new PupTextTrackCueList();
  /** @internal 0 none, 1 loading, 2 loaded, 3 failed (like HTMLTrackElement.readyState). */
  _readyState = 0;
  private _mode: PupTextTrackMode = 'disabled';

  /** @internal */
  constructor(
    readonly kind: PupTextTrackKind,
    private element: HTMLTrackElement,
    private onModeChange: (track: PupTextTrack) => void,
  ) {
    super();
    this.addEventListener('cuechange', (e) => this.oncuechange?.call(this, e));
  }

  get label(): string {
    return this.element.getAttribute('label') ?? '';
  }

  get language(): string {
    return this.element.getAttribute('srclang') ?? '';
  }

  get id(): string {
    return this.element.id;
  }

  get mode(): PupTextTrackMode {
    return this._mode;
  }

  set mode(mode: PupTextTrackMode) {
    if (mode !== 'disabled' && mode !== 'hidden' && mode !== 'showing') return;
    if (mode === this._mode) return;
    this._mode = mode;
    this.onModeChange(this);
  }
}

export class PupTextTrackList extends EventTarget {
  [index: number]: PupTextTrack;
  onchange: Handler<PupTextTrackList> = null;
  onaddtrack: Handler<PupTextTrackList> = null;
  onremovetrack: Handler<PupTextTrackList> = null;
  private list = new ArrayLikeList<PupTextTrack>();

  constructor() {
    super();
    this.addEventListener('change', (e) => this.onchange?.call(this, e));
    this.addEventListener('addtrack', (e) => this.onaddtrack?.call(this, e));
    this.addEventListener('removetrack', (e) => this.onremovetrack?.call(this, e));
  }

  get length(): number {
    return this.list.length;
  }

  [Symbol.iterator](): Iterator<PupTextTrack> {
    return this.list[Symbol.iterator]();
  }

  item(index: number): PupTextTrack | null {
    return this.list[index] ?? null;
  }

  getTrackById(id: string): PupTextTrack | null {
    for (const track of this.list) if (track.id === id) return track;
    return null;
  }

  /** @internal Replaces the tracks, firing addtrack/removetrack for the difference. */
  _set(tracks: PupTextTrack[]): void {
    const before = [...this.list];
    for (let i = tracks.length; i < before.length; i++) delete this[i];
    this.list._set(tracks);
    tracks.forEach((track, i) => (this[i] = track));
    const fire = (type: string, track: PupTextTrack) => this.dispatchEvent(Object.assign(new Event(type), { track }));
    for (const track of before) if (!tracks.includes(track)) fire('removetrack', track);
    for (const track of tracks) if (!before.includes(track)) fire('addtrack', track);
  }
}
