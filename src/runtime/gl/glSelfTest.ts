import { GLContext, GLSourceTexture } from "./GLContext";
import { GLBlurEffect } from "./GLBlurEffect";
import { TESTPATTERN_FRAG } from "./glShaders";

/**
 * Phase 1 step-1 verification hook. Proves the WebGL2 render core end to end:
 * context → program → attribute-less fullscreen draw → (optional) video frame
 * uploaded to a GPU texture at full resolution → presented to a canvas.
 *
 * Run from the devtools console of the running app:
 *
 *   __pnGLTest()                 // animated GPU test pattern
 *   __pnGLTest({ video: el })    // upload+present a specific <video> at full res
 *
 * With no `video`, it auto-picks the first <video> in the document if present,
 * else falls back to the procedural pattern. Returns a handle with stop().
 */
export interface GLSelfTestHandle {
  stop(): void;
  readonly canvas: HTMLCanvasElement;
}

export interface GLSelfTestOpts {
  video?: HTMLVideoElement | null;
  /** CSS width of the preview overlay (px). Default 480. */
  previewW?: number;
}

export function glSelfTest(opts: GLSelfTestOpts = {}): GLSelfTestHandle {
  const video =
    opts.video ?? (document.querySelector("video") as HTMLVideoElement | null);
  const previewW = opts.previewW ?? 480;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;top:8px;right:8px;width:${previewW}px;height:auto;z-index:2147483647;border:1px solid #0f0;background:#000;image-rendering:auto;`;
  // Initial buffer size; resized to the video's intrinsic resolution below.
  canvas.width = 1280;
  canvas.height = 720;
  document.body.appendChild(canvas);

  const ctx = new GLContext(canvas);
  const src = new GLSourceTexture(ctx.gl);

  let running = true;
  let rafId = 0;
  let frames = 0;
  let acc = 0;
  let last = performance.now();
  const t0 = last;

  const tick = () => {
    if (!running || ctx.isLost) return;
    const now = performance.now();
    acc += now - last;
    frames++;
    last = now;
    if (acc >= 1000) {
      const fps = (frames * 1000) / acc;
      const mode = hasVideoFrame() ? `video ${src.width}x${src.height}` : "testpattern";
      // eslint-disable-next-line no-console
      console.log(`[glSelfTest] ${fps.toFixed(1)} fps  (${mode})`);
      acc = 0;
      frames = 0;
    }

    if (hasVideoFrame()) {
      const vw = video!.videoWidth;
      const vh = video!.videoHeight;
      // Render the GPU buffer at the video's FULL resolution (the point of the
      // test) — the CSS width just scales the on-screen preview down.
      ctx.resize(vw, vh);
      src.update(video!, vw, vh);
      ctx.present(src.tex, true);
    } else {
      const prog = ctx.getProgram("testpattern", TESTPATTERN_FRAG);
      ctx.draw(null, prog, (p) => {
        ctx.gl.uniform1f(p.uniform("u_time"), (now - t0) / 1000);
      });
    }

    rafId = requestAnimationFrame(tick);
  };

  const hasVideoFrame = (): boolean =>
    !!video && video.readyState >= 2 && video.videoWidth > 0;

  rafId = requestAnimationFrame(tick);

  const handle: GLSelfTestHandle = {
    canvas,
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
      src.destroy();
      ctx.destroy();
      canvas.remove();
    },
  };
  return handle;
}

// ── Step 2: GPU separable-blur A/B test ────────────────────────────────

export interface GLBlurTestHandle {
  stop(): void;
  setRadius(r: number): void;
  readonly canvas: HTMLCanvasElement;
}

export interface GLBlurTestOpts {
  video?: HTMLVideoElement | null;
  /** Initial blur strength (tap-offset multiplier). Default 6. */
  radius?: number;
  previewW?: number;
}

/**
 * Blurs a <video> entirely on the GPU at the source's FULL resolution and
 * presents it. Run from the console:
 *
 *   const b = __pnGLBlurTest({ radius: 8 })   // start
 *   b.setRadius(20)                            // crank the blur live
 *   b.stop()                                   // tear down
 *
 * Compare its fps (logged each second) against your CPU reaperVideo blur, which
 * is capped at 360px and runs per-pixel on the main thread. This one runs at
 * 1080p (or whatever the source is) and should hold 60fps.
 */
export function glBlurTest(opts: GLBlurTestOpts = {}): GLBlurTestHandle {
  const video =
    opts.video ?? (document.querySelector("video") as HTMLVideoElement | null);
  const previewW = opts.previewW ?? 480;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;top:8px;right:8px;width:${previewW}px;height:auto;z-index:2147483647;border:1px solid #0f0;background:#000;`;
  canvas.width = 1280;
  canvas.height = 720;
  document.body.appendChild(canvas);

  const ctx = new GLContext(canvas);
  const src = new GLSourceTexture(ctx.gl);
  const blur = new GLBlurEffect(ctx);
  blur.radius = opts.radius ?? 6;

  let running = true;
  let rafId = 0;
  let frames = 0;
  let acc = 0;
  let last = performance.now();

  const hasFrame = (): boolean =>
    !!video && video.readyState >= 2 && video.videoWidth > 0;

  const tick = () => {
    if (!running || ctx.isLost) return;
    const now = performance.now();
    acc += now - last;
    frames++;
    last = now;
    if (acc >= 1000) {
      const fps = (frames * 1000) / acc;
      const mode = hasFrame() ? `video ${src.width}x${src.height} r=${blur.radius}` : "no video";
      // eslint-disable-next-line no-console
      console.log(`[glBlurTest] ${fps.toFixed(1)} fps  (${mode})`);
      acc = 0;
      frames = 0;
    }

    if (hasFrame()) {
      const vw = video!.videoWidth;
      const vh = video!.videoHeight;
      ctx.resize(vw, vh);
      src.update(video!, vw, vh);
      const out = blur.render(src.tex, vw, vh);
      ctx.present(out, true);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    canvas,
    setRadius(r: number) { blur.radius = Math.max(0, r); },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
      blur.destroy();
      src.destroy();
      ctx.destroy();
      canvas.remove();
    },
  };
}

// Expose on window for console-driven verification in dev.
(globalThis as unknown as {
  __pnGLTest?: typeof glSelfTest;
  __pnGLBlurTest?: typeof glBlurTest;
}).__pnGLTest = glSelfTest;
(globalThis as unknown as { __pnGLBlurTest?: typeof glBlurTest }).__pnGLBlurTest = glBlurTest;
