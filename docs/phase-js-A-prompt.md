# Phase A — `js~` object: scaffolding + end-to-end passthrough

**Read first:** `CLAUDE.md`, `AGENTS.md` (Project State + Architecture Decisions), `DESIGN_LANGUAGE.md`, `docs/JS_OBJECT_PLAN.md`.

**Exit bar of this phase (single line test the user will run):**
Paste a minimal JSFX into a `js~` object placed between `adc~` and `dac~`, move the slider, hear the effect.

The minimal JSFX to target is equivalent to:
```
desc:trivial gain
slider1:1<0,2,0.01>gain

@sample
spl0 *= slider1;
spl1 *= slider1;
```

If that works, Phase A is done. Control flow, `@init`, `@slider`, built-in math, error UX, and the rest of the EEL2 subset are Phases B–C.

---

## Scope — do in this phase

### 1. Object definition
- Add `js~` to `OBJECT_DEFS` in `src/graph/objectDefs.ts`.
- Category: `scripting` (matches codebox).
- Args:
  - `code` — symbol, hidden, base64-encoded source. Default: empty.
- Inlets: 2 × `signal` (L, R).
- Outlets: 2 × `signal` (L, R).
- `defaultWidth` / `defaultHeight`: pick to match the DmxPanel precedent (~560×280 — panel is wider than tall; user will resize).
- Messages: nothing in this phase (slider-via-message is Phase C+).

### 2. Runtime — AudioWorklet backbone
- New file `src/runtime/jsfx/jsfx-worklet.ts` — AudioWorkletProcessor.
  - Receives `{ type: "code", js: string }` via `port.onmessage`; compiles with `new Function("L", "R", "sliders", "state", jsSource)` and stores.
  - Receives `{ type: "slider", index: number, value: number }`; updates a `Float32Array` of 64 slider slots.
  - Per-sample: runs compiled fn over `inputs[0][0]` + `inputs[0][1]`, writes to `outputs[0][0]` + `outputs[0][1]`. If fn is null or throws → passthrough (copy in→out). Never kill the graph.
- New file `src/runtime/JsEffectNode.ts` — mirrors `FftAnalyzerNode.ts` shape.
  - Constructs the `AudioWorkletNode` with `channelCount: 2, channelCountMode: "explicit", channelInterpretation: "discrete"`, `numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]`.
  - `setCode(jsSource: string)` — `postMessage({type:"code", js:jsSource})`.
  - `setSlider(index: number, value: number)` — posts slider update.
  - Exposes `input: AudioNode` and `output: AudioNode` for wiring.
  - `destroy()` — disconnect + clear message handlers.
- New file `src/runtime/JsEffectGraph.ts` — mirrors `AudioGraph.ts` conventions.
  - `Map<nodeId, JsEffectNode>`, `sync()` on `graph.on("change")`, create/destroy diff.
  - `rewireConnections(allGraphs)` integrated into the existing audio signal wiring (see how `FftAnalyzerNode` and `DacNode` are wired — `js~` is both sink and source).
- Hook into `src/main.ts` where other audio graphs are instantiated.

### 3. Parser — minimal subset
- New file `src/runtime/jsfx/parser.ts`.
- Parse:
  - `desc: <text>` — extract title string.
  - `sliderN: default<min,max,step>label` — extract slider index, default, min, max, step (optional), label.
  - Sections `@init`, `@slider`, `@sample` — extract raw body text. In Phase A only `@sample` body is compiled; `@init` / `@slider` bodies can be parsed but ignored (Phase B).
- Output a typed `JsfxProgram` struct: `{ desc, sliders: SliderDecl[], initBody, sliderBody, sampleBody }`.
- Return `{ ok: false, error: {line, message} }` on any malformed slider line — don't throw.

### 4. Translator — minimal subset
- New file `src/runtime/jsfx/translate.ts`.
- In scope for Phase A:
  - Identifiers: `spl0`, `spl1` → `L`/`R` variables (read-write, returned at end of body).
  - `sliderN` → `sliders[N-1]`.
  - Assignment `=`, compound `+= -= *= /=`.
  - Expressions: literals, identifiers, `+ - * / %`, parentheses, unary minus.
  - Statement separator `;`.
  - Anything else → translator returns an error; panel shows "unsupported in Phase A: ..." (user will know to simplify or wait for Phase B).
- Output: a JS source string for the body of the per-sample fn. The worklet wraps it with `function(L, R, sliders, state) { <body>; return [L, R]; }`.

