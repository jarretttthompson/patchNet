# Codex Prompt — patchNet Visualizer Phase B

You are implementing the **media object layer** of the patchNet visualizer system — file loading, playback, and drag-and-drop. This prompt assumes Phase A is complete and passing. **Read every file mentioned before touching it.**

---

## Working directory

`/Users/user/vibing/patchNet`

---

## What you are building

- `MediaVideoNode` — wraps `HTMLVideoElement`; handles loading, play/pause/seek, exposes the element for compositing
- `MediaImageNode` — wraps `HTMLImageElement`; handles loading, exposes the element for compositing
- Double-click on a `mediaVideo` or `mediaImage` canvas object → opens a native file picker → loads the file
- Drag-and-drop a video or image file onto the canvas → auto-creates the correct object with the file pre-loaded
- `VisualizerGraph` wires message delivery to `MediaVideoNode` / `MediaImageNode`
- Object labels update to show the loaded filename

---

## Files to read before starting

```
src/runtime/VisualizerRuntime.ts
src/runtime/VisualizerNode.ts
src/runtime/VisualizerGraph.ts
src/runtime/LayerNode.ts
src/graph/objectDefs.ts
src/graph/PatchGraph.ts
src/graph/PatchNode.ts
src/canvas/ObjectRenderer.ts
src/canvas/ObjectInteractionController.ts
src/canvas/CanvasController.ts
src/main.ts
src/shell.css
```

---

## Step-by-step deliverables

---

### 1. `src/runtime/MediaVideoNode.ts` (new file)

```typescript
/**
 * MediaVideoNode — wraps an HTMLVideoElement.
 *
 * The video element lives in the main document (not the popup).
 * VisualizerNode reads it via LayerNode.draw() each rAF frame.
 *
 * File URLs are created with URL.createObjectURL() and revoked on replace/destroy.
 */
export class MediaVideoNode {
  readonly video: HTMLVideoElement;
  private objectUrl: string | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.loop    = true;
    this.video.muted   = false;
    this.video.preload = "auto";
    // Must be crossOrigin anonymous so canvas drawImage doesn't taint
    this.video.crossOrigin = "anonymous";
    this.video.style.display = "none";
    document.body.appendChild(this.video);
  }

  /** Load a File object (from file picker or drag-and-drop). */
  loadFile(file: File): void {
    this.revokeUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.video.load();
  }

  /** Load from an existing object URL or path string (e.g. restored from args). */
  loadUrl(url: string): void {
    this.revokeUrl();
    this.video.src = url;
    this.video.load();
  }

  play(): void  { this.video.play().catch(() => {}); }
  pause(): void { this.video.pause(); }

  togglePlay(): void {
    this.video.paused ? this.play() : this.pause();
  }

  /** Seek to a normalized position (0.0–1.0). */
  seek(normalized: number): void {
    if (!isFinite(this.video.duration)) return;
    this.video.currentTime = normalized * this.video.duration;
  }

  setLoop(on: boolean): void {
    this.video.loop = on;
  }

  /** Normalized playback position (0.0–1.0). */
  get position(): number {
    if (!this.video.duration) return 0;
    return this.video.currentTime / this.video.duration;
  }

  /** True when the video has enough data to draw a frame. */
  get isReady(): boolean {
    return this.video.readyState >= 2; // HAVE_CURRENT_DATA
  }

  destroy(): void {
    this.video.pause();
    this.revokeUrl();
    this.video.remove();
  }

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
```

---

### 2. `src/runtime/MediaImageNode.ts` (new file)

```typescript
/**
 * MediaImageNode — wraps an HTMLImageElement.
 *
 * Loaded images are stored as object URLs and drawn each frame
 * by LayerNode.draw() via ctx.drawImage().
 */
export class MediaImageNode {
  readonly image: HTMLImageElement;
  private objectUrl: string | null = null;

  constructor() {
    this.image = document.createElement("img");
    this.image.crossOrigin = "anonymous";
    this.image.style.display = "none";
    document.body.appendChild(this.image);
  }

  loadFile(file: File): void {
    this.revokeUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.image.src = this.objectUrl;
  }

  loadUrl(url: string): void {
    this.revokeUrl();
    this.image.src = url;
  }

  get isReady(): boolean {
    return this.image.complete && this.image.naturalWidth > 0;
  }

  destroy(): void {
    this.revokeUrl();
    this.image.remove();
  }

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
```

