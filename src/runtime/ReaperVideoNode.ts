import type { VideoFXSource } from "./LayerNode";
import { parseRVideo, type ParamDecl } from "./rvideo/parser";
import { translateRVideoBody } from "./rvideo/translate";
import { RVideoHost, type RVideoSource } from "./rvideo/host";
import { sanitizeIdent } from "./eel2/tokenize";

interface InputSlot {
  video: HTMLVideoElement | null;
  vfx:   VideoFXSource    | null;
}

function emptyInputSlot(): InputSlot {
  return { video: null, vfx: null };
}

/**
 * ReaperVideoNode — REAPER video-processor effect.
 * Signal path: mediaVideo|VideoFXSource → reaperVideo → layer
 *
 * Compiles user-pasted REAPER video-processor code (EEL2) to a per-frame JS
 * function and runs it each time a downstream consumer pulls a frame. The
 * compiled function draws into `this.canvas` via the host's gfx_* calls.
 *
 * Lifecycle:
 *   - compile(source) — parse + translate; on error, keeps last-good frame
 *     fn live so the output doesn't cut out.
 *   - setParam(index, value) — knob changes from the panel; writes the value
 *     into state under the param's sanitized name (`r.x` → `state.u_r_x`).
 *   - process() — pull-driven; called by the downstream consumer.
 */

export type RVideoCompileResult =
  | { ok: true; params: ParamDecl[] }
  | { ok: false; message: string; line?: number };

type FrameFn = (
  state: Record<string, number>,
  params: Float32Array,
  host: RVideoHost,
  mem: Float64Array,
) => void;

/** Shared `mem[]` buffer for `tab[i] = …` style LUT storage. 1M entries
 *  (8MB) is enough for every preset we've seen — colorize uses 768 slots,
 *  heavier presets rarely exceed a few thousand. Matches JSFX defaults. */
const RVIDEO_MEM_SIZE = 1 << 20;

export class ReaperVideoNode implements VideoFXSource {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host = new RVideoHost();

  /** Input slots. Index 0 is the primary input (drives output canvas size);
   *  indices 1+ feed `gfx_blit(N)` / `input_info(N, …)` in presets that
   *  reference them. Sparse — unused indices are empty slots. */
  private inputs: InputSlot[] = [emptyInputSlot()];

  /** Compiled frame fn. Null = passthrough. */
  private frame: FrameFn | null = null;
  /** Latched runtime-error text from the last throw. */
  private runtimeError = "";

  /** EEL2 user-var state (all numeric). Keys are `u_<sanitizedName>`. */
  private state: Record<string, number> = Object.create(null);

  /** Knob values, 64-slot float array. Indexed by (paramIndex - 1). */
  readonly params = new Float32Array(64);
  private paramDecls: ParamDecl[] = [];

  /** Shared user-accessible memory: `tab[i] = x` in EEL2 writes here.
   *  Zeroed on recompile; persists across frames within a compiled program. */
  private readonly mem = new Float64Array(RVIDEO_MEM_SIZE);

  /** Max inner dimension (width or height) the node will render at. Sources
   *  larger than this are downscaled to a scratch canvas before the frame fn
   *  runs — the downstream `layer` upscales for display. Default 360 gives
   *  ~57fps on Gaussian-blur-style `gfx_evalrect` kernels at 1080p sources.
   *  Enforced lower bound prevents the canvas from shrinking so small that
   *  downstream (layer / patchViz) can't display it. */
  private maxRenderDim = 360;
  private static readonly MIN_RENDER_DIM = 128;

  /** Scratch canvas used to downsample the primary input when it exceeds
   *  `maxRenderDim`. Reused across frames. */
  private inputScratch: HTMLCanvasElement | null = null;
  private inputScratchCtx: CanvasRenderingContext2D | null = null;

