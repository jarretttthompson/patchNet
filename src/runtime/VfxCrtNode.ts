import type { VideoFXSource } from "./LayerNode";

/**
 * VfxCrtNode — CRT video effect processor.
 * Signal path: mediaVideo|VideoFXSource → vfxCRT → layer
 *
 * Applies scanlines, vignette, chromatic aberration, and screen curvature
 * approximation using canvas 2D compositing.
 */
export class VfxCrtNode implements VideoFXSource {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private inputVideo: HTMLVideoElement | null = null;
  private inputVfx:   VideoFXSource    | null = null;

  // Cached temp canvases for chromatic aberration (avoid per-frame allocation)
  private readonly tmpR: HTMLCanvasElement;
  private readonly tmpCtxR: CanvasRenderingContext2D;
  private readonly tmpB: HTMLCanvasElement;
  private readonly tmpCtxB: CanvasRenderingContext2D;

  // Effect parameters — synced from patchNode.args by VisualizerGraph
  scanlines  = 0.35;   // 0–1: scanline darkness
  vignette   = 0.45;   // 0–1: corner vignette strength
  rgbShift   = 1.5;    // 0–10: chromatic aberration in pixels
  curvature  = 0.15;   // 0–1: screen edge curvature / corner darkening
  brightness = 1.0;    // 0.5–2: overall brightness

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("[VfxCrtNode] 2D context unavailable");
    this.ctx = ctx;

    this.tmpR = document.createElement("canvas");
    const ctxR = this.tmpR.getContext("2d");
    if (!ctxR) throw new Error("[VfxCrtNode] temp R context unavailable");
    this.tmpCtxR = ctxR;

    this.tmpB = document.createElement("canvas");
    const ctxB = this.tmpB.getContext("2d");
    if (!ctxB) throw new Error("[VfxCrtNode] temp B context unavailable");
    this.tmpCtxB = ctxB;
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

    this.ensureSize(this.canvas, w, h);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // 1. Base frame with brightness
    if (this.brightness !== 1) {
      ctx.filter = `brightness(${this.brightness})`;
    }
    ctx.drawImage(src, 0, 0, w, h);
    ctx.filter = "none";

    // 2. Chromatic aberration (RGB shift)
    if (this.rgbShift > 0.5) {
      const shift = Math.round(this.rgbShift);
      // Alpha scales with shift strength; base of 0.30 keeps default 1.5px clearly visible
      const caAlpha = Math.min(0.30 + (this.rgbShift / 40) * 0.55, 0.88);
      this.ensureSize(this.tmpR, w, h);
      this.ensureSize(this.tmpB, w, h);

      // Red-tinted copy shifted right
      const cR = this.tmpCtxR;
      cR.clearRect(0, 0, w, h);
      cR.drawImage(src, 0, 0, w, h);
      cR.globalCompositeOperation = "multiply";
      cR.fillStyle = "#ff3300";
      cR.fillRect(0, 0, w, h);
      cR.globalCompositeOperation = "source-over";

      // Blue-tinted copy shifted left
      const cB = this.tmpCtxB;
      cB.clearRect(0, 0, w, h);
      cB.drawImage(src, 0, 0, w, h);
      cB.globalCompositeOperation = "multiply";
      cB.fillStyle = "#0033ff";
      cB.fillRect(0, 0, w, h);
      cB.globalCompositeOperation = "source-over";

      // Overlay shifted copies with screen blend — alpha now tracks shift strength
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = caAlpha;
      ctx.drawImage(this.tmpR,  shift, 0, w, h);
      ctx.drawImage(this.tmpB, -shift, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    // 3. Scanlines — alternating dark horizontal bands
    if (this.scanlines > 0) {
      ctx.fillStyle = `rgba(0,0,0,${this.scanlines * 0.6})`;
      for (let y = 0; y < h; y += 3) {
        ctx.fillRect(0, y, w, 1);
      }
    }

    // 4. Screen curvature — darken corners to simulate curved CRT glass
    if (this.curvature > 0) {
      // Smaller radius concentrates darkening at corners; higher intensity makes it legible
      const r = Math.min(w, h) * (0.3 + this.curvature * 0.3);
      const intensity = Math.min(this.curvature * 3.5, 0.95);
      const corners = [[0, 0], [w, 0], [0, h], [w, h]] as const;
      for (const [cx, cy] of corners) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(0,0,0,${intensity})`);
        g.addColorStop(0.6, `rgba(0,0,0,${intensity * 0.3})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    }

    // 5. Vignette — radial gradient dark toward edges
    if (this.vignette > 0) {
      const innerR = Math.min(w, h) * 0.2;
      const outerR = Math.max(w, h) * 0.65;
      const g = ctx.createRadialGradient(w / 2, h / 2, innerR, w / 2, h / 2, outerR);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.5, `rgba(0,0,0,${this.vignette * 0.4})`);
      g.addColorStop(1, `rgba(0,0,0,${Math.min(this.vignette, 1)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }

  private ensureSize(c: HTMLCanvasElement, w: number, h: number): void {
    if (c.width !== w)  c.width  = w;
    if (c.height !== h) c.height = h;
  }

  destroy(): void {
    this.inputVideo = null;
    this.inputVfx   = null;
  }
}
