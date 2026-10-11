// HLS playlist model (RFC 8216): parses master and media playlists, keeps a
// stable timeline across reloads and picks a variant. Pure functions, no I/O.

export interface ByteRange {
  offset: number;
  length: number;
}

export interface HlsKey {
  /** NONE never appears here: a segment without encryption has no key. */
  method: string;
  uri?: string;
  /** 16 bytes; absent means "derive from the media sequence number". */
  iv?: Uint8Array;
  keyFormat?: string;
}

export interface HlsMap {
  uri: string;
  byteRange?: ByteRange;
}

export interface HlsSegment {
  /** Media sequence number. */
  seq: number;
  /** Seconds on the playlist timeline (0 = first segment ever seen). */
  start: number;
  duration: number;
  discontinuitySeq: number;
  uri: string;
  byteRange?: ByteRange;
  map?: HlsMap;
  key?: HlsKey;
}

/** `vod`: ENDLIST or PLAYLIST-TYPE:VOD; `event`: PLAYLIST-TYPE:EVENT; `live`: neither. */
export type HlsPlaylistKind = 'vod' | 'event' | 'live';

export interface MediaPlaylist {
  type: 'media';
  url: string;
  kind: HlsPlaylistKind;
  targetDuration: number;
  mediaSequence: number;
  discontinuitySequence: number;
  endList: boolean;
  playlistType?: string;
  segments: HlsSegment[];
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  resolution?: { width: number; height: number };
  codecs?: string;
  frameRate?: number;
  /** GROUP-ID of the audio renditions. */
  audio?: string;
}

export interface HlsRendition {
  type: string;
  groupId: string;
  name?: string;
  uri?: string;
}

export interface MasterPlaylist {
  type: 'master';
  url: string;
  variants: HlsVariant[];
  /** EXT-X-MEDIA entries; only used to detect separate audio renditions. */
  media: HlsRendition[];
}

export class PlaylistError extends Error {}

/** Parses an attribute list: `A=1,B="x,y",C=0x10`. Quotes are removed. */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\s*([A-Z0-9-]+)\s*=\s*("[^"]*"|[^,]*)\s*(?:,|$)/gi;
  for (let m = re.exec(s); m && m[0]; m = re.exec(s)) {
    const v = m[2];
    out[m[1].toUpperCase()] = v.startsWith('"') ? v.slice(1, -1) : v.trim();
  }
  return out;
}

function parseByteRange(s: string, implicitOffset: number): ByteRange {
  const [length, offset] = s.split('@');
  return { length: Number(length), offset: offset !== undefined ? Number(offset) : implicitOffset };
}

function parseIv(s: string): Uint8Array {
  const hex = s.replace(/^0x/i, '').padStart(32, '0');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new PlaylistError(`invalid IV ${s}`);
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return iv;
}

const resolve = (uri: string, base: string) => new URL(uri, base).href;

/**
 * Parses a playlist fetched from `url`. URIs are resolved against `url` (its
 * query string is not carried over). Segment `start` times count from 0 at
 * the first listed segment; mergePlaylist() re-bases them on reloads.
 */
export function parsePlaylist(text: string, url: string): MasterPlaylist | MediaPlaylist {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new PlaylistError('not an HLS playlist (no #EXTM3U)');
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'))) return parseMaster(lines, url);
  return parseMedia(lines, url);
}

