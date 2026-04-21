# patchNet — Agent Communication & Changelog

This file is the shared communication channel for all agents working on patchNet.
**All agents must read this before starting work and append an entry after completing work.**

Director: Claude Code
Second in Command: Cursor
Team: Cursor (canvas/UI), Codex (audio/runtime), Copilot (inline acceleration)

---

## How to Use This File

### Before starting any task:
1. Read all entries below to understand current project state
2. Check what phase is active in `PLAN.md`
3. Note any BLOCKER entries that affect your work

### After completing any task, append an entry in this format:

```
---
## [YYYY-MM-DD] COMPLETED | <task name>
**Agent:** Cursor | Codex | Claude Code | Copilot
**Phase:** Phase N — <phase name>
**Done:**
- bullet list of what was completed

**Changed files:**
- path/to/file.ts — what changed

**Notes / decisions made:**
- any architectural decisions or deviations from PLAN.md

**Next needed:**
- what the next agent or task needs to do
---
```

### When blocked, append a BLOCKER entry:

```
---
## [YYYY-MM-DD] BLOCKER | <description>
**Agent:** <who is blocked>
**Blocking:** <what task is stopped>
**Details:** <what the problem is>
**Needs:** <what is required to unblock>
---
```

---

## Project State

**Current Phase:** Control/Render Split Phase 1 landed + Evaluation Plan Parts 1, 2, 4 still in flight
**Active tasks:** Control/Render Split Phase 1 scaffolding landed (see `docs/CONTROL_RENDER_SPLIT.md`); `deliverPatchVizMessage` migrated to bus as proof path. Phase 2 gated on test infra (resolves BLOCKER-1). Evaluation Plan: Part 1.1/1.2/1.3/1.5 landed; Part 1.4 deferred (BLOCKER-2); Part 2.1 landed; Part 4 recipe + 3 of 21 ref pages landed. Persistence refactor landed earlier.
**Last updated:** 2026-04-19 by Claude Code

---

## Architecture Decisions Log

Agents: append here when making a decision that affects the whole project.

### 2026-04-16 — Claude Code
- **Cable rendering:** Straight SVG lines (not bezier). PD-style. This is non-negotiable per product spec.
- **No React in v1:** Vanilla DOM + TypeScript only. Canvas interaction requires direct DOM control; a vdom layer adds friction. Revisit after v1 if needed.
- **Audio in v1 is not sample-accurate:** `metro` uses `setInterval`, not the Web Audio clock. Good enough for v1 UX. Phase 3+ can upgrade to `AudioWorklet`-based scheduling.
- **Serialization format:** PD-inspired `#X obj x y type [args...]` lines. Human-readable, not JSON. Lets the text panel feel like real code.
- **Object size defaults:** See `DESIGN_LANGUAGE.md`. Objects are fixed-size rectangles in v1; resizable objects are a future feature.
- **No framework for text panel in v1:** Plain `<textarea>` with CSS styling. CodeMirror or Monaco is a Phase 4+ upgrade.

---

## Changelog

---
## [2026-04-21] COMPLETED | shaderToy object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new visual-category fragment-shader source
**Done:**
- Added `shaderToy` to `OBJECT_DEFS` (`src/graph/objectDefs.ts`). Visual-category. Args: `preset` (symbol default "default"), `code` (symbol, hidden — base64-encoded GLSL), `width`/`height` (int, default 512×512), `mouseX`/`mouseY` (hidden floats, default 0.5). Single `any` inlet; one `media` outlet → `layer`.
- New runtime node: `src/runtime/ShaderToyNode.ts`. WebGL2 renderer wrapping an offscreen `<canvas>`; implements the existing `VideoFXSource` interface (same SPI as `VfxCrtNode`/`VfxBlurNode`) so `LayerNode.setVideoFX(...)` picks it up with zero changes to LayerNode. Exposes the ShaderToy-compatible uniform subset: `iResolution` (vec3), `iTime`, `iTimeDelta`, `iFrame`, `iMouse` (vec4), `iDate` (vec4). User source is expected to define `void mainImage(out vec4 fragColor, in vec2 fragCoord)`; the prelude + a trivial `main()` are added automatically.
- Four built-in presets live in `SHADERTOY_PRESETS` (default rainbow gradient, plasma, warp, grid) so the object shows visible output immediately on placement.
- Messages (hot inlet 0): `preset <name>` (switches built-in, clears inline code), `code <base64>` (sets fragment source from base64), `glsl <rest-of-line>` (convenience path for hand-typed GLSL — re-encoded to base64 for persistence), `mouse <x> <y>` (normalized 0–1), `size <w> <h>` (resize render surface), `reset` / `bang` (reset `iTime`).
- `VisualizerGraph` wiring:
  - New `shaderToyNodes: Map<string, ShaderToyNode>` alongside the existing runtime-node maps; created in `sync()`, torn down when the patch node is removed, cleared in `destroy()`.
  - `rewireMedia()` gains a `fromNode.type === "shaderToy"` branch that calls `layer.setVideoFX(stn)` — same slot the vFX chain uses, so a layer holds either a shader OR a video/image (not both), matching the existing "swap by re-cabling" UX.
  - Mutable-state sync pass reads `width`/`height` into `setResolution()` every graph change and pushes `mouseX`/`mouseY` into the shader uniform. Preset changes propagate automatically: `syncAttributeNode`-style param edits go through the generic `trySetArgByName` path, but a preset change via attribute panel also triggers a re-compile because the sync pass detects `stn.getSource() !== SHADERTOY_PRESETS[preset]`.
  - `deliverShaderToyMessage(nodeId, selector, args)`: preset/code/glsl/mouse/size/reset handlers; mouse emits `"display"` (no text-panel flood), structural edits emit `"change"`.
  - Helpers: `applyShaderToySource()` restores shader on create (base64 code wins over preset; falls back to preset if code fails to compile) and `applyShaderToyMouseFromArgs()` seeds iMouse.
- `ObjectInteractionController`:
  - `deliverBang` branch for `shaderToy` → `deliverShaderToyMessage(..., "reset")`.
  - `deliverMessageValue` branch parses the incoming string; `glsl <rest-of-line>` is handled specially (preserves spaces/symbols inside the GLSL body by not splitting further); all other selectors go through the standard token-split path.
- `ObjectRenderer` adds a `shaderToy` branch with a `patch-object-visual-label` title + sub (preset-or-"custom" and resolution). No new CSS; re-uses the classes already used by visualizer/mediaVideo/layer.
- Reference docs: `docs/objects/shaderToy.md` written from `_TEMPLATE.md`; `docs/objects/INVENTORY.md` row added.
- `tsc --noEmit` passes. `npm run build` clean (586 KB bundle, up ~12 KB for the shader runtime + presets + docs).

