# pup-video-player

`<pup-video>` and `<pup-audio>` are Lit web components that work like `<video>` and `<audio>`. Instead of the browser's media stack, they use:

- **FFmpeg compiled to WebAssembly** (our own Emscripten build plus a small C wrapper, without libav.js) to demux the container and decode audio, and to decode video the browser can't.
- **WebCodecs `VideoDecoder`** to decode video whenever the browser supports the codec.

This lets them play MKV, MPEG-TS, AVI, HEVC/AC-3, MPEG-2, FLAC and other formats with the same API and events as a native media element.

```html
<!-- Standalone bundle (@krab3000/pup-player-bundle): no bundler, no other JS -->
<script type="module" src="/pup/pup-player.js"></script>

<pup-video src="movie.mkv" controls poster="poster.jpg"></pup-video>
<pup-audio src="track.flac" controls></pup-audio>
```

```js
const v = document.querySelector('pup-video');
v.addEventListener('loadedmetadata', () => console.log(v.duration, v.videoWidth, v.videoHeight));
await v.play();
v.currentTime = 42;
v.playbackRate = 1.5;
v.srcObject = fileFromInput; // Blob / File
```

## Packages

| Path | What |
| --- | --- |
| [packages/pup-wasm](packages/pup-wasm) | FFmpeg Docker build, the flat C API (`pup_*`), TS bindings, and synchronous Range/Blob readers |
| [packages/pup-player](packages/pup-player) | The engine (workers, clock, A/V sync) and the Lit elements |
| [packages/pup-player-bundle](packages/pup-player-bundle) | Standalone build of the elements (lit, workers and wasm included) for use from plain HTML |
| [apps/demo](apps/demo) | Vite demo that plays fixtures, URLs or files side by side with a native `<video>` |
| [e2e](e2e) | Playwright tests (Chromium and Firefox) |
| [test-media](test-media) | `generate.sh` creates the 10 s test fixtures with the ffmpeg CLI |

## Architecture

```
main thread               demux worker (wasm st)        decode worker (wasm st|mt)        AudioWorklet
<pup-video> ──ctrl──────▶ open (sync XHR Range /  ─pkts─▶ VideoDecoder or FFmpeg ─VideoFrame─▶ main: rAF draws the
 PupEngine ◀─metadata──── FileReaderSync, 1 MiB          FFmpeg audio + atempo ──PCM─────────▶ pup-audio-sink
 MediaClock ◀───────────────────────────────────── media time it has rendered ◀────────────────┘
```

- **Demux worker.** FFmpeg's I/O callbacks are synchronous, so it reads with synchronous XHR (HTTP `Range`) or `FileReaderSync` through a 1 MiB block cache with read-ahead. Large files are never downloaded in full.
- **Decode worker.** It pulls packets from the demux worker while its queues are below target: about 6 video frames ahead and 0.5 s of audio. Video goes to WebCodecs when `isConfigSupported` says yes. Otherwise FFmpeg decodes it to I420 and the result is wrapped in a `VideoFrame`, so both paths share one renderer. Audio always goes through FFmpeg, through `aformat` (stereo float at the context rate) and `atempo`, so `playbackRate` changes speed without changing pitch.
- **Clock.** With audio, the clock follows what the worklet has actually rendered, adjusted by `AudioContext.getOutputTimestamp()` so output latency is accounted for. Without audio it is a wall clock. On every animation frame the main thread shows the newest frame that is due and closes the ones it skipped.
- **Epochs.** Every load and seek bumps an epoch, and every component drops messages from older epochs. Seeks are frame-accurate: decoding restarts at the previous keyframe and frames before the target are discarded. Formats without an index, such as MPEG-TS, are handled by backing off until the first packet is a keyframe.

### WebAssembly build matrix

`pnpm build:wasm` builds all four cores into `packages/pup-wasm/dist/pup-core-<set>-<st|mt>.{mjs,wasm}` with `docker buildx` (`packages/pup-wasm/Dockerfile`: pinned emsdk 6.0.11 and FFmpeg 7.1.2). Each core is two stages: `scripts/build-ffmpeg.sh` compiles FFmpeg (slow) and `scripts/link-core.sh` links the C wrapper (seconds), so changes to `src/c` reuse the cached FFmpeg builds. Both are build-time variants; the element picks one at runtime.

