// AudioWorklet sink. Receives planar PCM chunks from the decode worker over a
// MessagePort, plays them while `playing`, and reports the media time it has
// rendered (to main, for the clock) and how much it has buffered (to the
// decode worker, for flow control).
//
// The processor is kept as a source string and loaded from a Blob URL so it
// works with any bundler.

const REPORT_EVERY_QUANTA = 8;

const processorSource = /* js */ `
class PupAudioSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.epoch = -1;
    this.playing = false;
    this.eos = false;
    this.data = null;
    this.mediaTime = 0;
    this.rate = 1;
    this.quanta = 0;
    this.lastState = '';
    this.cut = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'port') {
        this.data = m.port;
        this.data.onmessage = (ev) => this.onData(ev.data);
      } else if (m.type === 'flush') {
        this.adopt(m.epoch);
      } else if (m.type === 'play') {
        this.playing = true;
      } else if (m.type === 'pause') {
        this.playing = false;
      }
    };
  }

  // Epochs only grow. Main's flush and the decoder's first chunk of a new
  // epoch travel on different ports, so whichever arrives first flushes.
  adopt(epoch) {
    if (epoch <= this.epoch) return;
    this.epoch = epoch;
    this.queue = [];
    this.offset = 0;
    this.eos = false;
    this.cut = null;
  }

  onData(m) {
    this.adopt(m.epoch);
    if (m.epoch !== this.epoch) return;
    if (m.type === 'chunk') {
      if (this.cut !== null && !this.trim(m)) return;
      if (this.queue.length === 0 && this.offset === 0) this.mediaTime = m.pts;
      this.queue.push(m);
    } else if (m.type === 'eos') {
      this.eos = true;
    } else if (m.type === 'truncate') {
      // Rate change: replacement audio starts before what's already been
      // played; skip up to the current position so playback continues.
      this.queue = [];
      this.offset = 0;
      this.eos = false;
      this.cut = this.mediaTime;
    }
  }

  // Drops the part of chunk m before this.cut. Returns false if nothing is left.
  trim(m) {
    const len = m.channels[0].length;
    const skip = Math.ceil(((this.cut - m.pts) * sampleRate) / m.rate);
    if (skip <= 0) {
      this.cut = null;
      return true;
    }
    if (skip >= len) return false;
    m.channels = m.channels.map((ch) => ch.subarray(skip));
    m.pts = this.cut;
    this.cut = null;
    return true;
  }

  buffered() {
    let frames = -this.offset;
    for (const c of this.queue) frames += c.channels[0].length;
    return frames / sampleRate;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    let written = 0;
    if (this.playing) {
      while (written < n && this.queue.length) {
        const c = this.queue[0];
        const len = c.channels[0].length;
        const take = Math.min(n - written, len - this.offset);
        for (let ch = 0; ch < out.length; ch++) {
          const src = c.channels[Math.min(ch, c.channels.length - 1)];
          out[ch].set(src.subarray(this.offset, this.offset + take), written);
        }
        written += take;
        this.offset += take;
        this.rate = c.rate;
        this.mediaTime = c.pts + (this.offset * c.rate) / sampleRate;
        if (this.offset >= len) {
          this.queue.shift();
          this.offset = 0;
        }
      }
    }
    const starved = this.playing && written < n && !this.eos;
    const ended = this.eos && this.queue.length === 0;
    const state = starved + '|' + ended + '|' + this.playing;
    if (++this.quanta >= ${REPORT_EVERY_QUANTA} || state !== this.lastState) {
      this.quanta = 0;
      this.lastState = state;
      const buffered = this.buffered();
      // mediaTime is the media time at the end of this quantum, which is
      // rendered at context time currentTime + n / sampleRate.
      this.port.postMessage({
        type: 'pos',
        epoch: this.epoch,
        mediaTime: this.mediaTime,
        contextTime: currentTime + n / sampleRate,
        rate: this.rate,
        starved,
        ended,
        buffered,
      });
      if (this.data) this.data.postMessage({ type: 'buffered', epoch: this.epoch, seconds: buffered });
    }
    return true;
  }
}
registerProcessor('pup-audio-sink', PupAudioSink);
`;

let moduleUrl: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Registers the processor on `ctx` (once per context). */
export function loadAudioSink(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    moduleUrl ??= URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(moduleUrl);
    loaded.set(ctx, p);
  }
  return p;
}
