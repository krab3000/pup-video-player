// HLS end to end in Node: an HlsSession over a stubbed fetch that serves the
// test-media/hls fixtures (bash test-media/generate-hls.sh), decoded with the st core.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Decoder, IORegistry, loadCore, type Core, type Packet } from '@krab3000/pup-wasm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canPlayType } from '../src/element/can-play-type.js';
import { HlsError, HlsSession, isHlsSource, looksLikeHls, type HlsHost } from '../src/engine/hls-session.js';
import { describe as describeMedia } from '../src/engine/media-info.js';
import type { HlsStats, MediaInfo } from '../src/engine/protocol.js';

const root = fileURLToPath(new URL('../../../test-media/', import.meta.url));
const ORIGIN = 'http://media.test';
const haveFixtures = existsSync(`${root}hls/vod-ts/index.m3u8`);

let core: Core;
let io: IORegistry;
/** Dynamic responses by path (without query); anything else is read from test-media. */
let routes: Record<string, () => Response | string>;
let sessions: HlsSession[] = [];

beforeAll(async () => {
  core = await loadCore({ set: 'full', threading: 'st' });
  io = new IORegistry(core.m);
});

afterEach(() => {
  for (const s of sessions) s.close();
  sessions = [];
  routes = {};
});

const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const route = routes[url.pathname];
  if (route) {
    const r = route();
    return typeof r === 'string' ? new Response(r) : r;
  }
  const file = `${root}${url.pathname.slice(1)}`;
  if (!existsSync(file)) return new Response(null, { status: 404 });
  const body = new Uint8Array(readFileSync(file));
  const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
  if (range) return new Response(body.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
  return new Response(body);
}) as typeof fetch;

interface Harness {
  session: HlsSession;
  timelines: Array<[number, number, number]>;
  stats: HlsStats[];
  behind: number[];
}

function create(path: string, options = {}): Harness {
  const h = { timelines: [], stats: [], behind: [] } as unknown as Harness;
  const host: HlsHost = {
    core,
    io,
    describe: (d) => describeMedia(core, d),
    canPlay: (codecs) => canPlayType(`video/mp4; codecs="${codecs}"`) !== '',
    onTimeline: (d, s, e) => h.timelines.push([d, s, e]),
    onStats: (s) => h.stats.push(s),
    onBehind: (t) => h.behind.push(t),
    onProgress: () => {},
    fetch: stubFetch,
  };
  h.session = new HlsSession(host, `${ORIGIN}${path}`, 'same-origin', options);
  sessions.push(h.session);
  return h;
}

const active = (info: MediaInfo) => [info.video, info.audio].filter((i) => i >= 0);

/** Reads until EOF (or `until` seconds of video), returning the packets. */
async function readAll(session: HlsSession, until = Infinity): Promise<Packet[]> {
  const all: Packet[] = [];
  for (;;) {
    const batch = await session.read(48, 1 << 20);
    if (!batch) throw new Error('read superseded');
    all.push(...batch.packets);
    if (batch.eof || (all.length && all[all.length - 1].pts / 1e6 >= until)) return all;
  }
}

const times = (packets: Packet[], stream: number, field: 'pts' | 'dts' = 'pts') =>
  packets.filter((p) => p.stream === stream).map((p) => p[field] / 1e6);

function expectMonotonic(values: number[]) {
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
}

/** Decodes every packet; returns the video frame count and seconds of audio. */
function decode(info: MediaInfo, packets: Packet[]): { frames: number; audio: number } {
  const v = info.streams[info.video];
  const a = info.streams[info.audio];
  const vd = Decoder.open(core, v.codecpar, v.extradata);
  const ad = Decoder.open(core, a.codecpar, a.extradata, { sampleRate: 48000 });
  let frames = 0;
  let samples = 0;
  const drain = () => {
    for (let f = vd.video(); f !== 'again' && f !== null; f = vd.video()) frames++;
    for (let f = ad.audio(); f !== 'again' && f !== null; f = ad.audio()) samples += f.frames;
  };
  for (const p of packets) {
    const dec = p.stream === info.video ? vd : ad;
    while (!dec.send(p)) drain();
    drain();
  }
  vd.send(null);
  ad.send(null);
  drain();
  vd.close();
  ad.close();
  return { frames, audio: samples / 48000 };
}

