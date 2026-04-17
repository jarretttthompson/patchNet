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

**Current Phase:** Evaluation Plan — Parts 1, 2, 4 in flight + persistence refactor landed
**Active tasks:** Part 1.1/1.2/1.3/1.5 landed; Part 1.4 deferred (BLOCKER-2). Part 2.1 mechanical deletions landed. Part 4.1 recipe, 4.2 template, and 3 of 21 ref pages landed. **Persistence refactor (text as source of truth) landed** — `#X id` identity preservation, diff-based deserialize, mediaImage IDB migration.
**Last updated:** 2026-04-17 by Claude Code

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
