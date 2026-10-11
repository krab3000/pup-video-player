// Media clock. With audio playing, time comes from what the worklet has
// rendered, mapped through the context's output timestamp so output latency
// is compensated. Otherwise it is a wall clock scaled by playbackRate.

export interface AudioPosition {
  /** Media time at the end of the last rendered quantum. */
  mediaTime: number;
  /** Context time at which that quantum is rendered. */
  contextTime: number;
  rate: number;
  starved: boolean;
  ended: boolean;
}

/** How far the audio clock may run past the last report before it holds. */
const MAX_EXTRAPOLATION = 0.25;

export class MediaClock {
  private base = 0;
  private perfBase = 0;
  private running = false;
  private rate = 1;
  private ctx: AudioContext | null = null;
  private pos: AudioPosition | null = null;
  private last = 0;

  /** Drive the clock from audio (`ctx`) or from the wall clock (null). */
  useAudio(ctx: AudioContext | null): void {
    this.ctx = ctx;
    this.pos = null;
  }

  get audioDriven(): boolean {
    return this.ctx !== null;
  }

  /** Re-anchors at `time` (seek, pause). */
  set(time: number): void {
    this.base = this.last = time;
    this.perfBase = performance.now();
    this.pos = null;
  }

  start(): void {
    if (this.running) return;
    this.set(this.base);
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.set(this.now());
    this.running = false;
  }

  setRate(rate: number): void {
    if (this.running && !this.ctx) this.set(this.now());
    this.rate = rate;
  }

  onAudioPosition(pos: AudioPosition): void {
    this.pos = pos;
  }

  now(): number {
    if (!this.running) return this.base;
    let t: number;
    if (this.ctx) {
      const pos = this.pos;
      if (!pos) return this.last;
      let delta = this.outputTime(this.ctx) - pos.contextTime;
      if (pos.starved || pos.ended) delta = Math.min(delta, 0);
      t = pos.mediaTime + Math.min(delta, MAX_EXTRAPOLATION) * pos.rate;
    } else {
      t = this.base + ((performance.now() - this.perfBase) / 1000) * this.rate;
    }
    // Never run backwards while playing (report jitter, latency changes).
    if (t > this.last) this.last = t;
    return this.last;
  }

  /** Context time of the sample currently leaving the speakers. */
  private outputTime(ctx: AudioContext): number {
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.contextTime !== undefined) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency;
  }
}