---

### 3. Update `src/runtime/LayerNode.ts`

Read the file. Replace the stub `media` field with typed fields for both media types:

```typescript
import { MediaVideoNode } from "./MediaVideoNode";
import { MediaImageNode } from "./MediaImageNode";

export class LayerNode {
  private mediaVideo: MediaVideoNode | null = null;
  private mediaImage: MediaImageNode | null = null;

  constructor(
    public readonly patchNodeId: string,
    public priority: number,
  ) {}

  setMediaVideo(node: MediaVideoNode | null): void { this.mediaVideo = node; }
  setMediaImage(node: MediaImageNode | null): void { this.mediaImage = node; }
  clearMedia(): void { this.mediaVideo = null; this.mediaImage = null; }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    try {
      if (this.mediaVideo?.isReady) {
        ctx.drawImage(this.mediaVideo.video, 0, 0, w, h);
      } else if (this.mediaImage?.isReady) {
        ctx.drawImage(this.mediaImage.image, 0, 0, w, h);
      }
    } catch {
      // media not yet decodable — skip frame silently
    }
  }
}
```

---

### 4. Update `src/runtime/VisualizerGraph.ts`

Read the file fully. This is the most significant change in Phase B.

#### 4a. Add maps for media nodes

```typescript
private mediaVideoNodes = new Map<string, MediaVideoNode>(); // patchNodeId → MediaVideoNode
private mediaImageNodes = new Map<string, MediaImageNode>(); // patchNodeId → MediaImageNode
```

#### 4b. Extend `sync()` to create/destroy media runtime nodes

In the cleanup loop: destroy `MediaVideoNode` / `MediaImageNode` for removed patchNet nodes.
In the create loop:

```typescript
if (node.type === "mediaVideo" && !this.mediaVideoNodes.has(node.id)) {
  const mvn = new MediaVideoNode();
  this.mediaVideoNodes.set(node.id, mvn);
  // Restore file URL from args if present (e.g. after patch reload)
  const url = node.args[0];
  if (url) mvn.loadUrl(url);
}

if (node.type === "mediaImage" && !this.mediaImageNodes.has(node.id)) {
  const min = new MediaImageNode();
  this.mediaImageNodes.set(node.id, min);
  const url = node.args[0];
  if (url) min.loadUrl(url);
}
```

After creating all nodes, call `this.rewireMedia()`.

#### 4c. Add `rewireMedia()`

```typescript
private rewireMedia(): void {
  // Detach all layers from their current media and visualizers
  for (const layer of this.layerNodes.values()) {
    layer.clearMedia();
  }
  // Detach all layers from all visualizer nodes
  for (const vn of this.vizNodes.values()) {
    // VisualizerNode needs a clearLayers() method — add it
    vn.clearLayers();
  }

  // Re-wire: for each edge (mediaVideo|mediaImage) → layer
  for (const edge of this.graph.getEdges()) {
    const fromNode = this.graph.nodes.get(edge.fromNodeId);
    const toNode   = this.graph.nodes.get(edge.toNodeId);
    if (!fromNode || !toNode || toNode.type !== "layer") continue;

    const layer = this.layerNodes.get(edge.toNodeId);
    if (!layer) continue;

    if (fromNode.type === "mediaVideo") {
      const mvn = this.mediaVideoNodes.get(edge.fromNodeId);
      if (mvn) layer.setMediaVideo(mvn);
    } else if (fromNode.type === "mediaImage") {
      const min = this.mediaImageNodes.get(edge.fromNodeId);
      if (min) layer.setMediaImage(min);
    }
  }

  // Re-register layers with their target visualizer
  for (const [patchNodeId, layer] of this.layerNodes) {
    const patchNode = this.graph.nodes.get(patchNodeId);
    if (!patchNode) continue;
    const contextName = patchNode.args[0] ?? "world1";
    const vn = this.runtime.get(contextName) ?? this.runtime.getFirst();
    if (vn) vn.addLayer(layer);
  }
}
```

#### 4d. Add `deliverMediaMessage()` (called from ObjectInteractionController)

