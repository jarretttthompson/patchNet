# Codex Prompt — patchNet Visualizer Phase A

You are implementing the **foundation of the visualizer system** for patchNet — a browser-based visual programming environment built with vanilla TypeScript + Vite. This is a self-contained implementation task. **Read every file listed below before touching code.**

---

## Working directory

`/Users/user/vibing/patchNet`

---

## What you are building

Four new objects form the visual output pipeline:

```text
mediaVideo ──► layer ──► visualizer ("world1")  →  [popup canvas window]
mediaImage ──► layer ──┘
```

**Phase A scope only:**

- Register `visualizer`, `mediaVideo`, `mediaImage`, and `layer` in the object registry
- Make all four placeable from the right-click menu and object entry autocomplete
- Implement a visualizer runtime with popup window + canvas + `requestAnimationFrame` loop
- Implement a graph-sync layer that mirrors `PatchGraph` nodes into visualizer runtime nodes
- Wire visualizer message delivery into the existing interaction controller
- Render the new objects cleanly on canvas

**Not in scope for Phase A:**

- file pickers
- drag-and-drop
- media playback
- layer compositing beyond a stub structure
- WebGL, shaders, filters
- new npm dependencies

**Acceptance for Phase A:** place a `visualizer` object, trigger a bang on inlet 0, and a popup window opens titled `patchNet — world1` with a black canvas and a running render loop.

---

## Current architecture baseline

This repo has moved past the original scaffold. Your implementation must match the current codebase, not an earlier draft.

Important current facts:

- `src/graph/objectDefs.ts` already exports `ObjectSpec` with `category: "ui" | "control" | "audio" | "scripting"`
- `src/graph/PatchNode.ts` currently defines `PortType = "bang" | "float" | "signal" | "any" | "message"`
- `src/canvas/ObjectInteractionController.ts` already has `setAudioGraph(...)`, `setCodeboxController(...)`, public `deliverBang(...)`, and public `deliverMessageValue(...)`
- `src/main.ts` already instantiates `AudioRuntime`, `AudioGraph`, and `CodeboxController`
- `src/canvas/ObjectEntryBox.ts` owns the autocomplete type list via `VALID_TYPES`
- `src/canvas/CanvasController.ts` owns the right-click placement menu via its local `OBJECT_TYPES`
- `src/canvas/ObjectRenderer.ts` already branches for UI, audio, and codebox rendering
- `src/shell.css` is the canonical stylesheet; do not add extra CSS files

Use those patterns. Do not invent a parallel subsystem.

---

## Files you must read before editing

```text
src/graph/PatchNode.ts
src/graph/objectDefs.ts
src/graph/PatchGraph.ts
src/canvas/ObjectInteractionController.ts
src/canvas/ObjectRenderer.ts
src/canvas/ObjectEntryBox.ts
src/canvas/CanvasController.ts
src/runtime/AudioRuntime.ts
src/runtime/AudioGraph.ts
src/main.ts
src/shell.css
docs/VISUALIZER_PLAN.md
AGENTS.md
```

---

## Step-by-step deliverables

### 1. Add `"media"` to `PortType` in `src/graph/PatchNode.ts`

Update:

```typescript
export type PortType = "bang" | "float" | "signal" | "any" | "message" | "media";
```

No other `PatchNode` API changes are required in this phase.

---

### 2. Add `"visual"` to the `ObjectSpec.category` union and register all four objects in `src/graph/objectDefs.ts`

Update the category union:

```typescript
category: "ui" | "control" | "audio" | "scripting" | "visual";
```

Then add these `OBJECT_DEFS` entries:

