#include <math.h>
#include <stdio.h>
#include <string.h>

#include <emscripten/emscripten.h>
#include <libavformat/avformat.h>
#include <libavutil/pixdesc.h>

#include "pup.h"

#define PUP_IO_BUFFER_SIZE (64 * 1024)

/* Keep FFmpeg quiet unless something is actually wrong. */
__attribute__((constructor)) static void pup_init_logging(void) { av_log_set_level(AV_LOG_ERROR); }

EMSCRIPTEN_KEEPALIVE
void pup_set_log_level(int level) { av_log_set_level(level); }

#define PUP_PEEK_MAX 1024

typedef struct PupDemux {
  AVFormatContext *fmt;
  AVIOContext *avio;
  AVPacket *pkt;
  /* Packets read ahead while validating a seek, returned before new reads. */
  AVPacket *peeked[PUP_PEEK_MAX];
  int peek_head, peek_count;
  int io;
  int64_t pos;
  int64_t size;
  int64_t start_time; /* AV_TIME_BASE units; subtracted so the timeline starts at 0 */
} PupDemux;

static int io_read(void *opaque, uint8_t *buf, int size) {
  PupDemux *d = opaque;
  int n = pup_js_read(d->io, buf, size, (double)d->pos);
  if (n == 0) return AVERROR_EOF;
  if (n < 0) return AVERROR(EIO);
  d->pos += n;
  return n;
}

static int64_t io_seek(void *opaque, int64_t offset, int whence) {
  PupDemux *d = opaque;
  switch (whence & ~AVSEEK_FORCE) {
    case AVSEEK_SIZE: return d->size >= 0 ? d->size : AVERROR(ENOSYS);
    case SEEK_SET: d->pos = offset; break;
    case SEEK_CUR: d->pos += offset; break;
    case SEEK_END:
      if (d->size < 0) return AVERROR(ENOSYS);
      d->pos = d->size + offset;
      break;
    default: return AVERROR(EINVAL);
  }
  return d->pos;
}

static double to_us(int64_t ts, AVRational tb, int64_t offset) {
  if (ts == AV_NOPTS_VALUE) return NAN;
  return (double)(av_rescale_q(ts, tb, AV_TIME_BASE_Q) - offset);
}

static void peek_clear(PupDemux *d) {
  for (int i = 0; i < d->peek_count; i++) av_packet_free(&d->peeked[d->peek_head + i]);
  d->peek_head = d->peek_count = 0;
}

static void demux_free(PupDemux *d) {
  if (!d) return;
  peek_clear(d);
  if (d->fmt) avformat_close_input(&d->fmt);
  if (d->avio) {
    av_freep(&d->avio->buffer);
    avio_context_free(&d->avio);
  }
  av_packet_free(&d->pkt);
  av_free(d);
}

/* Opens the media behind JS io handle `io`. Returns NULL on failure; the
 * FFmpeg error code is written to *err. */
EMSCRIPTEN_KEEPALIVE
PupDemux *pup_demux_open(int io, int *err) {
  PupDemux *d = av_mallocz(sizeof(*d));
  int ret = AVERROR(ENOMEM);
  if (!d) goto fail;
  d->io = io;
  double size = pup_js_size(io);
  d->size = size >= 0 ? (int64_t)size : -1;

  uint8_t *buf = av_malloc(PUP_IO_BUFFER_SIZE);
  if (!buf) goto fail;
  d->avio = avio_alloc_context(buf, PUP_IO_BUFFER_SIZE, 0, d, io_read, NULL, io_seek);
  d->fmt = avformat_alloc_context();
  d->pkt = av_packet_alloc();
  if (!d->avio || !d->fmt || !d->pkt) goto fail;
  d->avio->seekable = d->size >= 0 ? AVIO_SEEKABLE_NORMAL : 0;
  d->fmt->pb = d->avio;
  d->fmt->flags |= AVFMT_FLAG_CUSTOM_IO;

  if ((ret = avformat_open_input(&d->fmt, NULL, NULL, NULL)) < 0) goto fail;
  if ((ret = avformat_find_stream_info(d->fmt, NULL)) < 0) goto fail;
  d->start_time = d->fmt->start_time != AV_NOPTS_VALUE ? d->fmt->start_time : 0;
  return d;

fail:
  if (err) *err = ret;
  demux_free(d);
  return NULL;
}

EMSCRIPTEN_KEEPALIVE
void pup_demux_close(PupDemux *d) { demux_free(d); }

EMSCRIPTEN_KEEPALIVE
int pup_demux_stream_count(PupDemux *d) { return d->fmt->nb_streams; }

/* Container duration in microseconds. Formats that don't record one (raw
 * RealAudio, some raw streams) get an estimate from size and bitrate. */
