// HTMLMediaElement.canPlayType for what the wasm build (plus WebCodecs) can
// handle. Answers from the static codec-set configs, so no wasm is loaded.

import { fullConfig, liteConfig, type CodecSet } from '@pup/wasm';

const CONTAINERS: Record<string, string> = {
  'video/mp4': 'mov',
  'audio/mp4': 'mov',
  'audio/x-m4a': 'mov',
  'video/quicktime': 'mov',
  'video/3gpp': 'mov',
  'audio/3gpp': 'mov',
  'video/3gpp2': 'mov',
  'audio/3gpp2': 'mov',
  'video/webm': 'matroska',
  'audio/webm': 'matroska',
  'video/x-matroska': 'matroska',
  'audio/x-matroska': 'matroska',
  'video/ogg': 'ogg',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'video/mp2t': 'mpegts',
  'video/mpeg': 'mpegps',
  'video/x-msvideo': 'avi',
  'video/avi': 'avi',
  'video/vnd.avi': 'avi',
  'video/x-flv': 'flv',
  'application/x-shockwave-flash': 'swf',
  'video/x-ms-asf': 'asf',
  'video/x-ms-wmv': 'asf',
  'audio/x-ms-wma': 'asf',
  'application/vnd.ms-asf': 'asf',
  'application/vnd.rn-realmedia': 'rm',
  'application/vnd.rn-realmedia-vbr': 'rm',
  'audio/x-pn-realaudio': 'rm',
  'audio/vnd.rn-realaudio': 'rm',
  'video/vnd.rn-realvideo': 'rm',
  'video/x-nsv': 'nsv',
  'application/mxf': 'mxf',
  'video/x-dv': 'dv',
  'video/dv': 'dv',
  'video/x-nut': 'nut',
  'video/x-ivf': 'ivf',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/basic': 'au',
  'audio/x-caf': 'caf',
  'audio/ape': 'ape',
  'audio/x-ape': 'ape',
  'audio/wavpack': 'wv',
  'audio/x-wavpack': 'wv',
  'audio/x-tta': 'tta',
  'audio/x-musepack': 'mpc8',
  'audio/amr': 'amr',
  'audio/amr-wb': 'amr',
  'audio/ac3': 'ac3',
  'audio/eac3': 'eac3',
  'audio/vnd.dts': 'dts',
  'audio/vnd.dts.hd': 'dtshd',
  'audio/x-voc': 'voc',
  'audio/x-gsm': 'gsm',
};

/** RFC 6381 codec prefixes -> FFmpeg decoder names. `null` = WebCodecs only. */
const CODECS: Array<[RegExp, string | null, boolean]> = [
  // [pattern, ffmpeg decoder, is video]
  [/^(avc1|avc3)(\.|$)/, 'h264', true],
  [/^(hvc1|hev1)(\.|$)/, 'hevc', true],
  [/^vp8(\.|$)/, 'vp8', true],
  [/^(vp09|vp9)(\.|$)/, 'vp9', true],
  [/^av01(\.|$)/, null, true],
  [/^mp4v\.20/, 'mpeg4', true],
  [/^mp4v\.6[0-5]$/i, 'mpeg2video', true],
  [/^mp4v\.6a$/i, 'mpeg1video', true],
  [/^(s263|h263)$/, 'h263', true],
  [/^(wmv1|wmv2|wmv3)$/i, null, true], // checked by name below
  [/^(wvc1|vc-1)$/i, 'vc1', true],
  [/^theora$/, 'theora', true],
  [/^mp4a\.40/, 'aac', false],
  [/^(mp4a\.(69|6b|6B)|mp3)$/, 'mp3', false],
  [/^opus$/, 'opus', false],
  [/^vorbis$/, 'vorbis', false],
  [/^(flac|fLaC)$/, 'flac', false],
  [/^(ac-3|mp4a\.a5)$/i, 'ac3', false],
  [/^(ec-3|mp4a\.a6)$/i, 'eac3', false],
  [/^(dtsc|dtsh|dtsl|dtse|mp4a\.a9)$/i, 'dca', false],
  [/^mlpa$/i, 'truehd', false],
  [/^alac$/, 'alac', false],
  [/^samr$/, 'amrnb', false],
  [/^sawb$/, 'amrwb', false],
  [/^(wmav1|wmav2|wmapro|wmalossless)$/i, null, false], // checked by name below
  [/^1$/, 'pcm_s16le', false], // WAV codecs="1"
];

export function canPlayType(type: string, set: CodecSet = 'full'): CanPlayTypeResult {
  const config = set === 'lite' ? liteConfig : fullConfig;
  const [mime, ...params] = type.split(';').map((s) => s.trim());
  const demuxer = CONTAINERS[mime.toLowerCase()];
  if (!demuxer || !config.demuxers.includes(demuxer)) return '';

  const codecsParam = params.find((p) => /^codecs\s*=/i.test(p));
  if (!codecsParam) return 'maybe';
  const codecs = codecsParam
    .replace(/^codecs\s*=\s*/i, '')
    .replace(/^"|"$/g, '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  let result: CanPlayTypeResult = 'probably';
  for (const codec of codecs) {
    const match = CODECS.find(([re]) => re.test(codec));
    if (!match) return '';
    const [, mapped, isVideo] = match;
    const decoder = mapped ?? (/^(wmv|wma)/i.test(codec) ? codec.toLowerCase() : null);
    if (decoder && config.decoders.includes(decoder)) continue;
    // Not in the wasm build: only WebCodecs could decode it, which can't be
    // checked synchronously.
    if (isVideo && typeof VideoDecoder !== 'undefined') {
      result = 'maybe';
      continue;
    }
    return '';
  }
  return result;
}
