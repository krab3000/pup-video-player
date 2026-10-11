#include <math.h>
#include <stdio.h>
#include <string.h>

#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>

#include "pup.h"

static const AVRational US = {1, 1000000};

typedef struct PupDecoder {
  AVCodecContext *ctx;
  AVPacket *pkt;
  AVFrame *frame; /* decoder output */
  int draining;

  /* video: everything is converted to tightly packed I420 */
  struct SwsContext *sws;
  uint8_t *vbuf;
  int vbuf_size;

  /* audio: abuffer -> atempo* -> aformat(fltp, out_rate) -> abuffersink */
  AVFilterGraph *graph;
  AVFilterContext *src, *sink;
  AVFrame *filtered;
  int out_rate;
  double tempo;
  double base_pts;       /* media time (us) of the first sample fed since reset */
  int64_t out_samples;   /* samples pulled from the sink since reset */
  int graph_eof;
  float *abuf;
  int abuf_cap;
} PupDecoder;

static void graph_free(PupDecoder *d) {
  avfilter_graph_free(&d->graph);
  d->src = d->sink = NULL;
  d->base_pts = NAN;
  d->out_samples = 0;
  d->graph_eof = 0;
}

static int graph_init(PupDecoder *d, const AVFrame *f) {
  char args[256], layout[64];
  int ret;
  graph_free(d);
  d->graph = avfilter_graph_alloc();
  if (!d->graph) return AVERROR(ENOMEM);
  /* The graph runs on the decoder thread; filter threads only add overhead. */
  d->graph->nb_threads = 1;

  /* Some containers (NUT, raw PCM) carry only a channel count; filters need a layout. */
  AVChannelLayout ch_layout = {0};
  if (f->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC)
    av_channel_layout_default(&ch_layout, f->ch_layout.nb_channels);
  else if ((ret = av_channel_layout_copy(&ch_layout, &f->ch_layout)) < 0)
    return ret;
  av_channel_layout_describe(&ch_layout, layout, sizeof(layout));
  av_channel_layout_uninit(&ch_layout);
  snprintf(args, sizeof(args), "time_base=1/%d:sample_rate=%d:sample_fmt=%s:channel_layout=%s", f->sample_rate,
           f->sample_rate, av_get_sample_fmt_name(f->format), layout);
  if ((ret = avfilter_graph_create_filter(&d->src, avfilter_get_by_name("abuffer"), "in", args, NULL, d->graph)) < 0)
    return ret;
  if ((ret = avfilter_graph_create_filter(&d->sink, avfilter_get_by_name("abuffersink"), "out", NULL, NULL,
                                          d->graph)) < 0)
    return ret;

  /* atempo accepts 0.5..100 per instance; chain instances for slower rates. */
  char chain[192] = "";
  int len = 0;
  double t = d->tempo;
  while (t < 0.5) {
    len += snprintf(chain + len, sizeof(chain) - len, "atempo=0.5,");
    t /= 0.5;
  }
  if (fabs(t - 1.0) > 1e-6) len += snprintf(chain + len, sizeof(chain) - len, "atempo=%f,", t);
  snprintf(chain + len, sizeof(chain) - len, "aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo", d->out_rate);

  AVFilterInOut *outputs = avfilter_inout_alloc();
  AVFilterInOut *inputs = avfilter_inout_alloc();
  outputs->name = av_strdup("in");
  outputs->filter_ctx = d->src;
  inputs->name = av_strdup("out");
  inputs->filter_ctx = d->sink;
  ret = avfilter_graph_parse_ptr(d->graph, chain, &inputs, &outputs, NULL);
  avfilter_inout_free(&inputs);
  avfilter_inout_free(&outputs);
  if (ret < 0) return ret;
  return avfilter_graph_config(d->graph, NULL);
}