EMSCRIPTEN_KEEPALIVE
double pup_demux_duration(PupDemux *d) {
  if (d->fmt->duration != AV_NOPTS_VALUE && d->fmt->duration > 0) return (double)d->fmt->duration;
  int64_t bit_rate = d->fmt->bit_rate;
  if (bit_rate <= 0) {
    bit_rate = 0;
    for (unsigned i = 0; i < d->fmt->nb_streams; i++) bit_rate += FFMAX(d->fmt->streams[i]->codecpar->bit_rate, 0);
  }
  if (bit_rate > 0 && d->size > 0) return (double)d->size * 8 * 1e6 / (double)bit_rate;
  return NAN;
}

EMSCRIPTEN_KEEPALIVE
const char *pup_demux_format_name(PupDemux *d) { return d->fmt->iformat->name; }

/* Writes a JSON description of stream `i` into `out`. Returns bytes written. */
EMSCRIPTEN_KEEPALIVE
int pup_demux_stream_info(PupDemux *d, int i, char *out, int cap) {
  AVStream *st = d->fmt->streams[i];
  AVCodecParameters *par = st->codecpar;
  const char *type = par->codec_type == AVMEDIA_TYPE_VIDEO   ? "video"
                     : par->codec_type == AVMEDIA_TYPE_AUDIO ? "audio"
                     : par->codec_type == AVMEDIA_TYPE_SUBTITLE ? "subtitle"
                                                                : "other";
  char wc[64];
  pup_webcodecs_codec(par, wc, sizeof(wc));
  AVRational sar = av_guess_sample_aspect_ratio(d->fmt, st, NULL);
  AVRational fps = av_guess_frame_rate(d->fmt, st, NULL);
  const char *pix = par->codec_type == AVMEDIA_TYPE_VIDEO ? av_get_pix_fmt_name(par->format) : NULL;
  int attached_pic = (st->disposition & AV_DISPOSITION_ATTACHED_PIC) != 0;
  int is_default = (st->disposition & AV_DISPOSITION_DEFAULT) != 0;

  return snprintf(out, cap,
                  "{\"index\":%d,\"type\":\"%s\",\"codec\":\"%s\",\"codecId\":%d,"
                  "\"webcodecs\":\"%s\",\"width\":%d,\"height\":%d,"
                  "\"sarNum\":%d,\"sarDen\":%d,\"fps\":%f,\"pixelFormat\":\"%s\","
                  "\"sampleRate\":%d,\"channels\":%d,\"profile\":%d,\"level\":%d,"
                  "\"bitRate\":%lld,\"attachedPic\":%s,\"default\":%s}",
                  i, type, avcodec_get_name(par->codec_id), par->codec_id, wc, par->width,
                  par->height, sar.num, sar.den > 0 ? sar.den : 1,
                  fps.den > 0 ? av_q2d(fps) : 0.0, pix ? pix : "", par->sample_rate,
                  par->ch_layout.nb_channels, par->profile, par->level,
                  (long long)par->bit_rate, attached_pic ? "true" : "false",
                  is_default ? "true" : "false");
}

/* Stream duration in microseconds (NaN if unknown). */
EMSCRIPTEN_KEEPALIVE
double pup_demux_stream_duration(PupDemux *d, int i) {
  AVStream *st = d->fmt->streams[i];
  return st->duration > 0 ? to_us(st->duration, st->time_base, 0) : NAN;
}

EMSCRIPTEN_KEEPALIVE
void pup_demux_codecpar(PupDemux *d, int i, int32_t *out) {
  AVCodecParameters *par = d->fmt->streams[i]->codecpar;
  uint64_t mask = par->ch_layout.order == AV_CHANNEL_ORDER_NATIVE ? par->ch_layout.u.mask : 0;
  out[PUP_CP_TYPE] = par->codec_type;
  out[PUP_CP_CODEC_ID] = par->codec_id;
  out[PUP_CP_CODEC_TAG] = par->codec_tag;
  out[PUP_CP_FORMAT] = par->format;
  out[PUP_CP_PROFILE] = par->profile;
  out[PUP_CP_LEVEL] = par->level;
  out[PUP_CP_WIDTH] = par->width;
  out[PUP_CP_HEIGHT] = par->height;
  out[PUP_CP_SAMPLE_RATE] = par->sample_rate;
  out[PUP_CP_CHANNELS] = par->ch_layout.nb_channels;
  out[PUP_CP_BITS_PER_CODED_SAMPLE] = par->bits_per_coded_sample;
  out[PUP_CP_BLOCK_ALIGN] = par->block_align;
  out[PUP_CP_BIT_RATE] = (int32_t)FFMIN(par->bit_rate, INT32_MAX);
  out[PUP_CP_FRAME_SIZE] = par->frame_size;
  out[PUP_CP_INITIAL_PADDING] = par->initial_padding;
  out[PUP_CP_CH_MASK_LO] = (int32_t)(mask & 0xffffffff);
  out[PUP_CP_CH_MASK_HI] = (int32_t)(mask >> 32);
}

EMSCRIPTEN_KEEPALIVE
const uint8_t *pup_demux_extradata(PupDemux *d, int i, int *size) {
  AVCodecParameters *par = d->fmt->streams[i]->codecpar;
  *size = par->extradata_size;
  return par->extradata;
}

