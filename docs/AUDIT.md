# patchNet — Codebase Audit

Generated 2026-04-17 for `docs/EVALUATION_PLAN.md` **Part 1 — Project Evaluation**.
Evidence-based view of what exists, what's used, and where the architecture is fraying.
The rest of the evaluation plan (Parts 2–5) is gated on findings here.

---

## 1.1 — Dependency map (knip)

Tooling: `knip` (added as devDependency 2026-04-17). Run with `npx knip`.
Full JSON output available via `npx knip --reporter json`.

### Unused exports
| symbol | file | notes |
|---|---|---|
| `derivePortsFromCode` | `src/canvas/CodeboxController.ts:308` | Helper extracted during Phase A codebox work. The module-scoped regex parser is used internally via `codeboxPorts.ts`; this export is no longer referenced by any importer. **Likely safe to delete after manual verification.** |
| `PatchParseError` (class) | `src/serializer/parse.ts:6` | Exported but never imported externally; `parse.ts` throws it and `main.ts` catches via structural typing on `.message`. Either (a) import it where caught for `instanceof` checks, or (b) make it module-local. Prefer (a). |

### Unused exported types
| symbol | file | recommendation |
|---|---|---|
| `PortPos` | `src/canvas/CableRenderer.ts:11` | Internal to cable rendering. Drop `export`. |
| `ArgDef` | `src/graph/objectDefs.ts:9` | Should be consumed by the attribute panel + Reference tab. **Keep the export** — Part 5 will use it. |
| `MessageDef` | `src/graph/objectDefs.ts:21` | Same as `ArgDef` — keep for Part 5. |
| `ObjectSpec` | `src/graph/objectDefs.ts:28` | Same — keep for Part 5. |
| `PortType` | `src/graph/objectDefs.ts:580` | Re-exported from `PatchNode`. Current callers import from `PatchNode` directly, so this re-export is redundant. Drop it. |
| `ParsedPatch` | `src/serializer/parse.ts:16` | Interface describing parser return shape. If Part 4.3's lint script uses it, keep. Otherwise drop the export. |

### Unused files
None in `src/`. `dist/assets/index-D4hyy6T0.js` shows up in the knip report because the `dist/` folder is committed — it's a build artifact, false positive. Consider adding `dist/` to `.gitignore` and purging to silence the warning.

**Action items landing in Part 2.1 (Dead Code Removal):**
- Delete `derivePortsFromCode` after confirming no dynamic string lookups rely on it.
- Un-export `PortPos` and the redundant `PortType` re-export.
- Decide on `PatchParseError`: import-for-catch vs. module-local. Do NOT silently delete — it improves runtime error handling.

---

## 1.2 — Object inventory

Full table: `docs/objects/INVENTORY.md`.

### Headline findings
- **21 object types** are registered in `OBJECT_DEFS`; `VALID_TYPES` in `ObjectEntryBox.ts` lists the same 21. No drift today. The Part 4.3 CI gate is still worth shipping to keep them in sync forever.
- **20 of 21 reference pages missing.** Only `docs/objects/message.md` exists. Blocks Part 5 (Reference tab).
- **No test infrastructure anywhere.** No `vitest`/`jest` config, no `*.test.ts`, no `tests/` dir. Smoke-testing is manual. Adding a serialize→parse round-trip per object would catch a large class of regressions cheaply.
- `scale`, `vfxCRT`, `vfxBlur` have no explicit renderer branch (they fall through to the default text-label path). That is intentional for now — none of them have live UI state worth drawing — but any future readout on those types will need a new branch.

### Category counts
- `ui` — 5 (button, toggle, slider, message, attribute)
- `control` — 6 (metro, integer, float, scale, s, r)
- `audio` — 2 (click~, dac~)
- `scripting` — 1 (codebox)
- `visual` — 7 (visualizer, mediaVideo, mediaImage, layer, imageFX, vfxCRT, vfxBlur)

