#!/usr/bin/env bash
# Generates 10 s fixtures in legacy/exotic formats (written to legacy/).
# Each file name is <video>-<audio>.<container> or <audio>.<container>.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p legacy
D=10
V="testsrc=size=320x240:rate=25:duration=$D"
A="sine=frequency=440:beep_factor=4:sample_rate=44100:duration=$D"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
av() { ff -f lavfi -i "$1" -f lavfi -i "$A" "${@:2}"; }

# Windows Media
av "$V" -c:v wmv2 -b:v 800k -c:a wmav2 -b:a 96k legacy/wmv2-wmav2.wmv
av "$V" -c:v wmv1 -b:v 800k -c:a wmav1 -b:a 96k legacy/wmv1-wmav1.asf
ff -f lavfi -i "$A" -c:a wmav2 -b:a 128k legacy/wmav2.wma
# DivX 3 / DivX 4-5 / Xvid era AVIs
av "$V" -c:v msmpeg4 -b:v 800k -c:a libmp3lame -b:a 128k legacy/msmpeg4v3-mp3.avi
av "$V" -c:v msmpeg4v2 -b:v 800k -c:a adpcm_ms legacy/msmpeg4v2-adpcm_ms.avi
av "$V" -c:v mpeg4 -vtag XVID -b:v 800k -bf 2 -c:a ac3 legacy/xvid-ac3.avi
av "$V" -c:v mpeg4 -vtag DX50 -b:v 800k -c:a mp2 legacy/divx5-mp2.avi
av "$V" -c:v mjpeg -q:v 4 -c:a adpcm_ima_wav legacy/mjpeg-adpcm_ima.avi
av "$V" -c:v huffyuv -c:a pcm_s16le legacy/huffyuv-pcm.avi
av "$V" -c:v zmbv -c:a pcm_s16le legacy/zmbv-pcm.avi
av "$V" -pix_fmt rgb555le -c:v msvideo1 -c:a pcm_u8 legacy/msvideo1-pcm_u8.avi
# Flash
av "$V" -c:v flv -b:v 800k -c:a libmp3lame -ar 44100 legacy/flv1-mp3.flv
av "$V" -c:v flv -b:v 800k -c:a adpcm_swf -ar 44100 legacy/flv1-adpcm_swf.flv
av "$V" -c:v flashsv -c:a nellymoser -ar 44100 legacy/flashsv-nellymoser.flv
# RealMedia
av "$V" -c:v rv20 -b:v 800k -c:a ac3 legacy/rv20-ac3.rm
av "$V" -c:v rv10 -b:v 800k -c:a real_144 -ar 8000 -ac 1 legacy/rv10-real144.rm
# Mobile / QuickTime / pro
ff -f lavfi -i "testsrc=size=352x288:rate=25:duration=$D" -f lavfi -i "$A" -c:v h263 -b:v 500k -c:a aac -ar 22050 legacy/h263-aac.3gp
av "$V" -c:v svq1 -c:a pcm_s16be legacy/svq1-pcm.mov
av "$V" -c:v cinepak -c:a pcm_s16le legacy/cinepak-pcm.mov
av "$V" -c:v qtrle -c:a alac legacy/qtrle-alac.mov
av "$V" -c:v prores_ks -profile:v 0 -c:a pcm_s24le legacy/prores-pcm24.mov
av "$V" -c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p -c:a pcm_s16le legacy/dnxhr-pcm.mov
ff -f lavfi -i "testsrc=size=720x576:rate=25:duration=$D" -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$D" -c:v dvvideo -pix_fmt yuv420p -c:a pcm_s16le -ac 2 legacy/dvvideo-pcm.dv
ff -f lavfi -i "testsrc=size=720x576:rate=25:duration=$D" -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$D" -c:v mpeg2video -b:v 5M -c:a pcm_s16le legacy/mpeg2-pcm.mxf
av "$V" -c:v mpeg1video -b:v 1M -c:a mp2 legacy/mpeg1-mp2.mpg
av "$V" -c:v ffv1 -c:a flac legacy/ffv1-flac.nut
av "$V" -c:v snow -c:a vorbis -strict -2 -ac 2 legacy/snow-vorbis.mkv
# Audio-only legacy / lossless
ff -f lavfi -i "$A" -c:a wavpack legacy/wavpack.wv
ff -f lavfi -i "$A" -c:a tta legacy/tta.tta
ff -f lavfi -i "$A" -c:a alac legacy/alac.m4a
ff -f lavfi -i "$A" -c:a alac legacy/alac.caf
ff -f lavfi -i "$A" -c:a pcm_s24be legacy/pcm24.aiff
ff -f lavfi -i "$A" -c:a pcm_mulaw -ar 8000 legacy/mulaw.au
ff -f lavfi -i "$A" -c:a mp2 legacy/mp2.mp2
ff -f lavfi -i "$A" -c:a ac3 legacy/ac3.ac3
ff -f lavfi -i "$A" -c:a eac3 legacy/eac3.eac3
ff -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$D" -c:a dca -strict -2 legacy/dts.dts
ff -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$D" -c:a truehd -strict -2 legacy/truehd.thd
ff -f lavfi -i "$A" -c:a adpcm_ima_wav legacy/adpcm_ima.wav
ff -f lavfi -i "sine=frequency=440:beep_factor=4:sample_rate=8000:duration=$D" -c:a g723_1 -b:a 6.3k legacy/g723_1.wav
# Raw RealAudio 1.0 has no timestamps: it plays but cannot be seeked.
ff -f lavfi -i "$A" -c:a real_144 -ar 8000 -ac 1 legacy/real144.ra
ls legacy | wc -l
