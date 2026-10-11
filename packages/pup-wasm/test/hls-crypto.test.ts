// AES-128 (HLS METHOD=AES-128) helper and the raw start time used to re-base segments.
import { createCipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockCache, Core, Demuxer, IORegistry, MemorySource, loadCore, segmentIv } from '../src/ts';

const media = (name: string) => fileURLToPath(new URL(`../../../test-media/${name}`, import.meta.url));
const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

let core: Core;
let io: IORegistry;

beforeAll(async () => {
  core = await loadCore({ set: 'full', threading: 'st' });
  io = new IORegistry(core.m);
});

describe('decryptAes128', () => {
  // NIST SP 800-38A F.2.5/F.2.6 (CBC-AES128), plus the PKCS#7 padding block HLS uses.
  const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
  const iv = hex('000102030405060708090a0b0c0d0e0f');
  const plain = hex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51');
  const cipherBlocks = '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2';

  it('decrypts the NIST test vector', () => {
    const c = createCipheriv('aes-128-cbc', key, iv);
    const encrypted = new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
    expect(Buffer.from(encrypted.subarray(0, 32)).toString('hex')).toBe(cipherBlocks);
    expect(encrypted.length).toBe(48);
    expect(core.decryptAes128(key, iv, encrypted)).toEqual(plain);
  });

  it('strips partial padding', () => {
    const text = new TextEncoder().encode('hello, segment');
    const c = createCipheriv('aes-128-cbc', key, iv);
    const encrypted = new Uint8Array(Buffer.concat([c.update(text), c.final()]));
    expect(core.decryptAes128(key, iv, encrypted)).toEqual(text);
  });

  it('rejects bad padding and partial blocks', () => {
    expect(() => core.decryptAes128(key, iv, hex(cipherBlocks))).toThrow(/AES-128/);
    expect(() => core.decryptAes128(key, iv, new Uint8Array(17))).toThrow(/AES-128/);
  });

  const fixture = 'hls/aes/seg1.ts';
  it.skipIf(!existsSync(media(fixture)))('decrypts the ffmpeg-encrypted fixture', () => {
    const key = new Uint8Array(readFileSync(media('hls/aes/key.bin')));
    const out = core.decryptAes128(key, hex('0f0e0d0c0b0a09080706050403020100'), new Uint8Array(readFileSync(media(fixture))));
    expect(out).toEqual(new Uint8Array(readFileSync(media('hls/vod-ts/seg1.ts'))));
  });

  it.skipIf(!existsSync(media('hls/aes-seqiv/seg2.ts')))('decrypts with the IV derived from the sequence number', () => {
    const key = new Uint8Array(readFileSync(media('hls/aes-seqiv/key.bin')));
    const iv = segmentIv({ method: 'AES-128', uri: 'key.bin' }, 9);
    const out = core.decryptAes128(key, iv, new Uint8Array(readFileSync(media('hls/aes-seqiv/seg2.ts'))));
    expect(out).toEqual(new Uint8Array(readFileSync(media('hls/vod-ts/seg2.ts'))));
  });
});

describe('Demuxer.startTime', () => {
  it.skipIf(!existsSync(media('hls/vod-ts/seg1.ts')))('reports the raw start that packet times are relative to', () => {
    const bytes = new Uint8Array(readFileSync(media('hls/vod-ts/seg1.ts')));
    const demux = Demuxer.open(core, io.register(new BlockCache(new MemorySource(bytes))));
    // ffmpeg's MPEG-TS muxer starts at 1.4 s; the second 2 s segment at 3.4 s.
    expect(demux.startTime).toBeCloseTo(3.4, 1);
    const first = demux.read()!;
    expect(first.dts / 1e6).toBeLessThan(0.2);
    demux.close();
  });
});
