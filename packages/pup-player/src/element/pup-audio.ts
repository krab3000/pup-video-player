import { css, html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { Renderer } from '../engine/renderer.js';
import './pup-controls.js';
import { PupMediaElement } from './pup-media-element.js';

/** <pup-audio>: drop-in replacement for <audio>. Hidden unless `controls` is set. */
@customElement('pup-audio')
export class PupAudioElement extends PupMediaElement {
  static styles = css`
    :host {
      display: none;
    }
    :host([controls]) {
      display: inline-block;
      width: 300px;
      height: 54px;
      position: relative;
      vertical-align: baseline;
    }
    pup-controls {
      position: absolute;
      inset: 0;
    }
  `;

  protected get renderer(): Renderer | null {
    return null;
  }

  render() {
    return this.controls ? html`<pup-controls part="controls" .media=${this}></pup-controls>` : nothing;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pup-audio': PupAudioElement;
  }
}
