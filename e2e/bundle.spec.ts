import { expect, test, type Page } from '@playwright/test';

// The standalone bundle (packages/pup-player-bundle/dist), loaded by a plain HTML page through one
// script tag and served without any build step. Requires `pnpm build` first.

type Video = HTMLVideoElement & { getStats(): { threading: string | null } };

async function playsFrom(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => customElements.get('pup-video'));
  await page.waitForFunction(() => (document.getElementById('video') as Video).readyState >= 3, null, {
    timeout: 20_000,
  });
  const info = await page.evaluate(() => {
    const video = document.getElementById('video') as Video;
    return { size: [video.videoWidth, video.videoHeight], threading: video.getStats().threading, isolated: crossOriginIsolated };
  });
  expect(info.size).toEqual([640, 360]);

  await page.evaluate(() => (document.getElementById('video') as Video).play());
  await page.waitForFunction(() => (document.getElementById('video') as Video).currentTime > 0.5, null, {
    timeout: 15_000,
  });
  return info;
}

test('standalone bundle: <pup-video> from a single script tag plays a legacy AVI', async ({ page }) => {
  const info = await playsFrom(page, 'http://localhost:5198/');
  expect(info.isolated).toBe(false);
  expect(info.threading).toBe('st');
});

test('standalone bundle: uses the multi-threaded core on a cross-origin isolated page', async ({ page }) => {
  const info = await playsFrom(page, 'http://localhost:5198/isolated.html');
  expect(info.isolated).toBe(true);
  expect(info.threading).toBe('mt');
});
