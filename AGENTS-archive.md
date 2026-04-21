# patchNet — Agent Changelog Archive

Entries moved here from `AGENTS.md` once no longer needed for active context.
For current state see `AGENTS.md`.

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
---

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
---

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
---

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
---

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
---

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
---

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
---

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
---

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
---
