# syntax=docker/dockerfile:1
# Builds the pup FFmpeg cores (full|lite x st|mt) with a pinned emsdk and FFmpeg.
#
#   docker buildx build . --output type=local,dest=dist                          # pnpm build:wasm
#   docker buildx build . --target ffmpeg-source --output type=local,dest=release # FFmpeg source (LGPL)
#
# Each matrix cell is two stages. `ffmpeg-<set>-<thr>` compiles FFmpeg (slow) and depends only on the
# toolchain, the FFmpeg source, that set's config and the FFmpeg build script, so it stays cached
# while pup's own C code changes. `core-<set>-<thr>` builds on it and only links src/c (fast).
# BuildKit builds all cells in parallel.

ARG EMSDK_VERSION=6.0.11

FROM emscripten/emsdk:${EMSDK_VERSION} AS toolchain
ENV FFMPEG_SRC=/ffmpeg PREFIX=/prefix BUILD=/build OUT=/out
WORKDIR /pup

FROM toolchain AS ffmpeg-src
ARG FFMPEG_VERSION=7.1.2
RUN curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o "/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && mkdir -p /ffmpeg \
    && tar -xJf "/ffmpeg-${FFMPEG_VERSION}.tar.xz" -C /ffmpeg --strip-components=1

FROM toolchain AS ffmpeg-base
COPY --from=ffmpeg-src /ffmpeg /ffmpeg
COPY scripts/common.sh scripts/build-ffmpeg.sh scripts/

FROM ffmpeg-base AS ffmpeg-full-st
COPY configs/full.json configs/
RUN scripts/build-ffmpeg.sh full st

FROM ffmpeg-base AS ffmpeg-full-mt
COPY configs/full.json configs/
RUN scripts/build-ffmpeg.sh full mt

FROM ffmpeg-base AS ffmpeg-lite-st
COPY configs/lite.json configs/
RUN scripts/build-ffmpeg.sh lite st

FROM ffmpeg-base AS ffmpeg-lite-mt
COPY configs/lite.json configs/
RUN scripts/build-ffmpeg.sh lite mt

FROM ffmpeg-full-st AS core-full-st
COPY scripts/link-core.sh scripts/
COPY src/c src/c
RUN scripts/link-core.sh full st

FROM ffmpeg-full-mt AS core-full-mt
COPY scripts/link-core.sh scripts/
COPY src/c src/c
RUN scripts/link-core.sh full mt

FROM ffmpeg-lite-st AS core-lite-st
COPY scripts/link-core.sh scripts/
COPY src/c src/c
RUN scripts/link-core.sh lite st

FROM ffmpeg-lite-mt AS core-lite-mt
COPY scripts/link-core.sh scripts/
COPY src/c src/c
RUN scripts/link-core.sh lite mt

# The exact FFmpeg source the cores were built from, for LGPL source distribution.
FROM scratch AS ffmpeg-source
COPY --from=ffmpeg-src /ffmpeg-*.tar.xz /

# Default target: the four cores, written straight into the output directory.
FROM scratch AS dist
COPY --from=core-full-st /out/ /
COPY --from=core-full-mt /out/ /
COPY --from=core-lite-st /out/ /
COPY --from=core-lite-mt /out/ /
