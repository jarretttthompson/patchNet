/**
 * REAPER video-processor → JavaScript translator.
 *
 * Wraps the shared EEL2 translator (`../eel2/translate.ts`) with the
 * video-processor identifier/function bindings:
 *
 *   Identifiers:
 *     true, false, pi/e/phi, $-constants ........ standard EEL2
 *     gfx_mode, gfx_a, gfx_r, gfx_g, gfx_b ...... host.<name> (R/W)
 *     colorspace ................................ host.colorspace (R/W)
 *     project_w, project_h, project_time,
 *     framerate, project_wh_valid ............... state.u_* user vars
 *                                                 (populated by input_info /
 *                                                  host before frame)
 *     anything else ............................. state.u_<sanitized> user var
 *
 *   Calls:
 *     gfx_fillrect(x,y,w,h) ..................... host.gfx_fillrect(...)
 *     gfx_blit(src,...) ......................... host.gfx_blit(...)
 *     input_info(idx, wVar, hVar) ............... SPECIAL — 2nd/3rd args must
 *                                                 be bare idents (output-
 *                                                 parameter style); emitted as
 *                                                 host.input_info(state, idx,
 *                                                 "u_<w>", "u_<h>")
 *     math builtins (sin/cos/…) ................. Math.*
 *     rand(x) ................................... Math.random() * x
 *
 *   Strings:
 *     'RGBA' .................................... 'RGBA' (only meaningful on
 *                                                 the RHS of `colorspace = …`)
 *
 * Output is a function body. The runtime wraps it as:
 *   (state, params, host) => { <body> }
 */

import {
  translateBody,
  type ResolvedIdent,
  type ResolvedCall,
  type EmitResult,
  type SpecialCallApi,
  type TranslateResult,
  type TranslatorResolvers,
} from "../eel2/translate";
import { sanitizeIdent } from "../eel2/tokenize";

const BUILTINS: Record<string, string> = {
  sin: "Math.sin", cos: "Math.cos", tan: "Math.tan",
  asin: "Math.asin", acos: "Math.acos", atan: "Math.atan", atan2: "Math.atan2",
  exp: "Math.exp", log: "Math.log", log10: "Math.log10", log2: "Math.log2",
  sqrt: "Math.sqrt", abs: "Math.abs",
  min: "Math.min", max: "Math.max",
  floor: "Math.floor", ceil: "Math.ceil", round: "Math.round",
  pow: "Math.pow", sign: "Math.sign",
};

/** Identifiers that the host owns (live on `host.<name>`). gfx_mode is the
 *  important one — the snippet reads/writes it between gfx_blit calls. */
const HOST_IDENTS = new Set([
  "gfx_mode",
  "gfx_a", "gfx_r", "gfx_g", "gfx_b",
  "gfx_x", "gfx_y", "gfx_texth",
  "colorspace",
]);

/** Standard-form gfx_* host calls — args go through unchanged. Output-param
 *  calls (gfx_getpixel, gfx_measurestr, input_info) have their own intercepts
 *  below because they need bare-ident args. */
const HOST_CALLS = new Set([
  "gfx_fillrect",
  "gfx_rect",
  "gfx_line",
  "gfx_circle",
  "gfx_gradrect",
  "gfx_blit",
  "gfx_blit2",
  "gfx_deltablit",
  "gfx_transformblit",
  "gfx_blurto",
  "gfx_setfont",
  "gfx_drawstr",
  "gfx_setpixel",
]);

function resolveIdent(name: string): ResolvedIdent | null {
  if (HOST_IDENTS.has(name)) {
    // `.` isn't allowed in these, so raw name works as a JS property key.
    return { js: `host.${name}`, assignable: true, pointerish: false };
  }
  if (name === "true")  return { js: "1", assignable: false, pointerish: false };
  if (name === "false") return { js: "0", assignable: false, pointerish: false };

  // Video-processor has no DAW transport either — stub to 0 so scripts that
  // read these don't explode.
  if (name === "tempo" || name === "beat_position" ||
      name === "play_position" || name === "play_state") {
    return { js: "0", assignable: false, pointerish: false };
  }

  // mem / gmem aren't meaningful for Phase A (no buffers yet) but stub so
  // scripts that touch them don't error out — treat as pointer offset 0.
  if (name === "mem" || name === "gmem") {
    return { js: "0", assignable: false, pointerish: true };
  }

  return null;
}

function resolveCall(name: string, args: string[]): ResolvedCall | null {
  if (name === "rand") {
    return { js: `(Math.random() * (${args[0] ?? "1"}))` };
  }
  const b = BUILTINS[name];
  if (b) return { js: `${b}(${args.join(", ")})` };

  // gfx_evalrect needs `state` and `mem` prepended — `state` so the per-pixel
  // body can read outer user vars (BB, b1b0, rowsize, …); `mem` so it can
  // index tab[]/gmem[] style LUTs.
  if (name === "gfx_evalrect") {
    return { js: `host.gfx_evalrect(state, mem, ${args.join(", ")})` };
  }

  // gfx_procrect is a LUT-based per-pixel op — it needs mem directly.
  if (name === "gfx_procrect") {
    return { js: `host.gfx_procrect(mem, ${args.join(", ")})` };
  }

  // Video-processor host functions — pass through to the runtime host.
  // The host enforces arity at runtime (missing args land as `undefined`).
  if (HOST_CALLS.has(name)) {
    return { js: `host.${name}(${args.join(", ")})` };
  }
  return null;
}

/** Out-parameter calls: arguments that are bare idents naming user vars, which
 *  the host then writes back into `state[u_<name>]`. The standard parser would
 *  turn those idents into value expressions, losing the name — we intercept
 *  first and emit an out-param-aware call.
 *
 *  `input_info(idx, wOut, hOut)` ............. source dimensions
 *  `gfx_getpixel(rOut, gOut, bOut)` .......... pixel read at (gfx_x, gfx_y)
 *  `gfx_measurestr(str, wOut, hOut)` ......... text dimensions under current font
 */
