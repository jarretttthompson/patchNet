/**
 * Per-pixel `gfx_evalrect` body compilation.
 *
 * REAPER's video processor runs an EEL2 code string once per pixel inside a
 * `gfx_evalrect` rectangle. Variables that behave differently than in the
 * outer script:
 *
 *   r, g, b, a ........ current pixel's channels (0..1), read at loop entry
 *                       and written back on exit. Assignable.
 *   x, y .............. current pixel coordinates (integer). Read-only.
 *   _N (underscore + digits) .. "serial" state vars that persist across
 *                               pixels within a single gfx_evalrect call.
 *                               Reset to 0 at the start of each call.
 *   everything else ... resolves via the outer rvideo resolver (host idents,
 *                       state.u_* user vars, builtins).
 *
 * ── Inlining strategy ──────────────────────────────────────────────────
 * Earlier revisions compiled the body as a per-pixel fn and called it in
 * a tight loop. At 720p × 4 sweeps that's ~3.7M function calls per blur
 * cycle — per-call overhead (allocating a call frame, binding args) was the
 * dominant cost, not the arithmetic itself.
 *
 * Now the body is injected directly into the sweep loop body. Pixel vars
 * become local `let` bindings (r/g/b/a/x/y). Serial state vars (_1/_11/…)
 * are also local `let` bindings declared once before the outer loop. State
 * user vars (state.u_*) and host idents stay as property access; V8's
 * inline caches handle those efficiently after warmup.
 *
 * The compiled sweep function signature:
 *   (state, host, data, rectW, rectH, x0, y0, flag) => void
 * where `data` is the Uint8ClampedArray from the host's getImageData.
 */

import {
  translateBody,
  type TranslateResult,
  type TranslatorResolvers,
} from "../eel2/translate";
import type { RVideoHost } from "./host";

export type EvalrectSweepFn = (
  state: Record<string, number>,
  host: RVideoHost,
  mem: Float64Array,
  data: Uint8ClampedArray,
  rectW: number,
  rectH: number,
  x0: number,
  y0: number,
  flag: number,
) => void;

export interface EvalrectCompiled {
  sweep: EvalrectSweepFn;
}

export type EvalrectCompileResult =
  | { ok: true; compiled: EvalrectCompiled }
  | { ok: false; message: string };

const SERIAL_RE = /^_\d+$/;
const PIXEL_RW  = new Set(["r", "g", "b", "a"]);
const PIXEL_RO  = new Set(["x", "y"]);

/** Build an inner-body resolver that routes pixel/serial vars to bare JS
 *  locals and delegates every other ident to the outer rvideo resolver.
 *  Side effect: every `_N` ident encountered is added to `serialNames` so
 *  the sweep-fn template can declare all of them as `let _N = 0;`. */
