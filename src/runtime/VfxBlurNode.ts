import type { VideoFXSource } from "./LayerNode";

/**
 * VfxBlurNode — Gaussian blur video effect processor.
 * Signal path: mediaVideo|VideoFXSource → vfxBlur → layer
 *
 * Applies CSS filter blur (and optional saturation/brightness) to each
 * video frame. Lightweight — no off-screen canvases needed.
 */
export class VfxBlurNode implements VideoFXSource {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private inputVideo: HTMLVideoElement | null = null;
  private inputVfx:   VideoFXSource    | null = null;

  // Effect parameters — synced from patchNode.args by VisualizerGraph
  radius     = 2;    // 0–30: Gaussian blur radius in pixels
  saturation = 1;    // 0–3: saturation multiplier
  brightness = 1;    // 0.5–2: brightness multiplier

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("[VfxBlurNode] 2D context unavailable");
    this.ctx = ctx;
  }

  setInput(video: HTMLVideoElement | null): void {
    this.inputVideo = video;
    this.inputVfx   = null;
  }

  setVfxInput(source: VideoFXSource | null): void {
    this.inputVfx   = source;
    this.inputVideo = null;
  }

  get isReady(): boolean {
    if (this.inputVfx)   return this.inputVfx.isReady;
    const v = this.inputVideo;
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  }

  process(): void {
    if (!this.isReady) return;

    let src: HTMLVideoElement | HTMLCanvasElement;
    let w: number, h: number;

    if (this.inputVfx) {
      this.inputVfx.process();
      src = this.inputVfx.canvas;
      w = src.width;
      h = src.height;
    } else {
      const v = this.inputVideo!;
      src = v;
      w = v.videoWidth;
      h = v.videoHeight;
    }

    if (w === 0 || h === 0) return;

    if (this.canvas.width  !== w) this.canvas.width  = w;
    if (this.canvas.height !== h) this.canvas.height = h;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const filterParts: string[] = [];
    if (this.radius > 0)        filterParts.push(`blur(${this.radius}px)`);
    if (this.brightness !== 1)  filterParts.push(`brightness(${this.brightness})`);
    if (this.saturation !== 1)  filterParts.push(`saturate(${this.saturation})`);

    if (filterParts.length > 0) ctx.filter = filterParts.join(" ");
    ctx.drawImage(src, 0, 0, w, h);
    ctx.filter = "none";
  }

  destroy(): void {
    this.inputVideo = null;
    this.inputVfx   = null;
  }
}
