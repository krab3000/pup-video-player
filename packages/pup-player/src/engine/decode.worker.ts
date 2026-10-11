// Decode worker: video through WebCodecs when supported (FFmpeg otherwise),
// audio always through FFmpeg. Pulls packets from the demux worker while its
// output queues are below target, sends VideoFrames to the main thread and
// PCM straight to the audio worklet.

import { Decoder, loadCore, type Core, type DecodedAudio, type DecodedVideo, type Packet, type StreamInfo } from '@pup/wasm';
import {
  MediaErrorCode,
  type AudioMode,
  type DecodeConfig,
  type DecodeToDemux,
  type DemuxToDecode,
  type FromDecode,
  type ToDecode,
  type ToWorkletData,
  type WorkletToDecode,
} from './protocol';

/** VideoFrames sent to main and not yet consumed. */
const VIDEO_AHEAD = 6;
/** Seconds of audio queued in the worklet. */
const AUDIO_AHEAD = 0.5;
const WEBCODECS_QUEUE = 4;
/** Stop asking for packets if one stream's backlog grows this large (bad interleaving). */
const MAX_PENDING = 600;
const SLICE_MS = 12;
const MAX_CONSECUTIVE_ERRORS = 20;

let core: Core;
let ready: Promise<void>;
let demuxPort: MessagePort;
let audioPort: MessagePort;
let forceSoftware = false;
let threads = 1;

let epoch = 0;
let config: DecodeConfig | null = null;
let rate = 1;

// video
let videoInfo: StreamInfo | null = null;
let webcodecs: VideoDecoder | null = null;
let webcodecsConfig: VideoDecoderConfig | null = null;
let software: Decoder | null = null;
let videoPending: Packet[] = [];
let videoInFlight = 0;
let videoEos = false;
let videoFlushing = false;
let needKey = true;
let frameDuration = 1 / 30;
/** Latest frame decoded before the seek target. */
let heldFrame: VideoFrame | null = null;

// audio
let audioDecoder: Decoder | null = null;
let audioMode: AudioMode = 'play';
let audioPending: Packet[] = [];
let audioReported = 0;
let audioSentSinceReport = 0;
let audioEos = false;
/** Recently decoded audio packets, re-decoded when the rate changes. */
let audioHistory: Packet[] = [];
/** Audio before this media time is dropped (seek target, rate change point). */
let audioTrim = 0;
const AUDIO_HISTORY_US = 3e6;

// position / flow
let seekTarget = 0;
let firstVideoSent = false;
let firstAudioSent = false;
let seekReadySent = true;
let demuxEof = false;
let wantOutstanding = false;
let bufferedEnd = 0;
let errors = 0;

// stats
let decodedFrames = 0;
let statsFrames = 0;
let statsAt = performance.now();
let lastLevels = '';

const post = (msg: FromDecode, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

// Main-thread and demux messages run strictly in order (configure is async).
let queue: Promise<void> = Promise.resolve();
const enqueue = (fn: () => void | Promise<void>) => {
  queue = queue.then(fn).catch((e) => fatal(MediaErrorCode.Decode, (e as Error).message));
};

self.onmessage = (e: MessageEvent<ToDecode>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    forceSoftware = msg.forceSoftware;
    demuxPort = msg.demuxPort;
    audioPort = msg.audioPort;
    demuxPort.onmessage = (ev: MessageEvent<DemuxToDecode>) => enqueue(() => onPackets(ev.data));
    audioPort.onmessage = (ev: MessageEvent<WorkletToDecode>) => onWorklet(ev.data);
    ready = loadCore({ set: msg.set, pthreadPoolSize: msg.threads }).then((c) => {
      core = c;
      threads = c.threading === 'mt' ? msg.threads : 1;
      post({ type: 'ready', threading: c.threading });
    });
    enqueue(() => ready);
    return;
  }
  enqueue(() => onMain(msg));
};

