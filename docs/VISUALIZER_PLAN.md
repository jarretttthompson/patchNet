# patchNet — Visualizer System Plan

**Author:** Claude Code (Director)
**Status:** Draft — awaiting greenlight
**Target agents:** Cursor (UI/canvas/CSS), Codex (runtime/graph wiring)

---

## Overview

Four new objects form a visual output pipeline modeled after Max/Jitter:

```
mediaVideo ──► layer (ctx "world", priority 1) ──► visualizer ("world")
mediaImage ──► layer (ctx "world", priority 0) ──┘     │
                                                        ▼
                                              [popup canvas window]
```

| Object | Analogous Max object | Role |
|---|---|---|
| `visualizer` | `jit.world` | Creates & manages a named popup render window |
| `mediaVideo` | `jit.movie` | Loads and plays a video file |
| `mediaImage` | `jit.matrix` (still) | Loads a still image |
| `layer` | `jit.layer` | Composites one media source into a visualizer at a given priority |

---

## Object Specifications

### `visualizer`

**Args:** `[name]` — the render context name (default: auto-generated `"world1"`, `"world2"`, …)

**Inlets:**
- 0 `any` — `bang`: open/show window · `"close"`: hide it · `"size w h"`: resize · `"pos x y"`: move

**Outlets:**
- 0 `bang` — fires when window opens
- 1 `bang` — fires when window closes

**Behavior:**
- Registers itself in `VisualizerRegistry` under its name on creation; unregisters on deletion
- Opens a detached `window.open()` popup containing a `<canvas>` element
- The popup runs its own `requestAnimationFrame` render loop
- Each frame: sorts all registered layers for this context by priority (ascending = back, so 0 is drawn last = on top), composites each onto the canvas in that order
- Multi-screen: exposes `"pos x y"` and `"size w h"` messages that call `popupWindow.moveTo()` / `popupWindow.resizeTo()`
- The popup window header shows the context name

**Default size:** 640 × 480

---

### `mediaVideo`

**Args:** `[filepath]` — optional; can be set later via double-click or drag-and-drop

**Inlets:**
- 0 `any` — `bang`: toggle play/pause · `"play"`: play · `"stop"`: stop · `"seek f"`: seek to normalized position (0.0–1.0) · `"open"`: open file picker

**Outlets:**
- 0 `media` — emits a reference to the internal `HTMLVideoElement` (consumed by `layer`)
- 1 `float` — normalized playback position (0.0–1.0) on each frame tick

**Double-click behavior:**
- `ObjectInteractionController` intercepts `dblclick` on `[data-node-id]` nodes of type `mediaVideo`
- Triggers an `<input type="file" accept="video/*">` click
- On file selected: creates an object URL, stores it in `node.args[0]`, emits graph change
- The `MediaVideoRuntime` picks up the new URL and loads it into the `HTMLVideoElement`

**Drag-and-drop behavior (onto canvas):**
- `CanvasController` listens for `dragover` / `drop` on `canvasArea`
- Checks `event.dataTransfer.files[0]` MIME type
- If `video/*` → creates a `mediaVideo` node at drop coordinates with the file URL as arg
- If `image/*` → creates a `mediaImage` node instead
- Both cases create an object URL and store it as `node.args[0]`

---

### `mediaImage`

**Args:** `[filepath]` — optional

**Inlets:**
- 0 `any` — `bang`: output current image · `"open"`: open file picker

**Outlets:**
- 0 `media` — emits a reference to the loaded `HTMLImageElement` / `ImageBitmap`

**Double-click and drag-and-drop:** identical flow to `mediaVideo`, filter `accept="image/*"`.

---

### `layer`

**Args:** `[context-name] [priority]`
- `context-name` — which visualizer to draw into (default: first active visualizer name, or `"world1"`)
- `priority` — integer draw order; **lower number = drawn later = on top** (0 = topmost layer)
  - Rationale: same as Max — priority 0 is the "foreground" layer

**Inlets:**
- 0 `media` — receives a media reference from `mediaVideo` or `mediaImage`

**Outlets:** none

**Behavior:**
- On graph change: reads `node.args[0]` (context name) and `node.args[1]` (priority), registers with the named visualizer in `VisualizerRegistry`
- Stores the last received media reference so the visualizer's render loop can pull from it each frame
- When the connected media source is removed or the cable is disconnected, clears its slot in the visualizer

---

## Architecture

### New files

```
src/
  runtime/
    VisualizerRuntime.ts     — singleton; owns the VisualizerRegistry
    VisualizerGraph.ts       — mirrors AudioGraph; syncs PatchGraph → runtime objects
    VisualizerNode.ts        — manages one popup window + canvas + rAF loop
    MediaVideoNode.ts        — wraps HTMLVideoElement; exposes current frame
    MediaImageNode.ts        — wraps HTMLImageElement / ImageBitmap
    LayerNode.ts             — registered with a VisualizerNode; has priority + media ref
  canvas/
    VisualizerObjectUI.ts    — double-click handler + file picker for mediaVideo/mediaImage
  graph/
    objectDefs.ts            — add entries for visualizer, mediaVideo, mediaImage, layer
    ObjectEntryBox.ts        — add all four to VALID_TYPES
```

