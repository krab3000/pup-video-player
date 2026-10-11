#!/usr/bin/env bash
# Generates 10 s test fixtures with the ffmpeg CLI. The video shows a frame
# counter and the audio beeps once per second, so A/V sync can be eyeballed.
set -euo pipefail
cd "$(dirname "$0")"
D=10
V="testsrc=size=640x360:rate=30:duration=$D"
VHD="testsrc2=size=1920x1080:rate=30:duration=$D"
A="sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$D"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac -b:a 128k -movflags +faststart h264-aac.mp4
ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 1M -g 30 -c:a libopus vp9-opus.webm
ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v libvpx -pix_fmt yuv420p -b:v 1M -g 30 -c:a libopus vp8-opus.webm
ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v libx265 -pix_fmt yuv420p -tag:v hvc1 -x265-params log-level=error -g 30 -c:a ac3 hevc-ac3.mkv
ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v mpeg2video -pix_fmt yuv420p -b:v 2M -g 15 -c:a mp2 mpeg2-mp2.ts
ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v mpeg4 -pix_fmt yuv420p -b:v 1M -g 30 -c:a libmp3lame mpeg4-mp3.avi
ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac h264-aac.ts
ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v libsvtav1 -pix_fmt yuv420p -svtav1-params log-level=0 -g 30 -c:a libopus av1-opus.mp4
ff -f lavfi -i "$VHD" -c:v libx264 -pix_fmt yuv420p -g 60 -preset veryfast h264-1080p-video-only.mp4
ff -f lavfi -i "$A" -c:a flac audio.flac
ff -f lavfi -i "$A" -c:a libmp3lame -b:a 192k audio.mp3
ff -f lavfi -i "$A" -c:a pcm_s16le audio.wav
ff -f lavfi -i "$A" -c:a libopus audio-opus.ogg
ls -lh
