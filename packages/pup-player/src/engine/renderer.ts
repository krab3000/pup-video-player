// Draws VideoFrames onto a canvas sized to the frame's display size; the
// element scales it with CSS (object-fit).

export interface Renderer {
  draw(frame: VideoFrame): void;
  clear(): void;
}

export class CanvasRenderer implements Renderer {
  private ctx: CanvasRenderingContext2D;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
  }

  draw(frame: VideoFrame): void {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
  }

  clear(): void {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
