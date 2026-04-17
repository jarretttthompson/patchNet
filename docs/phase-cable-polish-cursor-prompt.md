# Cursor Task — Patch Cable UX Polish

You are working on **patchNet**, a browser-based visual patching environment (Pure Data / Max MSP style). This is vanilla TypeScript + Vite — no React, no framework.

Read `AGENTS.md` before starting. Append a completion entry when done.

---

## What You Are Fixing

The patch cable system works but feels clunky. There are 8 specific issues to fix across 4 files plus `main.ts`. Each fix is described below with exact locations and instructions.

**Files you will touch:**
- `src/canvas/CableRenderer.ts`
- `src/canvas/CableDrawController.ts`
- `src/canvas/CanvasController.ts`
- `src/canvas/DragController.ts`
- `src/shell.css`

`src/main.ts` is already wired correctly — do not touch it unless a fix explicitly requires it.

---

## Fix 1 — Live cables during object drag

**File:** `src/canvas/CableRenderer.ts`

**Problem:** Cables snap to their new endpoints only after mouseup. During drag, cables stay frozen at the object's old position. This is the biggest source of clunkiness.

**How it works today:** `render()` reads all positions from `graph.nodes`. `main.ts` already silently updates `node.x` / `node.y` during drag (lines 86–89 of `main.ts`) and then calls `cables.render()`. So `render()` already has correct position data mid-drag — it just isn't being called.

**Check `main.ts` first.** Look at the `DragController` constructor call (around line 85). The `onMove` callback already does:
```ts
const node = graph.nodes.get(nodeId);
if (node) { node.x = x; node.y = y; }
cables.render();
```

If this is already there, Fix 1 is **already implemented** and you can skip it. If `cables.render()` is not being called from `onMove`, add it.

---

## Fix 2 — Re-patch from either cable end

**File:** `src/canvas/CableDrawController.ts`, `handleMouseDown` method

**Problem:** When a cable is selected and you click one of its endpoint ports to re-patch, the code always roots the new draw from the **outlet end**, even if you clicked the inlet end. You can't rewire the inlet end independently.

**Current code (around line 100–125):**
```ts
if (shouldRepatch) {
  // ... always uses edge.fromNodeId (outlet) as fixed anchor
  const from = getPortPos(fromNode, "outlet", edge.fromOutlet);
  this.draw = {
    fixedNodeId: edge.fromNodeId,
    fixedPortIndex: edge.fromOutlet,
    fixedIsInlet: false,   // ← always outlet
    ...
  };
```

**Fix:** Detect which end port was clicked. If the user clicked the **outlet** port, anchor the outlet and let the user drag a new inlet. If the user clicked the **inlet** port, anchor the inlet and let the user drag a new outlet.

Replace the re-patch block with logic like this:
```ts
if (shouldRepatch) {
  e.preventDefault();
  e.stopImmediatePropagation();
  this.graph.removeEdge(edge.id);
  this.cables.selectEdge(null);

  // Determine which end was clicked
  const clickedInlet =
    portEl?.classList.contains("patch-port-inlet") &&
    portEl.closest<HTMLElement>(".patch-object")?.dataset.nodeId === edge.toNodeId &&
    parseInt(portEl.dataset.portIndex ?? "0", 10) === edge.toInlet;

  const canvasRect = this.canvasEl.getBoundingClientRect();
  const cursorX = e.clientX - canvasRect.left;
  const cursorY = e.clientY - canvasRect.top;

  if (clickedInlet) {
    // User grabbed the inlet end — anchor the outlet, drag a new inlet
    const toNode = this.graph.nodes.get(edge.toNodeId);
    if (!toNode) { this.cancel(); return; }
    const anchor = getPortPos(toNode, "inlet", edge.toInlet);
    this.draw = {
      fixedNodeId: edge.toNodeId,
      fixedPortIndex: edge.toInlet,
      fixedIsInlet: true,
      x1: anchor.x,
      y1: anchor.y,
    };
    this.cables.startGhost(anchor.x, anchor.y, cursorX, cursorY);
  } else {
    // User grabbed the outlet end (or the object body) — anchor the outlet
    const anchor = getPortPos(fromNode, "outlet", edge.fromOutlet);
    this.draw = {
      fixedNodeId: edge.fromNodeId,
      fixedPortIndex: edge.fromOutlet,
      fixedIsInlet: false,
      x1: anchor.x,
      y1: anchor.y,
    };
    this.cables.startGhost(anchor.x, anchor.y, cursorX, cursorY);
  }

  document.addEventListener("mousemove", this.onMouseMove);
  document.addEventListener("mouseup", this.onMouseUp);
  return;
}
```

---

## Fix 3 — Re-patch must not trigger from object body clicks

**File:** `src/canvas/CableDrawController.ts`, `handleMouseDown` method

**Problem:** The current `shouldRepatch` check has a fallback (around lines 96–99) that triggers re-patch when you click anywhere on the body of either connected object — not just the port nubs. This means: select a cable, then try to click/drag either connected object → accidental re-patch instead of the expected object drag.

**Current offending code:**
```ts
} else {
  // This branch fires on object body click — should be removed
  const objectEl = target.closest<HTMLElement>(".patch-object");
  const nodeId = objectEl?.dataset.nodeId;
  shouldRepatch = nodeId === edge.fromNodeId || nodeId === edge.toNodeId;
}
```