The visual category is now the largest — 33% of all objects — so render/runtime performance for the visualizer pipeline should be the primary target of Part 3.

---

## 1.3 — Controller responsibility map

Read pass covers all 9 controllers in `src/canvas/`. Source-of-truth references below.

### Correction to the plan's suspicion
The plan hypothesized that `CanvasController`, `ObjectInteractionController`, and `DragController` all bind `mousedown` on `panGroup`. Actual wiring:

- `ObjectInteractionController` binds on `panGroup` (`OIC.ts:82`).
- `DragController`, `CableDrawController`, and `ResizeController` are constructed with `panGroup` passed as their `canvasEl` parameter — so they also bind on `panGroup` despite the misleading internal name. Confirmed at `DragController.ts:59`, `CableDrawController.ts:57`, `ResizeController.ts:38`.
- `CanvasController` binds on the **outer** `canvasArea` element (`CanvasController.ts:115`), not `panGroup`. Its mousedown fires only after the panGroup-level listeners bubble up — so pan / rubber-band only activate when no inner handler called `stopPropagation`.

No priority bug was found in the chain. Details below.

### mousedown precedence on `panGroup` (registration order from `main.ts`)
| order | controller | handler | preventDefault? | stopPropagation? | when it acts |
|:-:|---|---|:-:|:-:|---|
| 1 | `ObjectInteractionController` | `handleMouseDown` (OIC:126) | slider/numbox only | never | `mousedown` on a slider track → begins slider drag; on numbox digit → begins drag. Records `mouseDownX/Y` on every fire for later drag-threshold check in `handleClick`. |
| 2 | `DragController` | `handleMouseDown` (DC:73) | object body only | never | Skips when target is INSIDE `.patch-port`, `.pn-resize-handle`, `.pn-cable-svg`, `.patch-object-codebox-host`, `.cm-editor`, `.patch-object-slider-track`, or an `INPUT`. Otherwise begins object drag (or Cmd+drag clone). |
| 3 | `CableDrawController` | `handleMouseDown` (CDC:83) | always when it acts | `stopPropagation` on port-draw (line 186), `stopImmediatePropagation` on cable-endpoint re-patch (line 119), `stopPropagation` on cable-stroke drag (line 235) | Three paths: stroke-drag from cable body, re-patch from selected cable endpoint, new cable from a port. |
| 4 | `ResizeController` | `handleMouseDown` (RC:41) | always when it acts | always when it acts (RC:58) | Only fires when target closest-matches `.pn-resize-handle`. |
| 5 | `CanvasController` | `handlePanMouseDown` (CC:115, full body ~540) | middle-click / Space+drag only | never | Middle-button or Space+LMB → pan. LMB on empty canvas (no `.patch-object`, `.pn-cable-svg`, `.pn-context-menu` ancestor) → rubber-band select. |

**Observation (minor, non-bug):** For buttons/toggles/messages, the mousedown flow is:

