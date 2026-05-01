---
title: reaperVideo Object Plan
type: plan
status: draft
updated: 2026-04-24
---

> **Revision 2026-04-24:** added Phase A cleanup, Phase E ("kernel effects" — EEL2 `function` defs + `gfx_evalrect`), and a completion roadmap after field-testing the Gaussian-blur preset.

# `reaperVideo` Object Plan — REAPER Video Processor in the Browser

**Status:** Draft (2026-04-24).

A patchNet vFX object that executes REAPER-style **video processor** code against a live video stream. User pastes code from a REAPER video effect on the left of the object; `//@param` declarations populate a GUI on the right; video flows `mediaVideo → reaperVideo → layer` with per-frame compositing running in a Canvas2D context driven by the visualizer rAF loop.

Companion to `js~` (JSFX-in-the-browser). Where `js~` is EEL2-for-audio, `reaperVideo` is EEL2-for-video — same language, different stdlib, different runtime.

---

## The critical upfront fact

**REAPER's video processor is EEL2, not JavaScript.** It's the same interpreted C-like DSL as JSFX, with a different built-in vocabulary:

- **Parameters** use `//@param` comment-tagged declarations, not `sliderN:` lines.
- **No sections** — a video processor is a single flat script called once per frame (conceptually like `@gfx` in JSFX).
- **stdlib** is `gfx_*` compositing + `input_*` source queries + project/output state vars.
- **Blend modes** live in `gfx_mode` as a bitfield (additive flag + per-channel masks) — this is how the sample snippet does RGB decomposition.
- **Namespaced identifiers** — dotted names like `r.x`, `g.y` are a real EEL2 feature (namespaces). Treated as one identifier, not member access.

Decision: do it. The payoff is drop-in paste-from-REAPER for the entire video-processor preset library (stock REAPER effects, the JSFX video presets on GitHub, the ReaEffects video pack). Same argument as `js~` — any other path forfeits the ecosystem.

---

## Target snippet (locks Phase A scope)

Per the **DSL-port phasing rule**, Phase A must run this snippet correctly end-to-end — not just "architecture is in place":

```
// RGB decompose
//@param 1:r.x "red x offset"   0 -100 100 0 1
//@param 2:r.y "red y offset"   0 -100 100 0 1
//@param 3:g.x "green x offset" 0 -100 100 0 1
//@param 4:g.y "green y offset" 0 -100 100 0 1
//@param 5:b.x "blue x offset"  0 -100 100 0 1
//@param 6:b.y "blue y offset"  0 -100 100 0 1

gdf = g.x != r.x || g.y != r.y;
bdf = b.x != r.x || b.y != r.y;

colorspace = 'RGBA';
input_info(0, project_w, project_h);

gfx_fillrect(0, 0, project_w, project_h);
!gdf || !bdf ? gfx_blit(0) : (
  gfx_mode = 0xfa; gfx_blit(0, 0, r.x, r.y);
);
gdf ? ( gfx_mode = 0xf5; gfx_blit(0, 0, g.x, g.y) );
bdf ? ( gfx_mode = 0xf0; gfx_blit(0, 0, b.x, b.y) );
```

Everything in this snippet is a Phase A requirement:

| Feature | Phase A? |
|---------|----------|
| `//@param N:name "label" default min max step` | ✅ required |
| Dotted identifier names (`r.x`, `g.y`) as atomic idents | ✅ required |
| Comparison + logical: `!=`, `||`, `!` | ✅ (`js~` already has) |
| Ternary-as-statement, `cond ? (block) : (block);` | ✅ (`js~` already has) |
| Ternary with no else: `cond ? (stmt);` | ✅ (`js~` already has) |
| `colorspace = 'RGBA';` (string literal assigned to special var) | ✅ required |
| `input_info(idx, out_w, out_h)` with output-param refs | ✅ required |
| Special vars `project_w`, `project_h` | ✅ required |
| `gfx_fillrect(x,y,w,h)` | ✅ required |
| `gfx_blit(src)` — cover output with input | ✅ required |
| `gfx_blit(src, use_project_coords, x, y)` — offset blit | ✅ required |
| `gfx_mode` bitfield with additive + channel-mask bits | ✅ required |
| Hex literals (`0xfa`, `0xf5`, `0xf0`) | ✅ required |

