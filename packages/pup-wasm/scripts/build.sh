#!/usr/bin/env bash
# Builds one cell (or all cells) of the wasm build matrix.
#
#   scripts/build.sh <full|lite> <st|mt>
#   scripts/build.sh all
#
# Output: dist/pup-core-<set>-<threading>.{mjs,wasm}
# Uses the emsdk in third_party/emsdk (see README) unless emcc is already on PATH
# and PUP_USE_SYSTEM_EMSDK=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FFMPEG_SRC="$ROOT/third_party/ffmpeg"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"

if [ "${PUP_USE_SYSTEM_EMSDK:-0}" != "1" ]; then
  if [ ! -f "$ROOT/third_party/emsdk/emsdk_env.sh" ]; then
    echo "emsdk missing: run scripts/setup-emsdk.sh" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source "$ROOT/third_party/emsdk/emsdk_env.sh" >/dev/null 2>&1
fi
[ -f "$FFMPEG_SRC/configure" ] || "$ROOT/scripts/fetch-ffmpeg.sh"

if [ "${1:-}" = "all" ]; then
  for set in full lite; do
    for threading in st mt; do
      "$0" "$set" "$threading"
    done
  done
  exit 0
fi

SET="${1:?codec set (full|lite)}"
THREADING="${2:?threading (st|mt)}"
CONFIG="$ROOT/configs/$SET.json"
[ -f "$CONFIG" ] || { echo "unknown codec set: $SET" >&2; exit 1; }

list() { node -e "console.log((require('$CONFIG')['$1'] || []).join(','))"; }
# Space-separated lists: extra configure flags and emscripten flags (ports such as -sUSE_ZLIB=1).
words() { node -e "console.log((require('$CONFIG')['$1'] || []).join(' '))"; }
read -r -a EXTRA_CONFIGURE <<<"$(words configure)"
EMFLAGS="$(words emflags)"

BUILD="$ROOT/build/$SET-$THREADING"
PREFIX="$BUILD/prefix"
mkdir -p "$BUILD/ffmpeg" "$ROOT/dist"

CFLAGS="-O3 $EMFLAGS"
LDFLAGS="$EMFLAGS"
THREAD_FLAGS=(--disable-pthreads --disable-w32threads --disable-os2threads)
if [ "$THREADING" = "mt" ]; then
  CFLAGS="$CFLAGS -pthread"
  LDFLAGS="-pthread"
  THREAD_FLAGS=(--enable-pthreads --disable-w32threads --disable-os2threads)
fi

STAMP="$BUILD/ffmpeg/.pup-config"
CONFIG_KEY="$(cat "$CONFIG") $THREADING $(cat "$0" | shasum | cut -c1-12)"
if [ ! -f "$PREFIX/lib/libavcodec.a" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$CONFIG_KEY" ]; then
  echo "==> configuring FFmpeg ($SET-$THREADING)"
  (
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
  )
  echo "$CONFIG_KEY" >"$STAMP"
fi

echo "==> linking pup-core-$SET-$THREADING"
LINK_FLAGS=(
  -O3
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createPupCore
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sSTACK_SIZE=2MB
  -sEXPORTED_FUNCTIONS=_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=wasmMemory,UTF8ToString,stringToUTF8,lengthBytesUTF8
  --js-library "$ROOT/src/c/pup_io.js"
)
if [ "$THREADING" = "mt" ]; then
  LINK_FLAGS+=(-pthread -sPTHREAD_POOL_SIZE=Module.pthreadPoolSize -sDEFAULT_PTHREAD_STACK_SIZE=2MB)
fi

emcc "${LINK_FLAGS[@]}" $CFLAGS \
  -I"$PREFIX/include" \
  "$ROOT"/src/c/*.c \
  "$PREFIX/lib/libavformat.a" "$PREFIX/lib/libavfilter.a" "$PREFIX/lib/libavcodec.a" \
  "$PREFIX/lib/libswscale.a" "$PREFIX/lib/libswresample.a" "$PREFIX/lib/libavutil.a" \
  -o "$ROOT/dist/pup-core-$SET-$THREADING.mjs"

ls -lh "$ROOT/dist/pup-core-$SET-$THREADING".*
