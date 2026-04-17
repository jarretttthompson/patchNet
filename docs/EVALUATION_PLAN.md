# patchNet — Evaluation & Hardening Plan

A four-part work plan for a full-codebase sweep: (1) audit what we have,
(2) cut dead code, (3) improve efficiency, (4) formalize a repeatable
object-development method, (5) ship a Reference tab in the console area.

Draft date: 2026-04-17 · Owner: Director (Claude Code), with Cursor/Codex.

---

## Part 1 — Project Evaluation

Goal: an honest map of what exists, what's used, and where the architecture
is fraying. Output a single `AUDIT.md` checked into `docs/`.

### 1.1 Build a dependency map
- Walk `src/` and record every export + its importers.
- Flag **orphan modules** (exported but never imported) and **unreachable
  exports** (imported but never called by any reachable path from `main.ts`).
- Tooling: `ts-prune` or `knip` run against `tsconfig.json`. Do not hand-roll.

### 1.2 Catalog every object type
Produce `docs/objects/INVENTORY.md` with one row per type:

| type | category | has spec? | renderer branch | runtime node | messages doc | tests |
|------|----------|-----------|-----------------|--------------|--------------|-------|

Gaps surface immediately: objects that render but have no runtime, specs
with no renderer, etc. Expected gaps today: `scale`, `integer`, `float`,
`vfxBlur`, `vfxCRT` only have partial spec coverage.

### 1.3 Controller responsibility map
List every controller under `src/canvas/` with:
- What events it listens to
- What DOM it mutates
- What graph state it reads/writes
- Who calls its public API

Concrete suspicion to verify: `CanvasController`, `ObjectInteractionController`,
and `DragController` all bind `mousedown` on `panGroup` — document the
precedence chain and confirm no hidden priority bug.

### 1.4 Runtime graph audit
`VisualizerGraph` and `AudioGraph` both re-derive topology from the
`PatchGraph` on every edit. Measure:
- How often `rewireMedia()` / audio rewire runs (add counter, delete later)
- Per-rewire cost in a 20-node patch
- Whether changes that don't affect signal topology still trigger rewire

### 1.5 CSS / token audit
Grep `src/` for any hex color not inside `tokens.css` — each one is a
violation of Design Rule 3 in `CLAUDE.md`. Grep for `!important` usages
and document which are load-bearing (cursor system) vs. accidental.

**Deliverables at end of Part 1:**
- `docs/AUDIT.md`
- `docs/objects/INVENTORY.md`
- A short BLOCKER list in `AGENTS.md` for items too big to fix inline.

---

## Part 2 — Dead Code Removal

Gate: Part 1 must land first so deletions are evidence-based, not vibes.

### 2.1 Safe deletions (mechanical)
From `ts-prune` output, delete:
- Orphan modules with zero importers
- Exports that survive only because of a re-export chain
- Commented-out code blocks > 3 lines

Commit per-category, not all-at-once — easier to revert a bad call.

### 2.2 Feature-flag sweeps
Search for:
- `TODO`, `FIXME`, `XXX`, `HACK` → triage: file a ticket or delete
- `if (false)` / `if (0)` guards
- Dead branches in switch statements (types that were removed)

### 2.3 Duplicate helpers
High-suspicion pairs to check:
- Coordinate conversion: `getGraphCoords` in CanvasController vs. ad-hoc
  `(clientX - rect.left) / zoom` in other controllers. Extract
  `canvas/coords.ts` with `mouseToIntrinsic(e, panGroupEl)`.
- Port geometry: `getPortPos` formula path vs. DOM-query path. Unify with
  a single source of truth that always reads from DOM after layout.
- Number formatting: `buildNumboxContent` and the codebox value formatter
  both format floats — consolidate.

### 2.4 Style consolidation
After the CSS audit, collapse duplicated rules and hoist any remaining
literal colors into `tokens.css`.

**Deliverable:** one PR per category (mechanical deletes, duplicates, CSS).
Each PR passes type-check + smoke-test (open app, place one of each object,
verify nothing renders blank).

---

