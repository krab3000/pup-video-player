import { describe, expect, it } from 'vitest';
import {
  chooseVariant,
  findSegment,
  mergePlaylist,
  parseAttributes,
  parsePlaylist,
  playlistEnd,
  segmentIv,
  unsupportedKey,
  type MasterPlaylist,
  type MediaPlaylist,
} from '../src/ts';

const media = (text: string, url = 'https://cdn.example/a/b/index.m3u8?token=1') => parsePlaylist(text, url) as MediaPlaylist;
const master = (text: string, url = 'https://cdn.example/a/master.m3u8') => parsePlaylist(text, url) as MasterPlaylist;

describe('parseAttributes', () => {
  it('handles quoted commas and hex values', () => {
    expect(parseAttributes('BANDWIDTH=100,CODECS="avc1.4d401f,mp4a.40.2",IV=0x1F,RESOLUTION=640x360')).toEqual({
      BANDWIDTH: '100',
      CODECS: 'avc1.4d401f,mp4a.40.2',
      IV: '0x1F',
      RESOLUTION: '640x360',
    });
  });
});

describe('parsePlaylist: master', () => {
  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=29.970
hi/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
lo/index.m3u8
`;

  it('lists variants and renditions with resolved URIs', () => {
    const pl = master(text);
    expect(pl.type).toBe('master');
    expect(pl.variants).toEqual([
      {
        uri: 'https://cdn.example/a/hi/index.m3u8',
        bandwidth: 2000000,
        averageBandwidth: 1800000,
        resolution: { width: 1280, height: 720 },
        codecs: 'avc1.64001f,mp4a.40.2',
        frameRate: 29.97,
        audio: undefined,
      },
      {
        uri: 'https://cdn.example/a/lo/index.m3u8',
        bandwidth: 500000,
        averageBandwidth: undefined,
        resolution: { width: 640, height: 360 },
        codecs: 'avc1.4d401e,mp4a.40.2',
        frameRate: undefined,
        audio: 'aud',
      },
    ]);
    expect(pl.media).toEqual([{ type: 'AUDIO', groupId: 'aud', name: 'English', uri: 'https://cdn.example/a/audio/en.m3u8' }]);
  });

  it('rejects text that is not a playlist', () => {
    expect(() => parsePlaylist('<html>', 'https://x/')).toThrow(/EXTM3U/);
  });
});

describe('parsePlaylist: media', () => {
  it('parses a Cove-style EVENT playlist with root-relative URIs and a discontinuity', () => {
    const pl = media(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:6.006,
/api/stream/video/5/hls/720p/0.ts?session=abc&t=1
#EXTINF:5.5,
/api/stream/video/5/hls/720p/1.ts?session=abc&t=1
#EXT-X-DISCONTINUITY
#EXTINF:6,
/api/stream/video/5/hls/720p/2.ts?session=abc&t=1
`);
    expect(pl.kind).toBe('event');
    expect(pl.endList).toBe(false);
    expect(pl.targetDuration).toBe(6);
    expect(pl.segments.map((s) => [s.seq, s.start, s.duration, s.discontinuitySeq])).toEqual([
      [0, 0, 6.006, 0],
      [1, 6.006, 5.5, 0],
      [2, 11.506, 6, 1],
    ]);
    expect(pl.segments[0].uri).toBe('https://cdn.example/api/stream/video/5/hls/720p/0.ts?session=abc&t=1');
    expect(playlistEnd(pl)).toBeCloseTo(17.506);
  });

  it('resolves relative URIs without the playlist query string', () => {
    const pl = media('#EXTM3U\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST');
    expect(pl.segments[0].uri).toBe('https://cdn.example/a/b/seg0.ts');
    expect(pl.kind).toBe('vod');
  });

  it('classifies playlists', () => {
    expect(media('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2,\na.ts').kind).toBe('vod');
    expect(media('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST').kind).toBe('vod');
    expect(media('#EXTM3U\n#EXTINF:2,\na.ts').kind).toBe('live');
  });

  it('carries implicit byte-range offsets', () => {
    const pl = media(`#EXTM3U
#EXTINF:2,
#EXT-X-BYTERANGE:100@0
all.ts
#EXTINF:2,
#EXT-X-BYTERANGE:200
all.ts
#EXTINF:2,
#EXT-X-BYTERANGE:50
all.ts
#EXTINF:2,
#EXT-X-BYTERANGE:70
other.ts
`);
    expect(pl.segments.map((s) => s.byteRange)).toEqual([
      { offset: 0, length: 100 },
      { offset: 100, length: 200 },
      { offset: 300, length: 50 },
      { offset: 0, length: 70 },
    ]);
  });

  it('records EXT-X-MAP and EXT-X-KEY per segment', () => {
    const pl = media(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:4,
s10.m4s
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,
s11.m4s
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k2",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
s12.m4s
`);
    const [a, b, c] = pl.segments;
    expect(a.map).toEqual({ uri: 'https://cdn.example/a/b/init.mp4', byteRange: { offset: 0, length: 720 } });
    expect(c.map).toBe(a.map);
    expect(a.key?.method).toBe('AES-128');
    expect(a.key?.uri).toBe('https://keys.example/k1');
    expect([...a.key!.iv!]).toEqual([...Array(16).keys()]);
    expect(b.key).toBeUndefined();
    expect(c.key).toMatchObject({ method: 'SAMPLE-AES', keyFormat: 'com.apple.streamingkeydelivery' });
    expect(unsupportedKey(a.key)).toBeNull();
    expect(unsupportedKey(b.key)).toBeNull();
    expect(unsupportedKey(c.key)).toMatch(/SAMPLE-AES/);
    expect(unsupportedKey({ method: 'AES-128', uri: 'k', keyFormat: 'com.widevine' })).toMatch(/KEYFORMAT/);
  });

  it('numbers discontinuities from EXT-X-DISCONTINUITY-SEQUENCE', () => {
    const pl = media('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:40\n#EXT-X-DISCONTINUITY-SEQUENCE:3\n#EXTINF:2,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nb.ts');
    expect(pl.segments.map((s) => [s.seq, s.discontinuitySeq])).toEqual([
      [40, 3],
      [41, 4],
    ]);
  });
});

describe('segmentIv', () => {
  it('uses the IV attribute when present', () => {
    const iv = new Uint8Array(16).fill(7);
    expect(segmentIv({ method: 'AES-128', iv }, 5)).toBe(iv);
  });

  it('derives the IV from the media sequence number, big-endian', () => {
    expect([...segmentIv({ method: 'AES-128' }, 0x0102)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    expect([...segmentIv({ method: 'AES-128' }, 2 ** 32 + 5)].slice(8)).toEqual([0, 0, 0, 1, 0, 0, 0, 5]);
  });
});

describe('mergePlaylist', () => {
  const live = (first: number, count: number, extra = '') =>
    media(
      `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n${extra}` +
        Array.from({ length: count }, (_, i) => `#EXTINF:2,\ns${first + i}.ts\n`).join(''),
    );

  it('appends new segments to a growing EVENT playlist and records ENDLIST', () => {
    const a = media('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:6,\n0.ts\n#EXTINF:6,\n1.ts');
    const b = media('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:6,\n0.ts\n#EXTINF:6,\n1.ts\n#EXTINF:3,\n2.ts\n#EXT-X-ENDLIST');
    const merged = mergePlaylist(a, b);
    expect(merged.segments.map((s) => s.start)).toEqual([0, 6, 12]);
    expect(merged.segments[0]).toBe(a.segments[0]);
    expect(merged.endList).toBe(true);
    expect(merged.kind).toBe('vod');
    expect(playlistEnd(merged)).toBe(15);
  });

  it('keeps times stable as a live window slides', () => {
    let pl = live(100, 4);
    expect(pl.segments.map((s) => s.start)).toEqual([0, 2, 4, 6]);
    pl = mergePlaylist(pl, live(102, 4));
    expect(pl.segments.map((s) => [s.seq, s.start])).toEqual([
      [102, 4],
      [103, 6],
      [104, 8],
      [105, 10],
    ]);
    expect(pl.kind).toBe('live');
  });

  it('estimates the gap when the window moved past everything known', () => {
    const pl = mergePlaylist(live(100, 2), live(110, 2));
    // 100,101 end at 4; 102..109 are missing (8 x 2 s).
    expect(pl.segments.map((s) => s.start)).toEqual([20, 22]);
  });
});

