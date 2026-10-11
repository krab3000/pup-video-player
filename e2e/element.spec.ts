import { expect, test } from '@playwright/test';
import { mount, mounted, waitFor } from './helpers';

const LOAD_EVENTS = ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough'];

test('load and playback events follow the native <video> order', async ({ page }) => {
  const order = async (tag: string) => {
    await mount(page, tag, { src: '/media/h264-aac.mp4', preload: 'auto', muted: true });
    await waitFor(page, 'el.readyState === 4');
    await page.evaluate(() => el.play());
    await waitFor(page, 'window.events.includes("playing")');
    await page.evaluate(() => (el.currentTime = 4));
    await waitFor(page, 'window.events.includes("seeked")');
    await page.evaluate(() => el.pause());
    // Normalize: native may repeat canplay/canplaythrough/resize after seeks.
    const seen = new Set<string>();
    return (await page.evaluate(() => window.events)).filter((e) => !['resize', 'waiting'].includes(e) && !seen.has(e) && seen.add(e));
  };
  const native = await order('video');
  const pup = await order('pup-video');
  expect(pup.filter((e) => LOAD_EVENTS.includes(e))).toEqual(native.filter((e) => LOAD_EVENTS.includes(e)));
  expect(pup).toEqual(native);
});

test('loop restarts instead of ending', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/audio.mp3', loop: true });
  await waitFor(page, 'el.readyState >= 3');
  await page.evaluate(() => {
    el.currentTime = 9.5;
    return el.play();
  });
  await waitFor(page, 'el.currentTime > 0.2 && el.currentTime < 3 && !el.paused');
  const events = await page.evaluate(() => window.events);
  expect(events).not.toContain('ended');
  expect(await page.evaluate(() => el.ended)).toBe(false);
});

test('playbackRate changes take effect immediately during playback', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/h264-aac.mp4' });
  await waitFor(page, 'el.readyState >= 3');
  await page.evaluate(() => el.play());
  await page.waitForTimeout(500);
  const [t0, t1] = await page.evaluate(async () => {
    el.playbackRate = 2;
    const start = el.currentTime;
    await new Promise((r) => setTimeout(r, 1500));
    return [start, el.currentTime];
  });
  expect(t1 - t0).toBeGreaterThan(2.6);
  expect(t1 - t0).toBeLessThan(3.4);
  expect(await page.evaluate(() => window.events)).toContain('ratechange');
});

test('srcObject accepts a Blob/File', async ({ page }) => {
  await mount(page, 'pup-video', {});
  await page.evaluate(async () => {
    const blob = await (await fetch('/media/vp9-opus.webm')).blob();
    (el as any).srcObject = new File([blob], 'clip.webm');
  });
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => [el.duration > 9.9, (el as any).videoWidth])).toEqual([true, 640]);
  expect(await page.evaluate(() => el.currentSrc)).toBe('');
});

test('reads large URLs with Range requests instead of downloading them', async ({ page, browserName }) => {
  const ranges: string[] = [];
  page.on('request', (r) => r.url().includes('h264-1080p') && ranges.push(r.headers()['range'] ?? 'none'));
  await mount(page, 'pup-video', { src: '/media/h264-1080p-video-only.mp4', preload: 'metadata' });
  await waitFor(page, 'el.readyState >= 2');
  await page.waitForTimeout(500);
  const { bytesLoaded, bytesTotal } = await page.evaluate(() => el.getStats() as { bytesLoaded: number; bytesTotal: number });
  expect(bytesTotal).toBeGreaterThan(6.5 * 1024 * 1024); // ~6.8 MiB file
  expect(bytesLoaded).toBeGreaterThan(0);
  expect(bytesLoaded).toBeLessThan(bytesTotal * 0.75);
  // Firefox doesn't surface worker sync XHRs to Playwright.
  if (browserName === 'chromium') {
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((r) => r.startsWith('bytes='))).toBe(true);
  }
});

test('missing source reports MEDIA_ERR_SRC_NOT_SUPPORTED and rejects play()', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/does-not-exist.mp4' });
  await waitFor(page, 'el.error !== null');
  expect(await page.evaluate(() => [el.error!.code, el.networkState])).toEqual([4, 3]);
  expect(await page.evaluate(() => el.play().then(() => 'ok', (e) => e.name))).toBe('NotSupportedError');
  expect(await page.evaluate(() => window.events)).toContain('error');
});

test('garbage data reports MEDIA_ERR_SRC_NOT_SUPPORTED', async ({ page }) => {
  await mount(page, 'pup-video', {});
  await page.evaluate(() => ((el as any).srcObject = new Blob([new Uint8Array(4096).fill(7)])));
  await waitFor(page, 'el.error !== null');
  expect(await page.evaluate(() => el.error!.code)).toBe(4);
});