## Part 3 — Efficiency Improvements

Gate: don't optimize before profiling. Use Chrome DevTools Performance
panel on a 50-node patch to find real hot paths.

### 3.1 Render granularity
Today every `graph.emit("change")` triggers:
- Full object re-render in `main.ts:209-230`
- Full cable re-render in `CableRenderer.render()`
- Full text panel re-sync

Wins to chase:
- **Diff the node set** on render — only create/update/remove changed DOM.
  We already have `existingObjects` map in `main.ts` — extend it to skip
  unchanged nodes.
- **Cable render uses `innerHTML = ""`** equivalent — switch to keyed diff
  by edge ID. Most edges don't move.
- **Text panel debounce** — already fires on every change; debounce to
  `requestAnimationFrame` so rapid drags don't thrash `.value =`.

### 3.2 Visualizer / vFX chain
- `VfxCrtNode` and `VfxBlurNode` allocate new canvases in constructors.
  Verify they're pooled or destroyed cleanly on edge removal.
- `VisualizerNode` runs `requestAnimationFrame` in the main window — good
  fix from prior session. Confirm it halts when no `visualizer` node exists.

### 3.3 Event listener inventory
Several controllers add `document`-level listeners on every drag start.
Confirm matching `removeEventListener` on every code path — including
error exits. A single leaked mousemove listener per drag adds up.

### 3.4 Reflow hotspots
- `getBoundingClientRect` inside tight loops (CableDrawController's
  `findNearest` over all ports, PortTooltip `onMove`). Cache port rects
  at drag/hover start and invalidate on graph change.
- Setting `style.left`/`style.top` during drag triggers layout. Consider
  `transform: translate` for the dragged element + co-movers, committing
  to `left/top` only on mouseup.

**Success metric:** drag a 10-node selection on a 50-node patch at >55 fps
on a mid-tier laptop.

---

## Part 4 — Standardized Object Development

We already have `docs/object-spec-standard.md`. Extend it into a repeatable
method so anyone (human or agent) can add a new object without reading
the entire codebase.

### 4.1 The Object Recipe (one page, in `docs/OBJECT_RECIPE.md`)
A numbered checklist. Every new object follows it. Every step cites the
file to edit.

1. **Spec** — add entry to `OBJECT_DEFS` in `src/graph/objectDefs.ts`
   with full `ArgDef[]` and `MessageDef[]`.
2. **Entry-box allowlist** — append the type string to `VALID_TYPES` in
   `src/canvas/ObjectEntryBox.ts`.
3. **Renderer branch** — extend the switch in `src/canvas/ObjectRenderer.ts`.
   If purely text-labeled, no branch needed.
4. **Interaction** — if UI, add `handleMouseDown` branch in
   `src/canvas/ObjectInteractionController.ts`; add `deliverMessageValue`
   branch; add `deliverBang` branch if it responds to bang.
5. **Runtime node** (if audio/video) — subclass in `src/runtime/`,
   register in `VisualizerGraph` / `AudioGraph`.
6. **CSS** — if the object has new UI, add scoped styles to `shell.css`
   using `--pn-*` tokens only.
7. **Reference page** — add `docs/objects/<type>.md` following the
   template in §4.2. The new Reference tab (Part 5) reads these at runtime.
8. **Smoke test** — place the object, connect one inlet/outlet, verify
   serialize→parse→render round-trip.

### 4.2 Reference-page template (`docs/objects/_TEMPLATE.md`)

```markdown
---
type: <name>
category: ui | control | audio | video
version: 1
---

# <name>

One-line description.

## Arguments
| # | name | type | default | description |
|---|------|------|---------|-------------|

## Inlets
| # | type | description |

## Outlets
| # | type | description |

## Messages
| inlet | selector | args | description |

## Examples
Minimal patch snippet (text form).

## Notes
Gotchas, Max/MSP-compat caveats, related objects.
```

Today only `docs/objects/message.md` exists. Backfill the rest during
Part 1's inventory pass.

