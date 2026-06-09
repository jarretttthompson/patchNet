import type { GLContext, RenderTarget } from "./GLContext";
import { BLUR_FRAG } from "./glShaders";

/**
 * GPU separable Gaussian blur (Phase 1 step 2).
 *
 * Two fullscreen-triangle passes ping-ponging through a pair of render targets:
 * horizontal (source → A) then vertical (A → B). Each pass is the linear-sampled
 * 9-tap kernel in BLUR_FRAG, so a full 2D blur costs O(2N) fetches instead of
 * O(N²). Targets are allocated lazily and reused, reallocated only when the
 * source resolution changes — no per-frame allocation.
 *
 * Reusable beyond the self-test: step 3 wires this into the LayerNode effect
 * chain as the first real GPU `GLEffect`, replacing the CPU reaperVideo blur.
 */
export class GLBlurEffect {
  /** Tap-offset multiplier — blur strength. Drive from audio for reactivity. */
  radius = 4;

  private targetA: RenderTarget | null = null;
  private targetB: RenderTarget | null = null;
  private w = 0;
  private h = 0;

  constructor(private readonly ctx: GLContext) {}

  /**
   * Blur `srcTex` (intrinsic size `w`×`h`) and return the result texture.
   * The returned texture is owned by this effect — don't hold it across a
   * resolution change (it gets reallocated).
   */
  render(srcTex: WebGLTexture, w: number, h: number): WebGLTexture {
    this.ensureTargets(w, h);
    const ctx = this.ctx;
    const gl = ctx.gl;
    const prog = ctx.getProgram("blur", BLUR_FRAG);
    const tx = 1 / w;
    const ty = 1 / h;

    // Horizontal: source → A
    ctx.draw(this.targetA!, prog, (p) => {
      ctx.bindTexture(0, srcTex);
      gl.uniform1i(p.uniform("u_tex"), 0);
      gl.uniform2f(p.uniform("u_texel"), tx, ty);
      gl.uniform2f(p.uniform("u_dir"), 1, 0);
      gl.uniform1f(p.uniform("u_radius"), this.radius);
    });

    // Vertical: A → B
    ctx.draw(this.targetB!, prog, (p) => {
      ctx.bindTexture(0, this.targetA!.tex);
      gl.uniform1i(p.uniform("u_tex"), 0);
      gl.uniform2f(p.uniform("u_texel"), tx, ty);
      gl.uniform2f(p.uniform("u_dir"), 0, 1);
      gl.uniform1f(p.uniform("u_radius"), this.radius);
    });

    return this.targetB!.tex;
  }

  private ensureTargets(w: number, h: number): void {
    if (this.targetA && this.w === w && this.h === h) return;
    if (this.targetA) this.ctx.deleteTarget(this.targetA);
    if (this.targetB) this.ctx.deleteTarget(this.targetB);
    this.targetA = this.ctx.createTarget(w, h);
    this.targetB = this.ctx.createTarget(w, h);
    this.w = w;
    this.h = h;
  }

  destroy(): void {
    if (this.targetA) this.ctx.deleteTarget(this.targetA);
    if (this.targetB) this.ctx.deleteTarget(this.targetB);
    this.targetA = null;
    this.targetB = null;
  }
}
