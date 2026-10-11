import { describe, expect, it } from 'vitest';
import { activeCuesAt, PupTextTrackCueList, PupTextTrackList, sameCues } from '../src/element/text-tracks.js';
import type { VttCue } from '../src/element/webvtt.js';

const cue = (startTime: number, endTime: number, text = ''): VttCue => ({ id: '', startTime, endTime, text });

describe('activeCuesAt', () => {
  const cues = [cue(1, 3, 'a'), cue(2, 4, 'b'), cue(5, 6, 'c')];

  it('includes the start time and excludes the end time', () => {
    expect(activeCuesAt(cues, 0.999)).toEqual([]);
    expect(activeCuesAt(cues, 1).map((c) => c.text)).toEqual(['a']);
    expect(activeCuesAt(cues, 3).map((c) => c.text)).toEqual(['b']);
    expect(activeCuesAt(cues, 6)).toEqual([]);
  });

  it('returns overlapping cues in file order', () => {
    expect(activeCuesAt(cues, 2.5).map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('sameCues compares by identity and order', () => {
    expect(sameCues(activeCuesAt(cues, 2.5), [cues[0], cues[1]])).toBe(true);
    expect(sameCues([cues[1], cues[0]], [cues[0], cues[1]])).toBe(false);
    expect(sameCues([cue(1, 3, 'a')], [cues[0]])).toBe(false);
  });
});

describe('PupTextTrackCueList', () => {
  it('is array-like and drops stale indices', () => {
    const list = new PupTextTrackCueList();
    list._set([cue(0, 1, 'x'), { ...cue(1, 2, 'y'), id: 'y' }]);
    expect([list.length, list[0].text, list.getCueById('y')?.text]).toEqual([2, 'x', 'y']);
    list._set([cue(2, 3, 'z')]);
    expect([list.length, list[0].text, list[1], [...list].length]).toEqual([1, 'z', undefined, 1]);
  });
});

describe('PupTextTrackList', () => {
  it('fires addtrack/removetrack for the difference and calls on* handlers', () => {
    const list = new PupTextTrackList();
    const events: string[] = [];
    list.onaddtrack = () => events.push('add');
    list.addEventListener('removetrack', () => events.push('remove'));
    const a = {} as never;
    const b = {} as never;
    list._set([a, b]);
    list._set([b]);
    expect(events).toEqual(['add', 'add', 'remove']);
    expect([list.length, list[0] === b, list[1], list.item(5)]).toEqual([1, true, undefined, null]);
  });
});
