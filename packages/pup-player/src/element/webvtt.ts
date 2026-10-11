// Minimal WebVTT parser for <track> captions: cue ids, timings, the `line`
// and `align` settings, and the basic cue text tags. Regions, styles and
// other settings are ignored.

export type CueAlign = 'start' | 'center' | 'end' | 'left' | 'right';

export interface VttCue {
  id: string;
  startTime: number;
  endTime: number;
  /** Raw cue payload (tags and entities included), like VTTCue.text. */
  text: string;
  /** Line number (negative counts from the bottom) or a percentage like "10%". */
  line?: number | string;
  align?: CueAlign;
}

/** Cue text as a tree: plain strings and b/i/u spans. */
export type CueNode = string | { tag: 'b' | 'i' | 'u'; children: CueNode[] };

const TIMESTAMP = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
const TIMING = /^(\S+)[ \t]+-->[ \t]+(\S+)(.*)$/;
const ALIGNS = new Set(['start', 'center', 'end', 'left', 'right']);
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };

/** Seconds, or NaN when `value` isn't a WebVTT timestamp. */
export function parseTimestamp(value: string): number {
  const m = TIMESTAMP.exec(value);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Parses a WebVTT file. Throws when the WEBVTT signature is missing; skips malformed cues. */
export function parseWebVTT(input: string): VttCue[] {
  const lines = input.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0])) throw new Error('not a WebVTT file (missing WEBVTT header)');
  const cues: VttCue[] = [];
  let i = 1;
  // Header lines run up to the first blank line (or a stray cue timing).
  while (i < lines.length && lines[i] !== '' && !lines[i].includes('-->')) i++;
  while (i < lines.length) {
    if (lines[i] === '') {
      i++;
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && lines[i] !== '') block.push(lines[i++]);
    parseBlock(block, cues);
  }
  return cues;
}

function parseBlock(block: string[], cues: VttCue[]): void {
  if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block[0])) return;
  const timingAt = block[0].includes('-->') ? 0 : block.length > 1 && block[1].includes('-->') ? 1 : -1;
  if (timingAt < 0) return;
  // A timing line inside the cue text starts the next cue.
  let end = timingAt + 1;
  while (end < block.length && !block[end].includes('-->')) end++;
  const cue = parseTiming(block[timingAt]);
  if (cue) {
    cue.id = timingAt === 1 ? block[0] : '';
    cue.text = block.slice(timingAt + 1, end).join('\n');
    cues.push(cue);
  }
  if (end < block.length) parseBlock(block.slice(end), cues);
}

function parseTiming(line: string): VttCue | null {
  const m = TIMING.exec(line.trim());
  if (!m) return null;
  const startTime = parseTimestamp(m[1]);
  const endTime = parseTimestamp(m[2]);
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) return null;
  const cue: VttCue = { id: '', startTime, endTime, text: '' };
  for (const setting of m[3].trim().split(/[ \t]+/)) {
    const sep = setting.indexOf(':');
    if (sep <= 0) continue;
    const key = setting.slice(0, sep);
    const value = setting.slice(sep + 1);
    if (key === 'line') {
      const pos = value.split(',')[0];
      if (/^\d+(\.\d+)?%$/.test(pos)) cue.line = pos;
      else if (/^-?\d+$/.test(pos)) cue.line = Number(pos);
    } else if (key === 'align') {
      const align = value === 'middle' ? 'center' : value;
      if (ALIGNS.has(align)) cue.align = align as CueAlign;
    }
  }
  return cue;
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|nbsp);/g, (e) => ENTITIES[e]);
}

/**
 * Cue text to a render tree: <b>, <i> and <u> are kept, <v Speaker> and every
 * other tag (classes, <c>, <lang>, <ruby>, timestamps) is reduced to its text.
 */
export function parseCueText(text: string): CueNode[] {
  const root: CueNode[] = [];
  const stack: Array<{ tag: string; children: CueNode[] }> = [{ tag: '', children: root }];
  const top = () => stack[stack.length - 1];
  const append = (s: string) => {
    if (!s) return;
    const children = top().children;
    const last = children[children.length - 1];
    if (typeof last === 'string') children[children.length - 1] = last + s;
    else children.push(s);
  };
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      append(decodeEntities(text.slice(i)));
      break;
    }
    append(decodeEntities(text.slice(i, lt)));
    const gt = text.indexOf('>', lt);
    const tag = text.slice(lt + 1, gt < 0 ? text.length : gt);
    i = gt < 0 ? text.length : gt + 1;
    const closing = tag.startsWith('/');
    const name = (closing ? tag.slice(1) : tag).split(/[.\s]/)[0];
    if (name !== 'b' && name !== 'i' && name !== 'u') continue;
    if (closing) {
      let at = stack.length - 1;
      while (at > 0 && stack[at].tag !== name) at--;
      if (at > 0) stack.length = at;
    } else {
      const node = { tag: name, children: [] as CueNode[] };
      top().children.push(node as CueNode);
      stack.push(node);
    }
  }
  return root;
}
