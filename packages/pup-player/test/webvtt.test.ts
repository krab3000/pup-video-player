import { describe, expect, it } from 'vitest';
import { parseCueText, parseTimestamp, parseWebVTT } from '../src/element/webvtt.js';

describe('parseTimestamp', () => {
  it.each([
    ['00:01.000', 1],
    ['01:02.500', 62.5],
    ['01:00:00.001', 3600.001],
    ['100:00:00.000', 360000],
  ])('%s -> %d', (value, seconds) => {
    expect(parseTimestamp(value)).toBeCloseTo(seconds, 6);
  });

  it.each(['1:02.500', '00:60.000', '00:01,000', '00:01.00', 'abc'])('rejects %s', (value) => {
    expect(parseTimestamp(value)).toBeNaN();
  });
});

describe('parseWebVTT', () => {
  it('parses ids, both timing forms and multi-line text', () => {
    const cues = parseWebVTT(
      'WEBVTT\n\nintro\n00:00:01.000 --> 00:00:02.500\nHello\nworld\n\n00:03.000 --> 00:04.000\nBye\n',
    );
    expect(cues).toEqual([
      { id: 'intro', startTime: 1, endTime: 2.5, text: 'Hello\nworld' },
      { id: '', startTime: 3, endTime: 4, text: 'Bye' },
    ]);
  });

  it('accepts a BOM, header text, CRLF line breaks and header metadata', () => {
    const cues = parseWebVTT('﻿WEBVTT - title\r\nKind: captions\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n');
    expect(cues.map((c) => [c.startTime, c.text])).toEqual([[1, 'Hi']]);
  });

  it('parses line and align, ignoring other settings', () => {
    const [a, b, c] = parseWebVTT(
      'WEBVTT\n\n00:01.000 --> 00:02.000 line:0 align:start position:10% size:50%\nA\n\n' +
        '00:02.000 --> 00:03.000 line:-2,end align:middle\nB\n\n' +
        '00:03.000 --> 00:04.000 line:85% align:bogus vertical:rl\nC\n',
    );
    expect([a.line, a.align]).toEqual([0, 'start']);
    expect([b.line, b.align]).toEqual([-2, 'center']);
    expect([c.line, c.align]).toEqual(['85%', undefined]);
    expect(Object.keys(a).sort()).toEqual(['align', 'endTime', 'id', 'line', 'startTime', 'text']);
  });

  it('skips NOTE, STYLE and REGION blocks', () => {
    const cues = parseWebVTT(
      'WEBVTT\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:r1\n\nNOTE a comment\n00:09.000 --> 00:10.000 is not a cue\n\n' +
        'NOTE\nmulti\nline\n\n00:01.000 --> 00:02.000\nKept\n',
    );
    expect(cues.map((c) => c.text)).toEqual(['Kept']);
  });

  it('keeps raw cue text, including tags and entities', () => {
    const [cue] = parseWebVTT('WEBVTT\n\n00:01.000 --> 00:02.000\n<v Bob>Tom &amp; <i>Jerry</i>\n');
    expect(cue.text).toBe('<v Bob>Tom &amp; <i>Jerry</i>');
  });

  it('throws without the WEBVTT signature', () => {
    expect(() => parseWebVTT('1\n00:01.000 --> 00:02.000\nHi\n')).toThrow(/WEBVTT/);
    expect(() => parseWebVTT('WEBVTTX\n')).toThrow(/WEBVTT/);
    expect(() => parseWebVTT('')).toThrow(/WEBVTT/);
  });

  it('skips malformed cues and keeps going', () => {
    const cues = parseWebVTT(
      'WEBVTT\n\n00:01 --> 00:02.000\nbad start\n\nid only\ntext\n\n00:01.000 -> 00:02.000\nbad arrow\n\n' +
        '00:03.000 --> 00:04.000\nGood\n',
    );
    expect(cues.map((c) => c.text)).toEqual(['Good']);
  });

  it('starts a new cue at a timing line without a blank line', () => {
    const cues = parseWebVTT('WEBVTT\n00:01.000 --> 00:02.000\nOne\n00:02.000 --> 00:03.000\nTwo\n');
    expect(cues.map((c) => [c.startTime, c.text])).toEqual([[1, 'One'], [2, 'Two']]);
  });
});

describe('parseCueText', () => {
  it('keeps b/i/u, nesting included', () => {
    expect(parseCueText('a <b>bold <i>both</i></b> <u>u</u>')).toEqual([
      'a ',
      { tag: 'b', children: ['bold ', { tag: 'i', children: ['both'] }] },
      ' ',
      { tag: 'u', children: ['u'] },
    ]);
  });

  it('strips <v>, classes, other tags and timestamps to their text', () => {
    expect(parseCueText('<v.loud Mary>Hi <c.yellow>there</c> <00:00:01.500>now</v>')).toEqual(['Hi there now']);
    expect(parseCueText('<b.red>x</b>')).toEqual([{ tag: 'b', children: ['x'] }]);
  });

  it('decodes &amp; &lt; &gt; &nbsp; and leaves other entities', () => {
    expect(parseCueText('&lt;b&gt; &amp;&nbsp;&copy;')).toEqual(['<b> & &copy;']);
  });

  it('closes unclosed tags and ignores stray end tags', () => {
    expect(parseCueText('</i>a<b>b')).toEqual(['a', { tag: 'b', children: ['b'] }]);
    // A tag cut off by the end of the text still opens (as in the spec tokenizer).
    expect(parseCueText('a<b')).toEqual(['a', { tag: 'b', children: [] }]);
  });
});
