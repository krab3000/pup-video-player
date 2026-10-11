import { expect, test } from '@playwright/test';

// The standalone bundle (packages/pup-player-bundle/dist), loaded by a plain HTML page through one
// script tag and served without any build step. Requires `pnpm build` first.
test('standalone bundle: <pup-video> from a single script tag plays a legacy AVI', async ({ page }) => {
  await page.goto('http://localhost:5198/');
  await page.waitForFunction(() => customElements.get('pup-video'));
  await page.waitForFunction(() => (document.getElementById('video') as HTMLMediaElement).readyState >= 3, null, {
    timeout: 20_000,
  });
  const size = await page.evaluate(() => {
    const video = document.getElementById('video') as HTMLVideoElement;
    return [video.videoWidth, video.videoHeight];
  });
  expect(size).toEqual([640, 360]);

  await page.evaluate(() => (document.getElementById('video') as HTMLMediaElement).play());
  await page.waitForFunction(() => (document.getElementById('video') as HTMLMediaElement).currentTime > 0.5, null, {
    timeout: 15_000,
  });
});
