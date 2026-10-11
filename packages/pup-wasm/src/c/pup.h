#ifndef PUP_H
#define PUP_H

#include <stdint.h>
#include <libavcodec/avcodec.h>

/*
 * Flat C API exported to JS. All times crossing the boundary are microseconds
 * as doubles (NaN = unknown). Structured outputs are written into caller-owned
 * double arrays; the slot layouts are mirrored in src/ts/bindings.ts.
 */

/* Codec parameters travel between wasm instances as an int32 array. */
enum {
  PUP_CP_TYPE,
  PUP_CP_CODEC_ID,
  PUP_CP_CODEC_TAG,
  PUP_CP_FORMAT,
  PUP_CP_PROFILE,
  PUP_CP_LEVEL,
  PUP_CP_WIDTH,
  PUP_CP_HEIGHT,
  PUP_CP_SAMPLE_RATE,
  PUP_CP_CHANNELS,
  PUP_CP_BITS_PER_CODED_SAMPLE,
  PUP_CP_BLOCK_ALIGN,
  PUP_CP_BIT_RATE,
  PUP_CP_FRAME_SIZE,
  PUP_CP_INITIAL_PADDING,
  PUP_CP_CH_MASK_LO,
  PUP_CP_CH_MASK_HI,
  PUP_CP_COUNT
};

/* pup_demux_read output slots. */
enum {
  PUP_PKT_STREAM,
  PUP_PKT_FLAGS, /* bit 0: keyframe */
  PUP_PKT_SIZE,
  PUP_PKT_DATA,
  PUP_PKT_PTS,
  PUP_PKT_DTS,
  PUP_PKT_DURATION,
  PUP_PKT_COUNT
};

/* pup_dec_video_frame output slots. Data is I420, tightly packed. */
enum {
  PUP_VF_WIDTH,
  PUP_VF_HEIGHT,
  PUP_VF_DISPLAY_WIDTH,
  PUP_VF_DISPLAY_HEIGHT,
  PUP_VF_PTS,
  PUP_VF_DURATION,
  PUP_VF_DATA,
  PUP_VF_SIZE,
  PUP_VF_FULL_RANGE,
  PUP_VF_MATRIX, /* AVColorSpace */
  PUP_VF_COUNT
};

/* pup_dec_audio_frame output slots. Data is planar float32 stereo [ch][frames]. */
enum {
  PUP_AF_FRAMES,
  PUP_AF_CHANNELS,
  PUP_AF_SAMPLE_RATE,
  PUP_AF_PTS,
  PUP_AF_DATA,
  PUP_AF_COUNT
};

/* Implemented in JS (pup_io.js). Returns bytes read, 0 at EOF, <0 on error. */
extern int pup_js_read(int io, uint8_t *buf, int size, double pos);
/* Total size in bytes, or <0 if unknown. */
extern double pup_js_size(int io);

/* Builds a WebCodecs codec string for a stream; empty string if unsupported. */
void pup_webcodecs_codec(const AVCodecParameters *par, char *out, int cap);

#endif