function interceptCall(name: string, api: SpecialCallApi): EmitResult | null {
  if (name === "input_info") return interceptInputInfo(api);
  if (name === "gfx_getpixel") return interceptGfxGetpixel(api);
  if (name === "gfx_measurestr") return interceptGfxMeasurestr(api);
  return null;
}

function interceptInputInfo(api: SpecialCallApi): EmitResult | null {
  const startTok = api.peek();
  if (startTok.kind !== "lparen") {
    return { message: "expected '(' after input_info", offset: startTok.offset };
  }
  api.next();

  const idxArg = api.parseExpression();
  if ("message" in idxArg) return idxArg;
  if (api.peek().kind !== "comma") {
    return { message: "input_info expects 3 args: input_info(idx, widthVar, heightVar)", offset: api.peek().offset };
  }
  api.next();

  const wTok = api.peek();
  if (wTok.kind !== "ident") {
    return { message: "input_info's 2nd arg must be a variable name (e.g. project_w)", offset: wTok.offset };
  }
  api.next();
  if (api.peek().kind !== "comma") {
    return { message: "input_info expects 3 args", offset: api.peek().offset };
  }
  api.next();

  const hTok = api.peek();
  if (hTok.kind !== "ident") {
    return { message: "input_info's 3rd arg must be a variable name (e.g. project_h)", offset: hTok.offset };
  }
  api.next();

  if (api.peek().kind !== "rparen") {
    return { message: "expected ')' closing input_info", offset: api.peek().offset };
  }
  api.next();

  const wKey = `u_${sanitizeIdent(wTok.value)}`;
  const hKey = `u_${sanitizeIdent(hTok.value)}`;

  return {
    js: `host.input_info(state, ${idxArg.js}, ${JSON.stringify(wKey)}, ${JSON.stringify(hKey)})`,
    assignable: false,
  };
}

function interceptGfxGetpixel(api: SpecialCallApi): EmitResult | null {
  const startTok = api.peek();
  if (startTok.kind !== "lparen") {
    return { message: "expected '(' after gfx_getpixel", offset: startTok.offset };
  }
  api.next();

  const names: string[] = [];
  for (let i = 0; i < 3; i++) {
    const tok = api.peek();
    if (tok.kind !== "ident") {
      return { message: "gfx_getpixel args must be bare variable names (r, g, b)", offset: tok.offset };
    }
    api.next();
    names.push(`u_${sanitizeIdent(tok.value)}`);
    if (i < 2) {
      if (api.peek().kind !== "comma") {
        return { message: "gfx_getpixel expects 3 args: gfx_getpixel(r, g, b)", offset: api.peek().offset };
      }
      api.next();
    }
  }

  if (api.peek().kind !== "rparen") {
    return { message: "expected ')' closing gfx_getpixel", offset: api.peek().offset };
  }
  api.next();

  const [r, g, b] = names;
  return {
    js: `host.gfx_getpixel(state, ${JSON.stringify(r)}, ${JSON.stringify(g)}, ${JSON.stringify(b)})`,
    assignable: false,
  };
}

function interceptGfxMeasurestr(api: SpecialCallApi): EmitResult | null {
  const startTok = api.peek();
  if (startTok.kind !== "lparen") {
    return { message: "expected '(' after gfx_measurestr", offset: startTok.offset };
  }
  api.next();

  const strArg = api.parseExpression();
  if ("message" in strArg) return strArg;
  if (api.peek().kind !== "comma") {
    return { message: "gfx_measurestr expects 3 args: gfx_measurestr(str, w, h)", offset: api.peek().offset };
  }
  api.next();

  const wTok = api.peek();
  if (wTok.kind !== "ident") {
    return { message: "gfx_measurestr's 2nd arg must be a variable name", offset: wTok.offset };
  }
  api.next();
  if (api.peek().kind !== "comma") {
    return { message: "gfx_measurestr expects 3 args", offset: api.peek().offset };
  }
  api.next();

  const hTok = api.peek();
  if (hTok.kind !== "ident") {
    return { message: "gfx_measurestr's 3rd arg must be a variable name", offset: hTok.offset };
  }
  api.next();

  if (api.peek().kind !== "rparen") {
    return { message: "expected ')' closing gfx_measurestr", offset: api.peek().offset };
  }
  api.next();

  const wKey = `u_${sanitizeIdent(wTok.value)}`;
  const hKey = `u_${sanitizeIdent(hTok.value)}`;

  return {
    js: `host.gfx_measurestr(state, ${strArg.js}, ${JSON.stringify(wKey)}, ${JSON.stringify(hKey)})`,
    assignable: false,
  };
}

function resolveStringLiteral(value: string): EmitResult {
  // Emit as a quoted JS string. REAPER video-processor strings often span
  // multiple lines (gfx_evalrect body literals) and may contain tabs — all
  // invalid inside an un-escaped JS double-quoted literal, so we route
  // through JSON.stringify which handles every control char correctly.
  return { js: JSON.stringify(value), assignable: false };
}

/** Canonical rvideo resolvers. The outer body compile uses these directly;
 *  the per-pixel `gfx_evalrect` body compile (`evalrect.ts`) wraps them to
 *  intercept pixel vars and serial state. */
export const rvideoResolvers: TranslatorResolvers = {
  resolveIdent,
  resolveCall,
  interceptCall,
  allowStrings: true,
  resolveStringLiteral,
};

export function translateRVideoBody(body: string): TranslateResult {
  return translateBody(body, rvideoResolvers);
}