**Fix:** Delete the entire `else` branch. `shouldRepatch` should only become `true` when `portEl` is non-null and matches an actual endpoint port. Without the `else`, clicking an object body while a cable is selected will fall through to normal object selection behavior.

---

## Fix 4 — Increase snap radius and improve ghost cable visibility

**File:** `src/canvas/CableDrawController.ts`

**Problem:** `findNearest` uses `bestDist = 36`. Port nubs are 8px — 36px requires cursor precision that feels fiddly. Raise it to `52`.

Find:
```ts
let bestDist = 36;
```
Change to:
```ts
let bestDist = 52;
```

---

**File:** `src/canvas/CableRenderer.ts`, `startGhost` method

**Problem:** Ghost cable is `opacity: 0.55` with `stroke-dasharray: "5 4"` — too dim and the gaps make it hard to track visually during fast drags.

Find:
```ts
line.setAttribute("stroke-dasharray", "5 4");
line.setAttribute("opacity", "0.55");
```
Change to:
```ts
line.setAttribute("stroke-dasharray", "8 5");
line.setAttribute("opacity", "0.82");
```

---

## Fix 5 — Port hover highlight before drawing starts

**File:** `src/shell.css`

**Problem:** Port nubs are visually static when hovered. There's no pre-draw affordance showing they're interactive — only the crosshair cursor change gives a hint.

Add this rule after the existing `.patch-port` block (the one with `pointer-events: all; cursor: crosshair`). Do not alter the snap or endpoint highlight rules:

```css
/* Pre-draw hover affordance — nub glows slightly on cursor approach */
.patch-port:hover {
  transform: translate(-50%, -50%) scale(1.35) !important;
  box-shadow:
    0 0 8px var(--pn-accent),
    0 0 18px rgba(106, 255, 145, 0.45) !important;
  transition: transform 0.07s ease, box-shadow 0.07s ease;
}
```

Note: The `:hover` rule will be suppressed by cable hit lines (z-index 5, pointer-events: stroke) when a cable is already connected — that's acceptable and expected. The tooltip system already works around this via proximity detection.

---

## Fix 6 — Widen cable hit area

**File:** `src/canvas/CableRenderer.ts`, `render` method

**Problem:** The invisible hit line uses `stroke-width: 12`, which is narrow when cables run close together.

Find:
```ts
hit.setAttribute("stroke-width", "12");
```
Change to:
```ts
hit.setAttribute("stroke-width", "18");
```

---

## Fix 7 — Alt-click to delete cable

**File:** `src/canvas/CanvasController.ts`, `handleCableClick` method

**Problem:** The only way to delete a cable is: click to select it, then press Delete/Backspace. Industry convention (PD, Max) is Alt/Option-click on a cable to delete it immediately.

Current `handleCableClick`:
```ts
private handleCableClick(e: MouseEvent): void {
  if (!this.cables) return;
  const edgeId = this.cables.edgeIdFromEvent(e);
  if (edgeId) {
    this.selectNode(null);
    this.cables.selectEdge(
      this.cables.getSelectedEdgeId() === edgeId ? null : edgeId,
    );
  }
}
```

Replace with:
```ts
private handleCableClick(e: MouseEvent): void {
  if (!this.cables) return;
  const edgeId = this.cables.edgeIdFromEvent(e);
  if (!edgeId) return;

  if (e.altKey) {
    // Alt-click: immediate delete, no selection step
    this.cables.selectEdge(null);
    this.graph.removeEdge(edgeId);
    return;
  }

  this.selectNode(null);
  this.cables.selectEdge(
    this.cables.getSelectedEdgeId() === edgeId ? null : edgeId,
  );
}
```

---

## Fix 8 — Fix drag clamping at canvas edge

**File:** `src/canvas/DragController.ts`, `handleMouseMove` method

**Problem:** Dragged objects are clamped to `canvasEl.clientWidth / clientHeight` (the visible viewport). On a scrolled canvas, objects near the viewport right/bottom edge get stuck and can't be dragged further, even though there's empty pan-group space beyond.

Current code (around lines 203–206):
```ts
const maxX = this.canvasEl.clientWidth - el.offsetWidth;
const maxY = this.canvasEl.clientHeight - el.offsetHeight;
```

Fix — use `scrollWidth / scrollHeight` instead, which reflects the full pan-group extent:
```ts
const maxX = this.canvasEl.scrollWidth - el.offsetWidth;
const maxY = this.canvasEl.scrollHeight - el.offsetHeight;
```

---

## Constraints — Do Not Violate

- **Straight cables only** — do not change the SVG `<line>` approach to curves or bezier paths
- **CSS tokens only** — no hardcoded hex colors anywhere; use `var(--pn-*)` tokens
- **No new dependencies** — vanilla TypeScript only
- **`npm run build` must pass with zero TypeScript errors** before you log completion

---

## When Done

Run `npx tsc --noEmit` and `npm run build`. If both pass, append a completion entry to `AGENTS.md` in this format:

```
---
## [2026-04-16] COMPLETED | Patch cable UX polish
**Agent:** Cursor
**Phase:** Cable polish pass
**Done:**
- bullet list of each fix completed

**Changed files:**
- src/canvas/CableRenderer.ts — [what changed]
- src/canvas/CableDrawController.ts — [what changed]
- src/canvas/CanvasController.ts — [what changed]
- src/canvas/DragController.ts — [what changed]
- src/shell.css — [what changed]

**Notes / decisions made:**
- any deviations or edge cases encountered

**Next needed:**
- browser validation of all 8 fixes
---
```