---

## Scope decisions (locked)

| Decision | Value | Why |
|----------|-------|-----|
| Object name | `reaperVideo` | Matches user request; no tilde (not audio-rate) |
| Node type | `media` vFX (fits existing `VideoFXSource` interface) | Slots into `mediaVideo → reaperVideo → layer`, mirrors `vfxCRT` / `vfxBlur` |
| Inlets / outlets | 1 media in, 1 media out | Phase A: single video source. `input_info(N)` with N>0 tabled to Phase C. |
| Language | EEL2 subset — **reuse `src/runtime/jsfx/translate.ts`** | Expression translator is language-agnostic; only stdlib + parser entry differ |
| Runtime | Canvas2D `process()` called by `VisualizerGraph` rAF loop | Same pattern as `VfxCrtNode`; per-frame, not per-sample |
| Code editor | CodeMirror | Matches `js~` / `codebox` |
| Render mode | "Expanded object" — code pane ‖ param-knobs pane ‖ tiny preview thumb | Mirrors `js~` layout; knobs instead of sliders (REAPER params are typically continuous knobs) |
| Serialization | `code` arg, base64-encoded | Matches `js~` / `codebox` |
| Fonts / colors | Vulf Mono + `--pn-*` tokens only | Design-language rules |
| Colorspace support | RGBA only in Phase A | Snippet requests `'RGBA'`; YUV/YV12 deferred |

---

## Architecture

```
┌── src/runtime/ReaperVideoNode.ts ─────────────────┐
│  implements VideoFXSource                         │
│  owns: HTMLCanvasElement + CanvasRenderingContext2D│
│         + compiled per-frame fn + param state     │
│         + temp channel-mask canvases              │
│  methods: setCode, setParam, setInput(Video|Vfx), │
│           process(), get isReady, destroy         │
└───────────┬───────────────────────────────────────┘
            │  registered by
┌───────────▼──── src/runtime/VisualizerGraph.ts ───┐
│  (existing) — add a branch for type==="reaperVideo"│
│  to instantiate ReaperVideoNode and sync args     │
│  (code + param values) on graph change            │
└───────────┬───────────────────────────────────────┘
            │
┌───────────▼──── src/runtime/rvideo/parser.ts ─────┐
│  Parses `//@param` declarations + body.           │
│  Output: { params: ParamDecl[], body: string }    │
│  (No @init/@sample sections — video processor is  │
│   a single flat program run once per frame.)      │
└───────────┬───────────────────────────────────────┘
            │
┌───────────▼──── src/runtime/rvideo/translate.ts ──┐
│  Thin wrapper around jsfx/translate.ts with:      │
│   • video-processor identifier/function resolver  │
│     (project_w, project_h, gfx_*, input_info, …)  │
│   • output-param support for input_info()         │
│   • namespaced identifier tokenization (r.x, g.y) │
│   • string-literal handling for colorspace=       │
│  Emits: (ctx, host) => { …frame body… }           │
└───────────┬───────────────────────────────────────┘
            │