describe('HLS detection', () => {
  it('detects HLS by MIME type, extension or content', () => {
    expect(isHlsSource('https://x/a/index.m3u8?token=1')).toBe(true);
    expect(isHlsSource('https://x/a/list.M3U')).toBe(true);
    expect(isHlsSource('https://x/stream', 'application/x-mpegURL')).toBe(true);
    expect(isHlsSource('https://x/a.mp4')).toBe(false);
    expect(looksLikeHls(new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3'))).toBe(true);
    expect(looksLikeHls(new TextEncoder().encode('﻿#EXTM3U\n'))).toBe(true);
    expect(looksLikeHls(new Uint8Array([0x47, 0x40, 0x11]))).toBe(false);
  });
});

describe.skipIf(!haveFixtures)('HlsSession', () => {
  it.each([
    ['vod-ts', '/hls/vod-ts/index.m3u8'],
    ['vod-fmp4', '/hls/vod-fmp4/index.m3u8'],
    ['byterange', '/hls/byterange/index.m3u8'],
    ['aes', '/hls/aes/index.m3u8'],
    ['aes-seqiv', '/hls/aes-seqiv/index.m3u8'],
    ['master', '/hls/master/master.m3u8'],
  ])('%s: demuxes and decodes every segment', async (_, path) => {
    const h = create(path);
    const info = await h.session.open();
    expect(info.format).toBe('hls');
    expect(info.duration).toBeCloseTo(10, 1);
    expect(info.startTime).toBe(0);
    expect(h.timelines[0]).toEqual([info.duration, 0, info.duration]);
    expect(info.streams[info.video].codec).toBe('h264');
    expect(info.streams[info.audio].codec).toBe('aac');

    h.session.seek(0, active(info));
    const packets = await readAll(h.session);
    const video = times(packets, info.video, 'dts');
    expect(video.length).toBe(300);
    expect(video[0]).toBeLessThan(0.1);
    expect(video[video.length - 1]).toBeGreaterThan(9.8);
    expectMonotonic(video);
    expectMonotonic(times(packets, info.audio));
    expect(packets.find((p) => p.stream === info.video)!.key).toBe(true);

    const { frames, audio } = decode(info, packets);
    expect(frames).toBe(300);
    expect(audio).toBeGreaterThan(9.9);
    expect(audio).toBeLessThan(10.1);
    expect(h.stats[h.stats.length - 1].segmentsLoaded).toBe(5);
  });

  it('picks the highest-bandwidth variant, or the one under hls-max-height', async () => {
    const h = create('/hls/master/master.m3u8');
    await h.session.open();
    expect(h.session.stats.variant).toMatchObject({ resolution: '640x360' });
    const capped = create('/hls/master/master.m3u8', { maxHeight: 200 });
    const info = await capped.session.open();
    expect(capped.session.stats.variant).toMatchObject({ resolution: '320x180', codecs: 'avc1.64000d,mp4a.40.2' });
    expect(info.streams[info.video].width).toBe(320);
  });

  it.each(['vod-ts', 'vod-fmp4'])('%s: seeks to the keyframe at or before the target', async (name) => {
    const h = create(`/hls/${name}/index.m3u8`);
    const info = await h.session.open();
    for (const target of [5, 5.5, 2.2, 9.5]) {
      h.session.seek(target, active(info));
      const batch = (await h.session.read(48, 1 << 20))!;
      const first = batch.packets.find((p) => p.stream === info.video)!;
      expect(first.key).toBe(true);
      // Reading resumes on a keyframe shown at or before the target (the decode worker drops the
      // frames before it), within the target's 2 s segment.
      expect(first.pts / 1e6).toBeLessThanOrEqual(target);
      expect(first.pts / 1e6).toBeGreaterThan(Math.floor(target / 2) * 2 - 0.1);
    }
  });

  it('keeps time running across a discontinuity with a timestamp reset', async () => {
    const seg = (n: number, q: string) => `#EXTINF:2.000000,\n/hls/vod-ts/seg${n}.ts?${q}\n`;
    routes['/disc/index.m3u8'] = () =>
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
      seg(0, 'a') + seg(1, 'a') + seg(2, 'a') + '#EXT-X-DISCONTINUITY\n' + seg(0, 'b') + seg(1, 'b') + '#EXT-X-ENDLIST\n';
    const h = create('/disc/index.m3u8');
    const info = await h.session.open();
    h.session.seek(0, active(info));
    const packets = await readAll(h.session);
    const video = times(packets, info.video, 'dts');
    expect(video.length).toBe(300);
    expectMonotonic(video);
    expectMonotonic(times(packets, info.audio));
    const after = packets.filter((p) => p.stream === info.video && p.key && p.pts / 1e6 > 5.5)[0];
    expect(after.pts / 1e6).toBeGreaterThan(5.99);
    expect(after.pts / 1e6).toBeLessThan(6.1);
    expect(decode(info, packets).frames).toBe(300);

    // A seek past the discontinuity starts a run there.
    h.session.seek(8.5, active(info));
    const batch = (await h.session.read(48, 1 << 20))!;
    const first = batch.packets.find((p) => p.stream === info.video)!.pts / 1e6;
    expect(first).toBeGreaterThan(7.99);
    expect(first).toBeLessThanOrEqual(8.5);
  });

  it('follows a growing EVENT playlist until ENDLIST', async () => {
    let reloads = 0;
    const seg = (n: number) => `#EXTINF:2.000000,\n/hls/vod-ts/seg${n}.ts?session=1\n`;
    routes['/event/index.m3u8'] = () => {
      const count = Math.min(5, 2 + reloads++);
      return (
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:EVENT\n' +
        Array.from({ length: count }, (_, i) => seg(i)).join('') +
        (count === 5 ? '#EXT-X-ENDLIST\n' : '')
      );
    };
    const h = create('/event/index.m3u8');
    const info = await h.session.open();
    expect(info.duration).toBe(Infinity);
    expect(h.session.stats.kind).toBe('event');
    h.session.seek(0, active(info));
    const packets = await readAll(h.session);
    expect(times(packets, info.video).length).toBe(300);
    expect(h.timelines.map(([d, , e]) => [d, e])).toEqual([
      [Infinity, 4],
      [Infinity, 6],
      [Infinity, 8],
      [10, 10],
    ]);
    expect(h.session.stats.kind).toBe('vod');
    expect(h.session.stats.reloads).toBe(3);
  });

  it('starts live playlists 3 segments before the end and reports falling behind', async () => {
    let calls = 0;
    routes['/live/index.m3u8'] = () => {
      const first = calls++ === 0 ? 100 : 110;
      return (
        `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-DISCONTINUITY-SEQUENCE:${first}\n` +
        [0, 1, 2, 3, 4].map((i) => `#EXTINF:2.000000,\n/hls/vod-ts/seg${i}.ts\n`).join('')
      );
    };
    const h = create('/live/index.m3u8');
    const info = await h.session.open();
    expect(h.session.stats.kind).toBe('live');
    expect(info.duration).toBe(Infinity);
    expect(info.startTime).toBe(4);
    expect(h.timelines[0]).toEqual([Infinity, 0, 10]);
    h.session.seek(4, active(info));
    // The next reload moves the window past what is being played.
    await new Promise((r) => setTimeout(r, 1300));
    // 105..109 were never listed: estimated at the target duration each.
    expect(h.timelines[h.timelines.length - 1]).toEqual([Infinity, 15, 25]);
    let batch;
    do batch = await h.session.read(48, 1 << 20);
    while (batch);
    expect(h.behind).toEqual([15]);
  });

  it('retries a listed segment that is not there yet', async () => {
    let misses = 0;
    routes['/hls/vod-ts/seg1.ts'] = () =>
      misses++ < 2 ? new Response(null, { status: 404 }) : new Response(new Uint8Array(readFileSync(`${root}hls/vod-ts/seg1.ts`)));
    const h = create('/hls/vod-ts/index.m3u8');
    const info = await h.session.open();
    h.session.seek(0, active(info));
    const packets = await readAll(h.session);
    expect(misses).toBe(3);
    expect(times(packets, info.video).length).toBe(300);
  });

  it('fails with MEDIA_ERR_NETWORK when a segment is forbidden', async () => {
    routes['/hls/vod-ts/seg2.ts'] = () => new Response(null, { status: 403 });
    const h = create('/hls/vod-ts/index.m3u8');
    const info = await h.session.open();
    h.session.seek(0, active(info));
    await expect(readAll(h.session)).rejects.toMatchObject({ code: 2 });
  });

  it('rejects SAMPLE-AES with MEDIA_ERR_SRC_NOT_SUPPORTED', async () => {
    const h = create('/hls/sample-aes/index.m3u8');
    const err = await h.session.open().catch((e) => e);
    expect(err).toBeInstanceOf(HlsError);
    expect(err.code).toBe(4);
    expect(err.message).toMatch(/SAMPLE-AES/);
  });

  it('treats an HTTP error on the playlist as an unsupported source', async () => {
    const err = await create('/hls/missing.m3u8').session.open().catch((e) => e);
    expect(err.code).toBe(4);
  });

  it('fails clearly when the codec changes across a discontinuity', async () => {
    routes['/codec-change/index.m3u8'] = () =>
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2,\n/hls/vod-ts/seg0.ts\n' +
      '#EXT-X-DISCONTINUITY\n#EXTINF:2,\n/mpeg2-mp2.ts\n#EXT-X-ENDLIST\n';
    const h = create('/codec-change/index.m3u8');
    const info = await h.session.open();
    h.session.seek(0, active(info));
    await expect(readAll(h.session)).rejects.toMatchObject({ code: 3, message: expect.stringMatching(/h264 -> mpeg2video/) });
  });
});