describe('findSegment', () => {
  const pl = media('#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXTINF:2,\nc.ts\n#EXT-X-ENDLIST');
  it('finds the segment containing a time, clamping outside the list', () => {
    expect(findSegment(pl, 0)?.seq).toBe(0);
    expect(findSegment(pl, 1.999)?.seq).toBe(0);
    expect(findSegment(pl, 2)?.seq).toBe(1);
    expect(findSegment(pl, 5.5)?.seq).toBe(2);
    expect(findSegment(pl, 60)?.seq).toBe(2);
    expect(findSegment(pl, -1)?.seq).toBe(0);
  });
});

describe('chooseVariant', () => {
  const pl = master(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,CODECS="dvh1.05.06,ec-3"
2160.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720.m3u8
`);
  const canPlay = (codecs: string) => !codecs.includes('dvh1');
  const pick = (opts = {}) => chooseVariant(pl, { canPlay, ...opts })?.variant.uri.split('/').pop();

  it('picks the highest playable bandwidth', () => {
    expect(pick()).toBe('1080.m3u8');
    expect(chooseVariant(pl)?.variant.uri).toMatch(/2160/);
  });

  it('honours the height and bandwidth caps', () => {
    expect(pick({ maxHeight: 720 })).toBe('720.m3u8');
    expect(pick({ maxBandwidth: 1_000_000 })).toBe('360.m3u8');
    expect(pick({ maxHeight: 100 })).toBe('360.m3u8');
  });

  it('prefers variants with muxed audio over separate audio renditions', () => {
    const alt = master(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="muxed",NAME="main"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"
hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="muxed"
lo.m3u8
`);
    expect(chooseVariant(alt, { canPlay })).toMatchObject({ variant: { bandwidth: 1000000 }, audioDropped: false });
    const only = master('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8');
    expect(chooseVariant(only, { canPlay })).toMatchObject({ audioDropped: true });
  });

  it('returns null when nothing is playable', () => {
    expect(chooseVariant(pl, { canPlay: () => false })).toBeNull();
  });
});
