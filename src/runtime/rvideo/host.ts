/**
 * Canvas2D host for the REAPER video-processor subset.
 *
 * The translator emits `host.gfx_fillrect(...)`, `host.gfx_blit(...)`,
 * `host.gfx_rect(...)` etc. plus `host.input_info(state, idx, "u_w", "u_h")`
 * calls; this class implements them against a target 2D context plus a
 * per-frame source resolution.
 *
 * ── gfx_mode (bitfield) ─────────────────────────────────────────────────
 * REAPER's exact bit layout is under-documented. What we currently honor:
 *   bit 0 (0x01) ........ additive compositing (globalCompositeOperation="lighter")
 *   bit 3 (0x08) ........ linear source filter (imageSmoothingEnabled = true)
 *   special cases ....... 0xfa / 0xf5 / 0xf0 isolate R / G / B (additive) for
 *                         the RGB-decompose preset — the reference snippet
 *                         locks Phase A scope.
 * Every other bit pattern falls through to normal source-over.
 * TODO(Phase B): verify the remaining bits empirically against REAPER.
 *
 * Canvas2D can't per-channel-mask `drawImage` directly, so channel isolation
 * runs the source through a scratch canvas that multiplies by the desired
 * tint, then blits with `globalCompositeOperation = "lighter"` to sum
 * channels additively.
 *
 * ── gfx_a/gfx_r/gfx_g/gfx_b ─────────────────────────────────────────────
 * These are the active fill color for `gfx_rect`, `gfx_line`, `gfx_circle`,
 * `gfx_fillrect`, `gfx_drawstr`. Range 0–1, clamped when emitted as CSS.
 *
 * ── gfx_x/gfx_y ─────────────────────────────────────────────────────────
 * Text cursor + single-pixel op cursor. `gfx_drawstr` draws at (gfx_x, gfx_y)
 * and advances gfx_x by the measured width; `gfx_setpixel` / `gfx_getpixel`
 * operate at (gfx_x, gfx_y).
 */

import {
  compileEvalrectBody,
  type EvalrectCompiled,
} from "./evalrect";
import { rvideoResolvers } from "./translate";

export type RVideoSource = HTMLVideoElement | HTMLCanvasElement;

interface FontSlot {
  name: string;    // CSS font-family
  size: number;    // px
  flags: number;   // bit 0 = bold, bit 1 = italic (REAPER convention)
}

const DEFAULT_FONT: FontSlot = { name: "sans-serif", size: 12, flags: 0 };

export class RVideoHost {
  /** Target 2D context the frame body draws into. Set per-frame by the
   *  owning ReaperVideoNode.process(). */
  ctx: CanvasRenderingContext2D | null = null;

  /** Current input sources, indexed. Phase A filled index 0 only; Phase C
   *  extends to multi-input. */
  sources: (RVideoSource | null)[] = [];

  /** Output canvas dimensions the host believes are current. Set per-frame
   *  by the node so gfx_fillrect(0,0,project_w,project_h) clears the right
   *  region even if the source-set dims haven't propagated. */
  outWidth  = 0;
  outHeight = 0;

  // ── Mutable EEL2-level state ────────────────────────────────────────────
  gfx_mode     = 0;
  gfx_a        = 1;
  gfx_r        = 1;
  gfx_g        = 1;
  gfx_b        = 1;
  gfx_x        = 0;
  gfx_y        = 0;
  gfx_texth    = 12;   // REAPER reports current font's line height
  colorspace   = "RGBA";

  // Font slots (REAPER supports 1..16; default = slot 0).
  private fontSlots: FontSlot[] = [{ ...DEFAULT_FONT }];
  private currentFont = 0;

  // ── Compiled gfx_evalrect body cache (keyed by source string) ───────────
  private readonly evalrectCache = new Map<string, EvalrectCompiled | null>();

  // ── Scratch canvases for channel-mask compositing ───────────────────────
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;