/* Opens a decoder from codec parameters produced by pup_demux_codecpar. */
EMSCRIPTEN_KEEPALIVE
PupDecoder *pup_dec_open(const int32_t *cp, const uint8_t *extradata, int extradata_size, int threads, int out_rate,
                         int *err) {
  int ret = AVERROR(ENOMEM);
  PupDecoder *d = av_mallocz(sizeof(*d));
  if (!d) goto fail;
  d->tempo = 1.0;
  d->base_pts = NAN;
  d->out_rate = out_rate > 0 ? out_rate : 48000;

  const AVCodec *codec = avcodec_find_decoder(cp[PUP_CP_CODEC_ID]);
  if (!codec) {
    ret = AVERROR_DECODER_NOT_FOUND;
    goto fail;
  }
  d->ctx = avcodec_alloc_context3(codec);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  d->filtered = av_frame_alloc();
  if (!d->ctx || !d->pkt || !d->frame || !d->filtered) goto fail;

  AVCodecContext *c = d->ctx;
  c->codec_tag = cp[PUP_CP_CODEC_TAG];
  c->profile = cp[PUP_CP_PROFILE];
  c->level = cp[PUP_CP_LEVEL];
  c->width = cp[PUP_CP_WIDTH];
  c->height = cp[PUP_CP_HEIGHT];
  c->sample_rate = cp[PUP_CP_SAMPLE_RATE];
  c->bits_per_coded_sample = cp[PUP_CP_BITS_PER_CODED_SAMPLE];
  c->block_align = cp[PUP_CP_BLOCK_ALIGN];
  c->bit_rate = cp[PUP_CP_BIT_RATE];
  c->frame_size = cp[PUP_CP_FRAME_SIZE];
  c->initial_padding = cp[PUP_CP_INITIAL_PADDING];
  if (cp[PUP_CP_TYPE] == AVMEDIA_TYPE_VIDEO) c->pix_fmt = cp[PUP_CP_FORMAT];
  if (cp[PUP_CP_TYPE] == AVMEDIA_TYPE_AUDIO) {
    c->sample_fmt = cp[PUP_CP_FORMAT];
    uint64_t mask = (uint64_t)(uint32_t)cp[PUP_CP_CH_MASK_LO] | (uint64_t)(uint32_t)cp[PUP_CP_CH_MASK_HI] << 32;
    if (mask && av_popcount64(mask) == cp[PUP_CP_CHANNELS])
      av_channel_layout_from_mask(&c->ch_layout, mask);
    else if (cp[PUP_CP_CHANNELS] > 0)
      av_channel_layout_default(&c->ch_layout, cp[PUP_CP_CHANNELS]);
  }
  if (extradata_size > 0) {
    c->extradata = av_mallocz(extradata_size + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!c->extradata) goto fail;
    memcpy(c->extradata, extradata, extradata_size);
    c->extradata_size = extradata_size;
  }
  c->pkt_timebase = US;
  c->thread_count = threads > 0 ? threads : 1;
  c->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;

  if ((ret = avcodec_open2(c, codec, NULL)) < 0) goto fail;
  return d;

fail:
  if (err) *err = ret;
  if (d) {
    avcodec_free_context(&d->ctx);
    av_packet_free(&d->pkt);
    av_frame_free(&d->frame);
    av_frame_free(&d->filtered);
    av_free(d);
  }
  return NULL;
}

EMSCRIPTEN_KEEPALIVE
void pup_dec_close(PupDecoder *d) {
  if (!d) return;
  graph_free(d);
  sws_freeContext(d->sws);
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  av_frame_free(&d->filtered);
  av_free(d->vbuf);
  av_free(d->abuf);
  av_free(d);
}

/* Feeds one packet (data == NULL starts draining). Returns 0, AVERROR(EAGAIN)
 * if output must be read first, or another negative error. */
EMSCRIPTEN_KEEPALIVE
int pup_dec_send(PupDecoder *d, const uint8_t *data, int size, double pts, double dts, double duration, int key) {
  if (!data) {
    d->draining = 1;
    return avcodec_send_packet(d->ctx, NULL);
  }
  /* An empty packet would put the decoder into draining mode; some muxers
   * (NUT, MKV) emit them for side data only. */
  if (size <= 0) return 0;
  av_packet_unref(d->pkt);
  int ret = av_new_packet(d->pkt, size);
  if (ret < 0) return ret;
  memcpy(d->pkt->data, data, size);
  d->pkt->pts = isnan(pts) ? AV_NOPTS_VALUE : (int64_t)pts;
  d->pkt->dts = isnan(dts) ? AV_NOPTS_VALUE : (int64_t)dts;
  d->pkt->duration = isnan(duration) ? 0 : (int64_t)duration;
  if (key) d->pkt->flags |= AV_PKT_FLAG_KEY;
  d->pkt->time_base = US;
  return avcodec_send_packet(d->ctx, d->pkt);
}

EMSCRIPTEN_KEEPALIVE
void pup_dec_flush(PupDecoder *d) {
  avcodec_flush_buffers(d->ctx);
  d->draining = 0;
  graph_free(d);
}

static double frame_pts(const AVFrame *f) {
  int64_t ts = f->best_effort_timestamp != AV_NOPTS_VALUE ? f->best_effort_timestamp : f->pts;
  return ts == AV_NOPTS_VALUE ? NAN : (double)ts;
}

/* Receives the next video frame as I420. Returns 0 with `out` filled,
 * AVERROR(EAGAIN) if more input is needed, AVERROR_EOF when drained. */
