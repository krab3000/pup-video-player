import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { CanvasRenderer, type Renderer } from '../engine/renderer.js';
import './pup-controls.js';
import { PupMediaElement } from './pup-media-element.js';
import { parseCueText, type CueNode, type VttCue } from './webvtt.js';

const renderCueNodes = (nodes: CueNode[]): Array<string | TemplateResult> =>
  nodes.map((n) => {
    if (typeof n === 'string') return n;
    const inner = renderCueNodes(n.children);
    return n.tag === 'b' ? html`<b>${inner}</b>` : n.tag === 'i' ? html`<i>${inner}</i>` : html`<u>${inner}</u>`;
  });

/** Rough placement: positive lines and percentages under 50% go to the top. */
const cueAtTop = (cue: VttCue) =>
  typeof cue.line === 'number' ? cue.line >= 0 : cue.line !== undefined && parseFloat(cue.line) < 50;

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
    /* Captions cover the letterboxed picture: --pup-ar is its aspect ratio. */
    .captions-frame {
      position: absolute;
      inset: 0;
      container-type: size;
      pointer-events: none;
    }
    [part='captions'] {
      --pup-picture-h: min(100cqh, 100cqw / var(--pup-ar));
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(100cqw, 100cqh * var(--pup-ar));
      height: var(--pup-picture-h);
      box-sizing: border-box;
      padding: calc(var(--pup-picture-h) * 0.04) 4%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      font: calc(var(--pup-picture-h) * 0.05) / 1.25 system-ui, sans-serif;
      color: #fff;
    }
    [part='captions'].fill {
      --pup-picture-h: 100cqh;
      width: 100cqw;
    }
    .cue {
      text-align: center;
      white-space: pre-line;
    }
    .cue span {
      background: rgba(0, 0, 0, 0.75);
      padding: 0.05em 0.3em;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .cue.start,
    .cue.left {
      text-align: left;
    }
    .cue.end,
    .cue.right {
      text-align: right;
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
    // The captions box follows the picture's aspect ratio.
    this.addEventListener('resize', () => this.requestUpdate());
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

  private renderCaptions() {
    const cues = this.showingCues;
    if (!cues.length) return nothing;
    const vw = this.videoWidth;
    const vh = this.videoHeight;
    const cue = (c: VttCue) => html`<div class="cue ${c.align ?? ''}"><span>${renderCueNodes(parseCueText(c.text))}</span></div>`;
    return html`
      <div class="captions-frame">
        <div part="captions" class=${vw && vh ? '' : 'fill'} style=${styleMap(vw && vh ? { '--pup-ar': String(vw / vh) } : {})}>
          <div>${cues.filter(cueAtTop).map(cue)}</div>
          <div>${cues.filter((c) => !cueAtTop(c)).map(cue)}</div>
        </div>
      </div>
    `;
  }

  render() {
    const showPoster = this.poster && this.posterVisible;
    return html`
      <canvas part="video"></canvas>
      ${showPoster ? html`<img part="poster" src=${this.poster} alt="" />` : nothing}
      ${this.renderCaptions()}
      ${this.controls ? html`<pup-controls part="controls" .media=${this} video></pup-controls>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pup-video': PupVideoElement;
  }
}