1. OIC records `mouseDownX/Y` (no action yet — the "click" fires later on `mouseup` if the cursor hasn't moved more than 4 px).
2. DragController initiates a drag on the same mousedown. If the mouse never moves before mouseup, the drag ends harmlessly with `moved = false` and no `setNodePosition` call.
3. The eventual `click` event fires, OIC's `handleClick` checks the drag threshold vs. the stored `mouseDownX/Y`, and if still within 4 px, dispatches the button/toggle/message semantics.

This is a working pattern but worth noting because `mouseDownX/Y` is a single pair of fields on OIC — if a user mousedowns on object A without releasing, then mousedowns on object B (e.g., during a multi-click flurry), the first values get overwritten. Not a real-world bug today.

### Per-controller responsibilities

#### `CanvasController` (807 LOC — the largest)
- **Listens on `canvasEl`:** `click`, `dblclick`, `contextmenu`, `mousedown`, `wheel`, plus `dragover`/`dragleave`/`drop` (files). On `document`: `keydown`, `keyup`, `click` (capture phase — closes context menu). On the cable SVG: `click`.
- **DOM mutates:** creates/removes `.pn-context-menu`, `.pn-rubber-band`, `.pn-scroll-spacer`; toggles `.patch-object--selected` on node elements; updates `panGroup.style.transform` for zoom.
- **Graph reads:** `getNodes`, `getEdges`, `nodes.get`, node positions/sizes for pan-group sizing.
- **Graph writes:** `addNode` (context menu + drop), `addEdge` indirectly via selectionally passing through `cableDraw`, `removeNode` + `removeEdge` (Delete key).
- **Owns:** `selectedNodeIds` (multi-select state), pan state (`isPanning`, `panStartX/Y`), rubber-band state, zoom via `zoomState`.
- **Public API consumers (`main.ts`):** `setPanGroup`, `setCableRenderer`, `setCableDrawController`, `setUndoManager`, `setVisualizerGraph`, `getSelectedNodeId`, `getSelectedNodeIds`, `selectNodes`, `updatePanGroupSize`.

#### `ObjectInteractionController` (1111 LOC — the 2nd largest, highest-fanout)
- **Listens on `panGroup`:** `click`, `mousedown`, `dblclick`, `input`, `change`. On `document` (dynamic): `mousemove`/`mouseup` during slider/numbox drag. On `graph`: `"change"` event.
- **DOM mutates:** flashes button, toggles X glyph for toggle, moves slider thumb, rewrites numbox digits via `buildNumboxContent`, mounts inline `<input>` for message edit (line ~900), rebuilds attribute-panel rows via `syncAttributeNodes`, delivers selector messages to codebox via `CodeboxController.executeWithValue`.
- **Graph reads:** node type, args, inlets, edges outgoing from a node (for `dispatchBang`/`dispatchValue`).
- **Graph writes:** `setNodeArg` (slider value, numbox value, toggle state, metro running, attribute value), edge mutations via message bus indirection (s/r broadcast triggers `deliverBang` which writes on the receiver).
- **Owns:** `sliderDrag`, `numboxDrag`, `metroTimers` (per-node `setInterval` handles — cleaned up on graph change), attribute-panel mouse-drag state, codebox/visualizer/audioGraph refs (injected).
- **Public API consumers:** `setAudioGraph`, `setCodeboxController`, `setVisualizerGraph`, `deliverBang`, `deliverMessageValue`, `startMessageEdit` (called from `main.ts:88` right after placing a message), `dispatchBang`, `dispatchValue` (exposed so `VisualizerGraph` can call back).

#### `DragController` (287 LOC)
- **Listens on `canvasEl` (= panGroup):** `mousedown`. On `document` (dynamic): `mousemove`, `mouseup`.
- **DOM mutates:** sets `.patch-object[style].left/top` directly on the dragged element and every co-mover; adds/removes `.patch-object--dragging`.
- **Graph reads:** `nodes.get` (to find group siblings), `getNodes` (for group-sibling scan), selection via injected `getSelection()`.
- **Graph writes:** `setNodePosition` on mouseup; `duplicateNodes` on Cmd+drag.
- **Owns:** `drag` state, `coMovers` list.
- **Public API consumers:** `isDragging`; callbacks into `main.ts` for `onMove`, `onDragEnd`, `onDuplicated`.

#### `CableDrawController` (421 LOC)
- **Listens on `canvasEl` (= panGroup):** `mousedown`. On `document` (dynamic): `mousemove`, `mouseup`.
- **DOM mutates:** `.pn-port--snap` hover class on snap target; ghost cable via `CableRenderer.startGhost/updateGhost/clearGhost`.
- **Graph reads:** `nodes.get`, `getEdges`, selected edge via `cables.getSelectedEdgeId`. Per-port DOM queries inside `findNearest`.
- **Graph writes:** `addEdge`, `removeEdge` (during re-patch).
- **Owns:** `draw` state, `snapTarget`, `suppressCableClick` (post-stroke-drag flag).
- **Public API consumers:** `isDrawing`, `consumeCableClickSuppression` (called from `CanvasController.handleCableClick`).

#### `CableRenderer` (316 LOC)
- **Listens on each rendered cable hit-element:** `mouseenter`, `mouseleave` (adds/removes hover class). No panGroup-level mousedown — cable click is handled by `CanvasController` via the SVG root element listener.
- **DOM mutates:** builds SVG `<line>` elements inside `.pn-cable-svg`; ghost line element; selected class.
- **Graph reads:** `getEdges`, `nodes.get` (for port positions).
- **Graph writes:** none — purely a renderer.
- **Owns:** `selectedEdgeId`.
- **Public API consumers:** `render`, `startGhost`, `updateGhost`, `clearGhost`, `selectEdge`, `getSelectedEdgeId`, `getSVGElement`, exported `getPortPos` + `CABLE_SNAP_RADIUS_PX` constants used by `CableDrawController`.

#### `ResizeController` (130 LOC)
- **Listens on `panGroup`:** `mousedown`. On `document` (dynamic): `mousemove`, `mouseup`.
- **DOM mutates:** `.patch-object[style].width/height`; `.patch-object--resizing`.
- **Graph reads:** `nodes.get` (for `attribute` height-lock rule).
- **Graph writes:** `setNodeSize` on mouseup.
- **Owns:** `state` (resize session).
- **Public API consumers:** constructor callback `onResize` wired in `main.ts:104`.

#### `PortTooltip` (81 LOC)
- **Listens on the outer `canvasEl` (canvasArea):** `mousemove`, `mouseleave`.
- **DOM mutates:** appends `.pn-port-tooltip` to `document.body`, positions it with `fixed` coords, toggles `--visible` class.
- **Graph reads:** none — reads label text from `data-pn-label` DOM attributes written by `PortRenderer`.
- **Graph writes:** none.
- **Owns:** `currentPort`, tooltip element.
- **Hotspot flag:** `onMove` runs `querySelectorAll("[data-pn-label]")` + `getBoundingClientRect()` in a loop on every mousemove. Targeted by Part 3.4.

#### `CodeboxController` (308 LOC)
- **Listens on:** nothing at the panGroup level. CodeMirror editors it mounts are self-contained; they stop event propagation by their nature (DOM editors), and `DragController` explicitly skips `.cm-editor` and `.patch-object-codebox-host`.
- **DOM mutates:** mounts CodeMirror `EditorView` instances into per-node host elements from `main.ts:223`.
- **Graph reads:** edges via callback from `main.ts:64-82`.
- **Graph writes:** `setNodeArg` (to persist source after debounce) and rebuilds inlets via `derivePortsFromCode` helper.
- **Owns:** `editors` map (node ID → `EditorView`), per-node source debounce timers.
- **Public API consumers:** `mountEditor`, `pruneEditors`, `executeWithBang`, `executeWithValue`, `destroy`; the module also exports `derivePortsFromCode` (unused by any caller — flagged in §1.1 for deletion).

#### `ObjectEntryBox` (226 LOC)
- **Listens on its own `<input>`:** `input`, `keydown`; on each dropdown item: `mousedown`; on `document` (capture phase): `mousedown` for outside-click dismissal.
- **DOM mutates:** creates/removes its wrapper div inside `panGroup`.
- **Graph reads/writes:** none directly — confirms via callback, which is wired in `CanvasController` to call `graph.addNode`.
- **Owns:** the entry box element, autocomplete match set, `activeIndex`.
- **Public API consumers:** instantiated by `CanvasController` for `n`-key and double-click empty-canvas flows.

### Suggested follow-ups that the map surfaces
1. **Coordinate-conversion duplication (Part 2.3 confirmed):** `DragController` (lines 92–95, 122–127), `CableDrawController` (lines 130–133, 196–199, 225–228), and `CanvasController.getGraphCoords` all independently compute `{ x: (clientX − rect.left) / zoom, y: (clientY − rect.top) / zoom }`. Extract `src/canvas/coords.ts` exporting `canvasPointerCoords(e: MouseEvent, canvasEl: HTMLElement): { x: number; y: number }`. Low-risk consolidation.
2. **Port-rect caching (Part 3.4 confirmed):** Both `PortTooltip.onMove` and `CableDrawController.findNearest` walk all port DOM nodes and call `getBoundingClientRect()` per port. On a 50-node patch this is ~100 `getBoundingClientRect` calls per mousemove event in each handler — a reflow each time. Caching port rects at drag-start / hover-start and invalidating on graph change is the win.
3. **`ObjectInteractionController` carries too much:** 1111 LOC handles clicks, drags, timers, message dispatch, and attribute-panel plumbing. Consider a future split: `ControlInteraction` (slider/numbox/button/toggle/message mouse UI), `MessageBus` (dispatch, s/r broadcast, bang delivery), `MetroTimers`, `AttributePanel`. Not urgent but would improve testability once test infra lands.

---

## 1.4 — Runtime graph audit

**Status: DEFERRED to a follow-up session.** Requires code instrumentation + browser profiling, which needs an active dev-server run.

### Plan for the measurement pass
1. Add a counter in `VisualizerGraph.rewireMedia()` and any equivalent rewire path in `AudioGraph`. Log increments to console during a scripted test patch.
2. Construct a 20-node test patch: 1× visualizer, 2× layer, 3× mediaVideo/Image, 2× vfx effects, plus control nodes. Save via serializer; load from parse.
3. Measure three scenarios:
   - Drag a node (no topology change) — expected: **zero** rewires. If non-zero, that is a bug and the first Part 3 win.
   - Add an edge between two visual nodes — expected: exactly one rewire.
   - Delete a layer — expected: exactly one rewire.
4. Delete the counter afterward (it's diagnostic code, not shipping).

### Static observation (no instrumentation needed yet)
Grepping `src/runtime/VisualizerGraph.ts` shows the rewire path at lines 432–505 re-walks every `mediaVideo`/`vfxCRT`/`vfxBlur`/`imageFX`/`mediaImage` connected upstream of every layer, every time. No memoization. On a 20-node patch this is still cheap; on a 100-node patch it will show up in a profile.

---

## 1.5 — CSS / token audit

### Hex colors outside `tokens.css` (Design Rule 3 violations)
`src/shell.css` holds the only violations. All of them:

| line | literal | context | severity | fix |
|------|---------|---------|:--------:|-----|
| 55 | `#050806` | body background gradient stop | low | It is literally `--pn-bg`. Swap for `var(--pn-bg)`. |
| 881 | `#6a91ff` | visualizer object border color-mix | **medium** | New blue that isn't tokenized. Add `--pn-visualizer` to `tokens.css`, reuse it. |
| 1505, 1507–1510 | `#111`, `#1a1a1a` (×4) | imageFX checkerboard transparency indicator | low | Checkerboard is a graphics primitive; tokenize as `--pn-checker-bg` / `--pn-checker-tile`. |
| 1695 | `#6affee` | imageFX object border color-mix | **medium** | New cyan not tokenized. Add `--pn-imagefx` (or reuse `--pn-cyan`?), then replace. |

Fix cost: ~15 minutes. Recommend landing during Part 2.4 (Style consolidation).

### `rgba()` literals
96 occurrences in `shell.css`. The vast majority are glow/shadow variants of accent-green (`rgba(106, 255, 145, …)`), which is `--pn-accent` expressed as R/G/B literals.

**Recommendation:** do not chase a 100% conversion. Modern CSS's `color-mix(in srgb, var(--pn-accent) X%, transparent)` is the right replacement for glows, but there are legitimate cases (shadow rgba with opacity) where token-ization adds noise without benefit. Target only glow/shadow declarations that currently have matching design intent elsewhere (e.g., `--pn-shadow-soft`) and move them under a shared token. Save 30–40% of the occurrences, leave the rest.

### `!important` usage
44 occurrences. Classification:

| group | count | load-bearing? | notes |
|-------|:-----:|:-------------:|-------|
| Cursor-system (`body.pn-state-*` + `cursor: var(--pn-cursor-*) !important`) | ~18 | **yes** | Documented in `DESIGN_LANGUAGE.md` as the cursor coordination system — `!important` is required to beat default `cursor: auto` on every element during pan/drag states. |
| Patch-object border/box-shadow overrides for selection/active states | ~10 | partial | Could be removed by reordering selectors so the state class wins by natural specificity. Low priority. |
| Slider thumb visual overrides (`-webkit-slider-thumb`) | ~8 | **yes** | Vendor-prefixed pseudo-elements resist specificity; `!important` is the pragmatic tool. |
| Miscellaneous (`padding: 0 !important`, `transform: none !important`) | ~8 | probably not | Audit during Part 2.4. |

No emergency. `!important` use is mostly deliberate.

---

## BLOCKER list — items too big to fix inline

These are items uncovered during the audit that shouldn't be handled as drive-by fixes. Mirrored into `AGENTS.md` so other agents see them.

### BLOCKER-1: No test infrastructure
**Severity:** medium
**Blocking:** Part 2 (Dead Code Removal) — deletions are evidence-based via knip but regression safety net is zero. Smoke tests are manual.
**Needs:** A decision on `vitest` vs. `jest`. Vitest is the obvious choice given Vite is the dev server. One round-trip serialize→parse test per object type is the starting bar.
**Owner:** Director + Codex.

### BLOCKER-2: Runtime graph rewire behavior unmeasured
**Severity:** low (performance only, no correctness risk today)
**Blocking:** Part 3 (Efficiency). Cannot optimize what isn't measured.
**Needs:** Instrumented counter + a scripted 20-node test patch. See section 1.4.
**Owner:** Codex (runtime owner).

### BLOCKER-3: Controller precedence chain undocumented
**Severity:** medium (correctness)
**Blocking:** Part 1.3 completion, Part 2.3 (duplicate helpers — need to know which controller owns coordinate conversion before consolidating `canvas/coords.ts`).
**Needs:** Full read of the 9 controllers in `src/canvas/`. Section 1.3 deferred.
**Owner:** Director.

### BLOCKER-4: `dist/` committed to repo
**Severity:** very low (hygiene)
**Blocking:** nothing, but pollutes `knip` output.
**Needs:** Add `dist/` to `.gitignore`, delete committed files. Trivial PR.
**Owner:** anyone.

---

## What's done in this audit pass
- 1.1 ✓ dependency map landed (above)
- 1.2 ✓ inventory landed (`docs/objects/INVENTORY.md`)
- 1.3 ✓ controller responsibility map landed (above) — BLOCKER-3 **RESOLVED**
- 1.4 ✗ deferred — see BLOCKER-2 (requires browser profiling)
- 1.5 ✓ CSS/token audit landed (above)

## Next-session starting points (in priority order)
1. Land the mechanical wins from 1.1 + 1.5 + 1.3 as Part 2 PRs:
   - 2.1 delete unused exports (`derivePortsFromCode`, redundant `PortType` re-export)
   - 2.3 extract `src/canvas/coords.ts` — confirmed duplication across 4 controllers
   - 2.4 convert shell.css hex violations to tokens
2. Start Part 4 (OBJECT_RECIPE.md + reference-page template) in parallel — doesn't depend on BLOCKER-2.
3. BLOCKER-2 (runtime instrumentation) — addressable when a dev-server session is available.
