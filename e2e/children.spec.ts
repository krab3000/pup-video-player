import { expect, test } from '@playwright/test';
import { mount, mounted, waitFor } from './helpers';

test('<source> children: a failing candidate falls through to the next', async ({ page }) => {
  await mount(page, 'pup-video', {}, '', '<source src="/media/missing.mp4"><source src="/media/h264-aac.mp4" type="video/mp4">');
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => [el.error, el.currentSrc.endsWith('/media/h264-aac.mp4'), el.duration > 9.9])).toEqual([null, true, true]);
  const events = await page.evaluate(() => window.events);
  expect(events).toContain('source0:error');
  expect(events).not.toContain('source1:error');
  expect(events).not.toContain('error');
  expect(events.filter((e) => e === 'loadstart')).toHaveLength(1);
});

test('<source> children: no candidate left means NETWORK_NO_SOURCE without an error', async ({ page }) => {
  await mount(page, 'pup-video', {}, '', '<source src="/media/missing.mp4"><source src="/media/also-missing.webm">');
  await waitFor(page, 'window.events.includes("source1:error")');
  await waitFor(page, 'el.networkState === 3');
  expect(await page.evaluate(() => [el.error, el.readyState])).toEqual([null, 0]);
  const events = await page.evaluate(() => window.events);
  expect(events).toEqual(['loadstart', 'source0:error', 'source1:error']);

  // A <source> inserted while waiting resumes the selection.
  await page.evaluate(() => el.append(Object.assign(document.createElement('source'), { src: '/media/vp9-opus.webm' })));
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => [el.error, el.currentSrc.endsWith('vp9-opus.webm')])).toEqual([null, true]);
});

test('<source> children: types canPlayType rejects are skipped', async ({ page }) => {
  await mount(page, 'pup-video', {}, '', '<source src="/media/h264-aac.mp4" type="video/x-unknown"><source src="/media/vp9-opus.webm" type="video/webm">');
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => el.currentSrc.endsWith('/media/vp9-opus.webm'))).toBe(true);
  expect(await page.evaluate(() => window.events)).toContain('source0:error');
});

test('<source> children: inserting one into an empty element starts loading', async ({ page }) => {
  await mount(page, 'pup-video', {});
  await page.evaluate(() => el.append(Object.assign(document.createElement('source'), { src: '/media/h264-aac.mp4' })));
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => el.currentSrc.endsWith('/media/h264-aac.mp4'))).toBe(true);
});

test('src wins over <source> children', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/vp9-opus.webm' }, '', '<source src="/media/h264-aac.mp4">');
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => el.currentSrc.endsWith('/media/vp9-opus.webm'))).toBe(true);
});

test('<track default> renders WebVTT captions for the active cue', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/h264-aac.mp4' }, '', '<track default kind="captions" src="/media/captions.vtt" srclang="en" label="English">');
  const tracks = await page.evaluate(() => {
    const t = (el as any).textTracks;
    return [t.length, t[0].mode, t[0].kind, t[0].label, t[0].language];
  });
  expect(tracks).toEqual([1, 'showing', 'captions', 'English', 'en']);
  await waitFor(page, 'window.events.includes("track0:load") && el.readyState >= 3');
  expect(await page.evaluate(() => (el as any).textTracks[0].cues.length)).toBe(3);

  await page.evaluate(() => (el.currentTime = 2));
  await waitFor(page, 'window.events.includes("seeked")');
  const captions = mounted(page).locator('[part="captions"]');
  await expect(captions).toContainText('First caption');
  await expect(captions.locator('b')).toHaveText('caption');
  expect(await page.evaluate(() => (el as any).textTracks[0].activeCues[0].text)).toBe('First <b>caption</b>');

  const changed = page.evaluate(() => new Promise<boolean>((r) => (el as any).textTracks.addEventListener('change', () => r(true))));
  await page.evaluate(() => ((el as any).textTracks[0].mode = 'disabled'));
  expect(await changed).toBe(true);
  await expect(captions).toHaveCount(0);
});

test('<track> without default stays disabled until enabled; cuechange fires', async ({ page }) => {
  await mount(page, 'pup-audio', { src: '/media/audio.mp3' }, '', '<track src="/media/captions.vtt"><track kind="chapters" src="/media/captions.vtt">');
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => [(el as any).textTracks.length, (el as any).textTracks[0].mode, (el as any).textTracks[0].kind])).toEqual([1, 'disabled', 'subtitles']);
  expect(await page.evaluate(() => window.events)).not.toContain('track0:load');
  await page.evaluate(() => {
    const track = (el as any).textTracks[0];
    (window as any).cuechanges = 0;
    track.oncuechange = () => (window as any).cuechanges++;
    track.mode = 'hidden';
  });
  await waitFor(page, 'window.events.includes("track0:load")');
  await page.evaluate(() => (el.currentTime = 4.5));
  await waitFor(page, 'window.cuechanges > 0');
  expect(await page.evaluate(() => (el as any).textTracks[0].activeCues[0].text)).toBe('Second &amp; top');
});
