# Shared setup for build-ffmpeg.sh and link-core.sh: sourced with "<set> <threading>" arguments.
# Both run inside the Docker build (../Dockerfile, `pnpm build:wasm`), which provides emcc.
# Kept separate from the step scripts so editing the link step never invalidates the cached
# FFmpeg build layers.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FFMPEG_SRC="${FFMPEG_SRC:-$ROOT/third_party/ffmpeg}"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu)}"

SET="${1:?codec set (full|lite)}"
THREADING="${2:?threading (st|mt)}"
CONFIG="$ROOT/configs/$SET.json"
[ -f "$CONFIG" ] || { echo "unknown codec set: $SET" >&2; exit 1; }
command -v emcc >/dev/null || { echo "emcc not found: build through Docker (pnpm build:wasm)" >&2; exit 1; }

BUILD="${BUILD:-$ROOT/build/$SET-$THREADING}"
PREFIX="${PREFIX:-$BUILD/prefix}"
OUT="${OUT:-$ROOT/dist}"

list() { node -e "console.log((require('$CONFIG')['$1'] || []).join(','))"; }
# Space-separated lists: extra configure flags and emscripten flags (ports such as -sUSE_ZLIB=1).
words() { node -e "console.log((require('$CONFIG')['$1'] || []).join(' '))"; }
read -r -a EXTRA_CONFIGURE <<<"$(words configure)"
EMFLAGS="$(words emflags)"

CFLAGS="-O3 $EMFLAGS"
LDFLAGS="$EMFLAGS"
THREAD_FLAGS=(--disable-pthreads --disable-w32threads --disable-os2threads)
if [ "$THREADING" = "mt" ]; then
  CFLAGS="$CFLAGS -pthread"
  LDFLAGS="-pthread"
  THREAD_FLAGS=(--enable-pthreads --disable-w32threads --disable-os2threads)
fi

