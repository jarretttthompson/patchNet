# `js~` Object Plan — JSFX-in-the-Browser

**Status:** Planned (2026-04-23). Phase A prompt at `docs/phase-js-A-prompt.md`.

A patchNet object that executes REAPER-style JSFX code against live audio. User pastes code from a REAPER JS effect on the left of the object; sliders declared in that code populate a GUI on the right; audio flows `adc~ → js~ → dac~` with the DSP running in an AudioWorklet.

---

## The critical upfront fact

**REAPER JSFX is not JavaScript.** It's [EEL2](https://www.reaper.fm/sdk/js/js.php), a C-like interpreted DSL with its own parser, memory model (`mem[]`), and section structure (`@init`, `@slider`, `@sample`, `@block`, `@serialize`, `@gfx`). The `js` name is historical. Supporting "paste code from REAPER and hear it work" therefore means building an EEL2-subset parser + translator to JS, not eval-ing user input.

Decision: do it anyway. The payoff is a drop-in path to the enormous existing JSFX library (Liteon, Saike, stock ReaPlugs, the whole GitHub ecosystem). Any other choice forfeits that.

## Scope decisions (locked)

| Decision | Value | Why |
|----------|-------|-----|
| Object name | `js~` | patchNet convention: tilde suffix on all audio-rate objects |
| Channel config | Stereo 2 in / 2 out, always | Matches 95% of JSFX effects; variable channel counts deferred |
| Language | EEL2 subset (see below) | Full fidelity is multi-month; subset ships useful coverage |
| Runtime | AudioWorklet | Per-sample DSP at audio rate; matches `fft~` precedent |
| Code editor | CodeMirror | Already a dependency (used by codebox) |
| Render mode | New "expanded object" — code pane ‖ GUI pane | Inline, resizable, lives on canvas like any object |
| Serialization | `code` arg, base64-encoded | Matches codebox precedent |
| Fonts / colors | Vulf Mono + `--pn-*` tokens only | Design-language rules |

## EEL2 subset — v1 surface

**In:**
- Sections: `desc:`, `slider1:`…`sliderN:`, `@init`, `@slider`, `@sample`
- Slider syntax: `sliderN:default<min,max,step>label` (with step optional)
- Assignment + compound: `=`, `+=`, `-=`, `*=`, `/=`
- Expressions: `+ - * / %`, parentheses, comparison, `&&`, `||`, ternary `? :`
- Control flow: `if (cond) ( … ) else ( … );`, `while (cond) ( … );`, `loop(n, …);`
- Built-ins: `sin cos tan atan atan2 exp log log10 sqrt abs min max floor ceil pow sign`
- Special vars: `spl0`, `spl1` (R/W current-sample L/R), `srate` (read-only), `slider1`…`sliderN` (read-only inside `@sample`, mutable via GUI)

**Out (tabled for later phases or future updates):**
- `mem[]` / `gmem[]` buffers — v2
- User-defined functions (`function foo(x) (…)`) — v2
- `@block`, `@serialize` — v3
- `@gfx` section — probably never (use a separate `shaderToy`-style object)
- `num_ch`, `spl2`…`spl63` — deferred with channel-count work

## Architecture

```
┌── src/runtime/JsEffectNode.ts ────────────────────┐
│  owns: AudioWorkletNode + message port + compiled │
│  code + current slider values                     │
│  methods: setCode, setSlider, connect, destroy    │
└───────────┬───────────────────────────────────────┘
            │
┌───────────▼──── src/runtime/JsEffectGraph.ts ─────┐
│  Map<nodeId, JsEffectNode>, sync() on change,     │
│  rewireConnections — mirrors FftAnalyzerNode      │
│  pattern                                          │
└───────────┬───────────────────────────────────────┘
            │
┌───────────▼──── src/runtime/jsfx/parser.ts ───────┐
│  tokenize → split sections → slider decls →       │
│  per-section AST (expressions + statements)       │
└───────────┬───────────────────────────────────────┘
            │
┌───────────▼──── src/runtime/jsfx/translate.ts ────┐
│  EEL2 AST → JS source for three fns:              │
│    init()         — runs once at node creation    │
│    onSlider()     — runs on any slider change     │
│    process(L, R)  — runs per-sample               │
│  Closure over slider state + srate                │
└───────────┬───────────────────────────────────────┘
            │
┌───────────▼──── src/runtime/jsfx/jsfx-worklet.ts ─┐
│  AudioWorkletProcessor; receives compiled JS      │
│  string via postMessage; `new Function(…)` it     │
│  inside the worklet; per-frame loop calls         │
│  process(L, R) with scalar float32 samples        │
└────────────────────────────────────────────────────┘

┌── src/canvas/JsEffectPanel.ts ────────────────────┐
│  inline panel mounted by JsEffectPanelController  │
│  (DmxPanelController pattern)                     │
│                                                   │
│  [  code pane (CodeMirror)  ‖  slider GUI pane  ] │
│                                                   │
│  code pane: edit → debounce → parse → translate → │
│  postMessage to worklet; parse errors shown inline│
│  slider GUI: rendered from parsed slider decls;   │
│  each slider fires setSlider + triggers onSlider  │
└────────────────────────────────────────────────────┘
```

