import { describe, expect, it } from 'vitest';
import { canPlayType } from '../src/element/can-play-type.js';
import { selectSource, type SourceCandidate } from '../src/element/source-selection.js';

const play = (type: string) => canPlayType(type);

describe('selectSource', () => {
  it('takes candidates in document order', () => {
    const list: SourceCandidate[] = [
      { src: 'a.mp4', type: null },
      { src: 'b.webm', type: 'video/webm' },
    ];
    expect(selectSource(list, 0, play)).toEqual({ index: 0, rejected: [] });
    expect(selectSource(list, 1, play)).toEqual({ index: 1, rejected: [] });
    expect(selectSource(list, 2, play)).toEqual({ index: -1, rejected: [] });
  });

  it('skips types canPlayType rejects, and sources without src', () => {
    const list: SourceCandidate[] = [
      { src: 'a.m3u8', type: 'application/x-mpegURL' },
      { src: null, type: 'video/mp4' },
      { src: '', type: null },
      { src: 'b.mkv', type: 'video/x-unknown' },
      { src: 'c.mp4', type: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' },
    ];
    expect(selectSource(list, 0, play)).toEqual({ index: 4, rejected: [0, 1, 2, 3] });
  });

  it('treats an empty type attribute as "maybe"', () => {
    expect(selectSource([{ src: 'x', type: '' }], 0, () => '')).toEqual({ index: 0, rejected: [] });
  });

  it('reports every rejected candidate when none is playable', () => {
    const list: SourceCandidate[] = [
      { src: 'a', type: 'video/x-unknown' },
      { src: 'b', type: 'text/plain' },
    ];
    expect(selectSource(list, 0, play)).toEqual({ index: -1, rejected: [0, 1] });
    expect(selectSource(list, 1, play)).toEqual({ index: -1, rejected: [1] });
  });
});