/* Reads the next packet. Returns 0 on success, 1 at EOF, <0 on error.
 * The packet data stays valid until the next call. */
EMSCRIPTEN_KEEPALIVE
int pup_demux_read(PupDemux *d, double *out) {
  av_packet_unref(d->pkt);
  if (d->peek_count > 0) {
    av_packet_move_ref(d->pkt, d->peeked[d->peek_head]);
    av_packet_free(&d->peeked[d->peek_head]);
    d->peek_head++;
    if (--d->peek_count == 0) d->peek_head = 0;
  } else {
    int ret = av_read_frame(d->fmt, d->pkt);
    if (ret == AVERROR_EOF) return 1;
    if (ret < 0) return ret;
  }
  AVStream *st = d->fmt->streams[d->pkt->stream_index];
  out[PUP_PKT_STREAM] = d->pkt->stream_index;
  out[PUP_PKT_FLAGS] = (d->pkt->flags & AV_PKT_FLAG_KEY) ? 1 : 0;
  out[PUP_PKT_SIZE] = d->pkt->size;
  out[PUP_PKT_DATA] = (double)(uintptr_t)d->pkt->data;
  out[PUP_PKT_PTS] = to_us(d->pkt->pts, st->time_base, d->start_time);
  out[PUP_PKT_DTS] = to_us(d->pkt->dts, st->time_base, d->start_time);
  out[PUP_PKT_DURATION] = d->pkt->duration > 0 ? to_us(d->pkt->duration, st->time_base, 0) : NAN;
  return 0;
}

static int seek_raw(PupDemux *d, int64_t target) {
  int ret = avformat_seek_file(d->fmt, -1, INT64_MIN, target, target, 0);
  if (ret < 0) ret = av_seek_frame(d->fmt, -1, target, AVSEEK_FLAG_BACKWARD);
  if (ret < 0) ret = av_seek_frame(d->fmt, -1, target, AVSEEK_FLAG_ANY | AVSEEK_FLAG_BACKWARD);
  return ret;
}

/* Rewinds to byte 0, for formats whose time-based seeks can't reach the very
 * first keyframe (MPEG-TS). Only used after time seeks were tried. */
static int seek_to_start(PupDemux *d) {
  if (d->fmt->iformat->flags & AVFMT_NO_BYTE_SEEK) return AVERROR(ENOSYS);
  return av_seek_frame(d->fmt, -1, 0, AVSEEK_FLAG_BYTE);
}

/* Reads ahead to the first packet of `video`. Returns 1 if it is a keyframe
 * (or there is none to check), 0 if not; the packets stay queued. */
static int peek_starts_with_key(PupDemux *d, int video) {
  if (video < 0) return 1;
  while (d->peek_count < PUP_PEEK_MAX) {
    AVPacket *pkt = av_packet_alloc();
    if (!pkt) return 1;
    if (av_read_frame(d->fmt, pkt) < 0) {
      av_packet_free(&pkt);
      return 1; /* EOF or error: nothing better to find */
    }
    d->peeked[d->peek_count++] = pkt;
    if (pkt->stream_index == video) return (pkt->flags & AV_PKT_FLAG_KEY) != 0;
  }
  return 1;
}

/* Seeks so that reading resumes at or before `us` (timeline time), starting
 * on a keyframe of stream `video` (-1 to skip the check). Formats without an
 * index (MPEG-TS, ...) can land mid-GOP, so back off until a keyframe leads. */
EMSCRIPTEN_KEEPALIVE
int pup_demux_seek(PupDemux *d, double us, int video) {
  int64_t target = (int64_t)us + d->start_time;
  int64_t backoff = 0;
  int ret = 0;
  int64_t ts = target;
  for (int attempt = 0; attempt < 8; attempt++) {
    peek_clear(d);
    ts = target - backoff;
    if (ts < d->start_time) ts = d->start_time;
    if ((ret = seek_raw(d, ts)) < 0) break;
    if (peek_starts_with_key(d, video)) return 0;
    if (ts <= d->start_time) break;
    backoff = backoff ? backoff * 2 : AV_TIME_BASE / 2;
  }
  /* A failed seek can leave the position anywhere (generic seeking reads
   * ahead), and the start may still be mid-GOP: rewind by bytes if possible. */
  if (ret < 0 && ts > d->start_time) return ret;
  peek_clear(d);
  if (seek_to_start(d) < 0) return ret;
  peek_starts_with_key(d, video);
  return 0;
}

EMSCRIPTEN_KEEPALIVE
int pup_has_demuxer(const char *name) { return av_find_input_format(name) != NULL; }

EMSCRIPTEN_KEEPALIVE
void pup_error_string(int err, char *out, int cap) { av_strerror(err, out, cap); }

/* errno values differ under emscripten, so JS asks for them. */
EMSCRIPTEN_KEEPALIVE
int pup_err_eagain(void) { return AVERROR(EAGAIN); }

EMSCRIPTEN_KEEPALIVE
int pup_err_eof(void) { return AVERROR_EOF; }