  constructor() {
    this.scratch = document.createElement("canvas");
    const ctx = this.scratch.getContext("2d");
    if (!ctx) throw new Error("[RVideoHost] scratch 2D context unavailable");
    this.scratchCtx = ctx;
  }

  // ── Frame lifecycle ─────────────────────────────────────────────────────

  beginFrame(ctx: CanvasRenderingContext2D, source: RVideoSource | null, w: number, h: number): void {
    this.ctx = ctx;
    this.sources[0] = source;
    this.outWidth = w;
    this.outHeight = h;
    this.gfx_mode = 0;
    this.gfx_a = 1; this.gfx_r = 1; this.gfx_g = 1; this.gfx_b = 1;
    this.gfx_x = 0; this.gfx_y = 0;
    this.currentFont = 0;
    this.gfx_texth = this.fontSlots[0].size;
    // Reset composite op + smoothing at frame start so prior-frame state
    // doesn't leak.
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
  }

  /** Replace the indexed inputs in one shot (Phase C). Index 0 is the
   *  required primary input; higher indices are optional secondary feeds. */
  setSources(srcs: (RVideoSource | null)[]): void {
    this.sources = srcs.slice();
  }

  // ── EEL2-visible stdlib: source info ────────────────────────────────────

  /** REAPER's input_info — reads the source's natural size into the supplied
   *  state keys. Returns 1 when a source is ready, 0 otherwise. */
  input_info(state: Record<string, number>, idx: number, wKey: string, hKey: string): number {
    const src = this.sources[idx] ?? null;
    if (!src) {
      state[wKey] = 0;
      state[hKey] = 0;
      return 0;
    }
    const w = sourceWidth(src);
    const h = sourceHeight(src);
    state[wKey] = w;
    state[hKey] = h;
    return w > 0 && h > 0 ? 1 : 0;
  }

  // ── EEL2-visible stdlib: filled / cleared primitives ────────────────────

  /** REAPER's gfx_fillrect clears the region (its default fillstyle is
   *  transparent black) — the RGB-decompose reference snippet uses it
   *  exactly that way before compositing. */
  gfx_fillrect(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(x, y, w, h);
    ctx.globalCompositeOperation = prev;
  }