function parseMaster(lines: string[], url: string): MasterPlaylist {
  const variants: HlsVariant[] = [];
  const media: HlsRendition[] = [];
  let pending: Record<string, string> | null = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice(18));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      media.push({ type: a.TYPE, groupId: a['GROUP-ID'], name: a.NAME, uri: a.URI ? resolve(a.URI, url) : undefined });
    } else if (line && !line.startsWith('#') && pending) {
      const res = /^(\d+)x(\d+)$/.exec(pending.RESOLUTION ?? '');
      variants.push({
        uri: resolve(line, url),
        bandwidth: Number(pending.BANDWIDTH) || 0,
        averageBandwidth: pending['AVERAGE-BANDWIDTH'] ? Number(pending['AVERAGE-BANDWIDTH']) : undefined,
        resolution: res ? { width: Number(res[1]), height: Number(res[2]) } : undefined,
        codecs: pending.CODECS || undefined,
        frameRate: pending['FRAME-RATE'] ? Number(pending['FRAME-RATE']) : undefined,
        audio: pending.AUDIO || undefined,
      });
      pending = null;
    }
  }
  return { type: 'master', url, variants, media };
}

function parseMedia(lines: string[], url: string): MediaPlaylist {
  const pl: MediaPlaylist = {
    type: 'media',
    url,
    kind: 'live',
    targetDuration: 0,
    mediaSequence: 0,
    discontinuitySequence: 0,
    endList: false,
    segments: [],
  };
  let duration = 0;
  let byteRange: string | null = null;
  let discontinuities = 0;
  let key: HlsKey | undefined;
  let map: HlsMap | undefined;
  let start = 0;
  // Implicit BYTERANGE offsets continue from the previous range of the same resource.
  let lastRangeUri = '';
  let lastRangeEnd = 0;

  for (const line of lines) {
    if (!line) continue;
    if (!line.startsWith('#')) {
      const uri = resolve(line, url);
      const seg: HlsSegment = {
        seq: pl.mediaSequence + pl.segments.length,
        start,
        duration,
        discontinuitySeq: pl.discontinuitySequence + discontinuities,
        uri,
      };
      if (byteRange !== null) {
        seg.byteRange = parseByteRange(byteRange, uri === lastRangeUri ? lastRangeEnd : 0);
        lastRangeUri = uri;
        lastRangeEnd = seg.byteRange.offset + seg.byteRange.length;
      }
      if (map) seg.map = map;
      if (key) seg.key = key;
      pl.segments.push(seg);
      start += duration;
      duration = 0;
      byteRange = null;
      continue;
    }
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    switch (tag) {
      case '#EXT-X-TARGETDURATION':
        pl.targetDuration = Number(value);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        pl.mediaSequence = Number(value);
        break;
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        pl.discontinuitySequence = Number(value);
        break;
      case '#EXT-X-PLAYLIST-TYPE':
        pl.playlistType = value.toUpperCase();
        break;
      case '#EXT-X-ENDLIST':
        pl.endList = true;
        break;
      case '#EXTINF':
        duration = parseFloat(value) || 0;
        break;
      case '#EXT-X-BYTERANGE':
        byteRange = value;
        break;
      case '#EXT-X-DISCONTINUITY':
        discontinuities++;
        break;
      case '#EXT-X-MAP': {
        const a = parseAttributes(value);
        map = { uri: resolve(a.URI, url) };
        if (a.BYTERANGE) map.byteRange = parseByteRange(a.BYTERANGE, 0);
        break;
      }
      case '#EXT-X-KEY': {
        const a = parseAttributes(value);
        const method = (a.METHOD ?? 'NONE').toUpperCase();
        key =
          method === 'NONE'
            ? undefined
            : {
                method,
                uri: a.URI ? resolve(a.URI, url) : undefined,
                iv: a.IV ? parseIv(a.IV) : undefined,
                keyFormat: a.KEYFORMAT,
              };
        break;
      }
    }
  }
  pl.kind = playlistKind(pl);
  return pl;
}

function playlistKind(pl: MediaPlaylist): HlsPlaylistKind {
  if (pl.endList || pl.playlistType === 'VOD') return 'vod';
  return pl.playlistType === 'EVENT' ? 'event' : 'live';
}

/**
 * Merges a reloaded playlist into the previous one. Known segments keep their
 * `start` (the timeline is keyed by media sequence number), new ones follow
 * on, and segments that left a live window are dropped.
 */