  // Tier 1.3: satisfies VideoFXSource.outputVersion. ReaperVideo runs an
  // EEL2 frame fn that may have time-dependent or memory-stateful effects,
  // so we conservatively bump on every process() — downstream chained nodes
  // see "input changed" every frame. A future pass could diff
  // currentTime + params + mem-hash, but that's beyond Tier 1.3 scope.
  private _outputVersion = 0;
  get outputVersion(): number { return this._outputVersion; }

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("[ReaperVideoNode] 2D context unavailable");
    this.ctx = ctx;
  }

  /** Override the default render cap. Values below MIN_RENDER_DIM clamp up
   *  (prevents the canvas shrinking to 1px and breaking downstream layer /
   *  patchViz consumers). 0 is interpreted as "no cap" for cheap non-evalrect
   *  presets that can handle source resolution. */
  setMaxRenderDim(max: number): void {
    const n = max | 0;
    this.maxRenderDim = n === 0 ? 0 : Math.max(ReaperVideoNode.MIN_RENDER_DIM, n);
  }

  // ── Input wiring (matches VfxCrtNode/VfxBlurNode API) ────────────────────

  /** Primary-input convenience (matches VfxCrt/VfxBlur API). Writes inlet 0.
   *  Upstream callers that have a raw video element use this. */
  setInput(video: HTMLVideoElement | null): void {
    this.setInputAt(0, video, null);
  }
  /** Primary-input convenience for upstream VFX nodes. Writes inlet 0. */
  setVfxInput(source: VideoFXSource | null): void {
    this.setInputAt(0, null, source);
  }

  /** Multi-input wiring (Phase C). One of `video` or `vfx` must be non-null;
   *  both null clears the slot. `idx` is the inlet index (1+ for secondary
   *  media inputs that presets access via `gfx_blit(N)` / `input_info(N, …)`). */
  setInputAt(idx: number, video: HTMLVideoElement | null, vfx: VideoFXSource | null): void {
    while (this.inputs.length <= idx) this.inputs.push(emptyInputSlot());
    this.inputs[idx] = { video, vfx };
  }

  /** Unwire every input — caller rewires whatever's still connected after. */
  clearInputs(): void {
    for (let i = 0; i < this.inputs.length; i++) this.inputs[i] = emptyInputSlot();
  }

  get isReady(): boolean {
    // Only the primary input gates readiness; secondary inputs missing is fine
    // (gfx_blit(N) with no source just no-ops for that N).
    const slot = this.inputs[0];
    if (!slot) return false;
    if (slot.vfx) return slot.vfx.isReady;
    const v = slot.video;
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  }

  // ── Compilation ─────────────────────────────────────────────────────────

  compile(source: string): RVideoCompileResult {
    const trimmed = source.trim();
    if (!trimmed) {
      // Empty source → passthrough. Reset state + params so a prior
      // compilation's vars don't linger.
      this.frame = null;
      this.paramDecls = [];
      this.state = Object.create(null);
      this.runtimeError = "";
      return { ok: true, params: [] };
    }

    const parsed = parseRVideo(source);
    if (!parsed.ok) return { ok: false, message: parsed.error.message, line: parsed.error.line };

    const translated = translateRVideoBody(parsed.program.body);
    if (!translated.ok) return { ok: false, message: translated.error.message };

    let fn: FrameFn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function("state", "params", "host", "mem", translated.js) as FrameFn;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `JS compile error: ${msg}` };
    }

    // Fresh mem buffer per program — LUTs and scratch from the previous
    // compile would otherwise bleed into the new one.
    this.mem.fill(0);

    // Rebuild state from scratch for the new program, seeding each declared
    // param's sanitized namespaced var from its default so the first frame
    // sees meaningful values even before the panel writes knobs.
    const newState: Record<string, number> = Object.create(null);
    const newParams = new Float32Array(64);

    // Preserve existing knob positions where the same param (by name) survives
    // a recompile — otherwise the user's current knobs reset every edit.
    const prevByName = new Map<string, number>();
    for (let i = 0; i < this.paramDecls.length; i++) {
      prevByName.set(this.paramDecls[i].name, this.params[i]);
    }

    for (let i = 0; i < parsed.program.params.length; i++) {
      const p = parsed.program.params[i];
      const prev = prevByName.get(p.name);
      const value = prev !== undefined ? clamp(prev, p.min, p.max) : p.defaultValue;
      newParams[i] = value;
      newState[`u_${sanitizeIdent(p.name)}`] = value;
    }

    this.frame = fn;
    this.paramDecls = parsed.program.params;
    this.state = newState;
    (this.params as Float32Array).set(newParams);
    this.runtimeError = "";
    // Drop cached gfx_evalrect bodies — the outer program that defined them
    // is being replaced, and a stale compile-failure entry would suppress
    // retries even after the underlying error is fixed.
    this.host.invalidateEvalrectCache();

    return { ok: true, params: parsed.program.params };
  }

  getRuntimeError(): string { return this.runtimeError; }

  setParam(index: number, value: number): void {
    if (index < 0 || index >= 64) return;
    this.params[index] = value;
    const decl = this.paramDecls[index];
    if (decl) this.state[`u_${sanitizeIdent(decl.name)}`] = value;
  }

  // ── Per-frame render (pull-driven by downstream) ────────────────────────

  process(): void {
    if (!this.isReady) return;

    // Resolve every bound input to an RVideoSource. Pull upstream VFX nodes
    // first so their canvases are up to date before the host reads them.
    const resolved: (RVideoSource | null)[] = [];
    for (let i = 0; i < this.inputs.length; i++) {
      const slot = this.inputs[i];
      if (slot.vfx) {
        slot.vfx.process();
        resolved[i] = slot.vfx.canvas;
      } else if (slot.video) {
        resolved[i] = slot.video;
      } else {
        resolved[i] = null;
      }
    }

    const primary = resolved[0];
    if (!primary) return;
    const primarySlot = this.inputs[0];
    const nativeW = primarySlot.video ? primarySlot.video.videoWidth
                  : primarySlot.vfx   ? primarySlot.vfx.canvas.width
                  : 0;
    const nativeH = primarySlot.video ? primarySlot.video.videoHeight
                  : primarySlot.vfx   ? primarySlot.vfx.canvas.height
                  : 0;
    if (nativeW === 0 || nativeH === 0) return;

    // Clamp render dimensions. When the source exceeds `maxRenderDim` we draw
    // it into a scratch canvas at reduced resolution and present that to the
    // host — keeps `gfx_evalrect`-heavy presets realtime at 1080p sources.
    const cap = this.maxRenderDim;
    let w = nativeW;
    let h = nativeH;
    let effectivePrimary: RVideoSource = primary;
    if (cap > 0 && Math.max(nativeW, nativeH) > cap) {
      const scale = cap / Math.max(nativeW, nativeH);
      w = Math.max(1, Math.round(nativeW * scale));
      h = Math.max(1, Math.round(nativeH * scale));
      if (!this.inputScratch) {
        this.inputScratch = document.createElement("canvas");
        const sctx = this.inputScratch.getContext("2d");
        if (!sctx) throw new Error("[ReaperVideoNode] scratch 2D context unavailable");
        this.inputScratchCtx = sctx;
      }
      if (this.inputScratch.width  !== w) this.inputScratch.width  = w;
      if (this.inputScratch.height !== h) this.inputScratch.height = h;
      const sctx = this.inputScratchCtx!;
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(primary, 0, 0, w, h);
      effectivePrimary = this.inputScratch;
      resolved[0] = this.inputScratch;
    }

    if (this.canvas.width  !== w) this.canvas.width  = w;
    if (this.canvas.height !== h) this.canvas.height = h;

    // Passthrough when no compiled frame fn: just show the primary input.
    if (!this.frame) {
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.globalAlpha = 1;
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.drawImage(effectivePrimary, 0, 0, w, h);
      this._outputVersion++;
      return;
    }

    // Normal path: set up host + run compiled frame.
    this.ctx.clearRect(0, 0, w, h);
    this.host.beginFrame(this.ctx, effectivePrimary, w, h);
    this.host.setSources(resolved);

    // Seed the snippet's common size vars so code that reads them before
    // calling input_info (unlikely but possible) sees something sensible.
    this.state.u_project_w = w;
    this.state.u_project_h = h;

    try {
      this.frame(this.state, this.params, this.host, this.mem);
      this.runtimeError = "";
    } catch (e) {
      // Latch the error; don't clobber the output — caller will see the
      // last good frame until compile() replaces the fn.
      this.runtimeError = e instanceof Error ? e.message : String(e);
      // Fall back to passthrough so the display doesn't go black on throw.
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.drawImage(effectivePrimary, 0, 0, w, h);
    }

    this._outputVersion++;
  }

  destroy(): void {
    this.clearInputs();
    this.frame = null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