EMSCRIPTEN_KEEPALIVE
int pup_dec_video_frame(PupDecoder *d, double *out) {
  AVFrame *f = d->frame;
  int ret = avcodec_receive_frame(d->ctx, f);
  if (ret < 0) return ret;

  int w = f->width, h = f->height;
  int cw = (w + 1) / 2, ch = (h + 1) / 2;
  int size = w * h + 2 * cw * ch;
  if (size > d->vbuf_size) {
    av_free(d->vbuf);
    d->vbuf = av_malloc(size);
    d->vbuf_size = d->vbuf ? size : 0;
    if (!d->vbuf) return AVERROR(ENOMEM);
  }
  uint8_t *dst[4] = {d->vbuf, d->vbuf + w * h, d->vbuf + w * h + cw * ch, NULL};
  int dst_stride[4] = {w, cw, cw, 0};

  int full_range = f->color_range == AVCOL_RANGE_JPEG || f->format == AV_PIX_FMT_YUVJ420P;
  if (f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P) {
    av_image_copy2(dst, dst_stride, f->data, f->linesize, AV_PIX_FMT_YUV420P, w, h);
  } else {
    d->sws = sws_getCachedContext(d->sws, w, h, f->format, w, h, AV_PIX_FMT_YUV420P, SWS_BILINEAR, NULL, NULL, NULL);
    if (!d->sws) return AVERROR(EINVAL);
    if (f->format == AV_PIX_FMT_YUVJ422P || f->format == AV_PIX_FMT_YUVJ444P) full_range = 1;
    sws_scale(d->sws, (const uint8_t *const *)f->data, f->linesize, 0, h, dst, dst_stride);
  }

  AVRational sar = f->sample_aspect_ratio;
  int dw = w, dh = h;
  if (sar.num > 0 && sar.den > 0 && sar.num != sar.den) dw = (int)lrint((double)w * sar.num / sar.den);

  out[PUP_VF_WIDTH] = w;
  out[PUP_VF_HEIGHT] = h;
  out[PUP_VF_DISPLAY_WIDTH] = dw;
  out[PUP_VF_DISPLAY_HEIGHT] = dh;
  out[PUP_VF_PTS] = frame_pts(f);
  out[PUP_VF_DURATION] = f->duration > 0 ? (double)f->duration : NAN;
  out[PUP_VF_DATA] = (double)(uintptr_t)d->vbuf;
  out[PUP_VF_SIZE] = size;
  out[PUP_VF_FULL_RANGE] = full_range;
  out[PUP_VF_MATRIX] = f->colorspace;
  av_frame_unref(f);
  return 0;
}

/* Changes the audio tempo (playbackRate). Takes effect from the next frame. */
EMSCRIPTEN_KEEPALIVE
void pup_dec_set_tempo(PupDecoder *d, double tempo) {
  if (tempo <= 0 || fabs(tempo - d->tempo) < 1e-6) return;
  d->tempo = tempo;
  graph_free(d);
}

static int pull_filtered(PupDecoder *d, double *out) {
  AVFrame *f = d->filtered;
  int ret = av_buffersink_get_frame(d->sink, f);
  if (ret < 0) return ret;
  int n = f->nb_samples, chs = f->ch_layout.nb_channels;
  if (n * chs > d->abuf_cap) {
    av_free(d->abuf);
    d->abuf = av_malloc(sizeof(float) * n * chs);
    d->abuf_cap = d->abuf ? n * chs : 0;
    if (!d->abuf) return AVERROR(ENOMEM);
  }
  for (int c = 0; c < chs; c++) memcpy(d->abuf + c * n, f->extended_data[c], sizeof(float) * n);
  out[PUP_AF_FRAMES] = n;
  out[PUP_AF_CHANNELS] = chs;
  out[PUP_AF_SAMPLE_RATE] = f->sample_rate;
  /* Media time of the first sample: output samples advance media time by `tempo`. */
  out[PUP_AF_PTS] = d->base_pts + (double)d->out_samples * d->tempo * 1e6 / f->sample_rate;
  out[PUP_AF_DATA] = (double)(uintptr_t)d->abuf;
  d->out_samples += n;
  av_frame_unref(f);
  return 0;
}

/* Receives the next chunk of planar float audio at the output rate.
 * Same return convention as pup_dec_video_frame. */
EMSCRIPTEN_KEEPALIVE
int pup_dec_audio_frame(PupDecoder *d, double *out) {
  for (;;) {
    if (d->graph) {
      int ret = pull_filtered(d, out);
      if (ret != AVERROR(EAGAIN)) return ret;
      if (d->graph_eof) return AVERROR_EOF;
    }
    int ret = avcodec_receive_frame(d->ctx, d->frame);
    if (ret == AVERROR_EOF && d->graph && !d->graph_eof) {
      d->graph_eof = 1;
      if ((ret = av_buffersrc_add_frame(d->src, NULL)) < 0) return ret;
      continue;
    }
    if (ret < 0) return ret;
    if (!d->graph) {
      if ((ret = graph_init(d, d->frame)) < 0) {
        av_frame_unref(d->frame);
        return ret;
      }
    }
    if (isnan(d->base_pts)) d->base_pts = frame_pts(d->frame);
    if (isnan(d->base_pts)) d->base_pts = 0;
    /* The graph's own timestamps are unused; we track media time ourselves. */
    d->frame->pts = AV_NOPTS_VALUE;
    ret = av_buffersrc_add_frame_flags(d->src, d->frame, AV_BUFFERSRC_FLAG_KEEP_REF);
    av_frame_unref(d->frame);
    if (ret < 0) return ret;
  }
}

EMSCRIPTEN_KEEPALIVE
int pup_has_decoder(int codec_id) { return avcodec_find_decoder(codec_id) != NULL; }

EMSCRIPTEN_KEEPALIVE
int pup_has_decoder_name(const char *name) { return avcodec_find_decoder_by_name(name) != NULL; }
