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

Older entries archived to `AGENTS-archive.md`.

---
## [2026-04-21] COMPLETED | shaderToy object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new visual-category fragment-shader source
**Done:**
- Added `shaderToy` to `OBJECT_DEFS` (`src/graph/objectDefs.ts`). Visual-category. Args: `preset` (symbol default "default"), `code` (symbol, hidden — base64-encoded GLSL), `width`/`height` (int, default 512×512), `mouseX`/`mouseY` (hidden floats, default 0.5). Single `any` inlet; one `media` outlet → `layer`.
- New runtime node: `src/runtime/ShaderToyNode.ts`. WebGL2 renderer wrapping an offscreen `<canvas>`; implements the existing `VideoFXSource` interface (same SPI as `VfxCrtNode`/`VfxBlurNode`) so `LayerNode.setVideoFX(...)` picks it up with zero changes to LayerNode. Exposes the ShaderToy-compatible uniform subset: `iResolution` (vec3), `iTime`, `iTimeDelta`, `iFrame`, `iMouse` (vec4), `iDate` (vec4). User source is expected to define `void mainImage(out vec4 fragColor, in vec2 fragCoord)`; the prelude + a trivial `main()` are added automatically.
- Four built-in presets live in `SHADERTOY_PRESETS` (default rainbow gradient, plasma, warp, grid) so the object shows visible output immediately on placement.
- Messages (hot inlet 0): `preset <name>` (switches built-in, clears inline code), `code <base64>` (sets fragment source from base64), `glsl <rest-of-line>` (convenience path for hand-typed GLSL — re-encoded to base64 for persistence), `mouse <x> <y>` (normalized 0–1), `size <w> <h>` (resize render surface), `reset` / `bang` (reset `iTime`).
- `VisualizerGraph` wiring: new `shaderToyNodes` map; `rewireMedia()` gains a `shaderToy` branch calling `layer.setVideoFX(stn)`; mutable-state sync reads `width`/`height` + `mouseX`/`mouseY` every graph change; `deliverShaderToyMessage` handler.
- `ObjectInteractionController`: `deliverBang` + `deliverMessageValue` branches; `glsl <rest-of-line>` carve-out preserves spaces in GLSL body.
- `ObjectRenderer`: `shaderToy` branch with visual-label + sub (preset-or-"custom" and resolution). Reuses existing CSS classes.
- Reference docs: `docs/objects/shaderToy.md` + `docs/objects/INVENTORY.md` row.
- `tsc --noEmit` passes. `npm run build` clean (586 KB bundle).

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
- shaderToy is a *media source* (not a layer itself) so it composes with the existing `shaderToy → layer → (visualizer | patchViz)` graph shape. Reused `VideoFXSource` / `LayerNode.setVideoFX` — trade-off: a layer holds shader OR video/image but not both (acceptable in v1).
- WebGL2 (not WebGL1). Base64 code storage in `args[1]` for round-trip safety.
- ShaderToy URL/ID fetching intentionally NOT implemented — requires per-user API key and CORS is not universal. Users paste fragment source directly via `glsl` or `code`.
- Multi-pass / `iChannel*` out of scope for v1. Compile failures keep previous good shader.

**Next needed:**
- Browser smoke test: `shaderToy → layer → patchViz` (default rainbow), swap to `visualizer` popup, `message preset plasma`, `message glsl ...`, two sliders → `message mouse $1 $2`, round-trip.
- Follow-up candidates: `iChannel0` input slot, compile-error state in node DOM, more presets, live thumbnail.
---

---
## [2026-04-20] COMPLETED | sequencer object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new control-category step sequencer
**Done:**
- Added `sequencer` to `OBJECT_DEFS`. Control-category. Args: `rows` (int 1–32, default 4), `cols` (int 1–64, default 8), `playhead` (hidden int), `cells` (hidden base64 JSON matrix), `locked` (hidden int 0/1, default 1). Single bang inlet; one `any` outlet per row (derived).
- Port derivation: `deriveSequencerPorts(args)` rebuilds outlets from the row arg. Called from `PatchGraph.addNode`, `parse.ts`, and at every arg-mutation site.
- `ensureSequencerArgs` backfills sparse arg slots before serialization.
- Cell storage: `getSequencerCells` / `setSequencerCells` helpers; base64 JSON in `args[3]`.
- Renderer: CSS-grid of `.pn-seq-cell` divs, active column marked, lock button at top-right.
- Interaction: `advanceSequencer` wraps playhead, dispatches each row's active-column value, patches DOM in place (no full re-render), emits `"display"`. Lock-button handler mirrors subPatch toggle. Cell commit via `focusout`/`keydown` (Enter commits, Escape reverts). `syncSequencerPorts` rebuilds outlets and drops orphan edges.
- `DragController`: `pn-seq-cell` added to click-through allowlist.
- `tsc --noEmit` passes. `npm run build` clean (574 KB bundle).