```typescript
deliverMediaMessage(nodeId: string, nodeType: "mediaVideo" | "mediaImage", selector: string, args: string[]): void {
  if (nodeType === "mediaVideo") {
    const mvn = this.mediaVideoNodes.get(nodeId);
    if (!mvn) return;
    switch (selector) {
      case "bang":  mvn.togglePlay(); break;
      case "play":  mvn.play();       break;
      case "stop":  mvn.pause();      break;
      case "seek":  mvn.seek(parseFloat(args[0] ?? "0")); break;
      case "loop":  mvn.setLoop(args[0] !== "0"); break;
    }
  } else {
    // mediaImage — bang just outputs (no-op at runtime; output handled by cables)
  }
}
```

#### 4e. Add `loadFileForNode()` — called from the file picker UI

```typescript
loadFileForNode(nodeId: string, nodeType: "mediaVideo" | "mediaImage", file: File): void {
  if (nodeType === "mediaVideo") {
    const mvn = this.mediaVideoNodes.get(nodeId);
    if (!mvn) return;
    mvn.loadFile(file);
    // Store object URL in node args for serialization
    const patchNode = this.graph.nodes.get(nodeId);
    if (patchNode) {
      patchNode.args[0] = mvn["objectUrl"] ?? "";
      // Note: objectUrl is private — add a getter `get url()` to MediaVideoNode instead
    }
  } else {
    const min = this.mediaImageNodes.get(nodeId);
    if (!min) return;
    min.loadFile(file);
    const patchNode = this.graph.nodes.get(nodeId);
    if (patchNode) {
      patchNode.args[0] = min["objectUrl"] ?? "";
    }
  }
  this.graph.emit("change");
}
```

**Important:** Add a `get url(): string | null` getter to both `MediaVideoNode` and `MediaImageNode` that returns `this.objectUrl`. This avoids the private field bracket access above.

---

### 5. Add `clearLayers()` to `VisualizerNode.ts`

Read the file. Add:

```typescript
clearLayers(): void {
  this.layers = [];
}
```

---

### 6. `src/canvas/VisualizerObjectUI.ts` (new file)

Handles double-click → file picker for `mediaVideo` and `mediaImage` canvas objects.

```typescript
/**
 * VisualizerObjectUI — attaches double-click file-picker behavior to
 * mediaVideo and mediaImage patchNet canvas objects.
 *
 * Listens via event delegation on the pan group so it picks up
 * newly rendered objects automatically.
 */
export class VisualizerObjectUI {
  private readonly onDblClick: (e: MouseEvent) => void;

  constructor(
    private readonly panGroup: HTMLElement,
    private readonly graph: PatchGraph,
    private readonly vizGraph: VisualizerGraph,
  ) {
    this.onDblClick = this.handleDblClick.bind(this);
    panGroup.addEventListener("dblclick", this.onDblClick);
  }

  destroy(): void {
    this.panGroup.removeEventListener("dblclick", this.onDblClick);
  }

  private handleDblClick(e: MouseEvent): void {
    const objectEl = (e.target as Element).closest<HTMLElement>(".patch-object");
    const nodeId   = objectEl?.dataset.nodeId;
    if (!nodeId) return;

    const node = this.graph.nodes.get(nodeId);
    if (!node) return;

    if (node.type === "mediaVideo") {
      e.preventDefault();
      this.openFilePicker("video/*", nodeId, "mediaVideo");
    } else if (node.type === "mediaImage") {
      e.preventDefault();
      this.openFilePicker("image/*", nodeId, "mediaImage");
    }
  }

  private openFilePicker(accept: string, nodeId: string, nodeType: "mediaVideo" | "mediaImage"): void {
    const input = document.createElement("input");
    input.type   = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) {
        this.vizGraph.loadFileForNode(nodeId, nodeType, file);
      }
      input.remove();
    }, { once: true });

    input.click();
  }
}
```

---

### 7. Drag-and-drop onto canvas (`src/canvas/CanvasController.ts`)

Read the file fully before editing.

Add drag-and-drop support that detects video/image files dropped onto the canvas and creates the appropriate patchNet node.

Add this to the constructor (or a `setupDragDrop()` method called from the constructor):

