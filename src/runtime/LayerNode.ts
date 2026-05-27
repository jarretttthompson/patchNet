import type { MediaVideoSource } from "./MediaVideoNode";
import type { MediaImageNode } from "./MediaImageNode";
import type { ImageFXNode }    from "./ImageFXNode";

/** Minimal interface fulfilled by VfxCrtNode and VfxBlurNode. */
export interface VideoFXSource {
  readonly canvas: HTMLCanvasElement;
  readonly isReady: boolean;
  /** Monotonic counter bumped each frame the node did real work — lets
   *  downstream VFX skip processing when the input is unchanged. */
  readonly outputVersion: number;
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

  scaleX  = 1.0;
  scaleY  = 1.0;
  posX    = 0.0;
  posY    = 0.0;
  opacity = 1.0;
  /** Rotation around the horizontal axis (top/bottom tilt), in radians.
   *  Simulated as a vertical perspective squash: scale-Y by cos(rotX). */
  rotX    = 0.0;
  /** Rotation around the vertical axis (left/right tilt), in radians.
   *  Simulated as a horizontal perspective squash: scale-X by cos(rotY). */
  rotY    = 0.0;
  /** Rotation around the Z axis (in-plane spin), in radians. Exact. */
  rotZ    = 0.0;

  constructor(
    public readonly patchNodeId: string,
    public priority: number,
    scaleX  = 1.0,
    scaleY  = 1.0,
    posX    = 0.0,
    posY    = 0.0,
    opacity = 1.0,
    rotX    = 0.0,
    rotY    = 0.0,
    rotZ    = 0.0,
  ) {
    this.scaleX  = scaleX;
    this.scaleY  = scaleY;
    this.posX    = posX;
    this.posY    = posY;
    this.opacity = opacity;
    this.rotX    = rotX;
    this.rotY    = rotY;
    this.rotZ    = rotZ;
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
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity));

    // vFX nodes wrap mediaVideo — show placeholder while source video loads
    if (this.videoFX) {
      if (!this.videoFX.isReady) { ctx.restore(); return; }
      this.videoFX.process();
      this.drawSourceTransformed(ctx, this.videoFX.canvas, w, h);
      ctx.restore();
      return;
    }

    if (this.mediaVideo && !this.mediaVideo.isReady) {
      this.drawVideoPlaceholder(
        ctx,
        w,
        h,
        this.mediaVideo.hasError ? "video failed" : "loading video",
      );
      ctx.restore();
      return;
    }

    const source =
      this.mediaVideo?.isReady ? this.mediaVideo.video           :
      this.mediaFX?.isReady   ? this.mediaFX.canvas             :
      this.mediaImage?.isReady ? this.mediaImage.displaySource   :
      null;

    if (!source) { ctx.restore(); return; }

    this.drawSourceTransformed(ctx, source as CanvasImageSource, w, h);
    ctx.restore();
  }

  /**
   * Draw `source` into `ctx` with all layer transforms applied:
   *   - positioned by posX/posY (fraction of canvas)
   *   - scaled by scaleX/scaleY
   *   - rotZ: exact in-plane rotation (ctx.rotate)
   *   - rotX: perspective tilt around horizontal axis — simulated as vertical
   *     squash by cos(rotX); negative cos (angle > π/2) produces a mirror flip,
   *     which is the correct visual for a 3D rotation past 90°.
   *   - rotY: perspective tilt around vertical axis — simulated as horizontal
   *     squash by cos(rotY).
   * All rotations pivot around the layer's display center (posX/posY point).
   */
  private drawSourceTransformed(
    ctx: CanvasRenderingContext2D,
    source: CanvasImageSource,
    w: number,
    h: number,
  ): void {
    const drawW = w * this.scaleX;
    const drawH = h * this.scaleY;
    // Center of the layer in canvas space
    const cx = w / 2 + this.posX * w;
    const cy = h / 2 + this.posY * h;

    ctx.translate(cx, cy);
    if (this.rotZ !== 0) ctx.rotate(this.rotZ);
    if (this.rotX !== 0 || this.rotY !== 0) {
      ctx.scale(Math.cos(this.rotY), Math.cos(this.rotX));
    }

    try {
      ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
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