### VisualizerRegistry

```typescript
// Singleton map — context name → VisualizerNode
class VisualizerRegistry {
  static readonly instance = new VisualizerRegistry();
  private nodes = new Map<string, VisualizerNode>();
  register(name: string, node: VisualizerNode): void { ... }
  unregister(name: string): void { ... }
  get(name: string): VisualizerNode | undefined { ... }
  firstActive(): VisualizerNode | undefined { ... }
}
```

### Render loop (inside VisualizerNode)

```
rAF callback:
  ctx.clearRect(0, 0, w, h)
  layers = sort(this.layers, by priority descending)   ← higher number drawn first (background)
  for layer of layers:
    media = layer.currentMedia
    if media is HTMLVideoElement and not paused → ctx.drawImage(media, 0, 0, w, h)
    if media is HTMLImageElement / ImageBitmap  → ctx.drawImage(media, 0, 0, w, h)
```

Layer priority semantics: layers with **higher** priority numbers are drawn **first** (background); layers with **lower** priority numbers are drawn **last** (foreground/on top). So priority 0 wins.

### Data flow through cables

The `layer` inlet receives a `media` typed message. In the runtime, `VisualizerGraph` detects edges of the form `(mediaVideo|mediaImage) → layer` and calls `layerNode.setMedia(mediaNode)`. The layer stores a reference; the visualizer's rAF loop reads it.

This avoids passing raw pixel buffers over the message system — the layer holds a live reference to the `HTMLVideoElement` / `HTMLImageElement` and lets `drawImage` do the sampling each frame.

---

## Popup Window Notes

### Opening
```typescript
const popup = window.open(
  "",
  contextName,
  `width=${w},height=${h},left=${x},top=${y},resizable=yes,scrollbars=no`
);
popup.document.title = `patchNet — ${contextName}`;
// inject canvas into popup.document.body
```

### Multi-screen positioning
- `popup.moveTo(screenX, screenY)` — works across screens; browser may clamp to available area
- `popup.resizeTo(w, h)`
- The `"pos x y"` and `"size w h"` messages on the `visualizer` inlet call these

### Popup blockers
- The popup must be opened in direct response to a user gesture (clicking the object or sending a `bang`)
- Document this clearly — a bang from a `metro` will NOT reliably open a popup

---

## Implementation Phases

### Phase A — Foundation (Codex)
1. Add `visualizer`, `mediaVideo`, `mediaImage`, `layer` to `objectDefs.ts` and `ObjectEntryBox.ts`
2. Implement `VisualizerRuntime`, `VisualizerRegistry`, `VisualizerNode` (popup + canvas + rAF)
3. Implement `VisualizerGraph` (graph change listener, node lifecycle)
4. Wire into `main.ts` alongside `AudioGraph`
5. `visualizer` object: bang opens popup, basic render loop running (black canvas)

**Acceptance:** place a `visualizer` object, bang it, popup appears with black canvas.

### Phase B — Media objects (Codex + Cursor)
1. Implement `MediaVideoNode` and `MediaImageNode`
2. Implement `VisualizerObjectUI` — double-click → file picker → store URL in node args
3. Add drag-and-drop to `CanvasController`: detect file MIME on canvas drop, create appropriate node
4. `mediaVideo`/`mediaImage` objects render their file path or name as the object label

**Acceptance:** double-click `mediaVideo`, pick a file, object label updates to filename.

### Phase C — Layer compositing (Codex)
1. Implement `LayerNode`
2. `VisualizerGraph` wires `media → layer → visualizer` connections
3. Priority sorting in rAF loop
4. Test: two `mediaImage` objects → two `layer` objects at priority 0 and 1 → one `visualizer` → correct z-order

**Acceptance:** two images composited in correct priority order in popup window.

### Phase D — Controls & polish (Cursor)
1. `visualizer` object UI: show context name as label, show open/closed state visually
2. `mediaVideo` playback controls (play/pause via inlet messages)
3. Popup window resize/move persistence (store in node args)
4. Error states: missing file, popup blocked, unknown context name

---

## Open Questions / Decisions Needed

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | Rendering backend | Canvas2D vs WebGL | Start Canvas2D; WebGL only if shader support is added later |
| 2 | Popup vs in-page overlay | `window.open()` vs floating `<div>` | `window.open()` for multi-screen; fallback overlay if blocked |
| 3 | Drag-and-drop file URL | `URL.createObjectURL()` vs base64 | Object URL — much smaller memory footprint for video |
| 4 | Object URL persistence | Object URLs are tab-session only | Store original filename in args for display; re-prompt on reload |
| 5 | Layer transform | Scale-to-fit vs pixel-exact | Scale-to-fit (CSS `object-fit: contain` equivalent via `drawImage`) |
| 6 | Video looping | Always loop vs configurable | Default loop-on; `"loop 0"` / `"loop 1"` inlet message to toggle |
