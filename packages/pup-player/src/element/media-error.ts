import type { MediaErrorCode } from '../engine/protocol.js';

/** Mirrors the HTMLMediaElement MediaError interface. */
export class PupMediaError implements MediaError {
  static readonly MEDIA_ERR_ABORTED = 1;
  static readonly MEDIA_ERR_NETWORK = 2;
  static readonly MEDIA_ERR_DECODE = 3;
  static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
  readonly MEDIA_ERR_ABORTED = 1;
  readonly MEDIA_ERR_NETWORK = 2;
  readonly MEDIA_ERR_DECODE = 3;
  readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

  constructor(
    readonly code: MediaErrorCode,
    readonly message: string,
  ) {}
}
