// Picks the streams to play from an opened demuxer (shared by plain files and HLS segments).

import { DemuxError, type Core, type Demuxer, type StreamInfo } from '@krab3000/pup-wasm';
import type { MediaInfo } from './protocol.js';

function playable(core: Core, s: StreamInfo): boolean {
  if (s.type === 'video') return !s.attachedPic && (s.webcodecs !== '' || core.hasDecoder(s.codecId));
  if (s.type === 'audio') return core.hasDecoder(s.codecId);
  return false;
}

function pick(core: Core, streams: StreamInfo[], type: 'video' | 'audio'): number {
  const candidates = streams.filter((s) => s.type === type && playable(core, s));
  return (candidates.find((s) => s.default) ?? candidates[0])?.index ?? -1;
}

export function describe(core: Core, d: Demuxer): MediaInfo {
  const streams = d.streams();
  const video = pick(core, streams, 'video');
  const audio = pick(core, streams, 'audio');
  if (video < 0 && audio < 0) {
    const codecs = streams.map((s) => `${s.type}:${s.codec}`).join(', ');
    throw new DemuxError(`no playable streams (${codecs || 'none'})`, 0);
  }
  let duration = d.duration;
  if (!Number.isFinite(duration)) {
    const known = streams.map((s) => s.duration).filter((x) => Number.isFinite(x));
    duration = known.length ? Math.max(...known) : Infinity;
  }
  return { format: d.formatName, duration, streams, video, audio };
}
