#!/usr/bin/env bash
# Links pup's C sources against the FFmpeg build in $PREFIX (the fast step).
#
#   scripts/link-core.sh <full|lite> <st|mt>
#
# Output: $OUT/pup-core-<set>-<threading>.{mjs,wasm}
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "$0")/common.sh" "$@"

link_core() {
  mkdir -p "$OUT"
  echo "==> linking pup-core-$SET-$THREADING"
  local link_flags=(
    -O3
    -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createPupCore
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB -sSTACK_SIZE=2MB
    -sEXPORTED_FUNCTIONS=_malloc,_free
    -sEXPORTED_RUNTIME_METHODS=wasmMemory,UTF8ToString,stringToUTF8,lengthBytesUTF8
    --js-library "$ROOT/src/c/pup_io.js"
  )
  if [ "$THREADING" = "mt" ]; then
    # -Wno-pthreads-mem-growth: growing a shared heap detaches JS views of it, which the bindings
    # already handle (Core re-creates its views whenever the buffer changes). The suggested
    # -sGROWABLE_ARRAYBUFFERS needs growable SharedArrayBuffer support that older browsers lack.
    link_flags+=(-pthread -sPTHREAD_POOL_SIZE=Module.pthreadPoolSize -sDEFAULT_PTHREAD_STACK_SIZE=2MB -Wno-pthreads-mem-growth)
  fi

  # shellcheck disable=SC2086
  emcc "${link_flags[@]}" $CFLAGS \
    -I"$PREFIX/include" \
    "$ROOT"/src/c/*.c \
    "$PREFIX/lib/libavformat.a" "$PREFIX/lib/libavfilter.a" "$PREFIX/lib/libavcodec.a" \
    "$PREFIX/lib/libswscale.a" "$PREFIX/lib/libswresample.a" "$PREFIX/lib/libavutil.a" \
    -o "$OUT/pup-core-$SET-$THREADING.mjs"

  ls -lh "$OUT/pup-core-$SET-$THREADING".*
}

link_core
