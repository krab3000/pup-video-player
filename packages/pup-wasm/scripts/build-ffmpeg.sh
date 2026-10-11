#!/usr/bin/env bash
# Configures and builds FFmpeg for one cell of the matrix into $PREFIX (the slow step).
#
#   scripts/build-ffmpeg.sh <full|lite> <st|mt>
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "$0")/common.sh" "$@"

build_ffmpeg() {
  [ -f "$FFMPEG_SRC/configure" ] || { echo "FFmpeg source missing at $FFMPEG_SRC" >&2; exit 1; }
  mkdir -p "$BUILD/ffmpeg"
  echo "==> configuring FFmpeg ($SET-$THREADING)"
  cd "$BUILD/ffmpeg"
  emconfigure "$FFMPEG_SRC/configure" \
    --prefix="$PREFIX" \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --target-os=none --arch=x86_32 --enable-cross-compile \
    --disable-asm --disable-x86asm --disable-inline-asm --disable-runtime-cpudetect \
    --disable-programs --disable-doc --disable-debug --disable-stripping \
    --disable-network --disable-autodetect --disable-everything \
    --disable-avdevice --disable-postproc \
    --enable-avformat --enable-avcodec --enable-avfilter --enable-swresample --enable-swscale \
    "${THREAD_FLAGS[@]}" \
    ${EXTRA_CONFIGURE[@]+"${EXTRA_CONFIGURE[@]}"} \
    --enable-filter=abuffer,abuffersink,aformat,aresample,anull,atempo \
    --enable-demuxer="$(list demuxers)" \
    --enable-decoder="$(list decoders)" \
    --enable-parser="$(list parsers)" \
    --enable-bsf="$(list bsfs)" \
    --extra-cflags="$CFLAGS" \
    --extra-ldflags="$LDFLAGS" >"$BUILD/configure.log" 2>&1 || {
      tail -40 "$BUILD/configure.log"; tail -40 "$BUILD/ffmpeg/ffbuild/config.log"; exit 1;
    }
  echo "==> building FFmpeg ($SET-$THREADING)"
  emmake make -j"$JOBS" >"$BUILD/make.log" 2>&1 || { tail -40 "$BUILD/make.log"; exit 1; }
  emmake make install >>"$BUILD/make.log" 2>&1
}

build_ffmpeg