## Phase plan

### Phase A — Scaffolding + end-to-end passthrough + gain
**Goal:** paste a trivial JSFX (one slider, `spl0 *= slider1; spl1 *= slider1;`), hear gain control working.

- `js~` in `OBJECT_DEFS` (stereo in/out, hidden `code` arg, default width/height for the expanded body)
- Expanded-object rendering: two resizable panes (CodeMirror left, GUI placeholder right) — `JsEffectPanel` + `JsEffectPanelController` on the `DmxPanelController` pattern so state survives re-renders
- AudioWorklet scaffolding: loader in `VisualizerGraph`-adjacent spot, `JsEffectGraph` lifecycle manager on the `AudioGraph` pattern, wired into existing signal connection logic
- Minimal parser: split sections, parse slider declarations, extract `@sample` as raw text
- Minimal translator: expressions + compound assignment + `spl0`/`spl1` + `sliderN` reads. No control flow yet.
- Slider rendering: read parsed decls, render native `<input type="range">` elements styled with `--pn-*` tokens
- Passthrough fallback on parse error (don't kill the audio graph)

**Exit bar:** a ring mod / gain / bit-scale JSFX pasted verbatim from REAPER drives audible effect on `adc~ → js~ → dac~`.

### Phase B — Full EEL2 subset translator
**Goal:** the majority of simple-to-mid JSFX effects work unchanged.

- Control flow: `if/else`, `while`, `loop(n, …)`
- All built-in math functions
- `@init` section (runs once with worklet construction)
- `@slider` section (runs on any slider change — fires from GUI and from any future slider-inlet message path)
- Proper expression precedence + operator table match to EEL2
- Test corpus: 3–5 real JSFX effects from REAPER's stock bundle ported verbatim (saturator, tilt EQ, bitcrusher, ring mod, simple chorus)
- A `CLAUDE.md`-dev-friendly table in the code listing which EEL2 features translate and which don't

**Exit bar:** each effect in the test corpus sounds right compared to REAPER output on the same input (ear test — no null test required in v1).

### Phase C — GUI polish + error UX + save/load
**Goal:** production-feeling.

- Slider styling matched to patchNet's existing slider aesthetic
- Linear / log / enum slider types (EEL2 has `<min,max,step>` + `<min,max,step{A,B,C}>` enum form)
- Parse-error pane: line number + message inline under code pane; audio silences on error, resumes on fix
- Runtime exception trap in the worklet: if `process()` throws, clamp to passthrough and surface a runtime error
- `code` arg round-trips through patch save/load (base64)
- Reference doc `docs/objects/js~.md` + `docs/objects/INVENTORY.md` row
- `desc:` value drives the object's title-bar label

**Exit bar:** paste a broken JSFX → see error → fix typo → audio resumes. Reload the patch → code is preserved, audio is back.

### Phase D — Future / tabled
- `mem[]` buffer support (enables delays, reverbs, most time-domain effects — big)
- User-defined `function` declarations
- Variable channel counts via `[js~ 4]` creation arg
- `@block`, `@serialize`
- `@gfx` — probably not; use `shaderToy` instead
- Slider-index inlets: `slider N value` message to drive sliders from patch logic (may land earlier if asked)
- Preset/bank system (JSFX has none natively — patchNet-value-add if desired)

## Agent assignment

| Phase | Primary agent |
|-------|---------------|
| A | Claude Code (recent precedent: dmx/shaderToy/sequencer all done in-house) |
| B | Claude Code |
| C | Claude Code + Cursor collab for final CSS polish |
| D | TBD per user priority |

## Risks / open questions

- **Parser surface area.** EEL2 is small but quirky (semicolons-as-sequence, parens-as-blocks, no `var`). Budget explicit time in Phase A for parser work; it's the hardest piece.
- **Worklet code-update latency.** CodeMirror debounce → parse → translate → postMessage → `new Function` in worklet. Expect ~10–50ms on code change; fine for edit-test loop.
- **License posture.** JSFX code pasted by users is theirs; patchNet runs it locally in their browser. No server round-trip. No JSFX bundling by default — users bring their own.
- **Feature-creep risk on `mem[]`.** Skipping it in Phases A–C is the right call; with it, Phases A–C become Phases A–F. Get simple effects working first.

---

*Master plan. See `docs/phase-js-A-prompt.md` for the Phase A execution prompt.*
