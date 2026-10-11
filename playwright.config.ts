import { defineConfig } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  // Each page runs ~10 workers plus wasm instances; keep parallelism modest.
  workers: 3,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: [
    {
      command: `pnpm --filter demo exec vite --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: true,
    },
    {
      // Serves the built standalone bundle untouched (e2e/bundle.spec.ts) and the generated HLS
      // playlists of e2e/hls.spec.ts.
      command: 'node e2e/static-server.mjs 5198',
      url: 'http://localhost:5198/',
      reuseExistingServer: true,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
      grepInvert: /@autoplay-policy/,
    },
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        launchOptions: { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false } },
      },
      grepInvert: /@autoplay-policy/,
    },
    {
      // Default browser autoplay policy: unmuted playback needs a user gesture.
      name: 'chromium-autoplay-policy',
      use: { browserName: 'chromium', launchOptions: { args: ['--autoplay-policy=user-gesture-required'] } },
      grep: /@autoplay-policy/,
    },
  ],
});
