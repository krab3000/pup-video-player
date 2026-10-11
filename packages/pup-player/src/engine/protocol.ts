// Messages between the main thread, the demux worker, the decode worker and
// the audio worklet. Every message that refers to a playback position carries
// an `epoch`; a load or seek bumps it and receivers drop older messages.

import type { CodecSet, Packet, StreamInfo } from '@pup/wasm';

export type Source = { kind: 'url'; url: string; withCredentials: boolean } | { kind: 'blob'; blob: Blob };

export interface MediaInfo {
  format: string;
  /** Seconds; Infinity when unknown. */
  duration: number;
  streams: StreamInfo[];
  /** Index of the chosen video/audio stream, -1 if none. */
  video: number;
  audio: number;
}

export type AudioMode = 'play' | 'discard';

// main -> demux
export type ToDemux =
  | { type: 'init'; set: CodecSet; decodePort: MessagePort }
  | { type: 'open'; epoch: number; source: Source }
  | { type: 'close' };

// demux -> main
export type FromDemux =
  | { type: 'opened'; epoch: number; info: MediaInfo }
  | { type: 'progress'; epoch: number; size: number; loaded: number; ranges: Array<[number, number]> }
  | { type: 'error'; epoch: number; code: MediaErrorCode; message: string };

// decode -> demux (over the direct MessageChannel)
export type DecodeToDemux =
  | { type: 'seek'; epoch: number; time: number; streams: number[]; video: number }
  | { type: 'want'; epoch: number };

// demux -> decode
export type DemuxToDecode = { type: 'packets'; epoch: number; packets: Packet[]; eof: boolean };

export interface DecodeConfig {
  video: StreamInfo | null;
  audio: StreamInfo | null;
  sampleRate: number;
  rate: number;
}

// main -> decode
export type ToDecode =
  | {
      type: 'init';
      set: CodecSet;
      threads: number;
      forceSoftware: boolean;
      demuxPort: MessagePort;
      audioPort: MessagePort;
    }
  | { type: 'configure'; epoch: number; config: DecodeConfig }
  | { type: 'seek'; epoch: number; time: number; audioMode: AudioMode }
  /** `time`: current media time; queued audio after it is re-decoded at the new rate. */
  | { type: 'rate'; rate: number; time: number }
  | { type: 'consumed'; epoch: number; frames: number }
  | { type: 'reset' };

// decode -> main
export type FromDecode =
  | { type: 'ready'; threading: 'st' | 'mt' }
  | { type: 'configured'; epoch: number; videoDecoder: 'webcodecs' | 'software' | 'none' }
  | { type: 'frame'; epoch: number; frame: VideoFrame }
  | {
      type: 'levels';
      epoch: number;
      /** Seconds of audio decoded but not yet played. */
      audioAhead: number;
      videoEos: boolean;
      audioEos: boolean;
      /** Highest media time demuxed so far (seconds). */
      bufferedEnd: number;
    }
  | { type: 'seekReady'; epoch: number }
  /** WebCodecs failed mid-stream and decoding switched to software; main re-seeks. */
  | { type: 'fallback'; epoch: number }
  | { type: 'error'; epoch: number; code: MediaErrorCode; message: string }
  | { type: 'stats'; decodedFrames: number; decodeFps: number };

// decode -> worklet
export type ToWorkletData =
  | { type: 'chunk'; epoch: number; pts: number; rate: number; channels: Float32Array[] }
  | { type: 'eos'; epoch: number }
  /** Drop queued audio; re-decoded audio follows (rate change). */
  | { type: 'truncate'; epoch: number };

// worklet -> decode
export type WorkletToDecode = { type: 'buffered'; epoch: number; seconds: number };

// main -> worklet (node.port)
export type ToWorklet =
  | { type: 'port'; port: MessagePort }
  | { type: 'flush'; epoch: number }
  | { type: 'play' }
  | { type: 'pause' };

// worklet -> main (node.port)
export type FromWorklet = {
  type: 'pos';
  epoch: number;
  /** Media time of the sample being rendered when `contextTime` started. */
  mediaTime: number;
  contextTime: number;
  rate: number;
  starved: boolean;
  ended: boolean;
  buffered: number;
};

/** HTMLMediaElement MediaError codes. */
export const MediaErrorCode = {
  Aborted: 1,
  Network: 2,
  Decode: 3,
  SrcNotSupported: 4,
} as const;
export type MediaErrorCode = (typeof MediaErrorCode)[keyof typeof MediaErrorCode];
