// Codec set definitions shared with the FFmpeg build (configs/*.json). Imported as JSON so the
// lists the wasm was configured with and the ones canPlayType() checks never drift apart.
import full from '../../configs/full.json' with { type: 'json' };
import lite from '../../configs/lite.json' with { type: 'json' };

export interface CodecConfig {
  /** Extra FFmpeg configure flags. */
  configure?: string[];
  /** Extra emscripten flags (ports). */
  emflags?: string[];
  demuxers: string[];
  decoders: string[];
  parsers: string[];
  bsfs: string[];
}

export const fullConfig = full as CodecConfig;
export const liteConfig = lite as CodecConfig;