export function compileEvalrectBody(
  source: string,
  outer: TranslatorResolvers,
): EvalrectCompileResult {
  const serialNames = new Set<string>();

  const innerResolvers: TranslatorResolvers = {
    resolveIdent(name) {
      // Pixel channel: bare local var (r/g/b/a), assignable so writes at the
      // end of the body reach the data[] write-back below.
      if (PIXEL_RW.has(name)) {
        return { js: name, assignable: true, pointerish: false };
      }
      // Pixel coordinates: bare locals, read-only.
      if (PIXEL_RO.has(name)) {
        return { js: name, assignable: false, pointerish: false };
      }
      // Serial state: bare local var. We collect the name so the sweep fn
      // can declare it with an initial zero before the outer loop.
      if (SERIAL_RE.test(name)) {
        serialNames.add(name);
        return { js: name, assignable: true, pointerish: false };
      }
      // Everything else: delegate (host.<x>, state.u_<x>, builtins, …).
      return outer.resolveIdent?.(name) ?? null;
    },
    resolveCall: (name, args) => outer.resolveCall?.(name, args) ?? null,
    interceptCall: (name, api) => outer.interceptCall?.(name, api) ?? null,
    allowStrings: outer.allowStrings,
    resolveStringLiteral: outer.resolveStringLiteral,
  };

  const result: TranslateResult = translateBody(source, innerResolvers);
  if (!result.ok) return { ok: false, message: result.error.message };

  // Hoist outer user vars (`state.u_*`) into locals at sweep-fn entry so
  // the hot inner loop does pointer-sized local reads instead of object
  // property lookups per pixel. Real REAPER presets treat these as
  // coefficients computed in the outer script before gfx_evalrect — they
  // don't change during the sweep, so hoisting is semantically safe.
  //
  // Collect names by scanning the translated body, then rewrite every
  // `state.u_NAME` → `u_local_NAME` and emit `let u_local_NAME =
  // state.u_NAME;` up top. We also write back at exit in case a body does
  // mutate (rare but not forbidden).
  const stateVarRe = /state\.u_([A-Za-z_][A-Za-z0-9_]*)/g;
  const stateVars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = stateVarRe.exec(result.js)) !== null) {
    stateVars.add(match[1]);
  }
  const rewrittenBody = result.js.replace(stateVarRe, (_, name) => `u_local_${name}`);
  const hoistDecls = stateVars.size > 0
    ? `let ${Array.from(stateVars).map(n => `u_local_${n} = state.u_${n}`).join(", ")};\n`
    : "";
  const hoistWriteback = stateVars.size > 0
    ? Array.from(stateVars).map(n => `state.u_${n} = u_local_${n};`).join("\n") + "\n"
    : "";

  // Serial declarations up front. The outer loop then reuses them across
  // every pixel in one gfx_evalrect call — that's the whole point of the
  // `_N` convention.
  const serialDecls = serialNames.size > 0
    ? `let ${Array.from(serialNames).map(n => `${n} = 0`).join(", ")};\n`
    : "";

  // Sweep template. The two-level loop handles all four sweep directions
  // (h/v forward/backward) driven by the REAPER flag bitfield.
  //
  //   bit 2 (4) = backward along inner axis
  //   bit 3 (8) = vertical-major (swap inner/outer)
  //
  // Clamp-to-byte inline at write-back: branchless is faster than
  // Math.min/max on V8 for tight loops.
  const sweepSource = `
${hoistDecls}${serialDecls}const vertical = (flag & 8) !== 0;
const backward = (flag & 4) !== 0;
const innerLen = vertical ? rectH : rectW;
const outerLen = vertical ? rectW : rectH;
const innerStart = backward ? innerLen - 1 : 0;
const innerEnd   = backward ? -1 : innerLen;
const innerStep  = backward ? -1 : 1;
for (let o = 0; o < outerLen; o++) {
  for (let i = innerStart; i !== innerEnd; i += innerStep) {
    const px = vertical ? o : i;
    const py = vertical ? i : o;
    const idx = (py * rectW + px) * 4;
    let r = data[idx    ] * (1/255);
    let g = data[idx + 1] * (1/255);
    let b = data[idx + 2] * (1/255);
    let a = data[idx + 3] * (1/255);
    const x = x0 + px;
    const y = y0 + py;
${indentLines(rewrittenBody, 4)}
    const r8 = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
    const g8 = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
    const b8 = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0;
    const a8 = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255 + 0.5) | 0;
    data[idx    ] = r8;
    data[idx + 1] = g8;
    data[idx + 2] = b8;
    data[idx + 3] = a8;
  }
}
${hoistWriteback}`;

  let sweep: EvalrectSweepFn;
  try {
    // eslint-disable-next-line no-new-func
    sweep = new Function(
      "state", "host", "mem", "data", "rectW", "rectH", "x0", "y0", "flag",
      sweepSource,
    ) as EvalrectSweepFn;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `evalrect JS compile error: ${msg}` };
  }

  return { ok: true, compiled: { sweep } };
}

function indentLines(src: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return src.split("\n").map(line => line.length > 0 ? pad + line : line).join("\n");
}

// Re-exports retained for any consumer still using them.
export type { TranslatorResolvers };
