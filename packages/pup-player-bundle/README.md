# @krab3000/pup-player-bundle

Standalone `<pup-video>` and `<pup-audio>` elements: media elements with the `<video>` / `<audio>` API that decode almost any container and codec in the browser (FFmpeg compiled to WebAssembly, plus WebCodecs). lit, the workers and the FFmpeg cores are all included. No bundler or other JavaScript is needed.

## Use

Serve the package's `dist/` folder (keep `pup-player.js` and `assets/` together) and reference it from HTML:

```html
<script type="module" src="/pup/pup-player.js"></script>

<pup-video src="movie.avi" controls style="width: 640px; height: 360px"></pup-video>
```

The workers and wasm load relative to `pup-player.js`, so the folder can live under any path or on a CDN you control.

## Variants

The bundle contains four FFmpeg cores and the browser downloads only one:

- **Codec set**: `full` (default, ~3.6 MB gzipped: AVI, WMV, FLV, MKV, TS, RealMedia, AC-3, DTS, …) or `lite` (~0.9 MB gzipped: MP4/MKV/WebM/Ogg with common codecs). Choose it per element: `<pup-video codec-set="lite">`.
- **Threading**: the multi-threaded core is picked automatically when the page is cross-origin isolated, otherwise the single-threaded one is used. To enable it:
  - serve the page with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`;
  - serve the bundle's files (at least `assets/*.js`) with `Cross-Origin-Embedder-Policy: require-corp` too. An isolated page refuses to start workers whose script lacks it, and playback then fails with "worker failed";
  - media and other resources from a different origin need CORS or `Cross-Origin-Resource-Policy` headers.

## License

LGPL-2.1-or-later. The FFmpeg source the cores were built from is attached to each GitHub release of [pup-video-player](https://github.com/krab3000/pup-video-player).
