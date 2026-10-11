#include <string.h>

#include <emscripten/emscripten.h>
#include <libavutil/aes.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>

/* Decrypts `len` bytes of AES-128-CBC in place (HLS METHOD=AES-128) and
 * strips the PKCS#7 padding. `iv` is not modified. Returns the plaintext
 * length, or a negative AVERROR. */
EMSCRIPTEN_KEEPALIVE
int pup_aes128_cbc_decrypt(const uint8_t *key, const uint8_t *iv, uint8_t *buf, int len) {
  if (len <= 0 || len % 16) return AVERROR_INVALIDDATA;
  struct AVAES *aes = av_aes_alloc();
  if (!aes) return AVERROR(ENOMEM);
  uint8_t chain[16];
  memcpy(chain, iv, sizeof(chain));
  int ret = av_aes_init(aes, key, 128, 1);
  /* CBC decryption reads each block before writing it, so it works in place. */
  if (ret >= 0) av_aes_crypt(aes, buf, buf, len / 16, chain, 1);
  av_free(aes);
  if (ret < 0) return ret;

  int pad = buf[len - 1];
  if (pad < 1 || pad > 16) return AVERROR_INVALIDDATA;
  for (int i = len - pad; i < len; i++) {
    if (buf[i] != pad) return AVERROR_INVALIDDATA;
  }
  return len - pad;
}