**Changed files:**
- src/runtime/ShaderToyNode.ts — new
- src/graph/objectDefs.ts — shaderToy ObjectSpec
- src/runtime/VisualizerGraph.ts — create/destroy, rewireMedia branch, deliverShaderToyMessage, helpers
- src/canvas/ObjectInteractionController.ts — deliverBang + deliverMessageValue branches (incl. glsl rest-of-line carve-out)
- src/canvas/ObjectRenderer.ts — shaderToy body branch (visual-label + sub)
- docs/objects/shaderToy.md — new reference page
- docs/objects/INVENTORY.md — new row
- AGENTS.md — this entry

**Notes / decisions made:**
- Chose to implement shaderToy as a *media source* that produces a canvas, rather than as a layer itself, so it composes with the existing `shaderToy → layer → (visualizer | patchViz)` graph shape the user already knows. That also means the existing layer arg surface (scaleX/scaleY/posX/posY/priority/context) applies to shader output for free.
- Reused `VideoFXSource` (`LayerNode.setVideoFX`) rather than inventing a new slot. Trade-off: a layer can hold shader **or** video/image but not both — acceptable in v1 and matches the existing vFX-chain behavior.
- WebGL2 (not WebGL1). Broadly supported in modern browsers and gives us `out` fragment color + `precision highp int` for ShaderToy compatibility without polyfill gymnastics.
- Base64 code storage in `args[1]` for the same reason codebox does it: raw GLSL has newlines, braces, and quotes that would break the PD-style space-delimited line format. `glsl <rest-of-line>` exists as the "type it by hand" convenience, but persists as base64 — round-trip safe.
- **ShaderToy URL/ID fetching is intentionally NOT implemented.** The official ShaderToy API requires a per-user API key (`https://www.shadertoy.com/api/v1/shaders/<id>?key=<key>`), and CORS support on arbitrary proxy endpoints is not universal. Adding a best-effort fetch would make patches non-deterministic and bind them to network state. Instead, users paste fragment source directly via `glsl` or `code` — documented in the reference page's Notes section.
- Multi-pass / `iChannel*` texture inputs are out of scope for v1; noted in the reference page.
- Compile failures don't unbind the previous good shader — user sees the console warning and keeps rendering. Matches the fault-tolerance expectations of codebox.
- No new CSS. Reused `patch-object-visual-label` / `patch-object-visual-sub` from the existing visualizer/mediaVideo/layer branches — consistent with the rest of the visual-category objects.
- Registration is the single `OBJECT_DEFS` entry per the codified feedback memory ("one registration point only"): autocomplete and context menu derive from `Object.keys(OBJECT_DEFS)`.

**Next needed:**
- Browser smoke test:
  - Place `shaderToy → layer → patchViz`, confirm the default rainbow renders inside the patch canvas.
  - Swap `patchViz` for `visualizer` (popup), bang to open, confirm the same shader renders in the popup.
  - `message preset plasma` → shaderToy: preset switches live.
  - `message glsl void mainImage(out vec4 c,in vec2 p){c=vec4(fract(p/iResolution.xy),0,1);}` → shaderToy: compiles and runs.
  - Two sliders → `message mouse $1 $2` → shaderToy: iMouse moves (visible in any preset that uses it — e.g., feed `iMouse.x/iResolution.x` into a shader as the warp amount).
  - Round-trip: clear text panel → paste contents → shader restores with same preset/code.
- Follow-up candidates (out of scope here): add `iChannel0` input slot (shader-as-post-processor over a mediaVideo); expose compile-error state in the node DOM; add more presets; consider a small live thumbnail of the shader on the patch-object body.