```typescript
visualizer: {
  description: "Creates a named popup render window for compositing visual layers.",
  category: "visual",
  args: [
    {
      name: "name",
      type: "symbol",
      default: "world1",
      description: "Render context name used by layer objects to target this window.",
    },
  ],
  messages: [
    { inlet: 0, selector: "bang", description: "open / show the popup window" },
    { inlet: 0, selector: "close", description: "hide the popup window" },
    { inlet: 0, selector: "size", description: "resize window: size <w> <h>" },
    { inlet: 0, selector: "pos", description: "move window: pos <x> <y>" },
  ],
  inlets: [
    { index: 0, type: "any", label: "bang | close | size w h | pos x y" },
  ],
  outlets: [
    { index: 0, type: "bang", label: "bang: window opened" },
    { index: 1, type: "bang", label: "bang: window closed" },
  ],
  defaultWidth: 120,
  defaultHeight: 30,
},

mediaVideo: {
  description: "Video media source. File loading lands in Phase B.",
  category: "visual",
  args: [
    {
      name: "file",
      type: "symbol",
      default: "",
      description: "Video file path or object URL.",
    },
  ],
  messages: [
    { inlet: 0, selector: "bang", description: "toggle play / pause (Phase B)" },
    { inlet: 0, selector: "play", description: "start playback (Phase B)" },
    { inlet: 0, selector: "stop", description: "stop playback (Phase B)" },
    { inlet: 0, selector: "seek", description: "seek to normalized position (Phase B)" },
    { inlet: 0, selector: "open", description: "open file picker (Phase B)" },
    { inlet: 0, selector: "loop", description: "set loop state (Phase B)" },
  ],
  inlets: [
    { index: 0, type: "any", label: "bang | play | stop | seek f | open | loop 0/1" },
  ],
  outlets: [
    { index: 0, type: "media", label: "video media out" },
    { index: 1, type: "float", label: "playback position (Phase B)" },
  ],
  defaultWidth: 100,
  defaultHeight: 30,
},

mediaImage: {
  description: "Still image media source. File loading lands in Phase B.",
  category: "visual",
  args: [
    {
      name: "file",
      type: "symbol",
      default: "",
      description: "Image file path or object URL.",
    },
  ],
  messages: [
    { inlet: 0, selector: "bang", description: "output image reference (Phase B)" },
    { inlet: 0, selector: "open", description: "open file picker (Phase B)" },
  ],
  inlets: [
    { index: 0, type: "any", label: "bang | open" },
  ],
  outlets: [
    { index: 0, type: "media", label: "image media out" },
  ],
  defaultWidth: 100,
  defaultHeight: 30,
},

layer: {
  description: "Targets a named visualizer and compositing priority.",
  category: "visual",
  args: [
    {
      name: "context",
      type: "symbol",
      default: "world1",
      description: "Target visualizer context name.",
    },
    {
      name: "priority",
      type: "int",
      default: "0",
      description: "Draw priority. Lower number = drawn later = on top.",
    },
  ],
  messages: [],
  inlets: [
    { index: 0, type: "media", label: "media in" },
  ],
  outlets: [],
  defaultWidth: 100,
  defaultHeight: 30,
},
```

Do not remove or regress existing object specs.

---

### 3. Add the new objects to autocomplete in `src/canvas/ObjectEntryBox.ts`

Update `VALID_TYPES` so it includes:

```typescript
const VALID_TYPES = [
  "button",
  "click~",
  "codebox",
  "dac~",
  "layer",
  "mediaImage",
  "mediaVideo",
  "message",
  "metro",
  "slider",
  "toggle",
  "visualizer",
] as const;
```

Keep the list alphabetical.

---

### 4. Add the new objects to the right-click menu in `src/canvas/CanvasController.ts`

Update that file’s `OBJECT_TYPES` list to include:

- `layer`
- `mediaImage`
- `mediaVideo`
- `visualizer`

Keep the menu consistent with the object entry box.

---

### 5. Create `src/runtime/VisualizerRuntime.ts`

Follow the singleton style used by `AudioRuntime.ts`.

Required shape:

```typescript
import { VisualizerNode } from "./VisualizerNode";

export class VisualizerRuntime {
  private static instance: VisualizerRuntime | null = null;

  static getInstance(): VisualizerRuntime {
    if (!VisualizerRuntime.instance) {
      VisualizerRuntime.instance = new VisualizerRuntime();
    }
    return VisualizerRuntime.instance;
  }

  private readonly nodes = new Map<string, VisualizerNode>();

  register(name: string, node: VisualizerNode): void { ... }
  unregister(name: string): void { ... }
  get(name: string): VisualizerNode | undefined { ... }
  getFirst(): VisualizerNode | undefined { ... }
  destroy(): void { ... }
}
```

Behavior:

- `register(name, node)` replaces any previous entry for the same name
- `destroy()` destroys every registered `VisualizerNode` and clears the map

No DOM work belongs here. This is just the registry singleton.

---

### 6. Create `src/runtime/LayerNode.ts`

This is a Phase A stub. It only needs enough structure so `VisualizerNode` can sort and later draw layers.

Use this shape:

```typescript
export class LayerNode {
  media: HTMLVideoElement | HTMLImageElement | null = null;

  constructor(
    public readonly patchNodeId: string,
    public priority: number,
  ) {}

  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.media) return;
    try {
      ctx.drawImage(this.media as CanvasImageSource, 0, 0, w, h);
    } catch {
      // media not ready yet
    }
  }
}
```

Even though Phase A does not wire media yet, keep `draw(...)` implemented so the render loop is structurally complete.

---

### 7. Create `src/runtime/VisualizerNode.ts`

This class manages one popup window, one canvas, and one `requestAnimationFrame` loop.

Required behavior:

