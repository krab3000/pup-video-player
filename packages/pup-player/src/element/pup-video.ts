import { css, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { CanvasRenderer, type Renderer } from '../engine/renderer';
import './pup-controls';
import { PupMediaElement } from './pup-media-element';

/**
 * <pup-video>: drop-in replacement for <video> backed by FFmpeg (wasm) and
 * WebCodecs. Style the picture with `pup-video::part(video) { object-fit: cover }`.
 */
@customElement('pup-video')
export class PupVideoElement extends PupMediaElement {
  static styles = css`
    :host {
      display: inline-block;
      position: relative;
      overflow: hidden;
      background: #000;
      box-sizing: border-box;
      width: var(--pup-width, 300px);
      height: var(--pup-height, auto);
      aspect-ratio: var(--pup-aspect, 300 / 150);
      vertical-align: baseline;
    }
    :host([hidden]) {
      display: none;
    }
    :host(:fullscreen) {
      width: 100%;
      height: 100%;
      aspect-ratio: auto;
    }
    canvas,
    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
    img {
      background: #000;
    }
    pup-controls {
      position: absolute;
      inset: 0;
    }
  `;

  @property() poster = '';
  @property({ type: Number, reflect: true }) width?: number;
  @property({ type: Number, reflect: true }) height?: number;
  @property({ type: Boolean, attribute: 'playsinline', reflect: true }) playsInline = false;

  /** Poster stays up until playback starts or the user seeks. */
  @state() private posterVisible = true;
  @query('canvas') private canvas!: HTMLCanvasElement | null;
  private _renderer: CanvasRenderer | null = null;

  constructor() {
    super();
    const sync = () => this.syncIntrinsicSize();
    this.addEventListener('resize', sync);
    this.addEventListener('emptied', sync);
    this.addEventListener('loadstart', () => (this.posterVisible = true));
    this.addEventListener('playing', () => (this.posterVisible = false));
    this.addEventListener('seeked', () => (this.posterVisible = false));
  }

  get videoWidth(): number {
    return this.readyState >= this.HAVE_METADATA ? this.engine.videoWidth : 0;
  }

  get videoHeight(): number {
    return this.readyState >= this.HAVE_METADATA ? this.engine.videoHeight : 0;
  }

  protected get renderer(): Renderer | null {
    if (!this._renderer && this.canvas) this._renderer = new CanvasRenderer(this.canvas);
    return this._renderer;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has('width') || changed.has('height')) this.syncIntrinsicSize();
  }

  /** Sizes the host like <video>: attributes, then the video's size, then 300x150. */
  private syncIntrinsicSize(): void {
    const vw = this.videoWidth;
    const vh = this.videoHeight;
    const set = (name: string, value: string | null) =>
      value === null ? this.style.removeProperty(name) : this.style.setProperty(name, value);
    const w = this.width ?? (this.height && vw && vh ? (this.height * vw) / vh : vw || null);
    set('--pup-width', w ? `${w}px` : null);
    set('--pup-height', this.height ? `${this.height}px` : null);
    set('--pup-aspect', this.width && this.height ? 'auto' : vw && vh ? `${vw} / ${vh}` : null);
  }

  render() {
    const showPoster = this.poster && this.posterVisible;
    return html`
      <canvas part="video"></canvas>
      ${showPoster ? html`<img part="poster" src=${this.poster} alt="" />` : nothing}
      ${this.controls ? html`<pup-controls part="controls" .media=${this} video></pup-controls>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pup-video': PupVideoElement;
  }
}