**Changed files:**
- src/graph/objectDefs.ts — sequencer ObjectSpec + derivation/ensure/cells helpers
- src/graph/PatchGraph.ts — addNode sequencer branch
- src/serializer/parse.ts — sequencer parse branch
- src/canvas/ObjectRenderer.ts — sequencer body branch + shared `LOCK_ICON_SVG`
- src/canvas/ObjectInteractionController.ts — bang/value delivery, lock toggle, cell commit, port sync, focusout/keydown wiring
- src/canvas/DragController.ts — pn-seq-cell drag exclusion
- src/shell.css — sequencer grid / cell / playhead / lock-button styles
- AGENTS.md — this entry

**Notes / decisions made:**
- Single bang inlet (not one per row) per Max `coll`/`counter`/`matrixctrl` convention.
- Cells serialize as base64 JSON (raw JSON breaks PD-style format; base64 is the codebox/subPatch precedent).
- Shrink→grow preserves cell content (getSequencerCells pads missing slots).
- Playhead advance emits `"display"` not `"change"` — skips re-render so grid DOM, cables, focused cell survive bang cadence.

**Next needed:**
- Browser smoke test: unlock, type values, lock, `metro → sequencer`, confirm playhead walks. Round-trip test. Attribute panel: drag `rows` slider, confirm outlet count tracks and orphan cables clean up.
- Follow-up: `docs/objects/sequencer.md` reference page + `INVENTORY.md` row.
---

---
## [2026-04-19] COMPLETED | oscillateNumbers object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new control-category object
**Done:**
- Added `oscillateNumbers` to `OBJECT_DEFS`. Control-category. Args: `freq` (0.01–20 Hz, default 1), `running` (hidden). Hot inlet 0 accepts `1/0/bang/freq <hz>`; cold inlet 1 is a dedicated float-Hz inlet. Outlet 0 emits a float in `[0.0, 1.0]`.
- RAF-driven oscillator in `ObjectInteractionController`: `oscTimers` map, `pruneOscTimers`/`restoreOscTimers` survive text-panel diff deserialize, `destroy()` cancels in-flight RAFs.
- Output: `0.5 + 0.5 * sin(2π * freq * t)`, emitted every frame as `toFixed(4)`.
- Reference page `docs/objects/oscillateNumbers.md` + `INVENTORY.md` row.
- `tsc --noEmit` + `npm run build` clean (560 KB bundle).

**Changed files:**
- src/graph/objectDefs.ts — OBJECT_DEFS.oscillateNumbers
- src/canvas/ObjectInteractionController.ts — oscTimers field, hooks, deliverBang/deliverMessageValue branches, private osc methods
- docs/objects/oscillateNumbers.md — new reference page
- docs/objects/INVENTORY.md — new row
- docs/phase-oscillateNumbers-prompt.md — implementation prompt
- AGENTS.md — this entry

**Notes / decisions made:**
- `freq` = cycle Hz (RAF-decoupled output rate). Gate semantics mirror `metro` exactly.
- Phase resets on (re)start including freq changes via inlet 1 — documented explicitly.
- No runtime node, no AudioGraph/VisualizerGraph registration, no renderer branch (default text-label handles it).
- Single `OBJECT_DEFS` entry — autocomplete and context menu derive automatically.

**Next needed:**
- Browser smoke test: `toggle → oscillateNumbers → float` + `slider → oscillateNumbers inlet 1`. Round-trip test.
- Follow-up: `docs/OBJECT_RECIPE.md` step 2 ("Add to VALID_TYPES") is obsolete — recipe should be updated.
---

---
## [2026-04-19] COMPLETED | Control/render split — plan authored + Phase 1 scaffold landed
**Agent:** Claude Code
**Phase:** Control/Render Split — Phase 1 (Control surface extraction)
**Done:**
- Authored architecture plan at `docs/CONTROL_RENDER_SPLIT.md`. Firm recommendation: v1 stays browser-based in-process; real win is a clean control-plane abstraction. Popup → BroadcastChannel is v2; WebSocket is v3.
- Vault: `patchNet-Vault/wiki/concepts/control-render-split.md` + `visualizer-object.md` + `patchviz-object.md`. Index + log updated.
- Phase 1 scaffolding in `src/control/`: `ControlMessage.ts` (discriminated union), `IRenderer.ts`, `ControlBus.ts` (`LocalBus` impl), `RenderDirector.ts`.
- `VisualizerNode.apply()` handles `Command { close | size | move | setFloat | fullscreen }`.
- `PatchVizNode.apply()` handles `Command { enable | disable | toggle }` + `Trigger { bang }`.
- `VisualizerGraph` owns `LocalBus` + `RenderDirector`; renderers attach on create, detach on destroy.
- Proof path: `deliverPatchVizMessage` routes through `director.trigger` / `director.command` → `bus.publishDown` → `PatchVizNode.apply`.
- `tsc --noEmit` passes. `npm run build` clean (558 KB bundle).