┌───────────▼──── src/runtime/rvideo/host.ts ───────┐
│  Runtime host object passed to compiled frame fn. │
│  Implements gfx_fillrect / gfx_blit / input_info  │
│  against a target CanvasRenderingContext2D and a  │
│  source HTMLVideoElement|HTMLCanvasElement.       │
│  Maps gfx_mode bitfield → globalCompositeOperation│
│  + per-channel mask temp-canvas routing.          │
└────────────────────────────────────────────────────┘
```

**Critical reuse:** `src/runtime/jsfx/translate.ts` already handles expressions, assignment, `== != < > && || ! ~`, parens-as-blocks, ternary with/without else, hex literals (verify), and user vars via `state.u_<name>`. We reuse it wholesale. The new work is the **host binding layer** and **parser front-end**, not the expression translator.

---

## Parser / translator deltas from `js~`

### 1. Identifier grammar — dotted namespaces

EEL2 treats `r.x` as a single identifier. Current `jsfx/translate.ts` tokenizer (line ~101-105) stops at non-`isIdentContinue`. Extend `isIdentContinue` in a shared helper (or fork for the video path) to accept `.` between ident characters. Emit as `state.u_r_x` (replace `.` with `_` for JS safety). This change is **also valid for `js~`**, so we lift the identifier tokenizer into a shared module and both paths consume it.

### 2. Parameter syntax

`//@param` is a comment-embedded pragma. Parser phases:

```
//@param <index>:<name> "<label>" <default> <min> <max> <???> <step>
```

The REAPER format is actually `//@param [N:]name "label" default min max [mid [step]]` where `mid` is the knob center point (often `0` in the snippet). The parser must be tolerant — accept either 4- or 5- or 6-number trailing forms. Phase A ships: `index, name, label, default, min, max, mid, step` — unused fields stored but not UI-rendered.

### 3. String literals

`colorspace = 'RGBA';` — single-quoted strings. In EEL2 a single-quoted multi-char literal is a packed-int-per-char (like C multi-char literals). For Phase A we only need the `colorspace` special var, so: when the LHS of assignment is `colorspace`, parse RHS as a string literal and store on the host (`host.colorspace = 'RGBA'`). Other string-literal uses rejected with a typed error.

### 4. Output-parameter semantics for `input_info`

