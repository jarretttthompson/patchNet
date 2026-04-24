import type { MediaVideoSource } from "./MediaVideoNode";
import type { MediaImageNode } from "./MediaImageNode";
import type { ImageFXNode }    from "./ImageFXNode";

/** Minimal interface fulfilled by VfxCrtNode and VfxBlurNode. */
export interface VideoFXSource {
  readonly canvas: HTMLCanvasElement;
  readonly isReady: boolean;
  process(): void;
}

/**
 * LayerNode — composites one media source into a VisualizerNode canvas.
 *
 * Priority semantics: lower number = drawn first (background).
 *                     Higher number = drawn last (foreground / on top).
 *                     Priority 0 is the bottom layer.
 *
 * Scale semantics: scaleX / scaleY are multipliers on the canvas dimensions.
 *   1.0 = fills the full canvas axis (default).
 *   0.5 = half the canvas width/height, centered.
 *   2.0 = double the canvas width/height (extends beyond edges).
 * The scaled image is always centered in the canvas.
 */
export class LayerNode {
  private mediaVideo: MediaVideoSource | null = null;
  private mediaImage: MediaImageNode  | null = null;
  private mediaFX:    ImageFXNode     | null = null;
  private videoFX:    VideoFXSource   | null = null;

  scaleX = 1.0;
  scaleY = 1.0;
  posX   = 0.0;
  posY   = 0.0;

  constructor(
    public readonly patchNodeId: string,
    public priority: number,
    scaleX = 1.0,
    scaleY = 1.0,
    posX   = 0.0,
    posY   = 0.0,
  ) {
    this.scaleX = scaleX;
    this.scaleY = scaleY;
    this.posX   = posX;
    this.posY   = posY;
  }

  setMediaVideo(node: MediaVideoSource | null): void { this.mediaVideo = node; this.mediaImage = null; this.mediaFX = null; this.videoFX = null; }
  setMediaImage(node: MediaImageNode | null): void { this.mediaImage = node; this.mediaVideo = null; this.mediaFX = null; this.videoFX = null; }
  setMediaFX   (node: ImageFXNode    | null): void { this.mediaFX    = node; this.mediaImage = null; this.mediaVideo = null; this.videoFX = null; }
  setVideoFX   (node: VideoFXSource  | null): void { this.videoFX    = node; this.mediaVideo = null; this.mediaImage = null; this.mediaFX = null; }

  clearMedia(): void {
    this.mediaVideo = null;
    this.mediaImage = null;
    this.mediaFX    = null;
    this.videoFX    = null;
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // vFX nodes wrap mediaVideo — show placeholder while source video loads
    if (this.videoFX) {
      if (!this.videoFX.isReady) return;
      this.videoFX.process();
      const source = this.videoFX.canvas;
      const drawW = w * this.scaleX;
      const drawH = h * this.scaleY;
      const x     = (w - drawW) / 2 + this.posX * w;
      const y     = (h - drawH) / 2 + this.posY * h;
      try { ctx.drawImage(source, x, y, drawW, drawH); } catch { /* skip */ }
      return;
    }

    if (this.mediaVideo && !this.mediaVideo.isReady) {
      this.drawVideoPlaceholder(
        ctx,
        w,
        h,
        this.mediaVideo.hasError ? "video failed" : "loading video",
      );
      return;
    }

    const source =
      this.mediaVideo?.isReady ? this.mediaVideo.video           :
      this.mediaFX?.isReady   ? this.mediaFX.canvas             :
      this.mediaImage?.isReady ? this.mediaImage.displaySource   :
      null;

    if (!source) return;

    const drawW = w * this.scaleX;
    const drawH = h * this.scaleY;
    const x     = (w - drawW) / 2 + this.posX * w;
    const y     = (h - drawH) / 2 + this.posY * h;

    try {
      ctx.drawImage(source as CanvasImageSource, x, y, drawW, drawH);
    } catch {
      // media not yet decodable — skip frame silently
    }
  }

  private drawVideoPlaceholder(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    label: string,
  ): void {
    const tile = 24;
    for (let y = 0; y < h; y += tile) {
      for (let x = 0; x < w; x += tile) {
        const isDark = ((x / tile) + (y / tile)) % 2 === 0;
        ctx.fillStyle = isDark ? "rgba(0, 0, 0, 0.92)" : "rgba(0, 20, 0, 0.92)";
        ctx.fillRect(x, y, tile, tile);
      }
    }

    ctx.fillStyle = "rgba(0, 255, 0, 0.35)";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(0, 255, 0, 0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, Math.max(0, w - 20), Math.max(0, h - 20));

    ctx.fillStyle = "rgba(0, 255, 0, 0.9)";
    ctx.font = '14px "Vulf Mono", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, w / 2, h / 2);
  }
}