### 5. Canvas — expanded object body
- New file `src/canvas/JsEffectPanel.ts` — inline panel, NOT a popup. Follow `DmxPanel.ts` exactly:
  - `buildRoot()` returns the root div; `attach(host)`, `detach()`, `destroy()`.
  - Layout: flexbox two-pane. Left pane = CodeMirror editor. Right pane = slider GUI column (empty placeholder OK in Phase A if at least one slider renders; ship one slider working).
  - Code edit: debounce 300ms → call parser → call translator → post to worklet. Parser/translator errors: stash for display but keep the previous good compile live (don't cut audio).
  - Slider change: call `node.setSlider(i, value)` immediately (no debounce).
- New file `src/canvas/JsEffectPanelController.ts` — mirrors `DmxPanelController.ts`:
  - `Map<nodeId, JsEffectPanel>`.
  - `mount(panGroup)` walks `js~` nodes, ensures panel per node, attaches into `[data-jseffect-panel-host]` slot emitted by ObjectRenderer.
  - `prune(activeIds)` destroys panels whose nodes are gone.
- `ObjectRenderer` — `js~` branch: emit a single `pn-jseffect-panel-host` div with `data-jseffect-panel-host=<nodeId>`.
- `DragController` — add `.pn-jseffect-panel-host` to the drag allowlist (same as `.pn-dmx-panel-host`).
- `main.ts` — instantiate `JsEffectPanelController`, call `mount`/`prune` in render loop, `destroy` on unload.

### 6. CSS
- All styling via `--pn-*` tokens. No hex. No hardcoded colors. Vulf Mono for code pane, Vulf Sans for labels.
- Add panel-host styles in `src/shell.css` mirroring the dmx panel-host block.

### 7. Persistence
- On code edit → debounced save: base64-encode source → write to `args[0]` (`code`) → emit `change` (same pattern as codebox).
- On graph re-render: `JsEffectPanel` reads `args[0]`, base64-decodes, pushes into CodeMirror, triggers compile.

### 8. Build cleanliness
- `tsc --noEmit` clean.
- `npm run build` clean. Bundle impact ≤ ~40 KB.

---

## Out of scope for this phase — do NOT do

- `@init` / `@slider` sections actually running (parse only — execute is Phase B)
- Control flow (`if`, `while`, `loop`)
- Built-in math (`sin`, `cos`, …)
- `mem[]` / buffers
- User-defined `function`
- Multi-channel (stay stereo)
- Slider-via-message inlet (Phase C+)
- `desc:` driving the object's on-canvas title (nice-to-have, not required)
- Error surfacing UI beyond "panel shows a one-liner somewhere" (Phase C does the real error pane)

If any of those are tempting, stop and check with the Director.

---

## Architecture notes — read before coding

- **AudioWorklet registration.** The project should already have one somewhere (check `fft~` — `FftAnalyzerNode`). Register `jsfx-worklet.ts` via the same mechanism. Do NOT create a second `AudioContext`.
- **Panel lifecycle.** patchNet's render() nukes `.patch-object` DOM on every `change`. The controller-map pattern in `DmxPanelController`/`CodeboxController` is the only way to keep CodeMirror state + slider values alive across re-renders. Do not try to build the panel inline in `ObjectRenderer`.
- **Wheel + mousedown stopPropagation** on the panel root — otherwise scrolling inside CodeMirror pans the canvas. See `DmxPanel` for the exact incantation.
- **Slider values are worklet-side truth.** The panel sends values to the worklet; worklet is authoritative during `process()`. Panel caches for re-render only.
- **Compilation happens on the main thread**, not inside the worklet. Panel parses + translates, posts the JS string to the worklet, worklet calls `new Function(...)` once on receipt. This keeps parse errors on the main thread where the UI can see them.

---

## Smoke test protocol (for the Director review)

1. Fresh page. Drop `adc~` → `js~` → `dac~` on the canvas.
2. `js~` shows a two-pane expanded body: CodeMirror (empty) on the left, empty slider column on the right.
3. Paste:
   ```
   desc:trivial gain
   slider1:1<0,2,0.01>gain

   @sample
   spl0 *= slider1;
   spl1 *= slider1;
   ```
4. Within ~300ms: a slider appears on the right labeled "gain", range 0–2, default 1.
5. Start `adc~` and `dac~`. Audio passes through at unity.
6. Drag the slider. Gain changes audibly from silent (0) to 2× (doubled).
7. Save patch. Reload page. Code and slider value are restored. Audio works again.
8. Paste bad code (e.g., `spl0 ~= 3`). Audio stays at last good state (does NOT cut out). Error state somewhere in the panel — doesn't need to be pretty.

---

## Deliverable format

Append a COMPLETED entry to `AGENTS.md` using the template at the top of that file. Changed-files list, architectural decisions, post-phase state, and next-needed for Phase B greenlight.