```typescript
private setupDragDrop(): void {
  this.canvasEl.addEventListener("dragover", (e) => {
    // Only accept file drops
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });

  this.canvasEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;

    const canvasRect = this.canvasEl.getBoundingClientRect();
    // Account for pan offset so the object lands at the right world-space position
    const panOffset  = this.getPanOffset(); // use existing pan offset method/field
    const x = e.clientX - canvasRect.left - panOffset.x;
    const y = e.clientY - canvasRect.top  - panOffset.y;

    if (file.type.startsWith("video/")) {
      const node = this.graph.addNode("mediaVideo", Math.round(x), Math.round(y));
      // Schedule file load after node is in the graph
      // The VisualizerGraph.sync() will create the MediaVideoNode on the next change event.
      // We need to load the file after that — use a small timeout so sync() runs first.
      setTimeout(() => {
        this.vizGraph?.loadFileForNode(node.id, "mediaVideo", file);
      }, 0);
    } else if (file.type.startsWith("image/")) {
      const node = this.graph.addNode("mediaImage", Math.round(x), Math.round(y));
      setTimeout(() => {
        this.vizGraph?.loadFileForNode(node.id, "mediaImage", file);
      }, 0);
    }
  });
}
```

Add a `setVisualizerGraph(vg: VisualizerGraph)` method to `CanvasController` so `main.ts` can wire it up.

**Note on pan offset:** Look at how `CanvasController` currently tracks its pan transform (it likely stores `panX`/`panY` or reads the `pn-pan-group` transform). Use the same values for drop coordinate translation.

---

### 8. Update `src/canvas/ObjectInteractionController.ts`

Read the file fully. Extend the `"mediaVideo"` and `"mediaImage"` stubs added in Phase A to actually route messages:

```typescript
case "mediaVideo":
case "mediaImage":
  if (inletIndex === 0) {
    const selector = ...; // "bang" for deliverBang, or first token of value
    const args     = ...; // [] for bang, or remaining tokens
    this.visualizerGraph?.deliverMediaMessage(node.id, node.type as "mediaVideo" | "mediaImage", selector, args);
  }
  break;
```

---

### 9. Update `src/canvas/ObjectRenderer.ts`

Read the file fully. Update the visual category render branch to show the filename.

For `mediaVideo` and `mediaImage`, add a sub-label element that reads `node.args[0]`:

```typescript
// Show filename only (not the full path / object URL)
const url = node.args[0] ?? "";
const filename = url ? url.split("/").pop()?.split("?")[0] ?? url : "no file";
```

Display pattern:
```
mediaVideo          mediaImage
"my-clip.mp4"       "photo.png"
```

Use the `.patch-object-visual-sub` class added in Phase A CSS.

---

### 10. Update `src/main.ts`

Read the file fully.

Import the new classes:
```typescript
import { VisualizerObjectUI } from "./canvas/VisualizerObjectUI";
```

After `vizGraph` is created, instantiate:
```typescript
const vizUI = new VisualizerObjectUI(panGroup, graph, vizGraph);
canvas.setVisualizerGraph(vizGraph);
```

In the `beforeunload` handler, add:
```typescript
vizUI.destroy();
```

---

### 11. `src/shell.css` additions

Add a drop-zone highlight state for when a file is dragged over the canvas:

```css
/* Drag-and-drop file target indicator */
[data-canvas-root].pn-drag-over {
  outline: 2px dashed var(--pn-accent);
  outline-offset: -2px;
}
```

Add/remove `pn-drag-over` class in `CanvasController`'s `dragover`/`dragleave`/`drop` handlers.

---

## Acceptance criteria

1. Double-clicking a `mediaVideo` object opens a system file picker filtered to video files
2. Selecting a video file updates the object label to show the filename
3. Double-clicking a `mediaImage` object opens a file picker filtered to image files
4. Dropping a video file onto the canvas creates a `mediaVideo` object at the drop position
5. Dropping an image file onto the canvas creates a `mediaImage` object at the drop position
6. Sending `bang` to a loaded `mediaVideo` toggles play/pause
7. Sending `"seek 0.5"` to a loaded `mediaVideo` seeks to the midpoint
8. `npm run build` passes with zero errors

---

## Do not

- Implement layer compositing or canvas drawing (Phase C)
- Add WebGL / shader support
- Add audio features
- Modify `src/tokens.css`
- Add new npm dependencies

---

## After completing, append to `AGENTS.md`

Use the standard completion entry format.
