#!/usr/bin/env bash
# Installs the pinned emsdk into third_party/emsdk (does not touch any global emsdk).
set -euo pipefail
EMSDK_VERSION="${EMSDK_VERSION:-6.0.11}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/emsdk"
[ -d "$DEST" ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$DEST"
"$DEST/emsdk" install "$EMSDK_VERSION"
"$DEST/emsdk" activate "$EMSDK_VERSION"
