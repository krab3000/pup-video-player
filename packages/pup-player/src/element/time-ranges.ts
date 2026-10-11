/** Read-only TimeRanges built from sorted, merged [start, end] pairs. */
export class PupTimeRanges implements TimeRanges {
  private ranges: Array<[number, number]>;

  constructor(ranges: Array<[number, number]> = []) {
    this.ranges = PupTimeRanges.normalize(ranges);
  }

  static normalize(ranges: Array<[number, number]>): Array<[number, number]> {
    const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
    const out: Array<[number, number]> = [];
    for (const [s, e] of sorted) {
      const last = out[out.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }

  get length(): number {
    return this.ranges.length;
  }

  start(index: number): number {
    return this.at(index)[0];
  }

  end(index: number): number {
    return this.at(index)[1];
  }

  private at(index: number): [number, number] {
    const r = this.ranges[index];
    if (!r) throw new DOMException(`index ${index} out of range`, 'IndexSizeError');
    return r;
  }
}