export function mergePlaylist(prev: MediaPlaylist, next: MediaPlaylist): MediaPlaylist {
  const known = new Map(prev.segments.map((s) => [s.seq, s]));
  const anchor = next.segments.find((s) => known.has(s.seq));
  let offset: number;
  if (anchor) {
    offset = known.get(anchor.seq)!.start - anchor.start;
  } else {
    // No overlap (the window moved past everything we knew): estimate the gap.
    const last = prev.segments[prev.segments.length - 1];
    const first = next.segments[0];
    offset = last && first ? last.start + last.duration + Math.max(0, first.seq - last.seq - 1) * next.targetDuration : 0;
  }
  const segments = next.segments.map((s) => known.get(s.seq) ?? { ...s, start: s.start + offset });
  const merged = { ...next, segments };
  merged.kind = playlistKind(merged);
  return merged;
}

/** End of the last listed segment, in seconds. */
export function playlistEnd(pl: MediaPlaylist): number {
  const last = pl.segments[pl.segments.length - 1];
  return last ? last.start + last.duration : 0;
}

/** The segment covering `time`: the first one before the window, the last one after it. */
export function findSegment(pl: MediaPlaylist, time: number): HlsSegment | null {
  if (!pl.segments.length) return null;
  return pl.segments.find((s) => time < s.start + s.duration) ?? pl.segments[pl.segments.length - 1];
}

/** Why a key can't be used, or null when it can (AES-128 with the identity key format). */
export function unsupportedKey(key: HlsKey | undefined): string | null {
  if (!key) return null;
  if (key.method !== 'AES-128') return `HLS encryption METHOD=${key.method} is not supported`;
  if (key.keyFormat && key.keyFormat !== 'identity') return `HLS KEYFORMAT=${key.keyFormat} is not supported`;
  if (!key.uri) return 'HLS AES-128 key without a URI';
  return null;
}

/** The segment's IV: the IV attribute, or its media sequence number as 16 big-endian bytes. */
export function segmentIv(key: HlsKey, seq: number): Uint8Array {
  if (key.iv) return key.iv;
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(8, Math.floor(seq / 2 ** 32));
  view.setUint32(12, seq >>> 0);
  return iv;
}

export interface VariantOptions {
  /** True when every codec of a CODECS attribute can be played. */
  canPlay?: (codecs: string) => boolean;
  maxHeight?: number;
  maxBandwidth?: number;
}

export interface VariantChoice {
  variant: HlsVariant;
  /** The variant's audio is a separate rendition, which is not played. */
  audioDropped: boolean;
}

/**
 * Picks the highest-bandwidth playable variant within the caps that carries
 * its own audio. When every playable variant needs a separate audio rendition,
 * one of those is picked (its video plays alone). When the caps exclude every
 * variant, the lowest-bandwidth one is used.
 */
export function chooseVariant(master: MasterPlaylist, opts: VariantOptions = {}): VariantChoice | null {
  const separateAudio = new Set(master.media.filter((m) => m.type === 'AUDIO' && m.uri).map((m) => m.groupId));
  const needsAudio = (v: HlsVariant) => v.audio !== undefined && separateAudio.has(v.audio);
  const playable = master.variants.filter((v) => !v.codecs || !opts.canPlay || opts.canPlay(v.codecs));
  let pool = playable.filter((v) => !needsAudio(v));
  const audioDropped = pool.length === 0 && playable.length > 0;
  if (audioDropped) pool = playable;
  if (!pool.length) return null;
  const byBandwidth = [...pool].sort((a, b) => b.bandwidth - a.bandwidth);
  const fits = (v: HlsVariant) =>
    (!opts.maxHeight || !v.resolution || v.resolution.height <= opts.maxHeight) &&
    (!opts.maxBandwidth || v.bandwidth <= opts.maxBandwidth);
  const variant = byBandwidth.find(fits) ?? byBandwidth[byBandwidth.length - 1];
  return { variant, audioDropped };
}