- `open()` opens a popup or focuses an existing one
- popup title must be `patchNet — ${contextName}`
- popup body must contain exactly one black canvas that fills the window
- popup resize must resize the backing canvas
- render loop must clear black every frame and draw registered layers sorted by priority
- lower priority number means drawn later and therefore visually on top
- `close()` closes the popup and stops the loop
- `destroy()` closes everything and clears registered layers

Use this shape:

```typescript
import { LayerNode } from "./LayerNode";

export class VisualizerNode {
  private popup: Window | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private layers: LayerNode[] = [];

  constructor(
    public readonly contextName: string,
    private width = 640,
    private height = 480,
  ) {}

  open(): void { ... }
  close(): void { ... }
  moveTo(x: number, y: number): void { ... }
  resizeTo(w: number, h: number): void { ... }
  isOpen(): boolean { ... }

  addLayer(layer: LayerNode): void { ... }
  removeLayer(layer: LayerNode): void { ... }

  private startLoop(): void { ... }
  private stopLoop(): void { ... }
  private drawFrame(): void { ... }

  destroy(): void { ... }
}
```

Implementation details:

- use `window.open("", \`patchNet_${contextName}\`, features)`
- if popup opening fails, log a warning and return
- use popup-local `requestAnimationFrame`
- in `drawFrame()`, black-clear the canvas first:

```typescript
ctx.fillStyle = "#000";
ctx.fillRect(0, 0, this.width, this.height);
```

This is acceptable in TypeScript because the “no hardcoded hex” rule only applies to CSS in this repo. The popup document is built inline in JS and needs a black clear color.

Sort layers like this:

```typescript
const sorted = [...this.layers].sort((a, b) => b.priority - a.priority);
```

That makes higher numbers draw earlier in the background, and `0` draw last on top.

---

### 8. Create `src/runtime/VisualizerGraph.ts`

This mirrors the pattern of `AudioGraph.ts`: subscribe to `graph.on("change", ...)`, create runtime nodes for matching patch nodes, and destroy them when patch nodes disappear.

Required state:

```typescript
import type { PatchGraph } from "../graph/PatchGraph";
import { LayerNode } from "./LayerNode";
import { VisualizerNode } from "./VisualizerNode";
import { VisualizerRuntime } from "./VisualizerRuntime";

export class VisualizerGraph {
  private readonly unsubscribe: () => void;
  private readonly vizNodes = new Map<string, VisualizerNode>();   // patch node id -> runtime node
  private readonly layerNodes = new Map<string, LayerNode>();      // patch node id -> layer stub

  constructor(
    private readonly runtime: VisualizerRuntime,
    private readonly graph: PatchGraph,
  ) {
    this.unsubscribe = this.graph.on("change", () => this.sync());
    this.sync();
  }

  deliverMessage(nodeId: string, selector: string, args: string[]): void { ... }
  destroy(): void { ... }

  private sync(): void { ... }
}
```

`deliverMessage(...)` rules:

- `"bang"` -> `vizNode.open()`
- `"close"` -> `vizNode.close()`
- `"size"` -> parse `args[0]`, `args[1]` as numbers and call `resizeTo(...)`
- `"pos"` -> parse `args[0]`, `args[1]` as numbers and call `moveTo(...)`

`sync()` rules:

- create `VisualizerNode` instances for every `visualizer` patch node not yet mirrored
- create `LayerNode` instances for every `layer` patch node not yet mirrored
- destroy mirrored runtime nodes for deleted patch nodes
- register visualizer runtime nodes into `VisualizerRuntime` by their context name
- if a visualizer node’s name changes in `node.args[0]`, rebuild its runtime node and update the registry

Use a clean getter approach instead of private-field string access. `VisualizerNode` already exposes `contextName` in the shape above, so use that.

Do not implement media rewiring in Phase A.

When deleting a mirrored `VisualizerNode`:

- call `destroy()`
- unregister it from `VisualizerRuntime`
- remove it from `vizNodes`

---

### 9. Wire visualizer delivery into `src/canvas/ObjectInteractionController.ts`

Read the file fully before editing.

Add:

```typescript
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
```

Add field + setter:

```typescript
private visualizerGraph?: VisualizerGraph;

setVisualizerGraph(vg: VisualizerGraph): void {
  this.visualizerGraph = vg;
}
```

Then extend the existing switch statements.

In `deliverBang(node, inlet)`:

```typescript
case "visualizer":
  if (inlet === 0) {
    this.visualizerGraph?.deliverMessage(node.id, "bang", []);
  }
  break;

case "mediaVideo":
case "mediaImage":
case "layer":
  break;
```

In `deliverMessageValue(node, inlet, value)`:

```typescript
case "visualizer":
  if (inlet === 0) {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) break;
    const [selector, ...args] = tokens;
    this.visualizerGraph?.deliverMessage(node.id, selector, args);
  }
  break;

case "mediaVideo":
case "mediaImage":
case "layer":
  break;
```