async function onMain(msg: ToDecode): Promise<void> {
  switch (msg.type) {
    case 'configure':
      await configure(msg.epoch, msg.config);
      break;
    case 'seek':
      seek(msg.epoch, msg.time, msg.audioMode);
      break;
    case 'rate':
      changeRate(msg.rate, msg.time);
      break;
    case 'consumed':
      if (msg.epoch === epoch) videoInFlight = Math.max(0, videoInFlight - msg.frames);
      schedule();
      break;
    case 'reset':
      teardown();
      break;
  }
}

function onWorklet(msg: WorkletToDecode): void {
  if (msg.epoch !== epoch) return;
  audioReported = msg.seconds;
  audioSentSinceReport = 0;
  schedule();
}

// ---------------------------------------------------------------------------
// Configuration

function teardown(): void {
  epoch = -1;
  config = null;
  if (webcodecs && webcodecs.state !== 'closed') webcodecs.close();
  webcodecs = null;
  webcodecsConfig = null;
  software?.close();
  software = null;
  audioDecoder?.close();
  audioDecoder = null;
  videoInfo = null;
  videoPending = [];
  audioPending = [];
  heldFrame?.close();
  heldFrame = null;
}

function webcodecsConfigFor(s: StreamInfo): VideoDecoderConfig {
  const cfg: VideoDecoderConfig = {
    codec: s.webcodecs,
    codedWidth: s.width || undefined,
    codedHeight: s.height || undefined,
    hardwareAcceleration: 'no-preference',
  };
  // avcC / hvcC carry SPS/PPS and mean length-prefixed packets; Annex B
  // streams (MPEG-TS) are configured without a description.
  if ((s.codec === 'h264' || s.codec === 'hevc') && s.extradata[0] === 1) cfg.description = s.extradata;
  if (s.sarNum > 0 && s.sarDen > 0 && s.sarNum !== s.sarDen) {
    cfg.displayAspectWidth = Math.round(s.width * s.sarNum / s.sarDen);
    cfg.displayAspectHeight = s.height;
  }
  return cfg;
}

async function configure(newEpoch: number, cfg: DecodeConfig): Promise<void> {
  teardown();
  epoch = newEpoch;
  config = cfg;
  rate = cfg.rate;
  videoInfo = cfg.video;
  let videoDecoder: 'webcodecs' | 'software' | 'none' = 'none';

  if (cfg.video) {
    frameDuration = cfg.video.fps > 0 ? 1 / cfg.video.fps : 1 / 30;
    if (!forceSoftware && cfg.video.webcodecs && typeof VideoDecoder !== 'undefined') {
      const wcConfig = webcodecsConfigFor(cfg.video);
      const support = await VideoDecoder.isConfigSupported(wcConfig).catch(() => ({ supported: false }));
      if (support.supported) {
        webcodecsConfig = wcConfig;
        webcodecs = createWebCodecs();
        videoDecoder = 'webcodecs';
      }
    }
    if (videoDecoder === 'none' && openSoftware()) videoDecoder = 'software';
    if (videoDecoder === 'none') videoInfo = null;
  }
  if (cfg.audio) {
    try {
      audioDecoder = Decoder.open(core, cfg.audio.codecpar, cfg.audio.extradata, { sampleRate: cfg.sampleRate });
      audioDecoder.setTempo(rate);
    } catch (e) {
      console.warn('[pup decode] audio decoder unavailable:', (e as Error).message);
    }
  }
  if (!videoInfo && !audioDecoder) {
    fatal(MediaErrorCode.SrcNotSupported, `no decoder for ${[cfg.video?.codec, cfg.audio?.codec].filter(Boolean).join(', ')}`);
    return;
  }
  post({ type: 'configured', epoch, videoDecoder });
}

function openSoftware(): boolean {
  if (!videoInfo || !core.hasDecoder(videoInfo.codecId)) return false;
  try {
    software = Decoder.open(core, videoInfo.codecpar, videoInfo.extradata, { threads });
    return true;
  } catch (e) {
    console.warn('[pup decode] software video decoder failed:', (e as Error).message);
    return false;
  }
}

function createWebCodecs(): VideoDecoder {
  const dec = new VideoDecoder({
    output: (frame) => onVideoFrame(frame, frame.timestamp / 1e6, (frame.duration ?? 0) / 1e6),
    error: (e) => onWebCodecsError(dec, e),
  });
  dec.configure(webcodecsConfig!);
  dec.addEventListener('dequeue', schedule);
  return dec;
}