- **Codec sets** are defined in `configs/*.json`:
  - `full` (default, about 8.5 MB of wasm, 3.4 MB gzipped): almost every container and codec that was ever widely used, all native LGPL FFmpeg code with zlib from Emscripten's port:
    - **Containers:** MP4/MOV/3GP, MKV/WebM, Ogg, AVI, ASF/WMV/WMA, FLV/SWF, RealMedia, MPEG-PS/TS, MXF, NUT, DV, NSV, IVF, raw elementary streams, Bink/Smacker/RoQ/FLIC and other game formats, plus MP3, AAC, AC-3/E-AC-3, DTS, TrueHD, FLAC, WAV/W64, AIFF, AU, CAF, APE, WavPack, TTA, TAK, Musepack, AMR, DSF and more.
    - **Video:** H.264, HEVC, VP3–VP9, Theora, MPEG-1/2/4, DivX 3 / MS-MPEG4 v1–3, Xvid/DivX, H.261/H.263, Sorenson Spark (FLV1), Flash Screen Video, VP6, WMV1–3/VC-1, RealVideo 1–4, Sorenson SVQ1/3, Cinepak, Indeo 2–5, MS Video 1/RLE, TSCC, ZMBV, Fraps, QuickTime RLE/Road Pizza/Graphics, MJPEG, DV, ProRes, DNxHD, HuffYUV, FFV1, Ut Video, Lagarith, MagicYUV, PNG/APNG/GIF and others.
    - **Audio:** AAC, MP1/2/3, Opus, Vorbis, FLAC, ALAC, AC-3/E-AC-3, DTS, TrueHD/MLP, WMA 1/2/Pro/Lossless/Voice, Cook/RealAudio, ATRAC 1/3/3+/9, APE, WavPack, TTA, TAK, Musepack, Shorten, Speex, AMR-NB/WB, GSM, G.723/G.729, QDesign, Nellymoser, TrueSpeech, DSD, most ADPCM variants and every PCM layout.
  - `lite` (2.2 MB): common containers and audio codecs only; video uses WebCodecs only.

  Pick a set with `<pup-video codec-set="lite">`.
- **Threading:**
  - `mt` uses pthreads, so FFmpeg decodes with frame and slice threads. It is used automatically when the page is cross-origin isolated (COOP: same-origin, COEP: require-corp).
  - `st` is the fallback for every other page, so the element still works as a drop-in replacement anywhere.
  - Measured on a 10-core Mac, software-decoding 1080p H.264: about 477 fps on mt versus about 177 fps on st.

## HTMLMediaElement API coverage

- **Attributes:** `src`, `srcObject` (Blob or File), `autoplay`, `loop`, `muted` (as `defaultMuted`), `controls`, `preload`, `crossorigin`, `poster`, `width`, `height`, `playsinline`.
- **Children:**
  - `<source>`: without `src`/`srcObject`, candidates are tried in document order. A `type` that `canPlayType()` rejects is skipped. A candidate that fails before its metadata loads (network error, HTTP error, unreadable container) gets an `error` event and the next one is tried. When none is left, `networkState` is `NETWORK_NO_SOURCE` and `error` stays null, like native. Inserting a `<source>` into an empty element starts loading. `media` and `sizes` are ignored.
  - `<track kind="subtitles|captions">`: `textTracks` lists them with `mode`, `cues`, `activeCues` and `cuechange`. The first `default` track starts `showing`. A track's WebVTT file is fetched when its mode becomes `hidden` or `showing`, and the `<track>` gets `load` or `error`. `<pup-video>` draws the active cues of `showing` tracks over the picture (`::part(captions)`). Only the `line` and `align` cue settings are used, and only `<b>`, `<i>` and `<u>` are rendered. Regions, `::cue` styles and other track kinds are ignored, and `<pup-audio>` doesn't draw captions.
