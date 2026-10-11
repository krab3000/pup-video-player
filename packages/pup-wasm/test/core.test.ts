// Smoke test: demux and decode every fixture with the st build in Node.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockCache, Core, Decoder, Demuxer, IORegistry, MemorySource, loadCore } from '../src/ts';

const media = (name: string) => fileURLToPath(new URL(`../../../test-media/${name}`, import.meta.url));

const fixtures: Array<[string, string[]]> = [
  ['h264-aac.mp4', ['h264', 'aac']],
  ['vp9-opus.webm', ['vp9', 'opus']],
  ['vp8-opus.webm', ['vp8', 'opus']],
  ['hevc-ac3.mkv', ['hevc', 'ac3']],
  ['mpeg2-mp2.ts', ['mpeg2video', 'mp2']],
  ['mpeg4-mp3.avi', ['mpeg4', 'mp3']],
  ['h264-aac.ts', ['h264', 'aac']],
  ['av1-opus.mp4', ['av1', 'opus']],
  ['audio.flac', ['flac']],
  ['audio.mp3', ['mp3']],
  ['audio.wav', ['pcm_s16le']],
  ['audio-opus.ogg', ['opus']],
];

let core: Core;
let io: IORegistry;

beforeAll(async () => {
  core = await loadCore({ set: 'full', threading: 'st' });
  io = new IORegistry(core.m);
});

function open(name: string): Demuxer {
  const bytes = new Uint8Array(readFileSync(media(name)));
  // Small blocks to exercise block boundaries.
  return Demuxer.open(core, io.register(new BlockCache(new MemorySource(bytes), 4096, 8)));
}

describe.each(fixtures)('%s', (name, codecs) => {
  it.skipIf(!existsSync(media(name)))('demuxes and decodes', () => {
    const demux = open(name);
    const streams = demux.streams();
    expect(streams.map((s) => s.codec)).toEqual(codecs);
    expect(demux.duration).toBeGreaterThan(9.5);
    expect(demux.duration).toBeLessThan(10.6);

    const decoders = new Map<number, Decoder>();
    for (const s of streams) {
      if (s.type === 'video' && !core.hasDecoder(s.codecId)) continue;
      decoders.set(s.index, Decoder.open(core, s.codecpar, s.extradata, { sampleRate: 48000 }));
    }
    const counts = new Map<number, number>();
    let lastAudioPts = -Infinity;
    const drain = (index: number) => {
      const dec = decoders.get(index)!;
      for (;;) {
        const out = streams[index].type === 'video' ? dec.video() : dec.audio();
        if (out === 'again' || out === null) return;
        counts.set(index, (counts.get(index) ?? 0) + ('frames' in out ? out.frames : 1));
        if ('frames' in out) {
          expect(out.pts).toBeGreaterThanOrEqual(lastAudioPts);
          lastAudioPts = out.pts;
        } else {
          expect(out.data.length).toBe(out.width * out.height * 1.5);
        }
      }
    };
    let packets = 0;
    for (let pkt = demux.read(); pkt; pkt = demux.read()) {
      packets++;
      const dec = decoders.get(pkt.stream);
      if (!dec) continue;
      while (!dec.send(pkt)) drain(pkt.stream);
      drain(pkt.stream);
    }
    for (const [index, dec] of decoders) {
      dec.send(null);
      drain(index);
      dec.close();
    }
    demux.close();

    expect(packets).toBeGreaterThan(50);
    for (const s of streams) {
      if (!decoders.has(s.index)) continue;
      const n = counts.get(s.index) ?? 0;
      if (s.type === 'video') expect(n).toBeGreaterThanOrEqual(295);
      else expect(n / 48000).toBeGreaterThan(9.5);
    }
  });
});

describe('webcodecs codec strings', () => {
  it.each([
    ['h264-aac.mp4', /^avc1\.64001E$/],
    ['h264-aac.ts', /^avc1\.64001E$/],
    ['vp9-opus.webm', /^vp09\.00\.\d\d\.08$/],
    ['vp8-opus.webm', /^vp8$/],
    ['hevc-ac3.mkv', /^hvc1\.1\.6\.L\d+\.\w+/],
    ['av1-opus.mp4', /^av01\.0\.\d\dM\.08$/],
    ['mpeg2-mp2.ts', /^$/],
  ])('%s', (name, pattern) => {
    const demux = open(name);
    expect(demux.streams()[0].webcodecs).toMatch(pattern);
    demux.close();
  });
});

describe('seeking', () => {
  it('lands on a keyframe at or before the target', () => {
    const demux = open('h264-aac.mp4');
    demux.seek(5.5);
    let pkt = demux.read();
    while (pkt && pkt.stream !== 0) pkt = demux.read();
    expect(pkt!.key).toBe(true);
    expect(pkt!.pts / 1e6).toBeLessThanOrEqual(5.5);
    expect(pkt!.pts / 1e6).toBeGreaterThan(4);
    demux.close();
  });
});

describe('tempo', () => {
  it('produces half the samples at 2x', () => {
    const demux = open('audio.flac');
    const s = demux.streams()[0];
    const dec = Decoder.open(core, s.codecpar, s.extradata, { sampleRate: 48000 });
    dec.setTempo(2);
    let frames = 0;
    let lastPts = 0;
    const drain = () => {
      for (let out = dec.audio(); out && out !== 'again'; out = dec.audio()) {
        frames += out.frames;
        lastPts = out.pts;
      }
    };
    for (let pkt = demux.read(); pkt; pkt = demux.read()) {
      while (!dec.send(pkt)) drain();
      drain();
    }
    dec.send(null);
    drain();
    expect(frames / 48000).toBeGreaterThan(4.7);
    expect(frames / 48000).toBeLessThan(5.3);
    expect(lastPts / 1e6).toBeGreaterThan(9.5);
    dec.close();
    demux.close();
  });
});

describe('seeking unindexed formats', () => {
  it.each([0, 3.3, 7.9])('MPEG-TS resumes on a video keyframe at or before %ss', (target) => {
    const demux = open('h264-aac.ts');
    demux.seek(target, 0);
    let pkt = demux.read();
    while (pkt && pkt.stream !== 0) pkt = demux.read();
    expect(pkt!.key).toBe(true);
    expect(pkt!.pts / 1e6).toBeLessThanOrEqual(target + 0.05);
    demux.close();
  });
});

describe('seeking to the start', () => {
  it.each(['vp9-opus.webm', 'hevc-ac3.mkv', 'h264-aac.mp4', 'h264-aac.ts', 'mpeg2-mp2.ts'])('%s returns to the first packets', (name) => {
    const demux = open(name);
    const first = demux.read()!;
    demux.seek(0, demux.streams().findIndex((s) => s.type === 'video'));
    const again = demux.read()!;
    expect(Math.abs(again.pts - first.pts) / 1e6).toBeLessThan(0.1);
    demux.close();
  });
});
