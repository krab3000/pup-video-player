import { LitElement, css, html, nothing, svg, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MEDIA_EVENTS, type PupMediaElement } from './pup-media-element.js';

const HIDE_AFTER_MS = 2500;
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

const icon = (d: string) => svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${d} /></svg>`;
const ICONS = {
  play: icon('M8 5v14l11-7z'),
  pause: icon('M6 5h4v14H6zm8 0h4v14h-4z'),
  replay: icon('M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z'),
  volume: icon('M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z'),
  muted: icon('M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5V12zM19 12a7 7 0 0 1-.6 2.8l1.5 1.5A9 9 0 0 0 14 3.2v2.1A7 7 0 0 1 19 12zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3zM12 4 9.9 6.1 12 8.2z'),
  fullscreen: icon('M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z'),
  exitFullscreen: icon('M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z'),
};

function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '--:--';
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  const m = Math.floor((t / 60) % 60);
  const h = Math.floor(t / 3600);
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Built-in controls UI rendered by <pup-video controls> / <pup-audio controls>. */
@customElement('pup-controls')
export class PupControls extends LitElement {
  static styles = css`
    :host {
      display: block;
      font: 13px/1 system-ui, sans-serif;
      color: #fff;
      user-select: none;
      -webkit-user-select: none;
      outline: none;
    }
    .surface {
      position: absolute;
      inset: 0;
      cursor: pointer;
    }
    :host(:not([video])) .surface {
      display: none;
    }
    .spinner {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 40px;
      height: 40px;
      margin: -20px 0 0 -20px;
      border: 3px solid rgb(255 255 255 / 0.25);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
      pointer-events: none;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    .bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      background: linear-gradient(transparent, rgb(0 0 0 / 0.7));
      transition: opacity 0.2s;
    }
    :host(:not([video])) .bar {
      top: 0;
      background: #f1f3f4;
      color: #202124;
      border-radius: 27px;
      padding: 0 14px;
    }
    :host([idle]) .bar {
      opacity: 0;
    }
    :host([idle]) {
      cursor: none;
    }
    button,
    select {
      all: unset;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 4px;
      flex: none;
    }
    button {
      width: 30px;
      height: 30px;
    }
    button:focus-visible,
    select:focus-visible,
    input:focus-visible {
      outline: 2px solid #4c8dff;
    }
    svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }
    .time {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      flex: none;
    }
    input[type='range'] {
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      height: 16px;
      margin: 0;
      cursor: pointer;
      min-width: 0;
    }
    input[type='range']::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 2px;
      background: var(--track);
    }
    input[type='range']::-moz-range-track {
      height: 4px;
      border-radius: 2px;
      background: var(--track);
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      margin-top: -4px;
      border-radius: 50%;
      background: currentColor;
      border: none;
    }
    input[type='range']::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: currentColor;
      border: none;
    }
    .seek {
      flex: 1;
    }
    .live {
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .live::before {
      content: '';
      display: inline-block;
      width: 7px;
      height: 7px;
      margin: 0 5px 1px 0;
      border-radius: 50%;
      background: #e53935;
    }
    .volume {
      width: 64px;
    }
    select {
      padding: 0 4px;
      height: 30px;
    }
    select option {
      color: #000;
    }
  `;

  @property({ attribute: false }) media!: PupMediaElement;
  @property({ type: Boolean, reflect: true }) video = false;
  @property({ type: Boolean, reflect: true }) idle = false;
  @state() private tick = 0;
  /** Seek bar value while dragging, so time updates don't fight the thumb. */
  @state() private scrubbing: number | null = null;

  private hideTimer = 0;
  private attached: PupMediaElement | null = null;
  private onMediaEvent = () => {
    this.tick++;
    if (this.media.paused) this.showBar();
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.tabIndex = 0;
    this.addEventListener('keydown', this.onKey);
    this.addEventListener('pointermove', this.onPointer);
    this.addEventListener('fullscreenchange', this.onMediaEvent);
    document.addEventListener('fullscreenchange', this.onMediaEvent);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.detach();
    document.removeEventListener('fullscreenchange', this.onMediaEvent);
    clearTimeout(this.hideTimer);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('media')) {
      this.detach();
      this.attached = this.media;
      for (const type of MEDIA_EVENTS) this.media?.addEventListener(type, this.onMediaEvent);
    }
  }

  private detach(): void {
    for (const type of MEDIA_EVENTS) this.attached?.removeEventListener(type, this.onMediaEvent);
    this.attached = null;
  }

  private showBar = () => {
    this.idle = false;
    clearTimeout(this.hideTimer);
    if (this.video && !this.media.paused) this.hideTimer = window.setTimeout(() => (this.idle = true), HIDE_AFTER_MS);
  };

  private onPointer = () => this.showBar();

  private togglePlay = () => {
    const m = this.media;
    if (m.paused || m.ended) m.play().catch(() => {});
    else m.pause();
  };

  private toggleMute = () => {
    this.media.muted = !this.media.muted;
  };

  private toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.media.requestFullscreen?.();
  };

  private onKey = (e: KeyboardEvent) => {
    const m = this.media;
    const handled = () => {
      e.preventDefault();
      this.showBar();
    };
    switch (e.key) {
      case ' ':
      case 'k':
        this.togglePlay();
        return handled();
      case 'ArrowLeft':
        m.currentTime = Math.max(0, m.currentTime - 5);
        return handled();
      case 'ArrowRight':
        m.currentTime = Math.min(m.duration || 0, m.currentTime + 5);
        return handled();
      case 'ArrowUp':
        m.volume = Math.min(1, m.volume + 0.1);
        return handled();
      case 'ArrowDown':
        m.volume = Math.max(0, m.volume - 0.1);
        return handled();
      case 'm':
        this.toggleMute();
        return handled();
      case 'f':
        if (this.video) this.toggleFullscreen();
        return handled();
    }
  };

  private onSeekInput = (e: Event) => {
    this.scrubbing = Number((e.target as HTMLInputElement).value);
  };

  private onSeekChange = (e: Event) => {
    this.media.currentTime = Number((e.target as HTMLInputElement).value);
    this.scrubbing = null;
  };

  private onVolume = (e: Event) => {
    const v = Number((e.target as HTMLInputElement).value);
    this.media.volume = v;
    if (v > 0 && this.media.muted) this.media.muted = false;
  };

  private onRate = (e: Event) => {
    this.media.playbackRate = Number((e.target as HTMLSelectElement).value);
  };

  /**
   * The seek bar's range: [0, duration], or the seekable window while the
   * duration is unknown (growing or live HLS playlists).
   */
  private seekRange(): [number, number] | null {
    const m = this.media;
    if (Number.isFinite(m.duration)) return [0, m.duration];
    const s = m.seekable;
    return s.length && s.end(s.length - 1) > s.start(0) ? [s.start(0), s.end(s.length - 1)] : null;
  }

  /** Track gradient: played, buffered, rest. */
  private seekTrack(time: number, [min, max]: [number, number]): string {
    const m = this.media;
    const pct = (t: number) => (max > min ? ((Math.min(Math.max(t, min), max) - min) / (max - min)) * 100 : 0);
    const fg = this.video ? '#fff' : '#202124';
    const buf = this.video ? 'rgb(255 255 255 / 0.5)' : 'rgb(32 33 36 / 0.4)';
    const rest = this.video ? 'rgb(255 255 255 / 0.25)' : 'rgb(32 33 36 / 0.15)';
    const b = m.buffered;
    let bufferedEnd = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= time + 0.5) bufferedEnd = Math.max(bufferedEnd, b.end(i));
    const p = pct(time);
    const q = Math.max(p, pct(bufferedEnd));
    return `linear-gradient(to right, ${fg} ${p}%, ${buf} ${p}% ${q}%, ${rest} ${q}%)`;
  }

  render() {
    const m = this.media;
    if (!m) return nothing;
    void this.tick;
    const range = this.seekRange();
    const live = m.getStats().hls?.kind === 'live';
    const time = this.scrubbing ?? m.currentTime;
    const playing = !m.paused && !m.ended;
    const loading = playing && (m.readyState < m.HAVE_FUTURE_DATA || m.seeking);
    const fullscreen = document.fullscreenElement === m;
    const volume = m.muted ? 0 : m.volume;
    const volumeTrack = `linear-gradient(to right, currentColor ${volume * 100}%, rgb(128 128 128 / 0.4) ${volume * 100}%)`;
    return html`
      <div class="surface" @click=${this.togglePlay} @dblclick=${this.video ? this.toggleFullscreen : null}></div>
      ${loading && this.video ? html`<div class="spinner"></div>` : nothing}
      <div class="bar" @pointerdown=${this.showBar}>
        <button @click=${this.togglePlay} aria-label=${playing ? 'Pause' : 'Play'}>
          ${m.ended ? ICONS.replay : playing ? ICONS.pause : ICONS.play}
        </button>
        ${live
          ? html`<span class="time">${formatTime(time)}</span><span class="live">LIVE</span>`
          : html`<span class="time">${formatTime(time)} / ${formatTime(range ? range[1] : m.duration)}</span>`}
        <input
          class="seek"
          type="range"
          aria-label="Seek"
          min=${range ? range[0] : 0}
          max=${range ? range[1] : 0}
          step="any"
          .value=${String(time)}
          ?disabled=${!range}
          style="--track: ${this.seekTrack(time, range ?? [0, 0])}"
          @input=${this.onSeekInput}
          @change=${this.onSeekChange}
        />
        <button @click=${this.toggleMute} aria-label=${m.muted ? 'Unmute' : 'Mute'}>
          ${m.muted || m.volume === 0 ? ICONS.muted : ICONS.volume}
        </button>
        <input
          class="volume"
          type="range"
          aria-label="Volume"
          min="0"
          max="1"
          step="0.01"
          .value=${String(volume)}
          style="--track: ${volumeTrack}"
          @input=${this.onVolume}
        />
        ${this.video
          ? html`
              <select aria-label="Playback speed" @change=${this.onRate}>
                ${RATES.map((r) => html`<option value=${r} ?selected=${r === m.playbackRate}>${r}×</option>`)}
              </select>
              <button @click=${this.toggleFullscreen} aria-label=${fullscreen ? 'Exit full screen' : 'Full screen'}>
                ${fullscreen ? ICONS.exitFullscreen : ICONS.fullscreen}
              </button>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pup-controls': PupControls;
  }
}