- **Properties:** `currentTime`, `duration`, `paused`, `ended`, `seeking`, `readyState`, `networkState`, `buffered`, `seekable`, `played`, `error` (a MediaError with codes 1–4), `currentSrc`, `volume`, `muted`, `playbackRate`, `defaultPlaybackRate`, `videoWidth`, `videoHeight`, `textTracks`, and the `HAVE_*` and `NETWORK_*` constants.
- **Methods:** `play()` (returns a promise that rejects with `NotAllowedError` or `AbortError` like the native one), `pause()`, `load()`, `fastSeek()`, `canPlayType()`.
- **Events:** loadstart, durationchange, loadedmetadata, loadeddata, canplay, canplaythrough, play, playing, waiting, seeking, seeked, timeupdate, pause, ended, ratechange, volumechange, resize, progress, suspend, emptied, abort, error. The e2e suite checks that the order matches native `<video>`.
- **Styling:** `pup-video::part(video) { object-fit: cover }`, plus `::part(poster)`, `::part(captions)` and `::part(controls)`.
- **Extras:**
  - `getStats()` returns the decoder in use, threading, decode fps, dropped frames and bytes loaded.
  - `destroy()` frees the workers.
  - `force-software` is a debug attribute; `?forceSoftware` in the page URL does the same.

**Not implemented:** `audioTracks` and `videoTracks` (the first default stream is played), subtitle streams inside the media file (`textTracks` only covers WebVTT `<track>` children), `addTextTrack()`, MediaSource/MediaStream as `srcObject`, and HLS/DASH. Streams without timestamps, such as headerless RealAudio 1.0 `.ra`, play from the start but can't be seeked. When a container records no duration, `duration` is estimated from size and bitrate and corrected (with `durationchange`) when playback reaches the end.

**Autoplay:** audio is played through an AudioContext, so unmuted autoplay follows the Web Audio autoplay policy. In real browsers this matches the media-element policy. Muted autoplay always works: audio is skipped and playback runs on the wall clock until the element is unmuted.

## Development

Prerequisites: Node 22 or later, pnpm 9, Docker with buildx, and the ffmpeg CLI (used only to generate fixtures).

```sh
pnpm install
pnpm build:wasm                      # Docker: builds all four cores (full|lite × st|mt) into packages/pup-wasm/dist
pnpm build                           # compiles the three packages (lib/ and the standalone bundle)
./test-media/generate.sh             # creates the test fixtures
./test-media/generate-legacy.sh      # legacy/exotic fixtures (WMV, RealMedia, FLV1, DivX 3, DV, MXF, ...)
pnpm dev                             # demo at http://localhost:5173
```

Open the demo with `?noIsolation` to run the single-threaded build, or with `?forceSoftware` to skip WebCodecs.

Tests:

```sh
pnpm test                            # Vitest: wasm smoke tests in Node (every fixture, including all legacy ones) and player unit tests
pnpm test:e2e                        # Playwright: Chromium + Firefox, starts the demo on :5199 and the bundle site on :5198
```

## Releases

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

`.github/workflows/build.yml` runs only when started by hand (Actions → build → Run workflow):

- `run_tests` (checkbox) adds typecheck, unit and Chromium e2e tests.
- Publishing happens only when a version is known: the `version` input, or a tag ref selected as the workflow's branch (`v1.2.3` publishes `1.2.3`). Then `@krab3000/pup-wasm`, `@krab3000/pup-player` and `@krab3000/pup-player-bundle` are published to GitHub Packages, and a GitHub Release is created with the package tarballs, the bundle as a zip, and the FFmpeg source.
- Without a version, the packages are only built and attached to the run as artifacts.

The wasm build uses a BuildKit layer cache in GHCR (`ghcr.io/krab3000/pup-video-player:buildcache`), so FFmpeg is recompiled only when the emsdk/FFmpeg versions, a codec config or the FFmpeg build script change.

Installing the packages needs `@krab3000:registry=https://npm.pkg.github.com` in `.npmrc` and a token with `read:packages`.

## License

The FFmpeg build is configured LGPL-only (no `--enable-gpl` and no GPL components). If you distribute the wasm binaries, you must meet the LGPL-2.1 obligations: provide the FFmpeg source and the build scripts. The scripts are in this repo, and the exact FFmpeg source tarball is attached to every GitHub Release (`pnpm build:wasm:source` exports it locally). Every package ships the license text ([LICENSE](LICENSE)).
