// The candidate step of the media element resource selection algorithm for
// <source> children, kept free of DOM access so it can be unit-tested.

export interface SourceCandidate {
  /** The `src` attribute (null when absent). */
  src: string | null;
  /** The `type` attribute (null when absent). */
  type: string | null;
}

export interface SourceSelection {
  /** Index of the first usable candidate at or after `from`, -1 if none. */
  index: number;
  /** Candidates passed over on the way (no src, or a type that can't play); each gets an `error` event. */
  rejected: number[];
}

export function selectSource(
  candidates: readonly SourceCandidate[],
  from: number,
  canPlayType: (type: string) => string,
): SourceSelection {
  const rejected: number[] = [];
  for (let i = Math.max(0, from); i < candidates.length; i++) {
    const { src, type } = candidates[i];
    if (!src || (type && canPlayType(type) === '')) rejected.push(i);
    else return { index: i, rejected };
  }
  return { index: -1, rejected };
}
