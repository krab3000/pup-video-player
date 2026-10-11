# @krab3000/pup-player

`<pup-video>` and `<pup-audio>` as Lit web components for apps that use a bundler. For use without a bundler, see `@krab3000/pup-player-bundle`.

```ts
import '@krab3000/pup-player'; // registers <pup-video>, <pup-audio>, <pup-controls>
```

The elements implement the `HTMLMediaElement` API (`src`, `play()`, `currentTime`, media events, …). The FFmpeg cores come from `@krab3000/pup-wasm` and are loaded at runtime through `new URL(…, import.meta.url)` and module workers, which Vite handles out of the box. With Vite, exclude both packages from dependency pre-bundling and emit ES workers:

```ts
export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@krab3000/pup-player', '@krab3000/pup-wasm'] },
});
```

Installing from GitHub Packages needs `@krab3000:registry=https://npm.pkg.github.com` in `.npmrc` and a token with `read:packages`.

License: LGPL-2.1-or-later.
