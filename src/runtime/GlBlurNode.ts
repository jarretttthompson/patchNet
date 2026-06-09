import type { VideoFXSource } from "./LayerNode";
import { GLContext, GLSourceTexture } from "./gl/GLContext";
import { GLBlurEffect } from "./gl/GLBlurEffect";

/**
 * GlBlurNode — GPU Gaussian blur video effect (Phase 1 step 3).
 * Signal path: mediaVideo|VideoFXSource → glBlur → layer
 *
 * The GPU counterpart to VfxBlurNode. Runs a separable, linear-sampled Gaussian
 * blur on a private WebGL2 context at the source's FULL resolution — no 360px
 * cap, and the cost is independent of blur radius (unlike a CPU kernel). Its
 * output `canvas` is the WebGL canvas, which the existing Canvas2D compositor
 * draws via drawImage() exactly like any other VideoFXSource — so it drops into
 * the chain with no visualizer rewrite.
 *
 * If WebGL2 is unavailable the node goes inert (isReady=false) and the layer
 * simply shows nothing for it, leaving the rest of the patch working.
 */
export class GlBlurNode implements VideoFXSource {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: GLContext | null;
  private readonly src: GLSourceTexture | null;
  private readonly blur: GLBlurEffect | null;

  private inputVideo: HTMLVideoElement | null = null;
  private inputVfx:   VideoFXSource    | null = null;

  /** Blur strength (tap-offset multiplier). Synced from args / audio-driven. */
  radius = 4;

  // Tier 1.3 source-unchanged skip — same protocol as VfxBlurNode.
  private _lastInputVideoTime  = -2;
  private _lastInputVfxVersion = -2;
  private _outputVersion = 0;

  get outputVersion(): number { return this._outputVersion; }

  constructor() {
    this.canvas = document.createElement("canvas");
    let gl: GLContext | null = null;
    let src: GLSourceTexture | null = null;
    let blur: GLBlurEffect | null = null;
    try {
      gl = new GLContext(this.canvas, { preserveDrawingBuffer: true });
      src = new GLSourceTexture(gl.gl);
      blur = new GLBlurEffect(gl);
    } catch (e) {
      console.warn("[GlBlurNode] WebGL2 unavailable — node inert:", e);
      gl = null; src = null; blur = null;
    }
    this.gl = gl;
    this.src = src;
    this.blur = blur;
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
    if (!this.gl) return false;
    if (this.inputVfx) return this.inputVfx.isReady;
    const v = this.inputVideo;
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  }

  process(): void {
    if (!this.gl || !this.src || !this.blur || this.gl.isLost) return;
    if (!this.isReady) return;

    let source: TexImageSource;
    let w: number, h: number;

    if (this.inputVfx) {
      this.inputVfx.process();
      if (this.inputVfx.outputVersion === this._lastInputVfxVersion) return;
      this._lastInputVfxVersion = this.inputVfx.outputVersion;
      const c = this.inputVfx.canvas;
      source = c; w = c.width; h = c.height;
    } else {
      const v = this.inputVideo!;
      if (v.currentTime === this._lastInputVideoTime) return;
      this._lastInputVideoTime = v.currentTime;
      source = v; w = v.videoWidth; h = v.videoHeight;
    }

    if (w === 0 || h === 0) return;

    this.gl.resize(w, h);
    this.src.update(source, w, h);
    this.blur.radius = this.radius;
    const out = this.blur.render(this.src.tex, w, h);
    this.gl.present(out, true);

    this._outputVersion++;
  }

  destroy(): void {
    this.inputVideo = null;
    this.inputVfx   = null;
    this.blur?.destroy();
    this.src?.destroy();
    this.gl?.destroy();
  }
}