function onWebCodecsError(dec: VideoDecoder, e: DOMException): void {
  if (dec !== webcodecs) return; // a decoder we already replaced
  console.warn('[pup decode] WebCodecs error, falling back to software:', e.message);
  webcodecs = null;
  if (openSoftware()) {
    post({ type: 'fallback', epoch });
  } else {
    fatal(MediaErrorCode.Decode, `video decode failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Seeking and packet intake

function seek(newEpoch: number, time: number, mode: AudioMode): void {
  if (!config) return;
  epoch = newEpoch;
  seekTarget = audioTrim = time;
  audioMode = mode;
  videoPending = [];
  audioPending = [];
  audioHistory = [];
  videoInFlight = 0;
  videoEos = videoFlushing = false;
  audioEos = false;
  needKey = true;
  heldFrame?.close();
  heldFrame = null;
  firstVideoSent = firstAudioSent = false;
  seekReadySent = false;
  demuxEof = false;
  wantOutstanding = false;
  audioReported = 0;
  audioSentSinceReport = 0;
  bufferedEnd = time;
  errors = 0;
  lastLevels = '';

  if (webcodecs) {
    webcodecs.reset();
    webcodecs.configure(webcodecsConfig!);
  }
  software?.flush();
  audioDecoder?.flush();

  const streams: number[] = [];
  if (videoInfo) streams.push(videoInfo.index);
  if (audioActive()) streams.push(config.audio!.index);
  demuxPort.postMessage({ type: 'seek', epoch, time, streams, video: videoInfo?.index ?? -1 } satisfies DecodeToDemux);
  schedule();
}

const videoActive = () => videoInfo !== null && (webcodecs !== null || software !== null);
const audioActive = () => audioDecoder !== null && audioMode === 'play';
const audioAhead = () => audioReported + audioSentSinceReport;

function onPackets(msg: DemuxToDecode): void {
  if (msg.epoch !== epoch || !config) return;
  wantOutstanding = false;
  for (const pkt of msg.packets) {
    if (videoInfo && pkt.stream === videoInfo.index) videoPending.push(pkt);
    else if (config.audio && pkt.stream === config.audio.index) audioPending.push(pkt);
    const t = (Number.isFinite(pkt.pts) ? pkt.pts : pkt.dts) / 1e6;
    if (Number.isFinite(t) && t > bufferedEnd) bufferedEnd = t;
  }
  if (msg.eof) demuxEof = true;
  schedule();
}

// ---------------------------------------------------------------------------
// Pump

let scheduled = false;
const tick = new MessageChannel();
tick.port1.onmessage = () => {
  scheduled = false;
  enqueue(pump);
};

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  tick.port2.postMessage(null);
}

function pump(): void {
  if (!config || epoch < 0) return;
  const deadline = performance.now() + SLICE_MS;
  let more = false;

  // Audio first: cheap, and starving it is audible.
  if (audioActive()) {
    while (audioPending.length && audioAhead() < AUDIO_AHEAD && performance.now() < deadline) {
      decodeAudio(audioPending.shift()!);
    }
    if (!audioPending.length && demuxEof && !audioEos) finishAudio();
    more ||= audioPending.length > 0 && audioAhead() < AUDIO_AHEAD;
  }

  if (videoActive()) {
    if (webcodecs) {
      while (videoPending.length && webcodecs.decodeQueueSize < WEBCODECS_QUEUE && videoInFlight < VIDEO_AHEAD) {
        decodeWebCodecs(videoPending.shift()!);
      }
      if (!videoPending.length && demuxEof && !videoFlushing) {
        videoFlushing = true;
        const dec = webcodecs;
        dec.flush().then(
          () => dec === webcodecs && finishVideo(),
          () => {},
        );
      }
    } else if (software) {
      while (videoPending.length && videoInFlight < VIDEO_AHEAD && performance.now() < deadline) {
        decodeSoftware(videoPending.shift()!);
      }
      if (!videoPending.length && demuxEof && !videoEos) {
        software.send(null);
        drainSoftware();
        finishVideo();
      }
      more ||= videoPending.length > 0 && videoInFlight < VIDEO_AHEAD;
    }
  }

  requestPackets();
  sendLevels();
  sendStats();
  if (more) schedule();
}

function requestPackets(): void {
  if (demuxEof || wantOutstanding) return;
  if (videoPending.length > MAX_PENDING || audioPending.length > MAX_PENDING) return;
  const needVideo = videoActive() && videoPending.length < 4 && videoInFlight < VIDEO_AHEAD;
  const needAudio = audioActive() && audioPending.length < 4 && audioAhead() < AUDIO_AHEAD;
  if (!needVideo && !needAudio) return;
  wantOutstanding = true;
  demuxPort.postMessage({ type: 'want', epoch });
}

function maybeSeekReady(): void {
  if (seekReadySent) return;
  const videoReady = !videoActive() || firstVideoSent || videoEos;
  const audioReady = !audioActive() || firstAudioSent || audioEos;
  if (videoReady && audioReady) {
    seekReadySent = true;
    post({ type: 'seekReady', epoch });
  }
}

function sendLevels(force = false): void {
  const levels = {
    audioAhead: audioActive() ? audioAhead() : 0,
    videoEos: !videoActive() || videoEos,
    audioEos: !audioActive() || audioEos,
    bufferedEnd,
  };
  const key = `${levels.audioAhead.toFixed(1)}|${levels.videoEos}|${levels.audioEos}|${bufferedEnd.toFixed(1)}`;
  if (!force && key === lastLevels) return;
  lastLevels = key;
  post({ type: 'levels', epoch, ...levels });
}

function sendStats(): void {
  const now = performance.now();
  if (now - statsAt < 1000) return;
  post({ type: 'stats', decodedFrames, decodeFps: (statsFrames * 1000) / (now - statsAt) });
  statsFrames = 0;
  statsAt = now;
}

function fatal(code: MediaErrorCode, message: string): void {
  post({ type: 'error', epoch, code, message });
  teardown();
}

function decodeError(e: unknown): void {
  // Corrupt packets are skipped; a run of failures is fatal.
  if (++errors > MAX_CONSECUTIVE_ERRORS) fatal(MediaErrorCode.Decode, (e as Error).message);
}

// ---------------------------------------------------------------------------
// Video

function decodeWebCodecs(pkt: Packet): void {
  if (needKey && !pkt.key) return;
  needKey = false;
  const ts = Number.isFinite(pkt.pts) ? pkt.pts : Number.isFinite(pkt.dts) ? pkt.dts : 0;
  try {
    webcodecs!.decode(
      new EncodedVideoChunk({
        type: pkt.key ? 'key' : 'delta',
        timestamp: Math.round(ts),
        duration: Number.isFinite(pkt.duration) ? Math.round(pkt.duration) : undefined,
        data: pkt.data,
      }),
    );
  } catch (e) {
    onWebCodecsError(webcodecs!, e as DOMException);
  }
}

function decodeSoftware(pkt: Packet): void {
  try {
    while (!software!.send(pkt)) drainSoftware();
    drainSoftware();
    errors = 0;
  } catch (e) {
    decodeError(e);
  }
}

function drainSoftware(): void {
  for (;;) {
    const out = software!.video();
    if (out === 'again' || out === null) return;
    const pts = (Number.isFinite(out.pts) ? out.pts : 0) / 1e6;
    onVideoFrame(toVideoFrame(out), pts, Number.isFinite(out.duration) ? out.duration / 1e6 : frameDuration);
  }
}

const MATRIX: Record<number, VideoMatrixCoefficients> = {
  1: 'bt709',
  5: 'bt470bg',
  6: 'smpte170m',
  9: 'bt2020-ncl' as VideoMatrixCoefficients,
};

function toVideoFrame(f: DecodedVideo): VideoFrame {
  // Views into SharedArrayBuffer-backed memory are copied for portability.
  const data = core.threading === 'mt' ? f.data.slice() : f.data;
  return new VideoFrame(data, {
    format: 'I420',
    codedWidth: f.width,
    codedHeight: f.height,
    displayWidth: f.displayWidth,
    displayHeight: f.displayHeight,
    timestamp: Math.round(Number.isFinite(f.pts) ? f.pts : 0),
    duration: Number.isFinite(f.duration) ? Math.round(f.duration) : undefined,
    colorSpace: {
      fullRange: f.fullRange,
      matrix: MATRIX[f.matrix] ?? (f.height >= 720 ? 'bt709' : 'smpte170m'),
    },
  });
}

function onVideoFrame(frame: VideoFrame, pts: number, duration: number): void {
  decodedFrames++;
  statsFrames++;
  if (pts + (duration || frameDuration) <= seekTarget) {
    // Before the seek target: keep only the latest, in case the stream ends
    // before reaching the target (seek past the last frame).
    heldFrame?.close();
    heldFrame = frame;
    return;
  }
  heldFrame?.close();
  heldFrame = null;
  sendFrame(frame);
}

function sendFrame(frame: VideoFrame): void {
  videoInFlight++;
  firstVideoSent = true;
  post({ type: 'frame', epoch, frame }, [frame]);
  maybeSeekReady();
  schedule();
}

function finishVideo(): void {
  if (heldFrame) {
    if (!firstVideoSent) sendFrame(heldFrame);
    else heldFrame.close();
    heldFrame = null;
  }
  videoEos = true;
  maybeSeekReady();
  sendLevels(true);
}

// ---------------------------------------------------------------------------
// Audio

/**
 * Applies a new playbackRate to audio right away: the worklet drops what it
 * has queued and the retained packets from `time` on are decoded again.
 */
function changeRate(newRate: number, time: number): void {
  if (newRate === rate) return;
  rate = newRate;
  if (!audioDecoder) return;
  audioDecoder.setTempo(rate);
  if (!audioActive() || !audioHistory.length) return;
  audioDecoder.flush();
  // Restart a little early: decoders need a few packets of pre-roll.
  const from = Math.max(0, audioHistory.findIndex((p) => p.pts >= (time - 0.25) * 1e6));
  audioPending = [...audioHistory.slice(from), ...audioPending];
  audioHistory = audioHistory.slice(0, from);
  audioTrim = time;
  audioEos = false;
  audioReported = 0;
  audioSentSinceReport = 0;
  audioPort.postMessage({ type: 'truncate', epoch } satisfies ToWorkletData);
  schedule();
}

function decodeAudio(pkt: Packet): void {
  audioHistory.push(pkt);
  while (audioHistory.length > 1 && audioHistory[0].pts < pkt.pts - AUDIO_HISTORY_US) audioHistory.shift();
  try {
    while (!audioDecoder!.send(pkt)) drainAudio();
    drainAudio();
    errors = 0;
  } catch (e) {
    decodeError(e);
  }
}

function drainAudio(): void {
  for (;;) {
    const out = audioDecoder!.audio();
    if (out === 'again' || out === null) return;
    sendAudio(out);
  }
}

function sendAudio(out: DecodedAudio): void {
  const sr = out.sampleRate;
  let pts = out.pts / 1e6;
  let start = 0;
  if (pts + (out.frames * rate) / sr <= audioTrim) return;
  if (pts < audioTrim) {
    start = Math.min(out.frames, Math.floor(((audioTrim - pts) * sr) / rate));
    pts = audioTrim;
  }
  const n = out.frames;
  const channels: Float32Array[] = [];
  for (let c = 0; c < out.channels; c++) channels.push(out.data.slice(c * n + start, (c + 1) * n));
  const msg: ToWorkletData = { type: 'chunk', epoch, pts, rate, channels };
  audioPort.postMessage(msg, channels.map((ch) => ch.buffer));
  audioSentSinceReport += (n - start) / sr;
  firstAudioSent = true;
  maybeSeekReady();
}

function finishAudio(): void {
  try {
    audioDecoder!.send(null);
    drainAudio();
  } catch (e) {
    console.warn('[pup decode] audio drain failed:', (e as Error).message);
  }
  audioEos = true;
  audioPort.postMessage({ type: 'eos', epoch } satisfies ToWorkletData);
  maybeSeekReady();
  sendLevels(true);
}
