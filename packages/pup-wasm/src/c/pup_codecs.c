#include <stdio.h>
#include <string.h>

#include <libavutil/pixdesc.h>

#include "pup.h"

/* Finds the first Annex B NAL unit of `type` (H.264 header layout). */
static const uint8_t *find_annexb_nal(const uint8_t *p, int size, int type, int *len) {
  const uint8_t *end = p + size;
  for (const uint8_t *q = p; q + 3 < end; q++) {
    if (q[0] == 0 && q[1] == 0 && q[2] == 1) {
      const uint8_t *nal = q + 3;
      if ((nal[0] & 0x1f) == type) {
        const uint8_t *next = nal;
        while (next + 3 < end && !(next[0] == 0 && next[1] == 0 && (next[2] == 1 || next[2] == 0))) next++;
        *len = (int)((next + 3 < end ? next : end) - nal);
        return nal;
      }
    }
  }
  return NULL;
}

static void h264_codec(const AVCodecParameters *par, char *out, int cap) {
  int profile = par->profile > 0 ? par->profile & 0xff : 66;
  int constraints = 0;
  int level = par->level > 0 ? par->level : 30;
  const uint8_t *ed = par->extradata;
  int n = par->extradata_size;
  if (ed && n >= 4 && ed[0] == 1) {
    /* avcC: version, profile, compat, level */
    profile = ed[1];
    constraints = ed[2];
    level = ed[3];
  } else if (ed && n > 4) {
    int len = 0;
    const uint8_t *sps = find_annexb_nal(ed, n, 7, &len);
    if (sps && len >= 4) {
      profile = sps[1];
      constraints = sps[2];
      level = sps[3];
    }
  }
  snprintf(out, cap, "avc1.%02X%02X%02X", profile, constraints, level);
}

static uint32_t reverse_bits32(uint32_t v) {
  uint32_t r = 0;
  for (int i = 0; i < 32; i++) r |= ((v >> i) & 1u) << (31 - i);
  return r;
}

static void hevc_codec(const AVCodecParameters *par, char *out, int cap) {
  const uint8_t *ed = par->extradata;
  const char *tag = par->codec_tag == MKTAG('h', 'e', 'v', '1') ? "hev1" : "hvc1";
  if (ed && par->extradata_size >= 23 && ed[0] == 1) {
    /* hvcC */
    int space = ed[1] >> 6;
    int tier = (ed[1] >> 5) & 1;
    int idc = ed[1] & 0x1f;
    uint32_t compat = (uint32_t)ed[2] << 24 | (uint32_t)ed[3] << 16 | (uint32_t)ed[4] << 8 | ed[5];
    int level = ed[12];
    int len = snprintf(out, cap, "%s.%s%d.%X.%c%d", tag, space ? (space == 1 ? "A" : space == 2 ? "B" : "C") : "",
                       idc, reverse_bits32(compat), tier ? 'H' : 'L', level);
    /* Constraint bytes, trailing zero bytes omitted. */
    int last = -1;
    for (int i = 0; i < 6; i++)
      if (ed[6 + i]) last = i;
    for (int i = 0; i <= last && len < cap; i++) len += snprintf(out + len, cap - len, ".%X", ed[6 + i]);
    return;
  }
  int idc = par->profile > 0 ? par->profile : 1;
  int level = par->level > 0 ? par->level : 93;
  snprintf(out, cap, "%s.%d.%d.L%d.B0", tag, idc, idc == 2 ? 4 : 6, level);
}

static int bit_depth(const AVCodecParameters *par) {
  const AVPixFmtDescriptor *desc = av_pix_fmt_desc_get(par->format);
  return desc ? desc->comp[0].depth : 8;
}

static void vp9_codec(const AVCodecParameters *par, char *out, int cap) {
  int profile = par->profile > 0 ? par->profile : 0;
  int level = par->level > 0 ? par->level : 10;
  snprintf(out, cap, "vp09.%02d.%02d.%02d", profile, level, bit_depth(par));
}

static void av1_codec(const AVCodecParameters *par, char *out, int cap) {
  const uint8_t *ed = par->extradata;
  if (ed && par->extradata_size >= 4 && (ed[0] & 0x80)) {
    /* av1C */
    int profile = ed[1] >> 5;
    int level = ed[1] & 0x1f;
    int tier = ed[2] >> 7;
    int high = (ed[2] >> 6) & 1;
    int twelve = (ed[2] >> 5) & 1;
    int depth = high ? (twelve ? 12 : 10) : 8;
    snprintf(out, cap, "av01.%d.%02d%c.%02d", profile, level, tier ? 'H' : 'M', depth);
    return;
  }
  snprintf(out, cap, "av01.%d.%02dM.%02d", par->profile > 0 ? par->profile : 0, par->level > 0 ? par->level : 8,
           bit_depth(par));
}

void pup_webcodecs_codec(const AVCodecParameters *par, char *out, int cap) {
  out[0] = 0;
  switch (par->codec_id) {
    case AV_CODEC_ID_H264: h264_codec(par, out, cap); break;
    case AV_CODEC_ID_HEVC: hevc_codec(par, out, cap); break;
    case AV_CODEC_ID_VP8: snprintf(out, cap, "vp8"); break;
    case AV_CODEC_ID_VP9: vp9_codec(par, out, cap); break;
    case AV_CODEC_ID_AV1: av1_codec(par, out, cap); break;
    default: break;
  }
}
