import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPlayType } from '../src/element/can-play-type.js';
import { PupTimeRanges } from '../src/element/time-ranges.js';
import { MediaClock } from '../src/engine/clock.js';

// DOMException exists in Node; that's all TimeRanges needs.

describe('PupTimeRanges', () => {
  it('sorts and merges overlapping ranges', () => {
    const r = new PupTimeRanges([[5, 7], [0, 2], [1, 3], [7, 8], [9, 9]]);
    expect(r.length).toBe(2);
    expect([r.start(0), r.end(0), r.start(1), r.end(1)]).toEqual([0, 3, 5, 8]);
  });

  it('throws IndexSizeError out of range', () => {
    expect(() => new PupTimeRanges().start(0)).toThrowError(expect.objectContaining({ name: 'IndexSizeError' }));
  });
});

describe('canPlayType', () => {
  it.each([
    ['video/mp4', 'maybe'],
    ['video/mp4; codecs="avc1.640028, mp4a.40.2"', 'probably'],
    ['video/webm; codecs="vp9, opus"', 'probably'],
    ['video/x-matroska; codecs="hev1.1.6.L93.B0, ac-3"', 'probably'],
    ['video/mp2t; codecs="mp4v.20.8, mp4a.40.2"', 'probably'],
    ['audio/ogg; codecs=vorbis', 'probably'],
    ['audio/wav; codecs="1"', 'probably'],
    ['video/mp4; codecs="av01.0.08M.08"', ''], // no WebCodecs in Node, no sw AV1
    ['application/x-mpegURL', ''],
    ['video/mp4; codecs="avc1.42E01E, bogus"', ''],
  ])('%s -> %s', (type, expected) => {
    expect(canPlayType(type)).toBe(expected);
  });

  it('respects the lite codec set', () => {
    expect(canPlayType('video/mp2t', 'lite')).toBe('');
    expect(canPlayType('audio/mp4; codecs="mp4a.40.2"', 'lite')).toBe('probably');
    expect(canPlayType('video/mp4; codecs="avc1.640028"', 'lite')).toBe(''); // video needs WebCodecs
  });
});

describe('MediaClock (wall clock)', () => {
  afterEach(() => vi.useRealTimers());

  it('advances with playbackRate and holds while stopped', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const clock = new MediaClock();
    clock.set(2);
    expect(clock.now()).toBe(2);
    clock.start();
    vi.advanceTimersByTime(1000);
    expect(clock.now()).toBeCloseTo(3, 5);
    clock.setRate(2);
    vi.advanceTimersByTime(500);
    expect(clock.now()).toBeCloseTo(4, 5);
    clock.stop();
    vi.advanceTimersByTime(1000);
    expect(clock.now()).toBeCloseTo(4, 5);
  });
});

describe('canPlayType for legacy formats (full set)', () => {
  it.each([
    ['video/x-ms-wmv', 'maybe'],
    ['video/x-ms-wmv; codecs="wmv2, wmav2"', 'probably'],
    ['audio/x-ms-wma', 'maybe'],
    ['application/vnd.rn-realmedia', 'maybe'],
    ['video/3gpp; codecs="s263, samr"', 'probably'],
    ['video/x-dv', 'maybe'],
    ['application/mxf', 'maybe'],
    ['audio/x-ape', 'maybe'],
    ['audio/x-wavpack', 'maybe'],
    ['audio/vnd.dts', 'maybe'],
  ])('%s -> %s', (type, expected) => {
    expect(canPlayType(type)).toBe(expected);
  });

  it('lite does not include them', () => {
    expect(canPlayType('video/x-ms-wmv', 'lite')).toBe('');
    expect(canPlayType('application/vnd.rn-realmedia', 'lite')).toBe('');
  });
});
