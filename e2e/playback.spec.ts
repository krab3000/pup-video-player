import { expect, test } from '@playwright/test';
import { mount, waitFor } from './helpers';

const FIXTURES: Array<{
  file: string;
  video?: 'webcodecs' | 'software';
  size?: [number, number];
}> = [
  { file: 'h264-aac.mp4', video: 'webcodecs', size: [640, 360] },
  { file: 'vp9-opus.webm', video: 'webcodecs', size: [640, 360] },
  { file: 'vp8-opus.webm', video: 'webcodecs', size: [640, 360] },
  { file: 'av1-opus.mp4', video: 'webcodecs', size: [640, 360] },
  { file: 'hevc-ac3.mkv', size: [640, 360] }, // WebCodecs HEVC support varies by platform
  { file: 'h264-aac.ts', video: 'webcodecs', size: [640, 360] },
  { file: 'mpeg2-mp2.ts', video: 'software', size: [640, 360] },
  { file: 'mpeg4-mp3.avi', video: 'software', size: [640, 360] },
  { file: 'audio.flac' },
  { file: 'audio.mp3' },
  { file: 'audio.wav' },
  { file: 'audio-opus.ogg' },
];

// A cross-section of test-media/generate-legacy.sh (all of them are decoded in
// the Node smoke tests; these also exercise the browser pipeline).
for (const file of [
  'wmv2-wmav2.wmv', 'msmpeg4v3-mp3.avi', 'xvid-ac3.avi', 'flv1-adpcm_swf.flv', 'flashsv-nellymoser.flv',
  'rv20-ac3.rm', 'h263-aac.3gp', 'dvvideo-pcm.dv', 'mpeg2-pcm.mxf', 'svq1-pcm.mov', 'ffv1-flac.nut',
  'wmav2.wma', 'wavpack.wv', 'rv10-real144.rm', 'dts.dts',
]) {
  FIXTURES.push({
    file: `legacy/${file}`,
    video: /\.(wma|wv|dts)$/.test(file) ? undefined : 'software',
  });
}

for (const fx of FIXTURES) {
  test(`${fx.file}: loads, plays, seeks and ends`, async ({ page }) => {
    await mount(page, 'pup-video', { src: `/media/${fx.file}` });
    await waitFor(page, 'el.readyState >= 3');
    const meta = await page.evaluate(() => ({ d: el.duration, w: (el as any).videoWidth, h: (el as any).videoHeight }));
    expect(meta.d).toBeGreaterThan(9.9);
    expect(meta.d).toBeLessThan(10.2);
    if (fx.size) expect([meta.w, meta.h]).toEqual(fx.size);
    const stats = await page.evaluate(() => el.getStats());
    if (fx.video) expect(stats.videoDecoder).toBe(fx.video);

    await page.evaluate(() => el.play());
    await page.waitForTimeout(1000);
    const t = await page.evaluate(() => el.currentTime);
    expect(t).toBeGreaterThan(0.6);
    expect(t).toBeLessThan(1.4);

    await page.evaluate(() => (el.currentTime = 5));
    await waitFor(page, 'window.events.includes("seeked")');
    const afterSeek = await page.evaluate(() => el.currentTime);
    expect(afterSeek).toBeGreaterThanOrEqual(5);
    expect(afterSeek).toBeLessThan(5.6);

    await page.evaluate(() => (el.currentTime = 9));
    await waitFor(page, 'el.ended', 10_000);
    expect(await page.evaluate(() => el.paused)).toBe(true);
    expect(await page.evaluate(() => el.currentTime)).toBeGreaterThan(9.9);
    const ev = await page.evaluate(() => window.events);
    expect(ev.slice(-2)).toEqual(['pause', 'ended']);
    expect(ev).not.toContain('error');
  });
}

test('renders video pixels after loadeddata', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/h264-aac.mp4' });
  await waitFor(page, 'el.readyState >= 2');
  await page.waitForTimeout(100);
  const pixels = await page.evaluate(() => {
    const canvas = el.shadowRoot!.querySelector('canvas')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4 * 97) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
    return { w: canvas.width, h: canvas.height, lit };
  });
  expect([pixels.w, pixels.h]).toEqual([640, 360]);
  expect(pixels.lit).toBeGreaterThan(100);
});

test('software fallback renders when WebCodecs is bypassed', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/h264-aac.mp4', 'force-software': true });
  await waitFor(page, 'el.readyState >= 3');
  expect((await page.evaluate(() => el.getStats())).videoDecoder).toBe('software');
  await page.evaluate(() => el.play());
  await page.waitForTimeout(800);
  expect((await page.evaluate(() => el.getStats())).presentedFrames).toBeGreaterThan(15);
});

test('single-threaded build works without cross-origin isolation', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/hevc-ac3.mkv' }, 'noIsolation');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await waitFor(page, 'el.readyState >= 3');
  expect((await page.evaluate(() => el.getStats())).threading).toBe('st');
  await page.evaluate(() => el.play());
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => el.currentTime)).toBeGreaterThan(0.4);
});

test('multi-threaded build is used when cross-origin isolated', async ({ page }) => {
  await mount(page, 'pup-video', { src: '/media/mpeg2-mp2.ts' });
  await waitFor(page, 'el.readyState >= 3');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect((await page.evaluate(() => el.getStats())).threading).toBe('mt');
});