---
## [2026-04-20] COMPLETED | sequencer object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new control-category step sequencer
**Done:**
- Added `sequencer` to `OBJECT_DEFS` (`src/graph/objectDefs.ts`). Control-category. Args: `rows` (int 1–32, default 4), `cols` (int 1–64, default 8), `playhead` (hidden int), `cells` (hidden base64 JSON matrix), `locked` (hidden int 0/1, default 1). Single bang inlet; one `any` outlet per row (derived).
- Port derivation: `deriveSequencerPorts(args)` rebuilds outlets from the row arg. Called from `PatchGraph.addNode`, `parse.ts`, and inline at every arg-mutation site (`beginArgEdit` for type swaps and same-type edits, `trySetArgByName` when `rows`/`cols` change via the attribute panel).
- Ensure-args helper (`ensureSequencerArgs`) backfills any sparse arg slots with defaults before serialization — prevents `"undefined"` tokens from leaking into the text panel when args[4] is set while earlier slots remain empty. Base64 default for `cells` is `"W10="` (`btoa("[]")`) so args[3] is never the empty string (which would collapse under parse's `split(/\s+/)`).
- Cell storage + helpers: `getSequencerCells(node)` returns a rows×cols string matrix, padding missing slots with `""`; `setSequencerCells(node, cells)` writes back as base64 JSON to `args[3]`.
- Renderer (`ObjectRenderer.ts`): `sequencer` branch builds a CSS-grid of `.pn-seq-cell` divs, marking the active column with `pn-seq-cell--active`. Each cell is `contenteditable` iff unlocked. A lock button (shares the `pn-subpatch-lock` class so the existing DragController exclusion covers it) sits at the top-right to stay clear of the resize handle.
- Interaction (`ObjectInteractionController.ts`):
  - `advanceSequencer(node)`: wraps playhead via `(prev + 1) % cols`, dispatches each row's active-column value. Empty cells skip; literal `"bang"` dispatches a bang; everything else dispatches as a value. DOM is patched in place (no full re-render at bang cadence); emits `"display"` to keep the text panel in sync without re-rendering.
  - Lock-button handler in `handleClick` mirrors subPatch's toggle for `args[4]`.
  - Cell-edit events: new `focusout` + `keydown` listeners on `panGroup` (and mirrored on external panels so subPatch presentations also work). Enter commits via blur; Escape reverts. Commit writes back via `setSequencerCells` and emits `"change"`.
  - `syncSequencerPorts(node)` rebuilds outlets and drops orphan edges via direct `graph.edges.delete` (no `removeEdge` re-emit) so it is safe to call during `attrDragging`.
  - `deliverMessageValue` branch for `sequencer`: treats any non-selector value on inlet 0 as a bang-equivalent advance (selector-form messages like `rows 6` fall through to `trySetArgByName` → `syncSequencerPorts`).
- `DragController.ts`: `pn-seq-cell` added to the click-through allowlist so caret placement / text selection inside a cell doesn't start a reposition drag.
- `tsc --noEmit` passes. `npm run build` clean (574 KB bundle, same order as before).

**Changed files:**
- src/graph/objectDefs.ts — sequencer ObjectSpec + derivation/ensure/cells helpers
- src/graph/PatchGraph.ts — addNode sequencer branch
- src/serializer/parse.ts — sequencer parse branch (ensure args + derive ports)
- src/canvas/ObjectRenderer.ts — sequencer body branch + shared `LOCK_ICON_SVG`
- src/canvas/ObjectInteractionController.ts — bang/value delivery, lock toggle, cell commit, port sync, focusout/keydown wiring
- src/canvas/DragController.ts — pn-seq-cell drag exclusion
- src/shell.css — sequencer grid / cell / playhead / lock-button styles
- AGENTS.md — this entry

**Notes / decisions made:**
- Chose a single bang inlet (not one per row) per Max `coll`/`counter`/`matrixctrl` convention: upstream rhythm is authored once, outputs fan out per row.
- Cells serialize as base64 JSON inside `args[3]`. Reasoning: raw JSON would break the PD-style space-delimited line format (quotes, commas, spaces); base64 is already the codebox/subPatch precedent.
- Row/col changes truncate the visible cell matrix but do not destroy stored cell data — `getSequencerCells` reads whatever is stored and pads. That means shrinking → growing preserves cell content, matching Max's behavior.
- Playhead advance emits `"display"` (not `"change"`): text panel stays in sync, but re-render is skipped so the grid DOM, cables, and any actively-focused cell survive bang cadence. Advance patches the `--active` class in place.
- Lock button uses the same class as subPatch (`pn-subpatch-lock`) with a second class for positioning. Shares the existing SVG icon + styles + DragController exclusion with zero new surface area.

**Next needed:**
- Browser smoke test: place `sequencer`, unlock, type values into cells (Enter commits, Escape reverts), lock, wire `metro → sequencer`, wire each outlet into `float` boxes, start metro → confirm playhead walks and each row's active cell fires out its outlet. Verify round-trip: copy text panel → clear → paste → same grid + outlet count.
- Attribute panel check: connect `attribute → sequencer`, drag `rows` slider from 4 → 6 → 2, confirm outlet count tracks and that cables attached to now-gone rows are auto-cleaned.
- Follow-up (out of scope here): `docs/objects/sequencer.md` reference page + `INVENTORY.md` row.

---
## [2026-04-19] COMPLETED | oscillateNumbers object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new control-category object
**Done:**
- Added `oscillateNumbers` to `OBJECT_DEFS` (`src/graph/objectDefs.ts`). Control-category. Args: `freq` (0.01–20 Hz, default 1), `running` (hidden). Hot inlet 0 accepts `1/0/bang/freq <hz>`; cold inlet 1 is a dedicated float-Hz inlet. Outlet 0 emits a float in `[0.0, 1.0]`.
- Wired RAF-driven oscillator machinery into `ObjectInteractionController`:
  - `oscTimers: Map<nodeId, { rafId, startT }>` field alongside `metroTimers`.
  - Graph-change hook gained `pruneOscTimers` + `restoreOscTimers` so running state survives text-panel diff-based deserialize (same pattern as metro's `running` arg).
  - `deliverBang` and `deliverMessageValue` branches added for `oscillateNumbers`; `freq <hz>` selector and bare float gate both supported on inlet 0, dedicated float-Hz on inlet 1.
  - `destroy()` cancels any in-flight RAFs.
- Output formula: `0.5 + 0.5 * sin(2π * freq * t)` where `t` is seconds since last start. Emitted every animation frame via `dispatchValue(node.id, 0, v.toFixed(4))`.
- Reference page `docs/objects/oscillateNumbers.md` authored from `_TEMPLATE.md` (frontmatter + all six required sections + canonical `toggle → oscillateNumbers → float` example). `docs/objects/INVENTORY.md` row added.
- `npx tsc --noEmit` passes. `npm run build` clean (560 KB bundle; same order of magnitude as pre-change).

**Changed files:**
- src/graph/objectDefs.ts — OBJECT_DEFS.oscillateNumbers added
- src/canvas/ObjectInteractionController.ts — oscTimers field, graph-change + destroy hooks, deliverBang/deliverMessageValue branches, startOsc/stopOsc/isOscRunning/pruneOscTimers/restoreOscTimers/deliverOscValue private methods
- docs/objects/oscillateNumbers.md — new reference page
- docs/objects/INVENTORY.md — new row
- docs/phase-oscillateNumbers-prompt.md — implementation prompt (written by Director before execution)
- AGENTS.md — this entry

**Notes / decisions made:**
- Chose option (A) from planning: `freq` = cycle Hz (oscillation frequency), output rate decoupled via RAF. Rejected option (B) (slider = update-rate with fixed-phase step) because it produces visibly choppy output at low speeds and doesn't match Max/MSP LFO idioms.
- Gate semantics mirror `metro` exactly — float 1/0 start/stop, bang toggles, hidden `running` arg persists. No upstream-type introspection; a toggle connected into inlet 0 is the idiomatic enable path but any float source works (slider, r, message, codebox, etc.).
- Emits values formatted to 4 decimal places. Enough precision for control-rate use (0.0001 resolution on a 0–1 sweep); keeps text-panel / message-box output readable if a user inspects the stream.
- Phase resets on (re)start including frequency changes via inlet 1. Documented explicitly in the reference page Notes section — users who need phase-continuous freq changes can add a downstream smoother.
- No runtime node (control-rate floats, not audio signal / media frames). No `AudioGraph` / `VisualizerGraph` registration. No renderer branch (default text-label fallthrough handles it; `defaultWidth: 160` fits the `oscillateNumbers` label). No new CSS.
- Registration is the single `OBJECT_DEFS` entry — autocomplete (`ObjectEntryBox.ts:18`) and context menu (`CanvasController.ts:11`) derive from `Object.keys(OBJECT_DEFS)` automatically, so no allowlist edits were needed. (The `docs/OBJECT_RECIPE.md` step 2 describing a separate `VALID_TYPES` list is stale relative to the current code.)

**Next needed:**
- Browser smoke test: `toggle → oscillateNumbers → float` + `slider → oscillateNumbers inlet 1`; confirm flip-on begins smooth 0↔1 sweep, slider changes cycle speed live, flip-off halts emission (last value lingers on the float box — expected), reload restores running state.
- Round-trip: copy text-panel contents, clear patch, paste text back → oscillator re-materializes with the same freq + running state.
- Follow-up worth filing if recurring: `docs/OBJECT_RECIPE.md` step 2 ("Add to VALID_TYPES") is obsolete; recipe should be updated to reflect that `OBJECT_DEFS` is the single registration point.

---
## [2026-04-19] COMPLETED | Control/render split — plan authored + Phase 1 scaffold landed
**Agent:** Claude Code
**Phase:** Control/Render Split — Phase 1 (Control surface extraction)
**Done:**
- Authored the full architecture plan at `docs/CONTROL_RENDER_SPLIT.md` (7 sections: exec summary, architecture, object redesign, protocols, perf analysis, phased roadmap, final recommendations). Firm recommendations — v1 stays browser-based in-process; the real win is a clean control-plane abstraction, not process isolation. Popup → BroadcastChannel is v2; WebSocket is v3. No OSC in core; no frame streaming.
- Mirrored decisions to the vault: `patchNet-Vault/wiki/concepts/control-render-split.md` + sibling pages for `visualizer-object.md` and `patchviz-object.md`. Index + log updated.
- Phase 1 scaffolding landed in a new `src/control/` module:
  - `ControlMessage.ts` — discriminated union for `SceneAdd`/`SceneRemove`/`SceneWire`/`ParamUpdate`/`Command`/`Trigger`/`Tick`/`ScenePreset` downstream + `Status`/`Telemetry`/`Error`/`Heartbeat` upstream. Versioned envelope shape for future BroadcastChannel / WebSocket transports.
  - `IRenderer.ts` — extends `IRenderContext` with `apply(msg)` + optional `onUpstream` hook. Pluggable SPI.
  - `ControlBus.ts` — `IControlBus` interface + `LocalBus` direct-dispatch impl. Renderer keyed by opaque `rendererId` (Phase 1 uses `patchNodeId`; Phase 4 may switch to `contextName` once shared-context routing is unified).
  - `RenderDirector.ts` — owns the bus, exposes `command` / `param` / `trigger` primitives. Upstream handler is a stub reserved for Phase 2 args-mirroring migration.
- Renderers implement `IRenderer` as forwarders:
  - `VisualizerNode.apply()` handles `Command { close | size | move | setFloat | fullscreen }`. The `bang`/`open` flows that depend on `openAndRestore()` (which reads patch-side args) remain on the old direct call path; that moves in Phase 2.
  - `PatchVizNode.apply()` handles `Command { enable | disable | toggle }` + `Trigger { bang }`.
- `VisualizerGraph` constructs its own `LocalBus` + `RenderDirector`. Renderers attach on create (`sync()` in all five create sites) and detach on destroy. `destroy()` tears both down.
- Proof-of-concept path migrated: `deliverPatchVizMessage` now routes the renderer touch through `director.trigger` / `director.command` → `bus.publishDown` → `PatchVizNode.apply`. Args mirroring stays controller-side in Phase 1; Phase 2 moves it onto upstream `Status`.

**Changed files:**
- docs/CONTROL_RENDER_SPLIT.md — new
- patchNet-Vault/wiki/concepts/control-render-split.md — new
- patchNet-Vault/wiki/concepts/visualizer-object.md — new
- patchNet-Vault/wiki/concepts/patchviz-object.md — new
- patchNet-Vault/wiki/index.md — bumped date + 3 new concept links
- patchNet-Vault/wiki/log.md — new entry
- src/control/ControlMessage.ts — new
- src/control/IRenderer.ts — new
- src/control/ControlBus.ts — new
- src/control/RenderDirector.ts — new
- src/runtime/VisualizerNode.ts — implements IRenderer (forwarder `apply`)
- src/runtime/PatchVizNode.ts — implements IRenderer (forwarder `apply`)
- src/runtime/VisualizerGraph.ts — owns bus+director; attach/detach on renderer lifecycle; `deliverPatchVizMessage` routes via director

**Notes / decisions made:**
- `rendererId` is intentionally opaque to the bus — caller picks the namespace. Phase 1 uses `patchNodeId` because multiple renderers can share a `contextName` (popup + inline both `world1`). Unifying to `contextName`-as-key is a Phase 4 concern.
- Conservative migration: only `deliverPatchVizMessage` went through the bus. `deliverMessage` / `deliverMediaMessage` / `deliverVfxMessage` / `deliverLayerMessage` / `deliverImageFXMessage` all remain on the pre-refactor direct-call path until Phase 2, which will add test infra first (resolves BLOCKER-1).
- The `openAndRestore` flow stays on the direct path — it reads patch-side args mid-open, which is a controller concern that Phase 2 will either inline into the Command or compute upstream before emitting.
- `IRenderContext` is unchanged. `IRenderer` extends it. Existing `VisualizerRuntime` singleton lookups still work; they will be ripped in Phase 4 after contextName-vs-rendererId unification.
- `tsc --noEmit` passes. `npm run build` clean (558 KB bundle, same order of magnitude as before).
- No automated tests — Phase 2 will add vitest + a mock `IRenderer` harness for `RenderDirector` before migrating any other delivery methods.

**Next needed:**
- Browser smoke test: open a `patchViz` object, bang it / toggle enable/disable from a message box, confirm canvas still enables/disables. The other five `deliverXxx` paths are unchanged — visualizer popup, media, vfx, layer, imageFX should behave exactly as before.
- Phase 2 greenlight: add vitest + `tests/control/RenderDirector.test.ts` round-trip test, then migrate `deliverMessage` (the largest remaining surface) through the bus with status-driven arg mirroring.

---
## [2026-04-17] COMPLETED | Evaluation Plan — Part 1 audit (partial)
**Agent:** Claude Code
**Phase:** Evaluation Plan — Part 1 (Project Evaluation)
**Done:**
- Added `knip` as devDependency and ran against `tsconfig.json`; findings captured in `docs/AUDIT.md` §1.1
- Cataloged all 21 object types with renderer/runtime/doc coverage → `docs/objects/INVENTORY.md`
- CSS/token audit: 6 hex violations in `shell.css`, 44 `!important` (mostly load-bearing cursor-system), 96 `rgba()` literals (mostly accent-green glow variants) → `docs/AUDIT.md` §1.5
- Filed 4 BLOCKERs (see below) for items too big to fix inline

**Deferred (in this session):**
- Part 1.3 Controller responsibility map — requires full read of 9 controllers; captured as BLOCKER-3
- Part 1.4 Runtime graph audit — requires instrumentation + browser profiling; captured as BLOCKER-2

**Changed files:**
- package.json / package-lock.json — added knip devDependency
- docs/AUDIT.md — created (Part 1 synthesis doc)
- docs/objects/INVENTORY.md — created (21-row coverage table)
- AGENTS.md — this entry + BLOCKERs + project state header

**Notes / decisions made:**
- `OBJECT_DEFS` and `VALID_TYPES` are in perfect sync today (21/21). Part 4.3 CI lint still recommended to keep them that way.
- No test infrastructure anywhere — raised as BLOCKER-1 because it gates confident dead-code removal.
- `scale`, `vfxCRT`, `vfxBlur` intentionally fall through to default text-label rendering; not a bug.

**Next needed:**
- BLOCKER-3 resolution (controller map) is the most valuable single next step — unblocks Part 2.3 duplicate-helper consolidation.
- Part 4 (OBJECT_RECIPE + reference-page template) can start in parallel; doesn't depend on 1.3 or 1.4.

---

## [2026-04-17] BLOCKER | No test infrastructure
**Agent:** Director (filed on behalf of Part 2 work)
**Blocking:** Dead-code deletions in Part 2 have no regression safety net beyond manual smoke tests.
**Details:** No vitest/jest config, no `*.test.ts`, no `tests/` dir anywhere in repo.
**Needs:** Decision on vitest (likely — matches Vite) + one serialize→parse round-trip test per object type as starting bar.
---

## [2026-04-17] BLOCKER | Runtime graph rewire behavior unmeasured
**Agent:** Director (filed on behalf of Codex / Part 3 work)
**Blocking:** Part 3 efficiency work cannot start without numbers.
**Details:** `VisualizerGraph` and `AudioGraph` both re-walk upstream topology on every edit. Cost is unknown; whether non-topology edits (drag, arg change) trigger rewire is unknown.
**Needs:** Add counter in `rewireMedia()`, run against a scripted 20-node patch, record results in `docs/AUDIT.md` §1.4. Delete counter after.
---

## [2026-04-17] RESOLVED | BLOCKER-3 — Controller precedence chain documented
**Agent:** Claude Code
**Resolves:** BLOCKER-3 (filed earlier same day).
**Done:**
- Read all 9 controllers in `src/canvas/`; map filed as `docs/AUDIT.md` §1.3.
- Corrected the hypothesis: `CanvasController`'s mousedown binds on the outer `canvasArea`, not `panGroup`. The panGroup mousedown chain is: `ObjectInteractionController` → `DragController` → `CableDrawController` → `ResizeController` (in registration order); `CanvasController` only fires on bubble-up.
- No priority bug found. Minor note: OIC stores `mouseDownX/Y` in single-pair state — works for the current single-click flow but would break under hypothetical simultaneous multi-click scenarios (non-issue today).
- Confirmed Part 2.3 duplication: 4 controllers independently compute `(clientX − rect.left) / zoom`. Extract into `src/canvas/coords.ts` is low-risk.
- Confirmed Part 3.4 hotspots: `PortTooltip.onMove` and `CableDrawController.findNearest` both walk all port DOM nodes calling `getBoundingClientRect()` per port per event.
**Next:** remaining Part 1 work is BLOCKER-2 (1.4 runtime instrumentation, needs browser). Part 2 mechanical wins + Part 4 recipe work can proceed independently.
---

## [2026-04-17] BLOCKER | dist/ committed to repo
**Agent:** Director (hygiene)
**Blocking:** Nothing functional — knip reports false-positive unused files.
**Details:** `dist/assets/index-D4hyy6T0.js` shows up as an unused file.
**Needs:** Add `dist/` to `.gitignore`, remove committed files. Trivial.
---

---
## [2026-04-16] COMPLETED | ObjectSpec migration and control behavior fixes
**Agent:** Codex
**Phase:** Phase 3 prep — object behavior/runtime groundwork
**Done:**
- Migrated the object registry from `ObjectDef` to richer `ObjectSpec` metadata across all 7 shipped objects
- Updated object rendering to use spec category instead of a hardcoded UI type set
- Extended interaction routing for slider inlet handling, toggle float I/O, button numeric triggering, message dollar-arg/set/append/prepend/comma behavior, and metro timers
- Added metro timer lifecycle cleanup so removed metro nodes do not leak active intervals
- Verified `npx tsc --noEmit` and `npm run build` both pass

**Changed files:**
- src/graph/objectDefs.ts — replaced `ObjectDef` with `ObjectSpec`, added object descriptions/categories/args/messages, added slider inlets
- src/canvas/ObjectRenderer.ts — switched UI detection to `spec.category === "ui"`
- src/canvas/ObjectInteractionController.ts — added message routing fixes, toggle/slider/button coercion, metro timer state, and cleanup

**Notes / decisions made:**
- Message hot-inlet value delivery now treats stored text as the template for `$1` substitution; `set`/`append`/`prepend` are the only paths that mutate stored content programmatically
- Comma-separated message output is sequential on outlet 0; semicolon-routed messages log a warning and do not dispatch in v1
- Metro timer cleanup is handled inside the interaction controller by pruning timer handles on graph change, which covers node deletion without changing `PatchGraph` APIs

**Next needed:**
- Browser validation of the new control paths: message substitution, slider inlet updates, and metro start/stop behavior
- Phase E audio runtime can build on the now-complete non-audio message/control routing
---

---
## [2026-04-16] COMPLETED | Phase 2 — Canvas Interaction
**Agent:** Claude Code (Director, orchestrated)
**Phase:** Phase 2 — Canvas Interaction
**Done:**
- Created `src/canvas/CableRenderer.ts` — SVG overlay, straight-line cables, ghost preview, hit-test, selection
- Created `src/canvas/CanvasController.ts` — object selection, Delete/Backspace, right-click context menu (all 6 types), cable click-select, canvas pan (Space+drag, middle-click)
- Created `src/canvas/DragController.ts` — drag to reposition; DOM-direct during drag, commits to graph on mouseup
- Created `src/canvas/CableDrawController.ts` — outlet mousedown → ghost → inlet mouseup → graph.addEdge
- Updated `src/main.ts` — wired all controllers, pan group div, re-render restores selection
- Updated `src/shell.css` — selection/drag/port/pan-group styles
- Build: clean (tsc + vite, 0 errors)

**Changed files:**
- src/canvas/CableRenderer.ts — created
- src/canvas/CanvasController.ts — created
- src/canvas/DragController.ts — created
- src/canvas/CableDrawController.ts — created
- src/main.ts — rewritten
- src/shell.css — interaction state styles added

**Notes / decisions made:**
- Port nubs: `pointer-events: all` (override parent) so outlet clicks register for cable drawing
- DragController updates DOM directly mid-drag; setNodePosition only on mouseup (no mid-drag re-renders)
- Cables snap to new position on mouseup re-render; they don't follow during drag (v1 acceptable)
- Pan uses `pn-pan-group` wrapper div; canvas grid stays static
- Context menu subtracts pan offset for correct world-space object placement
- Codex exec requires TTY (stuck on stdin); all tasks executed by Director

**Next needed:**
- User tests in browser: right-click canvas → place objects → drag → connect cables → delete
- Phase 3: Audio Runtime prompt to write (Codex leads)
---

---
## [2026-04-16] REVIEW | Phase 0 — Director greenlight
**Agent:** Claude Code
**Phase:** Phase 0 → Phase 1 transition
**Done:**
- Reviewed Cursor Phase 0 completion log
- Phase 0 accepted — scaffold complete
- Bootstrapped Tier 2 vault (patchNet-Vault/wiki/) with index, log, overview, all 6 object specs, 3 concept docs
- Added patchNet to global CLAUDE.md brain table
- Created project CLAUDE.md
- Created ~/brain/wiki/projects/patchnet.md
- Written Phase 1 prompt → docs/phase-1-codex-prompt.md
- Research agent dispatched (browser PD/Max-like environments, WebPd, pd format, node editor libs)

**Next needed:**
- User pastes docs/phase-1-codex-prompt.md into Codex
- Research agent results to be filed into vault sources/ when returned

---
## [2026-04-16] COMPLETED | Phase 0 — Scaffold
**Agent:** Cursor
**Phase:** Phase 0 — Scaffold
**Done:**
- Added Vite + TypeScript toolchain (`package.json`, `tsconfig.json`, `vite.config.ts`)
- Created `src/tokens.css` with all `--pn-*` tokens from DESIGN_LANGUAGE (single `:root` block)
- Created `src/fonts.css` with Vulf Mono / Vulf Sans `@font-face` (paths relative to `src/`)
- Created `src/shell.css` — toolbar, workspace split, canvas dot grid, text panel, status bar, CRT overlay
- Created `index.html` app shell and `src/main.ts` stub entry
- Verified `npm install` and `npm run build` succeed

**Changed files:**
- package.json — created
- package-lock.json — generated by npm
- tsconfig.json — created
- vite.config.ts — created
- index.html — created
- src/tokens.css — created
- src/fonts.css — created
- src/shell.css — created
- src/main.ts — created
- AGENTS.md — project state + changelog entry

**Notes / decisions made:**
- `PLAN.md` lists a separate `src/canvas.css`; Phase 0 prompt scopes canvas grid into `shell.css` (no extra file).
- Font URLs use `../fonts/...` from `src/fonts.css` so Vite resolves and can bundle/cache-bust in production.

**Next needed:**
- Claude Code to review and greenlight Phase 1 start (in-memory patch graph + serialization stubs per PLAN)

---
## [2026-04-16] INIT | Project bootstrapped
**Agent:** Claude Code
**Phase:** Pre-Phase 0
**Done:**
- Created `patchNet/` directory with `fonts/`, `src/`, `docs/` subdirectories
- Wrote `DESIGN_LANGUAGE.md` — combined design tokens from patchBay and pedalToTheMetal
- Wrote `PLAN.md` — full phased architecture plan (Phase 0–4 + future)
- Wrote `AGENTS.md` — this file
- Identified font source: `patchBay/thejrummerWebsite/` Vulf font files to be copied to `patchNet/fonts/`

**Changed files:**
- patchNet/DESIGN_LANGUAGE.md — created
- patchNet/PLAN.md — created
- patchNet/AGENTS.md — created

**Next needed:**
- Copy Vulf Mono + Vulf Sans woff2 files into `patchNet/fonts/`
- Cursor to execute Phase 0: scaffold `index.html`, `vite.config.ts`, `package.json`, CSS token files, two-panel layout
- Use the Phase 0 Cursor prompt below

---
## [2026-04-16] COMPLETED | Phase 1 — Patch Graph Model
**Agent:** Codex
**Phase:** Phase 1 — Patch Graph Model
**Done:**
- Added `PatchNode`, `PatchEdge`, `PatchGraph`, and the v1 object registry for all 6 shipped object types
- Implemented PD-style serialization and parsing for `#N canvas`, `#X obj`, and `#X connect` lines with line-numbered parse errors
- Added DOM renderers for patch objects and inlet/outlet nubs using the canonical `--pn-*` design tokens
- Wired `main.ts` to render directly from the graph, keep the text panel serialized in sync on graph changes, and bootstrap a programmatic `button` node on load
- Verified `npm run build` succeeds

**Changed files:**
- src/graph/PatchNode.ts — node data model and defensive copying of args/ports
- src/graph/PatchEdge.ts — edge data model
- src/graph/objectDefs.ts — port layouts and default sizes for `button`, `toggle`, `slider`, `metro`, `click~`, `dac~`
- src/graph/PatchGraph.ts — graph mutation API, change events, serialize/deserialize hooks
- src/serializer/serialize.ts — graph to PD-style text serialization
- src/serializer/parse.ts — text to graph parser with validation and `PatchParseError`
- src/canvas/PortRenderer.ts — top/bottom port nub rendering
- src/canvas/ObjectRenderer.ts — object box rendering and per-object static visuals
- src/main.ts — bootstrap render loop and initial graph state
- index.html — data hooks for canvas, text panel, and status bar
- src/shell.css — patch object and port styling

**Notes / decisions made:**
- Phase 1 keeps text flow one-way: graph changes serialize into the textarea, but textarea edits do not re-parse yet. That stays aligned with Phase 4’s explicit text-to-patch milestone.
- Object rendering includes static visual vocabulary for all 6 v1 objects now so Phase 2 can focus on interaction wiring instead of redesigning markup.

**Next needed:**
- Cursor can start Phase 2 on top of the current DOM structure, adding placement, dragging, selection, and straight SVG cable rendering
- Codex Phase 3 can reuse `PatchGraph` traversal and the existing object registry when audio/runtime work begins

---
## [2026-04-16] COMPLETED | docs/CODEBOX_PLAN.md rewrite
**Agent:** Codex
**Phase:** Planning / codebox architecture
**Done:**
- Rewrote `docs/CODEBOX_PLAN.md` into a complete implementation plan aligned with the current patchNet architecture
- Updated the doc to reflect the existing `ObjectSpec`, `message` object, `PortType`, and `ObjectInteractionController` baseline instead of outdated scaffold assumptions
- Added explicit serializer/parser rules for multiline code via base64 encoding, dynamic-port rebuild rules, controller responsibilities, phased milestones, risks, and a concrete Phase A definition of done

**Changed files:**
- docs/CODEBOX_PLAN.md — replaced partial/outdated draft with a complete phased implementation plan
- AGENTS.md — appended completion log entry

**Notes / decisions made:**
- The doc now treats JavaScript data/message codebox as the only immediate shipping target; audio, video, and alternate-language runtimes remain follow-on phases
- Serialization safety is explicitly part of the plan now, because raw source text cannot safely live in the current PD-style line format

**Next needed:**
- Claude Code / Cursor can use `docs/CODEBOX_PLAN.md` as the implementation prompt source for the Phase A codebox milestone
- If codebox work starts, the first concrete task should be adding the `codebox` object spec plus serializer/parser support before editor embedding

---
## [2026-04-16] COMPLETED | Phase A — codebox object
**Agent:** Codex
**Phase:** Phase A — codebox scripting object
**Done:**
- Installed CodeMirror 6 JavaScript editor dependencies
- Added the `codebox` object spec and right-click placement support
- Implemented `CodeboxController` for editor lifecycle, debounced code sync, dynamic port derivation, stale-edge pruning, inline error display, and JS execution
- Wired codebox execution into the existing message bus and main render loop
- Added serializer/parser support for base64-encoded persisted source with decoded in-memory source and dynamic port rebuild on load
- Verified `npm run build` passes

**Changed files:**
- package.json — added CodeMirror dependencies
- package-lock.json — updated lockfile for new dependencies
- src/canvas/CodeboxController.ts — created codebox editor/runtime controller
- src/canvas/codeboxPorts.ts — created shared regex-based dynamic port derivation utility
- src/graph/objectDefs.ts — added `scripting` category and `codebox` spec
- src/canvas/ObjectRenderer.ts — added codebox-specific DOM structure
- src/canvas/ObjectInteractionController.ts — routed bang/value delivery into codebox execution
- src/canvas/DragController.ts — prevented object dragging from stealing editor interactions
- src/serializer/serialize.ts — added base64 codebox source serialization
- src/serializer/parse.ts — added codebox source decode and dynamic port reconstruction
- src/main.ts — instantiated codebox controller and mounted editors during render
- src/shell.css — added codebox object and embedded CodeMirror styling
- src/canvas/CanvasController.ts — added `codebox` to the context menu

**Notes / decisions made:**
- Codebox source is stored decoded in-memory on `node.args[1]` and only base64-encoded at serialize time; this keeps editor state, parser behavior, and runtime execution aligned
- Dynamic inlet typing treats explicit `inN` references as `any`, `bangN`-only references as `bang`, and fills missing inlet gaps with `any` placeholders

**Next needed:**
- Browser validation for `slider -> codebox -> message`, syntax/runtime error visuals, and patch reload behavior
- If bang-only codebox output semantics are needed later, define them explicitly; Phase A currently dispatches non-null outputs as value messages only

---
## [2026-04-16] COMPLETED | docs/phase-visualizer-A-codex-prompt.md rewrite
**Agent:** Codex
**Phase:** Planning / visualizer runtime prompt
**Done:**
- Rewrote `docs/phase-visualizer-A-codex-prompt.md` into a complete, current-state implementation prompt for Visualizer Phase A
- Updated the prompt to match the actual repo architecture after Codebox and audio runtime work, including existing controller APIs, `main.ts` wiring, and `ObjectSpec` unions
- Tightened scope so Phase A only covers object registration, popup runtime, graph sync, renderer/UI hooks, and interaction delivery, leaving media loading/compositing for later phases

**Changed files:**
- docs/phase-visualizer-A-codex-prompt.md — replaced outdated draft with a repo-accurate Phase A implementation prompt
- AGENTS.md — appended completion log entry

**Notes / decisions made:**
- The prompt now treats `VisualizerGraph` as an always-on runtime like `CodeboxController`, not something gated behind audio/DSP startup
- Phase A explicitly stops short of media file handling and layer rewiring so the implementation target is narrow and testable

**Next needed:**
- Claude Code / Cursor can use `docs/phase-visualizer-A-codex-prompt.md` as the implementation prompt for the popup visualizer foundation
- If implementation starts, browser validation should focus first on popup lifecycle, render loop stability, and object deletion cleanup

---
## [2026-04-16] COMPLETED | Patch cable UX polish
**Agent:** Cursor
**Phase:** Cable polish pass
**Done:**
- Fix 1 (live cables during drag): verified `main.ts` already updates graph positions on drag `onMove` and calls `cables.render()` — no change needed
- Fix 2: re-patch from either cable end (inlet-click anchors inlet and drags new outlet; outlet-click anchors outlet)
- Fix 3: removed object-body fallback so re-patch only triggers on actual endpoint port hits
- Fix 4: snap radius 36→52; ghost cable dash `8 5` and opacity `0.82`
- Fix 5: port `:hover` scale/glow pre-draw affordance in `shell.css`
- Fix 6: cable hit stroke width 12→18
- Fix 7: Alt-click on a cable deletes it immediately
- Fix 8: drag clamp uses `scrollWidth`/`scrollHeight` instead of viewport `clientWidth`/`clientHeight`

**Changed files:**
- src/canvas/CableDrawController.ts — repatch branch, removed body fallback, `bestDist` 52
- src/canvas/CableRenderer.ts — ghost styling, hit line width
- src/canvas/CanvasController.ts — `handleCableClick` Alt-delete
- src/canvas/DragController.ts — clamp bounds for full scrollable canvas
- src/shell.css — `.patch-port:hover` rule

**Notes / decisions made:**
- If re-patch runs but `toNode` is missing after edge removal, the handler returns early (degenerate case)

**Next needed:**
- Browser validation of all 8 behaviors per `docs/phase-cable-polish-cursor-prompt.md`

---
## [2026-04-17] COMPLETED | Evaluation Plan — Part 4 recipe + template + 3 ref pages
**Agent:** Claude Code
**Phase:** Evaluation Plan Part 4 — Standardized Object Development
**Done:**
- `docs/OBJECT_RECIPE.md` — 8-step checklist for adding a new object type (spec → allowlist → renderer → interaction → runtime → CSS → reference page → smoke test), each step citing the exact file/line to touch
- `docs/objects/_TEMPLATE.md` — reference-page scaffold with required YAML frontmatter (`type`, `category`, `version`) and section headings (Arguments / Inlets / Outlets / Messages / Examples / Notes) that Part 5's Reference tab loader will parse
- `docs/objects/button.md`, `toggle.md`, `metro.md` — three reference pages authored from the template, proving it fits the shape of data in `OBJECT_DEFS`
- `docs/objects/INVENTORY.md` — ref-doc column flipped to ✓ for button, toggle, metro (4 of 21 done now)

**Changed files:**
- docs/OBJECT_RECIPE.md — new
- docs/objects/_TEMPLATE.md — new
- docs/objects/button.md — new
- docs/objects/toggle.md — new
- docs/objects/metro.md — new
- docs/objects/INVENTORY.md — ref-doc column updated for 3 types

**Notes / decisions made:**
- Reference-page frontmatter uses `type | category | version` only. Kept lean on purpose — anything else (inlets/outlets/args) can be derived from `OBJECT_DEFS` at load time, so duplicating it in frontmatter would just create drift.
- Section headings are load-bearing for the Part 5 Reference tab loader. The `_TEMPLATE.md` HTML comment documents this contract.
- Recipe step 5 (runtime node) explicitly calls out the `AudioGraph.ts:61` / `VisualizerGraph.ts:234` registration sites as the "don't forget this" moments. These were the two places I'd expect a first-time object author to miss.
- Did NOT backfill the remaining 17 ref pages in this session — writing them mechanically risks sloppy content, and the three exemplars are enough to validate the template shape. The rest is follow-up work sized per-session.

**Next needed:**
- 17 remaining ref pages: slider, message (exists, predates template — re-check), attribute, integer, float, scale, s, r, click~, dac~, codebox, visualizer, mediaVideo, mediaImage, layer, imageFX, vfxCRT, vfxBlur. Assign in batches of 4–6 per session.
- Part 4.3: CI lint `npm run lint:objects` enforcing (a) `OBJECT_DEFS` keys == `VALID_TYPES`, (b) every key has a `docs/objects/<key>.md` with the required frontmatter + sections, (c) every key has at least one `renderer` or default-label path.
- User sign-off before moving to Part 2 (dead-code removal) or Part 5 (Reference tab UI).

---
## [2026-04-17] COMPLETED | Persistence refactor — text panel as source of truth
**Agent:** Claude Code
**Phase:** Out-of-band user request (media-object state persistence)
**Done:**
- Eliminated the dual-serializer design. Dropped `serializeForDisplay`, `serializeNodeForDisplay`, `serializePatchForDisplay`, and `deserializeDisplay`. Text panel now shows the full, round-trippable `serialize()` output.
- Added `#X id <index> <uuid>;` lines to the serialized format. Parser reads them back so node identity survives paste-back.
- Rewrote `PatchGraph.deserialize()` as a diff against the existing graph. Incoming nodes match existing nodes by id first, then by media-ref (idb: key for mediaVideo/mediaImage), then by (type, rounded position). Matched nodes are mutated in place — their `node.id` is preserved, which keeps all runtime bindings (IDB video blobs, imageFX bg PNGs, ImageFXNode instances, MediaVideoNode players) intact across any text-panel edit.
- Migrated mediaImage storage from inline data URL (in `args[0]`) to IndexedDB via new `src/runtime/ImageStore.ts`. Text panel for mediaImage now reads `mediaImage idb:<key> <filename> <mimetype>` instead of a 2MB base64 string.
- Added legacy auto-migration: any mediaImage loaded from localStorage with a `data:` URL in `args[0]` is moved into IDB on first sync and `args[0]` is rewritten to `idb:<nodeId>`. No user action required.
- Fixed visualizer popup geometry persistence — `onResize`/`onMove` and `screenX`/`screenY`/`winW`/`winH` message handlers now emit `change` (was `display`), so the autosave listener picks them up. Popup size/position now survives reload.
- Deleted the fragile position-based imageFX bg-ref restoration (`PatchGraph:197-206` in the old code) — the new diff-based identity model makes it unnecessary.
- Added cursor + scroll preservation to `syncTextPanel` so the user can actually edit the textarea without cursor jumps on every re-serialization tick. Also skips the write entirely when the serialized output is unchanged.
- `MediaImageNode` gained `loadBlob(buf, mimeType)` paralleling the existing `MediaVideoNode.loadBlob`.

**Changed files:**
- src/serializer/serialize.ts — rewritten; dropped display variants, emits `#X id` lines
- src/serializer/parse.ts — handles `#X id` lines and applies the UUID to parsed nodes
- src/graph/PatchGraph.ts — diff-based deserialize replaces clear-and-rebuild; structural matcher for unmatched parsed nodes
- src/runtime/VisualizerGraph.ts — IDB migration + load-from-IDB for mediaImage; popup geometry emits `change`; imageIdbKeys map; cleanup on destroy
- src/runtime/MediaImageNode.ts — `loadBlob(buf, mimeType)` added
- src/runtime/ImageStore.ts — NEW; parallel to VideoStore, stores image blobs with mime type
- src/main.ts — text panel uses `graph.serialize()` + `graph.deserialize()`; cursor/scroll preservation; no-op when output unchanged

**Notes / decisions made:**
- The user's invariant: paste the text-panel contents back into the panel and the graph restores exactly as left. Achieved by making the text round-trippable and making identity stable across parse. The `#X id` line is the hinge — without it, every parse would mint fresh UUIDs and any runtime state keyed on node.id would vanish.
- Chose IDB over inline data URLs for mediaImage because a 2MB base64 string in the text panel is actively hostile to the "user can hand-edit the text" goal.
- Structural matcher handles the case where user hand-types a patch without `#X id` lines (or edits one out). Match-by-media-ref is the key correctness anchor — as long as the `idb:<key>` is there, IDB lookup works regardless of which PatchNode instance wraps it.
- UndoManager already uses `serialize()`/`deserialize()` so the same identity preservation applies to undo/redo automatically — undoing across a file-load no longer wipes the IDB blob.
- `build` passes. `tsc --noEmit` passes. Manual browser validation still needed.

**Next needed:**
- Browser smoke test: load a video, load an image with bg-removal, resize the visualizer popup, reload, confirm all three restore. Also: copy text panel → clear patch → paste text back → confirm same result.
- Legacy patch migration hasn't been observed in real usage yet — if a user has an existing localStorage patch with inline `data:` URLs, it should migrate on first load. Watch console for migration warnings on the first `npm run dev` session.

---
## [2026-04-17] COMPLETED | Evaluation Plan — Part 2.1 mechanical deletions
**Agent:** Claude Code
**Phase:** Evaluation Plan Part 2 — Dead code
**Done:**
- Removed `export { derivePortsFromCode };` at `src/canvas/CodeboxController.ts:308`. The function is defined in `src/canvas/codeboxPorts.ts`; both real callers (`CodeboxController` itself and `serializer/parse.ts`) import it directly from `codeboxPorts`, so the re-export had zero consumers.
- Removed `export type { PortType };` + its explainer comment at `src/graph/objectDefs.ts:578-580`. Grep confirmed no file imports `PortType` from `objectDefs` — all callers pull it from `PatchNode` where it's defined.
- `npx tsc --noEmit` passes (exit 0) after both deletions.

**Changed files:**
- src/canvas/CodeboxController.ts — removed trailing re-export
- src/graph/objectDefs.ts — removed trailing `PortType` re-export + stale comment

**Notes / decisions made:**
- These were the two lowest-risk wins on the Part 2 list: pure re-exports, no behavior change, proof-by-grep that nothing consumes them. Kept the edit surface to exactly those two lines so the diff reads as "obvious mechanical cleanup" rather than a refactor.
- Did NOT touch `derivePortsFromCode` itself — it's live code with two callers.
- Remaining Part 2 work (coords extraction at 2.3, CSS hex cleanup at 2.4) touches real call sites and wants its own focused pass — not bundled here.

**Next needed:**
- Part 2.3: extract `src/canvas/coords.ts` exporting `screenToGraph(clientX, clientY, rect, zoom)`. Replace 4-way duplication across `CanvasController.getGraphCoords`, `DragController`, `CableDrawController`, `ResizeController`.
- Part 2.4: replace remaining hex in `src/shell.css` (lines 55, 881, 1505, 1507-1510, 1695) with `--pn-*` tokens or `color-mix(…)` equivalents per Design Rule 3.

---