test('volume, muted and validation mirror HTMLMediaElement', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/audio.flac', muted: true });
  expect(await page.evaluate(() => [el.muted, el.defaultMuted, el.volume])).toEqual([true, true, 1]);
  await page.evaluate(() => {
    el.muted = false;
    el.volume = 0.5;
  });
  expect(await page.evaluate(() => [el.muted, el.volume, window.events.filter((e) => e === 'volumechange').length])).toEqual([false, 0.5, 2]);
  expect(await page.evaluate(() => { try { el.volume = 2; return 'no error'; } catch (e) { return (e as DOMException).name; } })).toBe('IndexSizeError');
  expect(await page.evaluate(() => { try { el.playbackRate = -1; return 'no error'; } catch (e) { return (e as DOMException).name; } })).toBe('NotSupportedError');
});

test('canPlayType answers for wasm-supported formats', async ({ page }) => {
  await mount(page, 'pup-video', {});
  const answers = await page.evaluate(() =>
    ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/x-matroska', 'video/mp2t; codecs="avc1.64001E, mp4a.40.2"', 'audio/flac', 'video/x-unknown', 'video/mp4; codecs="bogus"'].map((t) => el.canPlayType(t)),
  );
  expect(answers).toEqual(['probably', 'maybe', 'probably', 'maybe', '', '']);
});

test('constants and TimeRanges behave like the native ones', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/h264-aac.mp4' });
  await waitFor(page, 'el.readyState >= 3');
  const r = await page.evaluate(() => ({
    have: [el.HAVE_NOTHING, el.HAVE_METADATA, el.HAVE_CURRENT_DATA, el.HAVE_FUTURE_DATA, el.HAVE_ENOUGH_DATA],
    net: [el.NETWORK_EMPTY, el.NETWORK_IDLE, el.NETWORK_LOADING, el.NETWORK_NO_SOURCE],
    seekable: [el.seekable.length, el.seekable.start(0), el.seekable.end(0)],
    buffered: el.buffered.length > 0 && el.buffered.start(0) === 0,
    outOfRange: (() => { try { el.buffered.start(9); return 'no error'; } catch (e) { return (e as DOMException).name; } })(),
  }));
  expect(r.have).toEqual([0, 1, 2, 3, 4]);
  expect(r.net).toEqual([0, 1, 2, 3]);
  expect(r.seekable).toEqual([1, 0, 10]);
  expect(r.buffered).toBe(true);
  expect(r.outOfRange).toBe('IndexSizeError');
});

test('paused seek shows the target frame and fires seeking/seeked', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/h264-aac.mp4' });
  await waitFor(page, 'el.readyState >= 3');
  await page.evaluate(() => (el.currentTime = 6.5));
  await waitFor(page, 'window.events.includes("seeked")');
  expect(await page.evaluate(() => [el.currentTime, el.paused, el.readyState >= 2])).toEqual([6.5, true, true]);
  const ev = await page.evaluate(() => window.events);
  expect(ev.indexOf('seeking')).toBeLessThan(ev.indexOf('seeked'));
});

test('controls render and toggle playback', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/h264-aac.mp4', controls: true });
  await waitFor(page, 'el.readyState >= 3');
  const play = mounted(page).locator('pup-controls button[aria-label="Play"]');
  await play.click();
  await waitFor(page, '!el.paused && window.events.includes("playing")');
  await mounted(page).locator('pup-controls button[aria-label="Pause"]').click({ force: true });
  await waitFor(page, 'el.paused');
});

// These navigate straight to a page that autoplays: any page.evaluate before
// that would count as a user gesture and unlock playback.
const settle = (page: import('@playwright/test').Page) => page.waitForTimeout(2500);

test('unmuted autoplay is allowed exactly when Web Audio may start @autoplay-policy', async ({ page }) => {
  // Audio goes through an AudioContext, so <pup-video> follows the Web Audio
  // autoplay policy (in real browsers it matches the media element policy;
  // headless Chromium can differ). Probe it before any user gesture.
  await page.addInitScript(() => {
    (window as any).__ctxState = new AudioContext().state;
  });
  await page.goto('/?src=/media/h264-aac.mp4&autoplay');
  await settle(page);
  const [pupPaused, ctxState] = await page.evaluate(() => [(window as any).pup.paused, (window as any).__ctxState]);
  expect(pupPaused).toBe(ctxState !== 'running');
});

test('muted autoplay plays like native <video> @autoplay-policy', async ({ page }) => {
  await page.goto('/?src=/media/h264-aac.mp4&autoplay&muted');
  await settle(page);
  const r = await page.evaluate(() => [(window as any).pup.paused, (window as any).ref.paused, (window as any).pup.currentTime]);
  expect(r[1]).toBe(false);
  expect(r[0]).toBe(false);
  expect(r[2]).toBeGreaterThan(1);
});

test('user gesture unlocks unmuted playback @autoplay-policy', async ({ page }) => {
  await page.goto('/?src=/media/h264-aac.mp4');
  await page.waitForFunction(() => (window as any).pup.readyState >= 3);
  await page.locator('#pup').locator('pup-controls button[aria-label="Play"]').click();
  await page.waitForFunction(() => !(window as any).pup.paused && (window as any).pup.currentTime > 0.5);
  expect(await page.evaluate(() => (window as any).pup.muted)).toBe(false);
});
