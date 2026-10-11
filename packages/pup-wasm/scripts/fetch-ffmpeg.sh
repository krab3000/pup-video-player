#!/usr/bin/env bash
# Downloads the pinned FFmpeg source into third_party/ffmpeg.
set -euo pipefail
FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/third_party/ffmpeg"
if [ -f "$DEST/configure" ]; then
  echo "ffmpeg already present at $DEST"
  exit 0
fi
mkdir -p "$ROOT/third_party"
TMP="$(mktemp -d)"
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o "$TMP/ffmpeg.tar.xz"
tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP"
mv "$TMP/ffmpeg-${FFMPEG_VERSION}" "$DEST"
rm -rf "$TMP"
echo "ffmpeg ${FFMPEG_VERSION} -> $DEST"