`input_info(0, project_w, project_h)` writes into its 2nd/3rd args. The translator must recognize `input_info` and emit `host.input_info(state, 0, 'project_w', 'project_h')` — passing variable **names** so the host can write back. This is special-cased at the call-site translator (same mechanism we'd use for `midirecv()` in `js~` later).

### 5. No sections

Parser skips the `@init`/`@slider`/`@sample` section splitter entirely. The whole file (minus `//@param` lines) is the per-frame body. Emit one JS function: `frame(state, params, host) { …body… }`.

---

## Runtime host — the compositing layer

The host translates EEL2 `gfx_*` calls into Canvas2D operations on the node's output canvas.

### `input_info(idx, out_w, out_h)`

```ts
input_info(state, idx: number, wVar: string, hVar: string) {
  const src = this.sources[idx];        // Phase A: idx always 0
  state[`u_${wVar}`] = src?.width ?? 0; // project_w
  state[`u_${hVar}`] = src?.height ?? 0; // project_h
  return src ? 1 : 0;
}
```

### `gfx_fillrect(x, y, w, h)`

```ts
ctx.fillStyle = this.gfxFillStyle;        // default: transparent black
ctx.globalCompositeOperation = 'source-over';
ctx.fillRect(x, y, w, h);
```

### `gfx_blit(src, useProjectCoords?, destX?, destY?, destW?, destH?, srcX?, srcY?, srcW?, srcH?)`

Map REAPER's blit to `ctx.drawImage` with the current `gfx_mode` applied. The 10-arg long form exists for Phase B+; Phase A only needs the 1-arg and 4-arg forms used in the snippet.

### `gfx_mode` — the hard part

REAPER's `gfx_mode` bitfield (from the video-processor docs):

| Bit | Meaning |
|-----|---------|
| `0x01` | Additive blend |
| `0x02` | Disable source alpha read (treat src alpha = 1) |
| `0x04` | Disable dest alpha write |
| `0x08` | Filter source linearly (default is nearest in some paths) |
| `0x10` | Mask: clear **red** from source |
| `0x20` | Mask: clear **green** from source |
| `0x40` | Mask: clear **blue** from source |
| `0x80` | Mask: clear **alpha** from source |

So in the snippet:
- `0xfa = 1111_1010` → additive (bit 0=0… wait) — **TODO verify exact semantics against REAPER docs**; the example clearly works as "additive, only red contributes", so:
  - `0xfa` → additive + mask out G + mask out B (leaves R only) → chromatic-aberration red pass
  - `0xf5` → additive + mask out R + mask out B (leaves G only)
  - `0xf0` → additive + mask out R + mask out G (leaves B only)

Canvas2D has no per-channel mask for `drawImage`. Implementation strategy (mirrors `VfxCrtNode`'s existing chromatic aberration at `src/runtime/VfxCrtNode.ts:16-46`):

1. Maintain three reusable temp canvases (R-only, G-only, B-only).
2. When `gfx_mode` has channel masks active, draw the source into the appropriate temp canvas once, then extract only the unmasked channel by drawing with a tinted `multiply` composite + `source-in` cleanup.
3. Blit the temp canvas to the output with `globalCompositeOperation = 'lighter'` for the additive flag.

For modes without channel masks (bits 0x10/0x20/0x40 all off), map straight to `'source-over'` / `'lighter'`.

**Phase A MUST verify** the exact bit semantics by running the snippet and visually matching REAPER's output on the same test clip. If the snippet renders as correct RGB separation under joystick control of the six params, bit interpretation is correct.

---

## GUI

Layout mirrors `js~`:

```
┌─────────────────────────────────────────────────┐
│ [code editor, CodeMirror, ~45% width]  │ [params]│
│                                         │ r.x  ▓ │
│ //@param 1:r.x ...                      │ r.y  ▓ │
│ ...                                     │ g.x  ▓ │
│                                         │ g.y  ▓ │
│ gdf = g.x != r.x ...                    │ b.x  ▓ │
│                                         │ b.y  ▓ │
│                                         │ ───── │
│                                         │ [prev]│
└─────────────────────────────────────────────────┘
```

- Params render as **knobs** (REAPER convention), labeled with the quoted label from `//@param`.
- Small live preview at the bottom-right of the param pane (the node's own output canvas, thumbnailed) — lets the user confirm the patch without scrolling to the `layer` object.
- Errors surface inline in the code pane (reuse `js~`'s error-badge pattern).

---

## Phasing

### Phase A — "render the RGB decompose snippet"
Goal: paste the exact snippet above into a `reaperVideo` placed between `mediaVideo` and `layer`, get live RGB-offset chromatic aberration in real time.

Deliverables:
- `objectDefs.ts` entry for `reaperVideo`
- `src/runtime/rvideo/parser.ts` — `//@param` + flat body
- `src/runtime/rvideo/translate.ts` — wraps `jsfx/translate.ts` with video-processor identifier/fn resolver, dotted idents, string literal for `colorspace`, `input_info` output-param handling
- `src/runtime/ReaperVideoNode.ts` — `VideoFXSource` implementation
- Host impls: `input_info`, `gfx_fillrect`, `gfx_blit(1-arg + 4-arg)`, `gfx_mode` with additive + 3 channel-mask bits
- `VisualizerGraph.ts` branch for `reaperVideo`
- Canvas UI: code pane + knob pane + preview, matching `js~` layout
- Serialization (`code` arg base64) + round-trip test
- **Acceptance:** snippet renders, six knobs live-update the output, lossless save/load

### Phase B — "cover the preset library"
- Full `gfx_blit` long-form (10 args, rotation, scale)
- `gfx_gradrect`, `gfx_line`, `gfx_circle`, `gfx_text`, `gfx_setfont`
- `gfx_getpixel`, `gfx_setpixel` (slow-path pixel ops)
- More `gfx_mode` bits: linear filter, alpha read/write disable
- `gfx_a`, `gfx_r`, `gfx_g`, `gfx_b` as writable fill-color globals
- String literal full support (multi-char packed int)

### Phase C — "multi-input effects"
- 2+ media inlets; `input_info(N)` with N>0 — needed for mix/crossfade/wipe effects
- `input_track(N)` mapping to a specific patchNet media node by position

### Phase D (maybe) — YUV/YV12 colorspaces
Only worth it if a real preset we want needs it. Likely skip — Phase F covers
the YUV-dependent presets we've actually seen via emulation in the RGBA
pipeline.

### Phase F — "LUT-based effects" (`mem[]` + `gfx_procrect`)

Target snippet: the stock REAPER "Colorize" preset (hue/saturation/brightness/
contrast sliders, writes a 768-entry Y/U/V lookup table into `mem[]`, calls
`gfx_procrect` with the YV12 colorspace flag).

Two deliverables; F3 stays deferred like D.

#### F1 — `mem[]` plumbing (~1 day)

- Give `ReaperVideoNode` a `Float64Array mem` (default 1M entries = 8MB). Reset
  on recompile; persist across frames within one compiled program. Matches
  JSFX semantics.
- Frame-fn signature grows a 4th arg: `(state, params, host, mem) => {…}`.
  The evalrect sweep fn also gains `mem` access — same arg.
- Translator: `mem` / `gmem` already resolve to `{js: "0", pointerish: true}`
  so the `tab[i]` postfix path emits `mem[((state.u_tab)|0) + ((state.u_i)|0)]`.
  We only need to ensure the compiled JS sees a real `mem` binding in scope —
  that's the signature change above.
- `gmem` aliased to the same buffer for now (true cross-node gmem can be a
  later concern; no preset we've hit uses it).

**Acceptance:** a preset with `tab[i]=value; val=tab[i];` round-trips
correctly; translator emits no `mem is not defined` runtime error.

#### F2 — `gfx_procrect(x, y, w, h, mem_offset, flags)` (~1.5 days)

REAPER's LUT-based per-pixel op. Three contiguous 256-entry planes in `mem`
starting at `mem_offset`.

**Operating mode (driven by colorize preset's behavior):**

- **Luma-indexed mode** (`flags & 1`, which is what the colorize preset
  passes). All three lookups are indexed by the *input luma* byte value
  — not by the pixel's U/V. That's how the preset synthesizes chroma
  from luma:
  ```
  y_idx    = clamp(round(Y_in * 255), 0, 255)
  Y_out    = mem[offset + y_idx]          // 0..1 float
  U_out    = mem[offset + 256 + y_idx]    // 0..1 float (0.5 = neutral)
  V_out    = mem[offset + 512 + y_idx]    // 0..1 float (0.5 = neutral)
  → YUV back to RGB via BT.601
  ```
- **Per-channel mode** (flags bit 0 clear). Straight LUT per channel:
  ```
  R_out = mem[offset +       R_idx]
  G_out = mem[offset + 256 + G_idx]
  B_out = mem[offset + 512 + B_idx]
  ```

**YUV emulation:** we operate in RGBA end-to-end but do the RGB↔YUV
conversion *inside* `gfx_procrect` when luma-indexed mode is requested.
This side-steps needing native YV12 storage (Phase D) while still making
colorize-style presets produce correct output. The BT.601 matrix is close
enough to REAPER's behavior for the preset-compatibility use case; we can
swap to BT.709 later if a test shows visible drift.

**Performance:** same JS pixel-loop approach as `gfx_evalrect`. Inline the
work into one big sweep function, honor the same `maxRenderDim` cap.
Expected similar throughput: ~60fps at 360p for the colorize preset.

**Acceptance:** the "Colorize" preset renders a visibly correct hue-shifted
output, all four sliders (hue/saturation/brightness/contrast) live-update.

#### F3 (deferred) — native YUV colorspaces

Would let us run presets that write directly to U/V planes without going
through the RGB round-trip emulator. Defer unless a preset actually requires
it — the BT.601 emulation handles the colorize case, and most presets that
declare `colorspace='YV12'` do so to get the luma-indexed LUT behavior
(which F2 supplies in RGBA).

---

## Completion roadmap update

Phase F slots between Phase C and Phase E1 in priority terms — it's a real
preset-compatibility win at moderate effort.

### Phase A cleanup — "real presets don't crash at parse time"

Discovered while field-testing the stock Gaussian-blur preset. Small, independent, unblocks any preset work downstream.

- **`//@paramN:` with no space** (`//@param1:sigma_parm`). REAPER's actual syntax has no required whitespace between `@param` and the index. Fix: in `src/runtime/rvideo/parser.ts:52`, change `\s+` → `\s*` before the index match. Without this, param lines fall through to the body silently and the GUI shows zero knobs for valid REAPER source.
- **Single-quoted labels** (`'Sigma'`). REAPER accepts both quote styles; parser currently accepts double only. Fix: extend the label regex in `splitParamTokens` to match `'...'` OR `"..."`. Be careful to still reject `'one" "two'` mixing.
- **JS reserved-word collision check is overly strict** (`src/runtime/eel2/translate.ts:385`). The translator emits user vars as `state.u_<name>` — a property access — where JS reserved words (`in`, `function`, `class`, etc.) are perfectly legal property keys. The check rejects REAPER scripts that use `in`, `case`, etc. as plain var names (the Gaussian-blur preset uses `in=0;`). Fix: remove the `JS_RESERVED.has(sanitized)` early-return. Add a unit test for `in = 0;` translating to `(state.u_in = 0)` without error. (`js~` benefits too — anything declaring `new`, `in`, etc. currently fails to compile.)

**Acceptance:** a `reaperVideo` object with the RGB-decompose preset still works, AND a preset starting `//@param1:foo 'Bar' …\nin = 0;` parses without error. The Gaussian-blur preset still won't *execute* (that needs Phase E) but it will now make it past the parse/translate stage and report a specific missing-feature error (`unknown function 'gfx_evalrect'`) instead of a cascade of cosmetic parse failures.

### Phase E — "kernel effects" (EEL2 `function` defs + `gfx_evalrect`)

Goal: run presets that define helper functions and use `gfx_evalrect` for per-pixel transforms. Lock target snippet: REAPER's stock Gaussian-blur preset (recursive IIR sweep with serial state vars `_1`, `_11`, `_21`, `_31`, plus `bd(flag)` helper and four-direction sweep via the `flag` argument).

Phase E splits into three sub-phases; E1 and E2 are required for the target snippet, E3 is a performance optimization that can ship later.

#### E1 — EEL2 `function` definitions (~2 days)

Useful standalone: unlocks many `js~` presets too (Stillwell-style helpers currently get inlined by hand).

- Parser: `function NAME(arg1 arg2 …) (body)` — EEL2 args are **space-separated, not comma-separated**.
- Hoist all function defs to the top of the emitted program body as JS function declarations: `function u_NAME(arg1, arg2) { …body…; return <last expr>; }`. EEL2 returns the last expression's value.
- Local vars inside a function body are scoped to that call (EEL2 "instance" semantics). Simplest legal model: give the function its own `state` proxy — unknown idents read/write the per-call proxy, known globals (`gfx_*`, `colorspace`, params) still punch through to the host/outer state. A `locals: {…}` param works.
- Recursion allowed (trivial once the name is in scope at emit time).
- No closures — REAPER EEL2 functions are global definitions.
- `function.name.arg = …` namespace-assignment syntax (EEL2 extended) is **out of scope for E1**; flag with a clear error.
- Test seeds: `function sq(x) (x*x); out = sq(5);` → `out === 25`. `function bd(flag) (…)` parses without gfx_evalrect being available (error deferred to call time).

#### E2 — `gfx_evalrect` via JS pixel loop (~3 days)

Correctness first, speed later.

- Host method: `gfx_evalrect(x, y, w, h, bodySource, flag = 0)`. The 5th arg is an EEL2 string literal — a new string context beyond `colorspace = 'RGBA'`.
- **Compile body once, cache by hash.** Cache lives on the node (cleared on `setCode`). `translateRVideoBody` is reused with a slightly different resolver that maps the per-pixel special vars onto locals rather than `state.u_*`.
- Per-pixel special vars:
  - RGBA mode: `r`, `g`, `b`, `a` — read from source pixel, written back after body runs.
  - YV12 mode: `y1`, `y2`, `y3`, `y4`, `u`, `v` — **Phase D territory**, stub with a runtime error for now.
- **Serial state vars** (`_1`, `_2`, … `_11`, `_21`, etc.). These persist across pixels in the sweep order — this is how recursive filters like Gaussian blur work. Implement as a `Float64Array` keyed by name, reset at each `gfx_evalrect` call. This is the load-bearing detail that lets the blur preset actually work.
- **Sweep flags** (4th arg to `gfx_evalrect`):
  - bit 0 (`1`) — still undocumented; treat as horizontal (default).
  - bit 2 (`4`) — backward along row.
  - bit 3 (`8`) — vertical-major (iterate columns). Combined with bit 2 = bottom-to-top.
  - Verify against the Gaussian-blur preset's `bd(4)` / `bd(8)` / `bd(4|8)` / `bd(0)` calls — it runs all four sweeps, so the blur's visual symmetry is the acceptance test.
- Outer body's user vars are **read-only** during `gfx_evalrect` execution (captured at call time into the per-call locals). This matches common REAPER preset patterns where coefficients (`BB`, `b1b0`, `b2b0`, `b3b0`) are computed once per frame and consumed by the kernel.
- Performance expectations, documented inline: 1080p × 30fps × ~20 ops/pixel ≈ 60 Mops/s of interpreted JS — likely realtime only up to ~360p–540p on mid-range hardware. This is the motivation for E3.
- **Acceptance:** Gaussian-blur preset renders a visually correct blur under all four sweep flags. Ignore fps for E2.

#### E3 — WebGL fast-path for parallel kernels (~4–5 days, optional)

- Compile-time classification: if the `gfx_evalrect` body references no `_N`-prefixed serial vars AND no `loop`/`while` with early-exit pixel dependencies, it's a **parallel kernel** → translate the EEL2 body to a GLSL fragment shader instead of JS.
- Runtime: bind the input source to a `sampler2D`, render a fullscreen triangle into an offscreen framebuffer, read back to the output canvas with `drawImage`. Ping-pong is only needed when the same evalrect is chained — Phase E3 can skip that.
- Serial kernels stay on the E2 JS path automatically (no regression risk).
- Escape hatch: a `render` arg on the `reaperVideo` object (`auto` | `js` | `webgl`) — default `auto`, forces available for debugging.
- **Acceptance:** a pure color-displacement preset (e.g., any chromatic-aberration preset built on `gfx_evalrect`) runs at 60fps on 1080p. Gaussian blur stays on the JS path and is unaffected.

#### Phase E explicit non-goals

- `gfx_blurto` — REAPER's native Gaussian blur helper. Implement separately using Canvas2D's `filter: 'blur(Npx)'` on a scratch canvas; doesn't need Phase E.
- Presets that use `mem[]` as a scratch framebuffer (some offset-mapped effects). Needs the JSFX shared `mem[]` plumbing — track as Phase F if a real preset requires it.
- Writing back to the source mid-frame. `gfx_evalrect` writes to the node's output canvas only.
- EEL2 namespace-assignment in function bodies (`this.r = …`). Out of scope; error out.

---

## Completion roadmap

Ordered by dependency and value. Effort estimates are single-developer-day ballparks, not commitments.

| # | Work | Covers | Effort |
|---|------|--------|--------|
| 0 | **Phase A cleanup** | Parser whitespace + quote tolerance; drop reserved-word collision check (also helps `js~`) | ~1 day |
| 1 | **Phase B** | Full `gfx_blit` long-form (rotate/scale), `gfx_gradrect`/`line`/`circle`/`rect`/`text`/`setfont`, `gfx_getpixel`/`setpixel`, remaining `gfx_mode` bits (filter + alpha), writable `gfx_a/r/g/b` fill-color globals, full string-literal support | ~4 days |
| 2 | **Phase C** | 2+ media inlets, `input_info(N>0)`, `input_track(N)`. Unlocks mix/wipe/crossfade presets | ~2 days |
| 3 | **Phase E1** | EEL2 `function` definitions. Standalone win — shared with `js~` | ~2 days |
| 4 | **Phase E2** | `gfx_evalrect` JS pixel loop with serial state + sweep flags. Unlocks Gaussian blur and most recursive-filter presets | ~3 days |
| 5 | **Phase E3** | WebGL fast-path for parallel kernels. Optional; ships when a preset demands it | ~4–5 days |
| — | Phase D (YUV) | Skip unless a specific preset forces it | — |

**Dependency notes.** Phase A cleanup is independent — ship first, regardless of later order. Phase B and C are independent of each other and of E. E1 is a prerequisite for E2 (the blur preset declares `function bd(flag)` before calling `gfx_evalrect`). E3 is purely optional and can be deferred indefinitely.

**PR cadence.** One phase per PR. Phase A cleanup gets its own small PR first (doubles as a `js~` bug-fix PR). Each subsequent phase lands with an updated `AGENTS.md` entry per the Director protocol and a tested-in-browser acceptance snippet in the PR description.

**Target end-state.** Paste-from-REAPER works for the overwhelming majority of stock video presets and the public preset library. Recursive serial kernels work correctly via the JS pixel loop; parallel kernels run on WebGL when E3 ships. YUV presets remain unsupported by design.

---

## Resolved decisions

1. **Hex literal support** — verify `0x` tokenization in `jsfx/translate.ts` during Phase A; add if missing (trivial tokenizer change). Required for the target snippet's `0xfa / 0xf5 / 0xf0`.
2. **Dotted-ident lift** — **locked.** Extract the identifier tokenizer into a shared `src/runtime/eel2/tokenize.ts` during Phase A. Both `reaperVideo` and `js~` consume it. Dotted names are real EEL2 namespace syntax and the fix benefits any future preset paste.
3. **Preview thumbnail** — **dropped from Phase A.** Downstream `layer` is the canonical preview. Param pane is knobs only. Simplifies layout and cuts render cost.
4. **Frame rate** — **drive from `VisualizerGraph`'s existing rAF loop.** Pin to display-rate, no separate timer. Rationale for live-performance:
   - The `layer` compositor already renders at rAF; a separately-timed `reaperVideo.process()` either duplicates frames (wasted work) or renders frames the compositor discards (also wasted).
   - rAF is vsync-aligned — no tearing, browser schedules it with the paint.
   - `process()` is **pull-based from `layer`** (lazy): `reaperVideo` only renders when the downstream compositor actually asks for a frame. Matches how `VfxCrtNode` / `VfxBlurNode` already work.
   - For time-based effects in Phase B, expose a `frame_time` special var populated from the rAF timestamp — no change to the drive model.

---

## Memory check

- ✅ **DSL-port phasing rule** — Phase A is scoped around the real RGB decompose snippet, every feature it uses is called out in the requirements table.
- ✅ **One registration point** — new `OBJECT_DEFS` entry in `objectDefs.ts` only.
- ✅ **Canvas ↔ text bidirectional bond** — code + param values both serialize through the standard `args` channel; text-panel edits of the base64 `code` arg trigger recompile, param changes propagate to text-panel args.
- ✅ **Max/MSP default UI** — knobs for continuous params match REAPER > Max convention here (REAPER wins because we're porting REAPER code).
