#!/usr/bin/env bash
# Generates 10 s HLS fixtures with the ffmpeg CLI (written to hls/). Same picture and sound as
# generate.sh: a frame counter and a beep per second. Segments are 2 s (keyframe every second).
#   hls/vod-ts        MPEG-TS segments
#   hls/vod-fmp4      fMP4 segments with an EXT-X-MAP init segment
#   hls/byterange     one MPEG-TS file addressed with EXT-X-BYTERANGE
#   hls/aes           AES-128 with a fixed key and IV
#   hls/aes-seqiv     AES-128 without an IV attribute (derived from the media sequence number,
#                     which starts at 7), encrypted with openssl
#   hls/master        a master playlist with a 640x360 and a 320x180 variant
#   hls/sample-aes    vod-ts tagged METHOD=SAMPLE-AES (unsupported: an error case)
set -euo pipefail
cd "$(dirname "$0")"
D=10
V="testsrc=size=640x360:rate=30:duration=$D"
A="sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$D"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
av() { ff -f lavfi -i "$V" -f lavfi -i "$A" -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac -b:a 128k "$@"; }
HLS=(-f hls -hls_time 2 -hls_playlist_type vod)

rm -rf hls
mkdir -p hls/vod-ts hls/vod-fmp4 hls/byterange hls/aes hls/aes-seqiv hls/master hls/sample-aes

av "${HLS[@]}" -hls_segment_filename hls/vod-ts/seg%d.ts hls/vod-ts/index.m3u8
av "${HLS[@]}" -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename hls/vod-fmp4/seg%d.m4s hls/vod-fmp4/index.m3u8
av "${HLS[@]}" -hls_flags single_file hls/byterange/index.m3u8

# Key info file: key URI (as written in the playlist), key file, optional IV.
printf '000102030405060708090a0b0c0d0e0f' | xxd -r -p >hls/aes/key.bin
printf 'key.bin\nhls/aes/key.bin\n0f0e0d0c0b0a09080706050403020100\n' >hls/aes/key-info.txt
av "${HLS[@]}" -hls_key_info_file hls/aes/key-info.txt -hls_segment_filename hls/aes/seg%d.ts hls/aes/index.m3u8

# ffmpeg always writes an IV attribute, so this one is encrypted by hand: IV = media sequence number.
cp hls/aes/key.bin hls/aes-seqiv/key.bin
for i in 0 1 2 3 4; do
  openssl aes-128-cbc -K 000102030405060708090a0b0c0d0e0f -iv "$(printf '%032x' $((7 + i)))" \
    -in hls/vod-ts/seg$i.ts -out hls/aes-seqiv/seg$i.ts
done
sed -e 's|^#EXT-X-MEDIA-SEQUENCE.*|#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"|' \
  hls/vod-ts/index.m3u8 >hls/aes-seqiv/index.m3u8

ff -f lavfi -i "$V" -f lavfi -i "$A" -filter_complex '[0:v]split=2[a][b];[b]scale=320:180[c]' \
  -map '[a]' -map '[c]' -map 1:a -map 1:a \
  -c:v libx264 -pix_fmt yuv420p -g 30 -b:v:0 1500k -b:v:1 300k -c:a aac -b:a 128k \
  "${HLS[@]}" -master_pl_name master.m3u8 -var_stream_map 'v:0,a:0 v:1,a:1' \
  -hls_segment_filename 'hls/master/v%v/seg%d.ts' 'hls/master/v%v/index.m3u8'

sed -e 's|^seg|../vod-ts/seg|' -e 's|^#EXT-X-MEDIA-SEQUENCE.*|&\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"|' \
  hls/vod-ts/index.m3u8 >hls/sample-aes/index.m3u8

find hls -type f | sort
