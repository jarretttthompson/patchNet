/**
 * JSFX → JavaScript translator.
 *
 * Thin wrapper around the shared EEL2 translator (`../eel2/translate.ts`).
 * Provides the JSFX-specific identifier/function bindings:
 *   - spl0, spl1, spl(n) → channels[n] (R/W sample values)
 *   - sliderN / aliases  → sliders[N-1]
 *   - srate              → sample rate constant
 *   - true, false     → 1, 0
 *   - host globals       → `host.*` values from the worklet
 *   - mem, gmem       → pointer offset 0
 *   - Math builtins   → Math.*
 *   - rand(x)         → Math.random() * x
 *
 * Output bodies are compiled by the worklet with `(channels, state, sliders,
 * srate, mem, host, __rt)` for `@sample` and `(state, sliders, srate, mem,
 * host, __rt)` for the other sections.
 */

import { translateBody, type ResolvedIdent, type ResolvedCall, type TranslateResult } from "../eel2/translate";
import type { SliderDecl } from "./parser";

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
  sqr: "__rt.sqr",
  db2ratio: "__rt.db2ratio", ratio2db: "__rt.ratio2db",
};

export interface JsfxTranslateOptions {
  sliders?: readonly SliderDecl[];
}

function buildSliderAliasMap(sliders: readonly SliderDecl[] | undefined): Map<string, number> {
  const aliases = new Map<string, number>();
  for (const s of sliders ?? []) {
    if (s.variableName) aliases.set(s.variableName, s.index);
  }
  return aliases;
}

function makeResolveIdent(sliderAliases: Map<string, number>) {
  return function resolveIdent(name: string): ResolvedIdent | null {
    const splMatch = /^spl(\d+)$/.exec(name);
    if (splMatch) {
      const idx = parseInt(splMatch[1], 10);
      if (idx >= 0 && idx < 64) return { js: `channels[${idx}]`, assignable: true, pointerish: false };
    }
    if (name === "srate") return { js: "srate", assignable: false, pointerish: false };

    const sliderMatch = /^slider(\d+)$/.exec(name);
    if (sliderMatch) {
      const idx = parseInt(sliderMatch[1], 10);
      if (idx >= 1 && idx <= 256) return { js: `sliders[${idx - 1}]`, assignable: true, pointerish: false };
    }

    const aliasIdx = sliderAliases.get(name);
    if (aliasIdx !== undefined) return { js: `sliders[${aliasIdx - 1}]`, assignable: true, pointerish: false };

    if (name === "true")  return { js: "1", assignable: false, pointerish: false };
    if (name === "false") return { js: "0", assignable: false, pointerish: false };

    if (HOST_READS.has(name)) return { js: `host.${name}`, assignable: false, pointerish: false };
    if (HOST_WRITES.has(name)) return { js: `host.${name}`, assignable: true, pointerish: false };

    if (name === "mem" || name === "gmem") {
      return { js: "0", assignable: false, pointerish: true };
    }

    return null;
  };
}

function resolveCall(name: string, args: string[]): ResolvedCall | null {
  if (name === "rand") {
    const a = args[0] ?? "1";
    return { js: `(Math.random() * (${a}))` };
  }
  if (name === "time_precise") return { js: "host.play_position" };
  if (name === "spl") {
    const idx = args[0] ?? "0";
    return { js: `channels[(${idx}) | 0]`, assignable: true };
  }
  if (name === "slider") {
    const idx = args[0] ?? "1";
    return { js: `sliders[(((${idx}) | 0) - 1)]`, assignable: true };
  }
  if (name === "memset") {
    return { js: `__rt.memset(mem, ${args[0] ?? "0"}, ${args[1] ?? "0"}, ${args[2] ?? "0"})` };
  }
  if (name === "memcpy") {
    return { js: `__rt.memcpy(mem, ${args[0] ?? "0"}, ${args[1] ?? "0"}, ${args[2] ?? "0"})` };
  }
  if (name === "freembuf") return { js: `__rt.freembuf(${args[0] ?? "0"})` };
  if (name === "sliderchange" || name === "slider_automate") return { js: "0" };
  if (name === "slider_next_chg") return { js: "-1" };
  if (name === "midirecv" || name === "midirecv_buf" || name === "midirecv_str") return { js: "0" };
  if (name === "midisend" || name === "midisend_buf" || name === "midisend_str") return { js: "0" };
  if (name === "file_open") return { js: "-1" };
  if (name === "file_close" || name === "file_rewind" || name === "file_text") return { js: "0" };
  if (name === "file_avail" || name === "file_var" || name === "file_mem" || name === "file_string") return { js: "0" };
  if (name === "sprintf" || name === "strcpy" || name === "strcat" || name === "strcmp" || name === "strlen") return { js: "0" };
  if (name === "fft" || name === "ifft" || name === "fft_permute" || name === "fft_ipermute" ||
      name === "mdct" || name === "imdct") {
    return { js: "0" };
  }
  const b = BUILTINS[name];
  if (!b) return null;
  return { js: `${b}(${args.join(", ")})` };
}

const HOST_READS = new Set([
  "tempo", "beat_position", "play_position", "play_state",
  "num_ch", "samplesblock", "tsnum", "tsdenom", "ts_num", "ts_denom",
]);

const HOST_WRITES = new Set([
  "pdc_delay", "pdc_top_ch", "pdc_bot_ch",
  "ext_tail_size", "ext_noinit", "ext_nodenorm", "ext_midi_bus",
]);

export function translateJsfxBody(body: string, opts: JsfxTranslateOptions = {}): JsfxTranslateResult {
  const sliderAliases = buildSliderAliasMap(opts.sliders);
  return translateBody(body, {
    resolveIdent: makeResolveIdent(sliderAliases),
    resolveCall,
    allowStrings: true,
    resolveStringLiteral: value => ({ js: JSON.stringify(value), assignable: false }),
  });
}
