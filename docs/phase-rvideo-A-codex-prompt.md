# Phase A — `reaperVideo` object: paste REAPER video processor code, see it run live

**Read first:** `CLAUDE.md`, `AGENTS.md` (Project State + Architecture Decisions), `DESIGN_LANGUAGE.md`, `docs/REAPER_VIDEO_OBJECT_PLAN.md`, `docs/phase-js-A-prompt.md` (structural precedent — you will mirror its layout decisions).

**Exit bar of this phase (the exact thing the user will do):**
Drop `mediaVideo → reaperVideo → layer` on the canvas, paste the RGB decompose snippet below into the code pane, twist the six knobs, see live per-channel RGB offset on the video in real time.

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

If that renders correctly and the knobs live-update the output without stutter, Phase A is done. Everything else (more `gfx_*` calls, multi-input, colorspaces beyond RGBA, time-based effects) is Phase B+.

---

## Scope — do in this phase

### 1. Shared EEL2 tokenizer (lift out of `js~`)

**This is a cross-cutting refactor — do it first, land it cleanly, then build on it.**

- New file `src/runtime/eel2/tokenize.ts`.
- Move the tokenizer currently inside `src/runtime/jsfx/translate.ts` into this module. Exported surface: `tokenize(source: string): Token[]` + the `Token` type.
- **Extend the identifier rule** so dotted names like `r.x`, `g.y`, `foo.bar.baz` tokenize as a single `ident` token. The rule: after a valid ident start, a `.` is part of the identifier iff both the character before and after it are ident-continue chars. Bare leading/trailing dots stay as their own tokens (they're not valid idents).
- **Verify hex literal support** (`0x...`). If `jsfx/translate.ts` doesn't already handle `0x` / `0X` prefixed integers, add it in the numeric literal rule in the shared tokenizer. The target snippet's `0xfa / 0xf5 / 0xf0` must parse.
- Update `src/runtime/jsfx/translate.ts` to import from the new shared module. When translating identifiers containing `.`, map to JS-safe names by replacing `.` with `_` (so `r.x` → `state.u_r_x`). Confirm `js~` still passes its existing tests / smoke flow after the refactor.

### 2. Object definition

- Add `reaperVideo` to `OBJECT_DEFS` in `src/graph/objectDefs.ts`.
- Category: `scripting` (same bucket as `js~` and `codebox`).
- Args:
  - `code` — symbol, hidden, base64-encoded source. Default: empty.
- Inlets: 1 × `media` (video in, from `mediaVideo` or an upstream vFX).
- Outlets: 1 × `media` (processed video out, to `layer` or downstream vFX).
- `defaultWidth` / `defaultHeight`: match `js~` proportions (code pane + right-side control column). Start ~560×320.
- Messages: none in Phase A (param-via-message is Phase C+).

### 3. Parser — `//@param` + flat body

- New file `src/runtime/rvideo/parser.ts`.
- Parse **only two things**:
  1. `//@param` comment-pragma lines. Tolerant format:
     ```
     //@param [N:]<name> "<label>" <default> <min> <max> [<mid>] [<step>]
     ```
     - `N:` index prefix is optional. If absent, assign sequentially (1-based).
     - `<name>` may contain dots (e.g. `r.x`). Must be a single token matching the shared tokenizer's ident rule.
     - `<label>` is quoted with `"..."`. Unescaped quotes inside the label are not supported in Phase A.
     - Numeric fields: accept 4, 5, or 6 trailing numbers. 4 = default/min/max/step; 5 = default/min/max/mid/step; 6 = reserved, accept and store the extra. Store all fields; Phase A UI uses `name`, `label`, `default`, `min`, `max`, `step` only.
  2. Everything else is **one flat body string** (stripped of `//@param` lines, preserving line numbers by replacing those lines with blanks so error line numbers match the user's source).
- Output: `{ ok: true, program: { params: ParamDecl[], body: string } }` or `{ ok: false, error: { line, message } }`. Do not throw on malformed param lines.

### 4. Translator — video-processor stdlib

- New file `src/runtime/rvideo/translate.ts`.
- Reuse `jsfx/translate.ts`'s expression translator for arithmetic, comparison, logical, ternary, parens-as-blocks, assignment, hex literals. **Do not duplicate that work.** If you need a translator entry point that doesn't exist yet, refactor `jsfx/translate.ts` to expose a `translateBody(source, identResolver, callResolver): { js, errors }` function and have both `js~` and `reaperVideo` consume it with different resolvers.
- Video-processor **identifier resolver** — names resolved to host state:
  - `project_w`, `project_h` → `state.u_project_w`, `state.u_project_h` (just user vars, but pre-initialized by `input_info`).
  - `colorspace` → `host.colorspace` (read/write).
  - `gfx_mode` → `host.gfxMode` (read/write, integer).
  - `gfx_a`, `gfx_r`, `gfx_g`, `gfx_b` → `host.gfx[Channel]` (Phase B — resolver can alias to user vars for now, fill color stays transparent black).
  - Dotted user vars: `r.x` → `state.u_r_x`. Params bind into this namespace at frame start: before each frame, the runtime writes `state.u_r_x = params[0]` for a param named `r.x`.
  - Anything else → `state.u_<name>`.
- Video-processor **call resolver** — function calls mapped to host methods:
  - `gfx_fillrect(x,y,w,h)` → `host.gfx_fillrect(x,y,w,h)`.
  - `gfx_blit(src)` → `host.gfx_blit(src)`.
  - `gfx_blit(src, useProjCoords, x, y)` → `host.gfx_blit(src, useProjCoords, x, y)`.
  - `gfx_blit` with 10 args → accept the call but only implement the 1- and 4-arg forms in Phase A; extras pass through as NO-OP with a typed warning in the parse error list (surface in console, don't cut rendering).
  - `input_info(idx, wVar, hVar)` → **special case at the call-site**: the 2nd and 3rd args must be bare identifiers; emit `host.input_info(state, idx, "<wVar name>", "<hVar name>")`. If they're not bare idents, emit a typed error ("input_info second and third args must be variable names").
- String literals: accept single-quoted `'...'` **only on the RHS of an assignment to `colorspace`**. Emit `host.colorspace = "RGBA"` directly. Any other string literal → typed error ("string literals only supported for colorspace assignment in Phase A"). Don't try to implement EEL2's packed-multi-char-int semantics.
- Output: a compiled function `frame(state, params, host)` that runs the full body once. The node will call this function once per `process()`.

### 5. Runtime — `ReaperVideoNode` (Canvas2D vFX)

- New file `src/runtime/ReaperVideoNode.ts`. Model it on `src/runtime/VfxCrtNode.ts` — `implements VideoFXSource` with `canvas`, `setInput(HTMLVideoElement|null)`, `setVfxInput(VideoFXSource|null)`, `get isReady`, `process()`, `destroy()`.
- Owns:
  - An output `HTMLCanvasElement` + `CanvasRenderingContext2D`.
  - Three reusable temp canvases for channel masking (R-only, G-only, B-only) — allocate at construction, reuse each frame. See `VfxCrtNode`'s `tmpR`/`tmpB` pattern.
  - The compiled `frame` fn (nullable — passthrough when null).
  - A `state: Record<string, number>` object holding all EEL2 user vars (incl. `u_project_w`, `u_project_h`, dotted vars).
  - A `params: Float32Array` of length 64 for knob values.
  - A `host` object implementing `gfx_fillrect`, `gfx_blit`, `input_info`, plus `colorspace` and `gfxMode` fields. **The host holds a reference to the current `ctx` and `sourceCanvas` per-frame, set by `process()` before invoking `frame()`.**
- API:
  - `setCode(program: { frame: Function, params: ParamDecl[] } | null)` — store the compiled program; initialize `state.u_<name>` for each param's dotted var from its default.
  - `setParam(index, value)` — write to `params[index]`; also write through to `state.u_<paramName>` so the param's namespaced var reflects the knob immediately.
  - `process()` — if `!isReady`, return. Resolve source canvas/video, set host's `ctx` and `source`, reset `gfx_mode = 0`, call compiled `frame(state, params, host)` inside a `try/catch`. On throw: passthrough (`ctx.drawImage(source, 0, 0)`) and latch the error for the panel to display. Never kill the graph.

### 6. Host implementation (the compositing core)

Same file or a helper module under `src/runtime/rvideo/`.

- **`input_info(state, idx, wVarName, hVarName)`** — for `idx === 0` in Phase A: look up `this.source`, write `state['u_' + wVarName] = source.width`, same for height. Return 1 if source ready, 0 otherwise. `idx !== 0` → return 0 (Phase C adds multi-input).
- **`gfx_fillrect(x, y, w, h)`** — resets `ctx.globalCompositeOperation = "source-over"`, `ctx.fillStyle = "rgba(0,0,0,0)"` (transparent black by default; REAPER's default fill is black with alpha 0 per the snippet's intent — it's used as a clear), then `ctx.clearRect(x,y,w,h)` (semantically cleaner than fillRect with transparent). Document the choice in a one-line code comment — behavior matches the snippet's usage (clearing before compositing).
- **`gfx_blit(src, useProjCoords?, destX?, destY?)`** — `src === 0` ⇒ use `this.source`. Resolve `gfxMode`:
  - Bit `0x01` (additive) → `ctx.globalCompositeOperation = "lighter"`; otherwise `"source-over"`.
  - Bits `0x10 / 0x20 / 0x40` (mask R / G / B from source) → if ANY are set, route through a temp canvas:
    1. Pick the surviving channel (e.g., mask=0x60 → only red survives; mask=0x50 → only green; mask=0x30 → only blue). Exactly one channel surviving is the only case used by the target snippet — handle it.
    2. Draw `source` into a temp canvas at its natural size.
    3. Extract the surviving channel: fill the temp with `rgba(R,G,B,1)` using `"destination-in"` where the channel mask color is `(255,0,0)` / `(0,255,0)` / `(0,0,255)` — actually simpler: draw source, then paint `fillStyle = "#ff0000"` (or `#00ff00` / `#0000ff`) with `globalCompositeOperation = "multiply"` over the full temp rect. Final step: blit the temp canvas to the output `ctx` at `(destX, destY)` with the additive composite op.
    4. Multi-channel survival (e.g., two bits cleared) → implement as the obvious generalization; not needed for the target snippet but is one `for` loop over the three channels.
  - No masks → straight `ctx.drawImage(source, destX ?? 0, destY ?? 0)` with the additive/over composite op already set.
  - `useProjCoords` is ignored in Phase A (Phase B wires explicit coord systems).
- After every `gfx_blit`, **do NOT** reset `gfxMode`. The snippet relies on `gfx_mode` sticking across calls within the same frame, but getting reset at the start of the next frame (handled by `process()` setting `gfxMode = 0` before invoking `frame`).

**Verification plan for `gfx_mode` bits**: render the snippet with one knob at e.g. `r.x = 30`, others at 0. Result should be a red-fringed image. Sweep each color separately. If the fringe color matches the active knob, bit semantics are right. If not, swap mask-bit → channel mapping until it matches.

### 7. VisualizerGraph wiring

- Follow the `vfxCRT` pattern exactly in `src/runtime/VisualizerGraph.ts`:
  - Add `reaperVideoNodes = new Map<string, ReaperVideoNode>()` field.
  - Create/destroy diff block mirroring the `vfxCRT` block around lines 470–480.
  - In the upstream wiring section (~L617–L631), add a `reaperVideo` branch so it can take input from `mediaVideo`, `browser~`, `vfxCRT`, `vfxBlur`, or another `reaperVideo`.
  - In the downstream consumers (`layer`, other vFX), accept `reaperVideo` as a valid upstream source — same switch as `vfxCRT`.
  - Add a `syncReaperVideoProgram(node, patchNode)` that recompiles from `patchNode.args[0]` (base64 code) when it changes, and writes param values from the panel into the node.

### 8. Canvas — expanded object body

- New file `src/canvas/ReaperVideoPanel.ts`. Structurally mirror `src/canvas/JsEffectPanel.ts`:
  - `buildRoot() / attach(host) / detach() / destroy()`.
  - Layout: flexbox two-pane. Left pane = CodeMirror (Vulf Mono, `--pn-*` tokens). Right pane = vertical column of knobs, one per declared `//@param`.
  - Code edit → debounce 300ms → parse → translate → push program to `ReaperVideoNode.setCode(...)`. Keep last-good compile live on error (don't blank the video).
  - Knob change → immediate `node.setParam(i, value)` (no debounce). Knob UI: reuse the existing knob component if one exists (look for it in `src/canvas/` — if not present, start with a vertical-drag number input with a label above, readout below; upgrade to visual knob in Phase B).
  - **No preview thumbnail.** Decision locked in the plan — the downstream `layer` is the canonical preview.
- New file `src/canvas/ReaperVideoPanelController.ts` — `Map<nodeId, ReaperVideoPanel>`, `mount(panGroup)` / `prune(activeIds)` mirroring `JsEffectPanelController`.
- `ObjectRenderer` — `reaperVideo` branch: emit a `pn-reaperVideo-panel-host` div with `data-reaperVideo-panel-host=<nodeId>`.
- `DragController` — add `.pn-reaperVideo-panel-host` to the drag allowlist.
- `main.ts` — instantiate the controller; `mount/prune/destroy` hooked into the render loop alongside `js~`.

### 9. CSS

- All styling via `--pn-*` tokens. Vulf Mono for code pane, Vulf Sans for labels. No hardcoded hex.
- Add the panel-host block in `src/shell.css` mirroring the `js~` / dmx panel-host blocks.

### 10. Persistence

- Code edit → debounced save: base64-encode source → write to `args[0]` → emit `change`. Same codebox/`js~` pattern.
- On graph re-render: panel reads `args[0]`, decodes, pushes to CodeMirror, triggers recompile.
- Knob values are **not** persisted in Phase A — they reset to `//@param` defaults on reload. (Persistence-of-knob-values is Phase B; the arg schema has to grow a `params` field without breaking the `code`-only round-trip.)

### 11. Build cleanliness

- `tsc --noEmit` clean.
- `npm run build` clean. Bundle impact ≤ ~50 KB (the shared EEL2 tokenizer lift should be roughly net-zero; the new vFX node + panel + host are the real additions).
- `js~` still works — smoke it with the Phase-A JSFX gain snippet after the tokenizer lift.

---

## Frame drive — lock this in

`reaperVideo.process()` is **pull-based from the downstream consumer** (usually `layer`). Do not add a standalone rAF timer. When `layer` renders, it calls `process()` on each upstream vFX, which chains back. This is how `VfxCrtNode` / `VfxBlurNode` already work. Rationale:

- rAF is vsync-aligned.
- Lazy: a `reaperVideo` with no downstream consumer renders zero frames per second.
- No dropped or duplicated frames at the compositor boundary.

`frame_time` / `beat_position` / `play_state` special vars are **Phase B**. Phase A's target snippet is frame-stateless.

---

## Out of scope for this phase — do NOT do

- Any `gfx_*` call beyond `gfx_fillrect` and `gfx_blit` (1-arg + 4-arg) — no `gfx_line`, `gfx_circle`, `gfx_text`, `gfx_gradrect`, `gfx_getpixel/setpixel`.
- `gfx_mode` bits beyond additive + the three channel-mask bits. No filter/alpha bits.
- YUV / YV12 / I420 colorspaces. RGBA only.
- Multi-input: `input_info(N)` with `N > 0` returns 0 and does nothing.
- Time-based special vars (`frame_time`, `beat_position`, `play_state`, `play_position`).
- Knob value persistence across reloads.
- Custom visual knob — vertical-drag number input is fine for Phase A.
- Error UI beyond a minimal inline badge. Rich error pane is Phase C.
- Param-via-message inlets (no inlet growth — 1 media in, 1 media out, period).

If any of these are tempting, stop and check with the Director.

---

## Architecture notes — read before coding

- **Panel lifecycle.** `render()` nukes `.patch-object` DOM on every `change`. The controller-map pattern (`JsEffectPanelController` / `DmxPanelController`) is the only way to keep CodeMirror state + knob values alive across re-renders. Do not inline the panel in `ObjectRenderer`.
- **Wheel + mousedown `stopPropagation`** on the panel root. See `JsEffectPanel` / `DmxPanel` for the exact incantation — otherwise canvas pan/zoom eats scrolls inside CodeMirror.
- **Compilation happens on the main thread.** The compiled `frame` fn is stored on the node as a closure. No worker, no worklet — unlike `js~`, video rendering is already main-thread (Canvas2D needs to be).
- **Source resolution** — at `process()` time: if `setVfxInput` has set an upstream vFX, call `upstream.process()` first and use its `canvas` as source; else use `inputVideo` directly. Copy the pattern from `VfxCrtNode.process()` at lines 64–81.
- **Channel-mask blend correctness** — the user will eyeball this. Sweep each knob alone, confirm the fringe color matches (`r.x` → red fringe, `g.x` → green, `b.x` → blue). If the mapping is off, fix the bit→channel table, not the blend math.
- **The shared EEL2 tokenizer lift must not break `js~`.** Land it as a separate commit (or at least a separable chunk). Run through the `js~` Phase A smoke test after the refactor.

---

## Smoke test protocol (for the Director review)

1. Fresh page. Drop `mediaVideo` (any source — webcam is fine) → `reaperVideo` → `layer` on the canvas. Start the video source.
2. `reaperVideo` shows a two-pane expanded body: CodeMirror (empty) on the left, empty knob column on the right. The `layer` downstream shows the unprocessed video (passthrough while no code is compiled).
3. Paste the RGB decompose snippet from the top of this doc.
4. Within ~300ms: six knobs appear on the right, labeled "red x offset", "red y offset", "green x offset", "green y offset", "blue x offset", "blue y offset". All default to 0, range -100..100.
5. Video still shows correctly (when all knobs are 0, the snippet's `!gdf || !bdf` branch fires → single unmodified `gfx_blit(0)`).
6. Drag `r.x` to ~30. Red channel offsets 30px right. No tearing, no stutter, update is immediate.
7. Drag `g.y` to ~20. Green channel offsets 20px down, independent of the red offset.
8. Drag `b.x` to ~-30. Blue channel offsets 30px left.
9. With all six knobs at nonzero: three-way chromatic aberration visible, all channels additively composed.
10. Smoke `js~` separately — paste its Phase A gain snippet, confirm audio still works after the tokenizer lift.
11. Save patch. Reload. Code restored to CodeMirror. Knobs reset to defaults (expected — persistence is Phase B). Video renders again.
12. Paste bad code (e.g., `gfx_fillrect(0, 0,` — unterminated). Video holds at last good state. Doesn't cut out. Error state surfaces somewhere in the panel.

---

## Deliverable format

Append a COMPLETED entry to `AGENTS.md` using the template at the top of that file. Changed-files list (especially the tokenizer-lift files), architectural decisions (`gfx_mode` bit mapping you landed on, any deviations from this prompt), post-phase state, and next-needed for Phase B greenlight.
