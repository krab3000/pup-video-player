# @krab3000/pup-wasm

Prebuilt FFmpeg demux/decode cores (Emscripten) and their TypeScript bindings, used by `@krab3000/pup-player`.

`dist/` holds four cores, `pup-core-{full,lite}-{st,mt}.{mjs,wasm}`. `loadCore()` picks one at runtime: the codec set from its options (`full` by default), and the multi-threaded build when the page is cross-origin isolated (`SharedArrayBuffer` available), otherwise the single-threaded one.

License: LGPL-2.1-or-later (FFmpeg is configured LGPL-only). The FFmpeg source is attached to each GitHub release of [pup-video-player](https://github.com/krab3000/pup-video-player).
