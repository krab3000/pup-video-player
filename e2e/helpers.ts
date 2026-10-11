import type { Page } from '@playwright/test';

type TestElement = HTMLMediaElement & { getStats(): Record<string, unknown> };

declare global {
  // Set by mount(); referenced as bare globals inside page.evaluate callbacks.
  var el: TestElement;
  var events: string[];
}

export const LOGGED_EVENTS = [
  'loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing',
  'waiting', 'seeking', 'seeked', 'pause', 'ended', 'ratechange', 'volumechange', 'emptied', 'abort', 'error', 'resize',
];

/** The element mounted by `mount` (prepended, so it is first in the body). */
export const mounted = (page: Page) => page.locator('body > :first-child');

/**
 * Opens the demo page with nothing loaded and mounts a fresh element as
 * window.el, recording media events into window.events. `children` (HTML) is
 * added before the element is inserted; their load/error events are recorded
 * as e.g. "source0:error".
 */
export async function mount(page: Page, tag: string, attrs: Record<string, string | true> = {}, query = '', children = '') {
  await page.goto(`/?empty${query ? '&' + query : ''}`);
  await page.waitForFunction(() => customElements.get('pup-video'));
  await page.evaluate(
    ({ tag, attrs, events, children }) => {
      const el = document.createElement(tag) as TestElement;
      window.events = [];
      for (const type of events) el.addEventListener(type, () => window.events.push(type));
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v === true ? '' : v);
      const template = document.createElement('template');
      template.innerHTML = children;
      const counts: Record<string, number> = {};
      for (const child of [...template.content.children]) {
        const name = `${child.localName}${(counts[child.localName] = (counts[child.localName] ?? -1) + 1)}`;
        for (const type of ['load', 'error']) child.addEventListener(type, () => window.events.push(`${name}:${type}`));
      }
      el.append(template.content);
      document.body.prepend(el);
      window.el = el;
    },
    { tag, attrs, events: LOGGED_EVENTS, children },
  );
}

export const waitFor = (page: Page, fn: string, timeout = 15_000) =>
  page.waitForFunction(fn, null, { timeout, polling: 50 });
