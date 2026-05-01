/**
 * JSFX → JavaScript translator.
 *
 * Thin wrapper around the shared EEL2 translator (`../eel2/translate.ts`).
 * Provides the JSFX-specific identifier/function bindings:
 *   - spl0, spl1      → L, R (R/W sample values)
 *   - sliderN         → sliders[N-1]
 *   - srate           → sample rate constant
 *   - true, false     → 1, 0
 *   - tempo, beat_position, play_position, play_state, num_ch, tsnum, tsdenom → 0
 *   - mem, gmem       → pointer offset 0
 *   - Math builtins   → Math.*
 *   - rand(x)         → Math.random() * x
 *
 * Output: `@sample` → wrapped `(L, R, state, sliders, srate, mem) => { body; return [L, R]; }`
 *         `@init / @slider / @block` → wrapped `(state, sliders, srate, mem) => { body; }`
 */

import { translateBody, type ResolvedIdent, type ResolvedCall, type TranslateResult } from "../eel2/translate";

export type JsfxTranslateError = { message: string; offset: number };
export type JsfxTranslateResult = TranslateResult;

const BUILTINS: Record<string, string> = {
  sin: "Math.sin", cos: "Math.cos", tan: "Math.tan",
  asin: "Math.asin", acos: "Math.acos", atan: "Math.atan", atan2: "Math.atan2",
  exp: "Math.exp", log: "Math.log", log10: "Math.log10", log2: "Math.log2",
  sqrt: "Math.sqrt", abs: "Math.abs",
  min: "Math.min", max: "Math.max",
  floor: "Math.floor", ceil: "Math.ceil", round: "Math.round",
  pow: "Math.pow", sign: "Math.sign",
};

function resolveIdent(name: string): ResolvedIdent | null {
  if (name === "spl0") return { js: "L", assignable: true, pointerish: false };
  if (name === "spl1") return { js: "R", assignable: true, pointerish: false };
  if (name === "srate") return { js: "srate", assignable: false, pointerish: false };

  const sliderMatch = /^slider(\d+)$/.exec(name);
  if (sliderMatch) {
    const idx = parseInt(sliderMatch[1], 10);
    if (idx >= 1 && idx <= 64) return { js: `sliders[${idx - 1}]`, assignable: true, pointerish: false };
  }

  if (name === "true")  return { js: "1", assignable: false, pointerish: false };
  if (name === "false") return { js: "0", assignable: false, pointerish: false };

  // Host globals stubbed to 0 — patchNet has no DAW transport yet. Scripts
  // that branch on `tempo > 0` take their free-running path, which is safe.
  if (name === "tempo"         || name === "beat_position" ||
      name === "play_position" || name === "play_state"    ||
      name === "num_ch"        || name === "tsnum"         || name === "tsdenom" ||
      name === "ts_num"        || name === "ts_denom") {
    return { js: "0", assignable: false, pointerish: false };
  }

  if (name === "mem" || name === "gmem") {
    return { js: "0", assignable: false, pointerish: true };
  }

  return null;
}

function resolveCall(name: string, args: string[]): ResolvedCall | null {
  if (name === "rand") {
    const a = args[0] ?? "1";
    return { js: `(Math.random() * (${a}))` };
  }
  const b = BUILTINS[name];
  if (!b) return null;
  return { js: `${b}(${args.join(", ")})` };
}

export function translateJsfxBody(body: string): JsfxTranslateResult {
  return translateBody(body, { resolveIdent, resolveCall });
}