  /** gfx_rect(x, y, w, h [, filled=1]) — solid rectangle using the current
   *  gfx_a/r/g/b color. Honors additive bit in gfx_mode. */
  gfx_rect(x: number, y: number, w: number, h: number, filled: number = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.globalCompositeOperation = additiveFromMode(this.gfx_mode) ? "lighter" : "source-over";
    ctx.globalAlpha = clamp01(this.gfx_a);
    const css = rgbCss(this.gfx_r, this.gfx_g, this.gfx_b);
    if (filled) {
      ctx.fillStyle = css;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.strokeStyle = css;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** gfx_line(x1, y1, x2, y2 [, antialias=1]) — 1px line. */
  gfx_line(x1: number, y1: number, x2: number, y2: number, antialias: number = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.globalCompositeOperation = additiveFromMode(this.gfx_mode) ? "lighter" : "source-over";
    ctx.globalAlpha = clamp01(this.gfx_a);
    ctx.strokeStyle = rgbCss(this.gfx_r, this.gfx_g, this.gfx_b);
    ctx.lineWidth = 1;
    ctx.imageSmoothingEnabled = antialias !== 0;
    // 0.5 offset gives a crisper 1px line on integer coords.
    const off = 0.5;
    ctx.beginPath();
    ctx.moveTo(x1 + off, y1 + off);
    ctx.lineTo(x2 + off, y2 + off);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** gfx_circle(x, y, r [, fill=0, antialias=1]) — circle at center. */
  gfx_circle(x: number, y: number, r: number, fill: number = 0, antialias: number = 1): void {
    const ctx = this.ctx;
    if (!ctx || r <= 0) return;
    ctx.globalCompositeOperation = additiveFromMode(this.gfx_mode) ? "lighter" : "source-over";
    ctx.globalAlpha = clamp01(this.gfx_a);
    ctx.imageSmoothingEnabled = antialias !== 0;
    const css = rgbCss(this.gfx_r, this.gfx_g, this.gfx_b);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = css;
      ctx.fill();
    } else {
      ctx.strokeStyle = css;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** gfx_gradrect(x, y, w, h, r, g, b, a [, drdx, dgdx, dbdx, dadx [, drdy, ...]]).
   *
   * We implement two common cases efficiently via CanvasGradient:
   *   - Only dx deltas (horizontal gradient)
   *   - Only dy deltas (vertical gradient)
   * The fully general "dx AND dy" case (both axes differ) is rare in real
   * presets; we approximate by summing horizontal + vertical as a semi-
   * transparent overlay. For pixel-perfect fidelity we could drop to an
   * ImageData pixel loop, but the cost isn't justified for Phase B. */
  gfx_gradrect(
    x: number, y: number, w: number, h: number,
    r: number, g: number, b: number, a: number,
    drdx: number = 0, dgdx: number = 0, dbdx: number = 0, dadx: number = 0,
    drdy: number = 0, dgdy: number = 0, dbdy: number = 0, dady: number = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || w <= 0 || h <= 0) return;

    const hasDx = drdx !== 0 || dgdx !== 0 || dbdx !== 0 || dadx !== 0;
    const hasDy = drdy !== 0 || dgdy !== 0 || dbdy !== 0 || dady !== 0;

    ctx.globalCompositeOperation = additiveFromMode(this.gfx_mode) ? "lighter" : "source-over";

    if (!hasDx && !hasDy) {
      ctx.fillStyle = rgbaCss(r, g, b, a);
      ctx.fillRect(x, y, w, h);
    } else if (hasDx && !hasDy) {
      const grad = ctx.createLinearGradient(x, y, x + w, y);
      grad.addColorStop(0, rgbaCss(r, g, b, a));
      grad.addColorStop(1, rgbaCss(r + drdx * w, g + dgdx * w, b + dbdx * w, a + dadx * w));
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
    } else if (!hasDx && hasDy) {
      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, rgbaCss(r, g, b, a));
      grad.addColorStop(1, rgbaCss(r + drdy * h, g + dgdy * h, b + dbdy * h, a + dady * h));
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
    } else {
      // Bilinear approximation: horizontal gradient, then blend a vertical
      // gradient on top. Not exact but visually close for well-behaved
      // inputs. Phase E could replace this with a shader.
      const hgrad = ctx.createLinearGradient(x, y, x + w, y);
      hgrad.addColorStop(0, rgbaCss(r, g, b, a));
      hgrad.addColorStop(1, rgbaCss(r + drdx * w, g + dgdx * w, b + dbdx * w, a + dadx * w));
      ctx.fillStyle = hgrad;
      ctx.fillRect(x, y, w, h);
      const vgrad = ctx.createLinearGradient(x, y, x, y + h);
      vgrad.addColorStop(0, "rgba(0,0,0,0)");
      vgrad.addColorStop(1, rgbaCss(drdy * h, dgdy * h, dbdy * h, dady * h));
      ctx.fillStyle = vgrad;
      ctx.fillRect(x, y, w, h);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  // ── EEL2-visible stdlib: text ───────────────────────────────────────────

  /** gfx_setfont(idx [, name, size, flags]). idx 0 = default. Missing args
   *  leave the prior slot config alone (REAPER allows sparse updates). */
  gfx_setfont(idx: number, name?: string, size?: number, flags?: number): void {
    const i = Math.max(0, Math.min(15, idx | 0));
    while (this.fontSlots.length <= i) this.fontSlots.push({ ...DEFAULT_FONT });
    const slot = this.fontSlots[i];
    if (typeof name === "string" && name.length > 0) slot.name = name;
    if (typeof size === "number" && size > 0) slot.size = size;
    if (typeof flags === "number") slot.flags = flags | 0;
    this.currentFont = i;
    this.gfx_texth = slot.size;
    this.applyFontToCtx();
  }

  /** gfx_drawstr(str [, flags, right, bottom]) — draws at (gfx_x, gfx_y) and
   *  advances gfx_x by the rendered width. Flags control alignment inside
   *  the optional right/bottom bounding box; we honor the common center bits
   *  when a bounding box is supplied. */
  gfx_drawstr(str: string, _flags: number = 0, right?: number, bottom?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.applyFontToCtx();
    ctx.globalCompositeOperation = additiveFromMode(this.gfx_mode) ? "lighter" : "source-over";
    ctx.globalAlpha = clamp01(this.gfx_a);
    ctx.fillStyle = rgbCss(this.gfx_r, this.gfx_g, this.gfx_b);
    ctx.textBaseline = "top";

    if (right !== undefined && bottom !== undefined) {
      // With a bounding box: horizontal/vertical center alignment. REAPER
      // flag bits: 1 = hcenter, 2 = right, 4 = vcenter, 8 = bottom.
      const flags = _flags | 0;
      const textW = ctx.measureText(str).width;
      const textH = this.fontSlots[this.currentFont].size;
      let dx = this.gfx_x;
      let dy = this.gfx_y;
      if (flags & 1) dx = (this.gfx_x + right - textW) * 0.5;
      else if (flags & 2) dx = right - textW;
      if (flags & 4) dy = (this.gfx_y + bottom - textH) * 0.5;
      else if (flags & 8) dy = bottom - textH;
      ctx.fillText(str, dx, dy);
      this.gfx_x = Math.min(right, dx + textW);
    } else {
      ctx.fillText(String(str), this.gfx_x, this.gfx_y);
      this.gfx_x += ctx.measureText(str).width;
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  /** gfx_measurestr(str, wOut, hOut) — pattern mirrors input_info (out-params
   *  written via host + state keys). Translator intercepts the call. */
  gfx_measurestr(state: Record<string, number>, str: string, wKey: string, hKey: string): number {
    const ctx = this.ctx;
    if (!ctx) {
      state[wKey] = 0;
      state[hKey] = 0;
      return 0;
    }
    this.applyFontToCtx();
    const m = ctx.measureText(str);
    state[wKey] = m.width;
    state[hKey] = this.fontSlots[this.currentFont].size;
    return 1;
  }

  private applyFontToCtx(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const slot = this.fontSlots[this.currentFont];
    const bold = slot.flags & 1 ? "bold " : "";
    const italic = slot.flags & 2 ? "italic " : "";
    ctx.font = `${italic}${bold}${slot.size}px ${slot.name}`;
  }

  // ── EEL2-visible stdlib: pixel ops (slow path) ──────────────────────────

  /** gfx_setpixel(r, g, b) — writes a single pixel at (gfx_x, gfx_y) using
   *  the current alpha (gfx_a). */
  gfx_setpixel(r: number, g: number, b: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const x = Math.floor(this.gfx_x);
    const y = Math.floor(this.gfx_y);
    if (x < 0 || y < 0 || x >= this.outWidth || y >= this.outHeight) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = clamp01(this.gfx_a);
    ctx.fillStyle = rgbCss(r, g, b);
    ctx.fillRect(x, y, 1, 1);
    ctx.globalAlpha = 1;
  }

  /** gfx_getpixel(rOut, gOut, bOut) — reads the pixel at (gfx_x, gfx_y) and
   *  writes channels into the named state vars. Translator intercepts the
   *  call so it can pass bare ident names. */
  gfx_getpixel(state: Record<string, number>, rKey: string, gKey: string, bKey: string): number {
    const ctx = this.ctx;
    if (!ctx) {
      state[rKey] = 0; state[gKey] = 0; state[bKey] = 0;
      return 0;
    }
    const x = Math.floor(this.gfx_x);
    const y = Math.floor(this.gfx_y);
    if (x < 0 || y < 0 || x >= this.outWidth || y >= this.outHeight) {
      state[rKey] = 0; state[gKey] = 0; state[bKey] = 0;
      return 0;
    }
    const data = ctx.getImageData(x, y, 1, 1).data;
    state[rKey] = data[0] / 255;
    state[gKey] = data[1] / 255;
    state[bKey] = data[2] / 255;
    return 1;
  }

  // ── EEL2-visible stdlib: blit ───────────────────────────────────────────

  /** Blit an input image onto the output canvas.
   *
   * REAPER's long form:
   *   gfx_blit(src [, useProjectCoords, destX, destY [, destW, destH [,
   *            srcX, srcY, srcW, srcH [, rotation, rotXC, rotYC]]]])
   *
   * Phase B honors: 1-arg cover, 4-arg offset, 6-arg dest rect, 10-arg
   * source rect, 13-arg rotation about a pivot. `useProjectCoords` is
   * ignored (we always treat positions as project coords — Phase A decision).
   */
  gfx_blit(
    src: number,
    _useProjectCoords?: number,
    destX?: number,
    destY?: number,
    destW?: number,
    destH?: number,
    srcX?: number, srcY?: number, srcW?: number, srcH?: number,
    rot?: number, rotXC?: number, rotYC?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const source = this.sources[src | 0];
    if (!source) return;

    const naturalW = sourceWidth(source);
    const naturalH = sourceHeight(source);
    if (naturalW === 0 || naturalH === 0) return;

    const dx = destX ?? 0;
    const dy = destY ?? 0;
    const dw = destW ?? naturalW;
    const dh = destH ?? naturalH;
    const sx = srcX ?? 0;
    const sy = srcY ?? 0;
    const sw = srcW ?? naturalW;
    const sh = srcH ?? naturalH;

    const { channel, additive, linear } = decodeGfxMode(this.gfx_mode);

    ctx.imageSmoothingEnabled = linear;
    ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
    ctx.globalAlpha = clamp01(this.gfx_a);

    const drawWith = (targetCtx: CanvasRenderingContext2D, img: CanvasImageSource) => {
      if (rot && rot !== 0) {
        const pivotX = rotXC ?? (dx + dw / 2);
        const pivotY = rotYC ?? (dy + dh / 2);
        targetCtx.save();
        targetCtx.translate(pivotX, pivotY);
        targetCtx.rotate(rot);
        targetCtx.translate(-pivotX, -pivotY);
        targetCtx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
        targetCtx.restore();
      } else {
        targetCtx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      }
    };

    if (channel === null) {
      drawWith(ctx, source);
    } else {
      // Isolate named channel via scratch: draw source → multiply by tint →
      // blit to output. globalCompositeOperation="lighter" handles additive
      // summing across subsequent blits.
      this.ensureScratch(naturalW, naturalH);
      const scratchCtx = this.scratchCtx;
      scratchCtx.globalCompositeOperation = "source-over";
      scratchCtx.globalAlpha = 1;
      scratchCtx.imageSmoothingEnabled = linear;
      scratchCtx.clearRect(0, 0, naturalW, naturalH);
      scratchCtx.drawImage(source, 0, 0, naturalW, naturalH);
      scratchCtx.globalCompositeOperation = "multiply";
      scratchCtx.fillStyle =
        channel === "r" ? "#ff0000" :
        channel === "g" ? "#00ff00" : "#0000ff";
      scratchCtx.fillRect(0, 0, naturalW, naturalH);
      scratchCtx.globalCompositeOperation = "source-over";
      drawWith(ctx, this.scratch);
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  // ── EEL2-visible stdlib: gfx_evalrect (per-pixel kernel) ────────────────

  /** gfx_evalrect(x, y, w, h, bodyStr [, flag=0])
   *
   *  Runs `bodyStr` (an EEL2 code string) once per pixel in the rectangle.
   *  Per-pixel vars `r/g/b/a` are 0..1 channels of the current output pixel;
   *  they're read at loop entry and written back on exit. `_N` vars (where N
   *  is digits) persist across pixels within the same call — REAPER's serial
   *  state convention, used by recursive filters like Gaussian blur.
   *
   *  Sweep direction (`flag` arg):
   *   - bit 2 (`4`)  = backward along the inner axis (right→left / bottom→top)
   *   - bit 3 (`8`)  = vertical-major (iterate y as inner, x as outer)
   *   - default      = forward horizontal (L→R, row by row)
   *
   *  Body JIT strategy: the translated body is inlined into a single big
   *  sweep function (evalrect.ts) so V8 optimizes the whole loop as one
   *  hot fn rather than doing a call per pixel. See evalrect.ts for the
   *  template. Phase E3 will add a WebGL fast-path for parallel kernels.
   */
  gfx_evalrect(
    state: Record<string, number>,
    mem: Float64Array,
    x: number, y: number, w: number, h: number,
    bodyStr: string,
    flag: number = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (typeof bodyStr !== "string" || bodyStr.length === 0) return;

    // Clip rectangle to the output canvas — getImageData rejects OOB reads.
    const outW = this.outWidth;
    const outH = this.outHeight;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(outW, Math.floor(x + w));
    const y1 = Math.min(outH, Math.floor(y + h));
    const rectW = x1 - x0;
    const rectH = y1 - y0;
    if (rectW <= 0 || rectH <= 0) return;

    // Compile-on-demand, cached by source string. A `null` cache entry means
    // the source failed to compile — skip execution but don't retry every
    // frame (clears when the outer script recompiles via invalidateEvalrectCache).
    let entry = this.evalrectCache.get(bodyStr);
    if (entry === undefined) {
      const r = compileEvalrectBody(bodyStr, rvideoResolvers);
      entry = r.ok ? r.compiled : null;
      this.evalrectCache.set(bodyStr, entry);
      if (!r.ok) {
        console.warn("[reaperVideo] gfx_evalrect compile failed:", r.message);
      }
    }
    if (!entry) return;

    // Read the rectangle's pixels once. Writing back in one putImageData
    // after the loop is both faster and semantically correct (REAPER also
    // operates on a snapshot — in-loop draws wouldn't show mid-loop).
    const img = ctx.getImageData(x0, y0, rectW, rectH);
    entry.sweep(state, this, mem, img.data, rectW, rectH, x0, y0, flag | 0);
    ctx.putImageData(img, x0, y0);
  }

  /** Called by the node when the outer code recompiles, so stale bodies
   *  (and stale compile-failure entries) don't pin memory or suppress
   *  retries on valid new sources. */
  invalidateEvalrectCache(): void {
    this.evalrectCache.clear();
  }

  // ── EEL2-visible stdlib: gfx_procrect (LUT per-pixel op) ────────────────

  /** gfx_procrect(x, y, w, h, mem_offset [, flags=0])
   *
   *  LUT-based per-pixel transform. `mem_offset` points into `mem[]` at a
   *  contiguous 3×256 float LUT (Y plane 0..255, U plane 256..511, V plane
   *  512..767). All entries are 0..1 floats.
   *
   *  flags bit 0 = "luma-indexed mode" (used by the Colorize preset):
   *      All three plane lookups use the input *luma* byte as the index.
   *      This is how colorize synthesizes chroma from luma — the preset
   *      stores U/V values keyed by Y_in, not by U_in/V_in.
   *
   *  flags bit 0 clear = "per-channel mode":
   *      R_out = mem[off +       R_idx]
   *      G_out = mem[off + 256 + G_idx]
   *      B_out = mem[off + 512 + B_idx]
   *
   *  Luma-indexed mode converts RGB→YUV (BT.601) for indexing, then back
   *  to RGB with the looked-up Y/U/V values. This emulates the REAPER
   *  YV12 behavior in our RGBA pipeline without needing native YUV storage.
   */
  gfx_procrect(
    mem: Float64Array,
    x: number, y: number, w: number, h: number,
    memOffset: number,
    flags: number = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const outW = this.outWidth;
    const outH = this.outHeight;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(outW, Math.floor(x + w));
    const y1 = Math.min(outH, Math.floor(y + h));
    const rectW = x1 - x0;
    const rectH = y1 - y0;
    if (rectW <= 0 || rectH <= 0) return;

    const offY = (memOffset | 0);
    const offU = offY + 256;
    const offV = offY + 512;
    if (offY < 0 || offV + 256 > mem.length) return;

    const img = ctx.getImageData(x0, y0, rectW, rectH);
    const data = img.data;
    const n = rectW * rectH * 4;

    const lumaMode = (flags & 1) !== 0;
    // When the shader has set colorspace to a YUV format (YV12 / YUY2), REAPER's
    // gfx_procrect indexes the three LUT planes by the pixel's actual Y, U, V
    // values. Our canvas is always RGBA, so we emulate this by converting each
    // pixel to YUV (BT.601), doing the LUT lookups, then converting back.
    // Without this, the brightness/contrast curve only hits the R channel and
    // the saturation curve distorts G and B independently — wrong.
    const yvMode = !lumaMode &&
      (this.colorspace === "YV12" || this.colorspace === "YUY2");

    if (lumaMode) {
      // RGB → Y_idx (BT.601) → LUT lookup → YUV → RGB.
      // Used by the Colorize preset: Y/U/V output values are all keyed by luma,
      // so this maps luma → arbitrary colour rather than adjusting per-channel.
      for (let i = 0; i < n; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // BT.601 luma in 0..255.
        const yIdx = (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
        const yClamped = yIdx < 0 ? 0 : yIdx > 255 ? 255 : yIdx;

        const yOut = mem[offY + yClamped];    // 0..1
        const uOut = mem[offU + yClamped];    // 0..1, 0.5 = neutral
        const vOut = mem[offV + yClamped];    // 0..1, 0.5 = neutral

        // YUV → RGB (BT.601, Y in 0..1, U/V in 0..1 centered at 0.5).
        const cy = yOut;
        const cu = uOut - 0.5;
        const cv = vOut - 0.5;
        const rOut = cy + 1.402 * cv;
        const gOut = cy - 0.344136 * cu - 0.714136 * cv;
        const bOut = cy + 1.772 * cu;

        data[i    ] = rOut <= 0 ? 0 : rOut >= 1 ? 255 : (rOut * 255 + 0.5) | 0;
        data[i + 1] = gOut <= 0 ? 0 : gOut >= 1 ? 255 : (gOut * 255 + 0.5) | 0;
        data[i + 2] = bOut <= 0 ? 0 : bOut >= 1 ? 255 : (bOut * 255 + 0.5) | 0;
        // alpha untouched
      }
    } else if (yvMode) {
      // YV12-emulation mode: RGB → YUV → LUT-by-channel → YUV → RGB.
      // This is the correct path for presets that set colorspace='YV12' and
      // build a 3×256 LUT with separate Y/U/V curves (e.g. Brightness/Contrast,
      // Saturation). In real REAPER the framebuffer IS in YV12 so gfx_procrect
      // naturally uses Y/U/V indices; we reproduce that here via conversion.
      for (let i = 0; i < n; i += 4) {
        const r = data[i]     / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;

        // RGB → YUV (BT.601, U/V centered at 0.5 so they map 0..1).
        const yIn =  0.299   * r + 0.587   * g + 0.114   * b;
        const uIn = -0.14713 * r - 0.28886 * g + 0.436   * b + 0.5;
        const vIn =  0.615   * r - 0.51499 * g - 0.10001 * b + 0.5;

        const yIdx = yIn <= 0 ? 0 : yIn >= 1 ? 255 : (yIn * 255 + 0.5) | 0;
        const uIdx = uIn <= 0 ? 0 : uIn >= 1 ? 255 : (uIn * 255 + 0.5) | 0;
        const vIdx = vIn <= 0 ? 0 : vIn >= 1 ? 255 : (vIn * 255 + 0.5) | 0;

        const yOut = mem[offY + yIdx];   // 0..1
        const uOut = mem[offU + uIdx];   // 0..1, 0.5 = neutral
        const vOut = mem[offV + vIdx];   // 0..1, 0.5 = neutral

        // YUV → RGB (BT.601).
        const cy = yOut;
        const cu = uOut - 0.5;
        const cv = vOut - 0.5;
        const rOut = cy + 1.402   * cv;
        const gOut = cy - 0.344136 * cu - 0.714136 * cv;
        const bOut = cy + 1.772   * cu;

        data[i    ] = rOut <= 0 ? 0 : rOut >= 1 ? 255 : (rOut * 255 + 0.5) | 0;
        data[i + 1] = gOut <= 0 ? 0 : gOut >= 1 ? 255 : (gOut * 255 + 0.5) | 0;
        data[i + 2] = bOut <= 0 ? 0 : bOut >= 1 ? 255 : (bOut * 255 + 0.5) | 0;
        // alpha untouched
      }
    } else {
      // Per-channel LUT (RGBA colorspace): R → Y-plane, G → U-plane, B → V-plane.
      // Used by presets that explicitly work in RGBA and build per-channel curves.
      for (let i = 0; i < n; i += 4) {
        const rIdx = data[i];
        const gIdx = data[i + 1];
        const bIdx = data[i + 2];
        const rOut = mem[offY + rIdx];
        const gOut = mem[offU + gIdx];
        const bOut = mem[offV + bIdx];
        data[i    ] = rOut <= 0 ? 0 : rOut >= 1 ? 255 : (rOut * 255 + 0.5) | 0;
        data[i + 1] = gOut <= 0 ? 0 : gOut >= 1 ? 255 : (gOut * 255 + 0.5) | 0;
        data[i + 2] = bOut <= 0 ? 0 : bOut >= 1 ? 255 : (bOut * 255 + 0.5) | 0;
      }
    }

    ctx.putImageData(img, x0, y0);
  }

  private ensureScratch(w: number, h: number): void {
    if (this.scratch.width  !== w) this.scratch.width  = w;
    if (this.scratch.height !== h) this.scratch.height = h;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface ModeDecode {
  channel: "r" | "g" | "b" | null;
  additive: boolean;
  /** Linear source filter — maps to `imageSmoothingEnabled`. */
  linear: boolean;
}

/** Resolve a REAPER gfx_mode value to a flag bundle.
 *
 *  The RGB-decompose reference snippet uses three specific values (0xfa / 0xf5
 *  / 0xf0) for additive red/green/blue passes. We special-case those, then
 *  fall through to a generic bit decode for the bits we're confident about
 *  (0x01 additive, 0x08 linear filter). Other bits (alpha read/write, channel
 *  masks outside the special cases) are TODO for an empirical test against
 *  REAPER. */
function decodeGfxMode(mode: number): ModeDecode {
  switch (mode & 0xff) {
    case 0xfa: return { channel: "r", additive: true, linear: true };
    case 0xf5: return { channel: "g", additive: true, linear: true };
    case 0xf0: return { channel: "b", additive: true, linear: true };
  }
  return {
    channel: null,
    additive: (mode & 0x01) !== 0,
    linear:   (mode & 0x08) !== 0,
  };
}

function additiveFromMode(mode: number): boolean {
  const { additive } = decodeGfxMode(mode);
  return additive;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function channelByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function rgbCss(r: number, g: number, b: number): string {
  return `rgb(${channelByte(r)}, ${channelByte(g)}, ${channelByte(b)})`;
}

function rgbaCss(r: number, g: number, b: number, a: number): string {
  return `rgba(${channelByte(r)}, ${channelByte(g)}, ${channelByte(b)}, ${clamp01(a)})`;
}

function sourceWidth(s: RVideoSource): number {
  if (s instanceof HTMLVideoElement) return s.videoWidth;
  return s.width;
}
function sourceHeight(s: RVideoSource): number {
  if (s instanceof HTMLVideoElement) return s.videoHeight;
  return s.height;
}