### 4.3 CI gate
One lint script (`npm run lint:objects`) that enforces:
- Every key in `OBJECT_DEFS` has a `docs/objects/<type>.md`.
- Every key in `VALID_TYPES` exists in `OBJECT_DEFS`.
- Every reference page has required frontmatter fields.

Fail the build on drift. Prevents the current situation where the three
lists (defs, entry-box allowlist, docs) silently diverge.

### 4.4 Decision log
Every non-trivial object choice (why `slider` defaults 0–127, why `scale`
takes 4 args not a list) goes in `patchNet-Vault/wiki/entities/object-<name>.md`.
The Reference tab surfaces a "Notes" section from this file.

---

## Part 5 — Reference Tab in the Console Area

User-visible feature: a second tab in the console area alongside the text
panel. Shows the selected object's reference, or a searchable index of
all objects.

### 5.1 Data source
- At build time, Vite's `import.meta.glob("../docs/objects/*.md", { eager, as: "raw" })`
  bundles all reference pages as strings.
- Parse YAML frontmatter + markdown body at app init; keep an in-memory
  `Map<type, ObjectReference>`.
- `ObjectReference` is the `ObjectSpec` + parsed markdown sections.

### 5.2 UI shell
New DOM structure in `index.html` console area:

```html
<div class="console-tabs" role="tablist">
  <button data-tab="text">Text</button>
  <button data-tab="reference">Reference</button>
</div>
<div data-tab-panel="text">…existing textarea…</div>
<div data-tab-panel="reference">
  <input class="pn-ref-search" placeholder="search objects…" />
  <div class="pn-ref-list"></div>
  <div class="pn-ref-detail"></div>
</div>
```

Styling reuses existing tokens. No new color values.

### 5.3 Behavior
- **Default view:** list of all objects sorted alphabetically, grouped by
  category. Click = show detail.
- **Search:** fuzzy match on type name, args, and description. Use a tiny
  handwritten scorer — no new dependency for a ~25-item list.
- **Selection sync:** when an object on the canvas is selected, the
  Reference tab auto-scrolls its list to that type and shows its detail
  (does not switch tabs on its own — just pre-loads).
- **Keyboard:** `/` focuses the search input from anywhere on the canvas
  (matching `n` / `b` / `t` convention).

### 5.4 Controller
`src/canvas/ReferenceTab.ts`:
- Constructor takes `(hostEl, graph, onObjectSelectedFromCanvas)`.
- Exposes `showReference(type)`, `setActiveTab("text" | "reference")`.
- Subscribes to `graph.on("select")` (new event, trivial to add to
  PatchGraph if not present).

### 5.5 Shipping order
1. Land Part 4's recipe + template first so the data source is coherent.
2. Backfill reference pages for all existing object types (inventory from
   Part 1).
3. Build the tab shell and search in isolation, behind a feature toggle
   in `main.ts` if needed.
4. Wire selection sync last — it touches `CanvasController.selectNode`.

**Done criteria:**
- Placing any object and selecting it pre-loads its reference.
- Typing `/` opens search, typing `metro` shows its reference in under
  100ms.
- Every object in `OBJECT_DEFS` has a visible reference page.

---

## Sequencing

| Phase | Depends on | Rough effort |
|-------|------------|--------------|
| 1. Audit | — | 1 session |
| 2. Dead-code cleanup | Part 1 | 1 session per category |
| 3. Efficiency | Parts 1–2 | 2 sessions (profile + fix) |
| 4. Object recipe + CI | Part 1 (inventory) | 1 session |
| 5. Reference tab | Part 4 | 2 sessions |

Parts 1, 2, 3 can overlap Part 4; Part 5 is the only one that hard-blocks
on Part 4 because it consumes the reference-page format.

---

## Risks & tradeoffs

- **`ts-prune` false positives** for modules only used via string-based
  DOM queries or dynamic imports. Review by hand before deleting.
- **Render-diff regressions** are easy to introduce. Keep the naive
  re-render as a `?debug=nodiff` fallback during Part 3.
- **Reference tab drift** — the CI gate in Part 4.3 is the only thing
  that keeps docs and code aligned long-term. Don't skip it.