Those visual-object stubs are intentional for Phase A so unknown visual types do not fall through awkwardly.

Do not regress existing audio/codebox behavior.

---

### 10. Wire the runtime into `src/main.ts`

Read the file fully before editing.

Add imports:

```typescript
import { VisualizerRuntime } from "./runtime/VisualizerRuntime";
import { VisualizerGraph } from "./runtime/VisualizerGraph";
```

Instantiate unconditionally near the other controller/runtime setup:

```typescript
const vizRuntime = VisualizerRuntime.getInstance();
const vizGraph = new VisualizerGraph(vizRuntime, graph);
objectInteraction.setVisualizerGraph(vizGraph);
```

Do **not** hide visualizer setup behind DSP/audio start. It is independent of audio.

In the `beforeunload` handler, destroy both:

```typescript
window.addEventListener("beforeunload", () => {
  codeboxController.destroy();
  vizGraph.destroy();
  vizRuntime.destroy();
});
```

That ensures popup windows are closed when the page exits.

---

### 11. Render the new objects in `src/canvas/ObjectRenderer.ts`

Read the file fully before editing.

Add a branch for visual objects.

Required rendering:

- `visualizer`
  - title line: `visualizer`
  - second muted line: context name from `node.args[0] ?? "world1"`
- `layer`
  - title line: `layer`
  - second muted line: `${context} · ${priority}`
- `mediaVideo`
  - title line: `mediaVideo`
  - second muted line: placeholder body with `data-media-label`
- `mediaImage`
  - title line: `mediaImage`
  - second muted line: placeholder body with `data-media-label`

Recommended DOM shape:

```html
<div class="patch-object-title">visualizer</div>
<div class="patch-object-visual-label">visualizer</div>
<div class="patch-object-visual-sub">world1</div>
```

You do not need a separate special-case root class system beyond the existing per-type slug and category classes.

Add a category class:

```typescript
if (def.category === "visual") el.classList.add("patch-object--visual");
```

Also add:

```typescript
el.dataset.nodeType = node.type;
```

That will help later phases style or target these objects more precisely.

Do not disturb codebox or existing object render branches.

---

### 12. Add CSS for visual objects in `src/shell.css`

Add:

```css
/* ── Visual objects (visualizer, mediaVideo, mediaImage, layer) ── */
.patch-object--visual .patch-object-body {
  gap: 2px;
}

.patch-object-visual-label {
  font-family: var(--pn-font-mono);
  font-size: var(--pn-type-chip);
  color: var(--pn-text-dim);
  line-height: 1.3;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
}

.patch-object-visual-sub {
  font-family: var(--pn-font-mono);
  font-size: 9px;
  color: var(--pn-muted);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
  opacity: 0.8;
}
```

Use only existing `--pn-*` tokens.

Do not modify `src/tokens.css`.

---

## Files to create

```text
src/runtime/VisualizerRuntime.ts
src/runtime/VisualizerNode.ts
src/runtime/LayerNode.ts
src/runtime/VisualizerGraph.ts
```

---

## Constraints

- No React, JSX, or framework abstractions
- No new npm dependencies
- No changes to `src/tokens.css`
- All CSS colors must use existing `--pn-*` tokens
- Do not break existing objects, audio runtime, or codebox runtime
- `npm run build` must pass
- Keep comments minimal and only where non-obvious
- Popup opening must still be invoked from actual user-triggered paths when testing; browsers may block popups opened without a gesture

---

## Acceptance criteria

1. `visualizer`, `mediaVideo`, `mediaImage`, and `layer` appear in the right-click menu
2. The same four appear in the object entry autocomplete
3. Placing a `visualizer` object renders its type and context name
4. Placing `mediaVideo`, `mediaImage`, and `layer` renders them without errors
5. Banging a `visualizer` object opens a popup titled `patchNet — world1`
6. The popup contains a black canvas and a running render loop
7. Sending `size 800 600` to inlet 0 resizes the popup
8. Sending `pos 100 100` to inlet 0 moves the popup
9. Deleting a `visualizer` patch node closes its popup window
10. `npm run build` passes with zero TypeScript errors

---

## Do not

- implement file picking
- implement drag-and-drop
- implement `MediaVideoNode` / `MediaImageNode`
- wire media -> layer -> visualizer edges
- add WebGL or shader logic
- add outlet bangs for open/close yet unless it falls out trivially and cleanly
- add save-format changes
- add any new dependencies

Those belong to later visualizer phases.

---

## After completing, append to `AGENTS.md`

Use the standard completion entry format.
List every changed file.
Note any deviation from this prompt explicitly.
