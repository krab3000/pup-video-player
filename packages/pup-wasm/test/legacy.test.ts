// Every legacy/exotic fixture (test-media/generate-legacy.sh) must demux and
// fully decode with the full build.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockCache, Core, Decoder, Demuxer, IORegistry, MemorySource, loadCore } from '../src/ts';

const dir = fileURLToPath(new URL('../../../test-media/legacy/', import.meta.url));
const files = existsSync(dir) ? readdirSync(dir).sort() : [];

let core: Core;
let io: IORegistry;

beforeAll(async () => {
  core = await loadCore({ set: 'full', threading: 'st' });
  io = new IORegistry(core.m);
});

describe.skipIf(!files.length)('legacy formats', () => {
  it.each(files)('%s', (name) => {
    const bytes = new Uint8Array(readFileSync(dir + name));
    const demux = Demuxer.open(core, io.register(new BlockCache(new MemorySource(bytes), 65536, 64)));
    const streams = demux.streams().filter((s) => s.type === 'video' || s.type === 'audio');
    expect(streams.length).toBeGreaterThan(0);

    const decoders = new Map<number, Decoder>();
    for (const s of streams) {
      expect(core.hasDecoder(s.codecId), `${s.type} decoder for ${s.codec}`).toBe(true);
      decoders.set(s.index, Decoder.open(core, s.codecpar, s.extradata, { sampleRate: 48000 }));
    }
    const produced = new Map<number, number>();
    const drain = (index: number) => {
      const dec = decoders.get(index)!;
      const video = streams.find((s) => s.index === index)!.type === 'video';
      for (;;) {
        const out = video ? dec.video() : dec.audio();
        if (out === 'again' || out === null) return;
        produced.set(index, (produced.get(index) ?? 0) + ('frames' in out ? out.frames / 48000 : 1));
      }
    };
    for (let pkt = demux.read(); pkt; pkt = demux.read()) {
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

    for (const s of streams) {
      const n = produced.get(s.index) ?? 0;
      if (s.type === 'video') expect(n, `${s.codec} frames`).toBeGreaterThanOrEqual(Math.floor(9.5 * (s.fps || 25)));
      else expect(n, `${s.codec} seconds`).toBeGreaterThan(9.4);
    }
  });
});
