# Changelog

All notable changes to pup-video-player are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[semantic versioning](https://semver.org/). One version covers all three packages:
`@krab3000/pup-wasm`, `@krab3000/pup-player` and `@krab3000/pup-player-bundle`.

## [Unreleased]

## [0.2.0-rc.1] - 2026-10-11

### Added
- `<source>` children work like they do in `<video>`. With no `src` or `srcObject`, the element picks the first `<source>` whose `type` is empty or playable (`canPlayType`). If that file can't be opened (a network error, an HTTP error or an unsupported container), the element fires `error` on that `<source>` and tries the next one. When none is left, `networkState` becomes `NETWORK_NO_SOURCE` and `error` stays `null`. A `<source>` added to an empty element starts loading. A `<source>` added after every candidate failed resumes selection from it. `currentSrc` reports the chosen file.
- Captions from WebVTT `<track>` children:
  - **`textTracks`** lists `subtitles` and `captions` tracks, with `mode`, `cues`, `activeCues` and `cuechange` events. The first track marked `default` starts `showing`.
  - **Loading:** a track's file is fetched when its mode becomes `hidden` or `showing`, and the `<track>` element fires `load` or `error`.
  - **Display:** `<pup-video>` draws the active cues over the picture, styled through `::part(captions)`. The `line` and `align` cue settings and `<b>`, `<i>` and `<u>` text are supported.
  - **Not supported:** regions, `::cue` styles, other track kinds, subtitle streams inside the media file and `addTextTrack()`.
- `PupTextTrack`, `PupTextTrackList`, `PupTextTrackCueList`, `PupTextTrackMode`, `VttCue` and `SourceProvider` are exported from `@krab3000/pup-player`.

### Changed
- The release workflow marks prerelease versions (such as `0.2.0-rc.1`) as prereleases on GitHub.

## [0.1.0-rc.1] - 2026-10-11

First release.

### Added
- `<pup-video>` and `<pup-audio>`: Lit web components with the `<video>`/`<audio>` API. Demuxing, and decoding of whatever the browser can't decode, run on FFmpeg 7.1.2 compiled to WebAssembly; video the browser supports is decoded with WebCodecs.
  - **Formats:** MKV, MPEG-TS, AVI, ASF/WMV, FLV, RealMedia, MPEG-PS, MXF and many more containers, plus codecs such as Xvid/DivX, WMV 1–3, VP6, RealVideo, HEVC, AC-3, DTS and WMA.
  - **API:** the usual media properties, methods and events, in the native event order, including `srcObject` with a Blob or File.
  - **Reading:** URLs are read with HTTP range requests instead of being downloaded whole.
  - **Fallback:** if WebCodecs fails, decoding moves to FFmpeg in software.
- Optional built-in controls (`controls`), with keyboard shortcuts, a speed menu and fullscreen.
- Four FFmpeg cores:
  - `full` or `lite` codec set, chosen per element with `codec-set`;
  - single- or multi-threaded, chosen automatically: the multi-threaded core runs on cross-origin isolated pages.
- npm packages on GitHub Packages, built output only:
  - `@krab3000/pup-wasm`: the prebuilt cores and their bindings.
  - `@krab3000/pup-player`: the elements, for apps with a bundler.
  - `@krab3000/pup-player-bundle`: a standalone build that works from a single `<script type="module">` tag.
- The FFmpeg cores are built with Docker (`pnpm build:wasm`), with the slow FFmpeg build cached per variant.
- A manually started release workflow. It builds the cores with a registry layer cache, optionally runs the tests, and publishes the packages and a GitHub Release (with the FFmpeg source, for the LGPL) when given a version or started on a tag.
- LGPL-2.1 license text in every package.

[Unreleased]: https://github.com/krab3000/pup-video-player/compare/v0.2.0-rc.1...HEAD
[0.2.0-rc.1]: https://github.com/krab3000/pup-video-player/compare/v0.1.0-rc.1...v0.2.0-rc.1
[0.1.0-rc.1]: https://github.com/krab3000/pup-video-player/releases/tag/v0.1.0-rc.1