**Changed files:**
- docs/CONTROL_RENDER_SPLIT.md — new
- patchNet-Vault/wiki/concepts/control-render-split.md — new
- patchNet-Vault/wiki/concepts/visualizer-object.md — new
- patchNet-Vault/wiki/concepts/patchviz-object.md — new
- patchNet-Vault/wiki/index.md — bumped + 3 new concept links
- patchNet-Vault/wiki/log.md — new entry
- src/control/ControlMessage.ts — new
- src/control/IRenderer.ts — new
- src/control/ControlBus.ts — new
- src/control/RenderDirector.ts — new
- src/runtime/VisualizerNode.ts — IRenderer forwarder `apply`
- src/runtime/PatchVizNode.ts — IRenderer forwarder `apply`
- src/runtime/VisualizerGraph.ts — owns bus+director; attach/detach on renderer lifecycle; deliverPatchVizMessage via director

**Notes / decisions made:**
- `rendererId` is opaque to the bus (Phase 1 uses `patchNodeId`; Phase 4 may unify to `contextName`).
- Conservative migration: only `deliverPatchVizMessage` went through the bus. Other `deliverXxx` paths remain on the pre-refactor direct-call path until Phase 2 adds test infra (BLOCKER-1).
- `openAndRestore` stays on direct path — reads patch-side args mid-open, a controller concern.
- No automated tests — Phase 2 adds vitest + mock `IRenderer` harness before migrating further.

**Next needed:**
- Browser smoke test: `patchViz` bang/enable/disable still works. Other five `deliverXxx` paths unchanged.
- Phase 2 greenlight: add vitest + `tests/control/RenderDirector.test.ts`, then migrate `deliverMessage`.
---

---
## [2026-04-17] COMPLETED | Evaluation Plan — Part 1 audit (partial)
**Agent:** Claude Code
**Phase:** Evaluation Plan — Part 1 (Project Evaluation)
**Done:**
- Added `knip` as devDependency; findings in `docs/AUDIT.md` §1.1
- Cataloged all 21 object types with renderer/runtime/doc coverage → `docs/objects/INVENTORY.md`
- CSS/token audit: 6 hex violations in `shell.css`, 44 `!important`, 96 `rgba()` literals → `docs/AUDIT.md` §1.5
- Filed 4 BLOCKERs for items too big to fix inline

**Deferred:**
- Part 1.3 Controller responsibility map — resolved same day (see archive)
- Part 1.4 Runtime graph audit — requires browser profiling; captured as BLOCKER-2

**Changed files:**
- package.json / package-lock.json — added knip devDependency
- docs/AUDIT.md — created (Part 1 synthesis doc)
- docs/objects/INVENTORY.md — created (21-row coverage table)
- AGENTS.md — this entry + BLOCKERs + project state header

**Next needed:**
- BLOCKER-3 resolved (see archive). Remaining: BLOCKER-1 (test infra) gates Phase 2; BLOCKER-2 (runtime profiling) gates Part 3.
- Part 4 (OBJECT_RECIPE + ref-page template) landed — see archive.
---

---
## [2026-04-17] BLOCKER | No test infrastructure
**Agent:** Director (filed on behalf of Part 2 work)
**Blocking:** Dead-code deletions in Part 2 have no regression safety net beyond manual smoke tests. Control/Render Split Phase 2 also gated here.
**Details:** No vitest/jest config, no `*.test.ts`, no `tests/` dir anywhere in repo.
**Needs:** Decision on vitest (likely — matches Vite) + one serialize→parse round-trip test per object type as starting bar.
---

---
## [2026-04-17] BLOCKER | Runtime graph rewire behavior unmeasured
**Agent:** Director (filed on behalf of Codex / Part 3 work)
**Blocking:** Part 3 efficiency work cannot start without numbers.
**Details:** `VisualizerGraph` and `AudioGraph` both re-walk upstream topology on every edit. Cost is unknown; whether non-topology edits (drag, arg change) trigger rewire is unknown.
**Needs:** Add counter in `rewireMedia()`, run against a scripted 20-node patch, record results in `docs/AUDIT.md` §1.4. Delete counter after.
---

---
## [2026-04-17] BLOCKER | dist/ committed to repo
**Agent:** Director (hygiene)
**Blocking:** Nothing functional — knip reports false-positive unused files.
**Details:** `dist/assets/index-D4hyy6T0.js` shows up as an unused file.
**Needs:** Add `dist/` to `.gitignore`, remove committed files. Trivial.
---
