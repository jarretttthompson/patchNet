# Codex Prompt — patchNet Visualizer Phase C

You are implementing the **layer compositing and full visual pipeline** for the patchNet visualizer system. This prompt assumes Phases A and B are complete and passing. **Read every file mentioned before touching it.**

---

## Working directory

`/Users/user/vibing/patchNet`

---

## What you are building

The full end-to-end data flow:

```
mediaVideo/mediaImage → (cable) → layer → (args: context, priority) → visualizer popup
```

Phase C delivers:
- Full layer compositing with correct priority z-order
- Layer registration/deregistration from visualizer when cables are connected/disconnected
- `layer` args update: changing context name or priority re-wires live
- Visual feedback on `layer` and `visualizer` objects showing connection state
- `visualizer` outlet bangs when popup opens/closes
- Playback position outlet on `mediaVideo` (float 0.0–1.0 on each tick)
- Serializer/parser support for `mediaVideo`/`mediaImage` file URLs so patches reload correctly

---

## Files to read before starting

```
src/runtime/VisualizerRuntime.ts
src/runtime/VisualizerNode.ts
src/runtime/VisualizerGraph.ts
src/runtime/LayerNode.ts
src/runtime/MediaVideoNode.ts
src/runtime/MediaImageNode.ts
src/graph/objectDefs.ts
src/graph/PatchGraph.ts
src/graph/PatchNode.ts
src/serializer/serialize.ts
src/serializer/parse.ts
src/canvas/ObjectRenderer.ts
src/canvas/ObjectInteractionController.ts
src/main.ts
src/shell.css
```

---

## Step-by-step deliverables

---

### 1. Verify and harden `VisualizerGraph.rewireMedia()`

Read `VisualizerGraph.ts` fully. The `rewireMedia()` method from Phase B wires media → layer → visualizer. Verify it handles all these cases correctly, fixing anything that doesn't:

**Case A — cable added between mediaVideo and layer:**
- `MediaVideoNode` is set on `LayerNode`
- `LayerNode` is registered with the correct `VisualizerNode` (from `layer.args[0]`)

**Case B — cable removed:**
- `LayerNode.clearMedia()` is called
- `LayerNode` is removed from its previous `VisualizerNode` via `vn.removeLayer(layer)` (not `clearLayers()` — that nukes ALL layers)

**Case C — layer `args[0]` (context name) changes:**
- Layer is removed from the old `VisualizerNode`
- Layer is added to the new `VisualizerNode`

**Case D — layer `args[1]` (priority) changes:**
- `layer.priority` is updated
- The rAF sort will pick it up automatically on next frame

**Case E — visualizer is deleted while layers point to it:**
- `VisualizerNode.destroy()` is called (closes popup)
- All `LayerNode`s that pointed to it have their `VisualizerNode` reference cleared
- Those layers are re-registered with the next available visualizer, or left unattached

Implement a proper `rewireMedia()` that covers all five cases. Call it at the END of every `sync()` invocation.

The correct algorithm:

```typescript
private rewireMedia(): void {
  // Step 1: detach every layer from every visualizer
  for (const vn of this.vizNodes.values()) {
    vn.clearLayers();
  }

  // Step 2: for each layer node, re-attach to the correct visualizer
  for (const [patchId, layer] of this.layerNodes) {
    const patchNode = this.graph.nodes.get(patchId);
    if (!patchNode) continue;

    // Update priority from args in case it changed
    const priority = parseInt(patchNode.args[1] ?? "0", 10);
    layer.priority = isNaN(priority) ? 0 : priority;

    // Clear existing media
    layer.clearMedia();

    // Re-wire media from incoming cable
    for (const edge of this.graph.getEdges()) {
      if (edge.toNodeId !== patchId) continue;
      const fromNode = this.graph.nodes.get(edge.fromNodeId);
      if (!fromNode) continue;
      if (fromNode.type === "mediaVideo") {
        const mvn = this.mediaVideoNodes.get(edge.fromNodeId);
        if (mvn) layer.setMediaVideo(mvn);
      } else if (fromNode.type === "mediaImage") {
        const min = this.mediaImageNodes.get(edge.fromNodeId);
        if (min) layer.setMediaImage(min);
      }
    }

    // Register layer with its target visualizer
    const contextName = patchNode.args[0] ?? "world1";
    const vn = this.runtime.get(contextName) ?? this.runtime.getFirst();
    if (vn) vn.addLayer(layer);
  }
}
```

---

### 2. `VisualizerNode` — outlet callbacks for open/close

Read `VisualizerNode.ts`. Add optional callbacks so `VisualizerGraph` can fire the visualizer's outlet bangs when the popup opens or closes:

```typescript
onOpen?:  () => void;
onClose?: () => void;
```

In `open()`, after successfully opening the popup, call `this.onOpen?.()`.
In `close()`, before clearing refs, call `this.onClose?.()`.

In `VisualizerGraph`, when creating a `VisualizerNode`, wire these callbacks:

```typescript
vn.onOpen  = () => this.fireOutlet(patchNodeId, 0); // outlet 0 = opened
vn.onClose = () => this.fireOutlet(patchNodeId, 1); // outlet 1 = closed
```

Add `fireOutlet(patchNodeId: string, outletIndex: number)` to `VisualizerGraph`:

```typescript
private fireOutlet(patchNodeId: string, outletIndex: number): void {
  for (const edge of this.graph.getEdges()) {
    if (edge.fromNodeId !== patchNodeId || edge.fromOutlet !== outletIndex) continue;
    const targetNode = this.graph.nodes.get(edge.toNodeId);
    if (targetNode) {
      this.objectInteraction?.deliverBang(targetNode, edge.toInlet);
    }
  }
}
```

Add `setObjectInteraction(oi: ObjectInteractionController)` to `VisualizerGraph` and store the reference. Wire it from `main.ts`.

---

### 3. `mediaVideo` playback position outlet

`mediaVideo` outlet 1 fires the normalized playback position on each animation frame tick. This should only fire while the video is playing.

In `VisualizerGraph`, maintain a `positionRafId` per playing `MediaVideoNode`:

```typescript
private positionLoops = new Map<string, number>(); // patchNodeId → rafId
```

Add `startPositionLoop(patchNodeId: string)` and `stopPositionLoop(patchNodeId: string)`:

```typescript
private startPositionLoop(patchNodeId: string): void {
  if (this.positionLoops.has(patchNodeId)) return;
  const tick = () => {
    const mvn = this.mediaVideoNodes.get(patchNodeId);
    if (!mvn || mvn.video.paused || mvn.video.ended) {
      this.positionLoops.delete(patchNodeId);
      return;
    }
    this.fireFloatOutlet(patchNodeId, 1, mvn.position);
    this.positionLoops.set(patchNodeId, requestAnimationFrame(tick));
  };
  this.positionLoops.set(patchNodeId, requestAnimationFrame(tick));
}

private stopPositionLoop(patchNodeId: string): void {
  const id = this.positionLoops.get(patchNodeId);
  if (id !== undefined) cancelAnimationFrame(id);
  this.positionLoops.delete(patchNodeId);
}
```

Add `fireFloatOutlet(patchNodeId: string, outletIndex: number, value: number)` that walks edges from that outlet and calls `deliverMessageValue(targetNode, edge.toInlet, String(value))`.

Start the position loop when `mediaVideo` receives `"play"` or `"bang"` (that toggles to playing). Stop it when `"stop"` is received or when the video's `ended` event fires. Wire video events in `MediaVideoNode`:

Add to `MediaVideoNode`:
```typescript
onPlay?:  () => void;
onPause?: () => void;
onEnded?: () => void;

// In constructor:
this.video.addEventListener("play",  () => this.onPlay?.());
this.video.addEventListener("pause", () => this.onPause?.());
this.video.addEventListener("ended", () => this.onEnded?.());
```

In `VisualizerGraph`, after creating a `MediaVideoNode`, wire these callbacks to start/stop the position loop.

---

### 4. Serialization — preserve file URLs (`src/serializer/serialize.ts`)

Read the file fully.

`mediaVideo` and `mediaImage` nodes store an object URL in `node.args[0]`. Object URLs (`blob:...`) are session-only — they become invalid after page reload. For serialization we should:

- Write the object URL to the `#X obj` line as-is (it's the best we can do in a browser context without a server)
- On reload, `parse.ts` will attempt to load the URL; if the URL is invalid, the object should load without crashing and simply show "no file" 

No special handling needed in `serialize.ts` — the existing arg serialization already writes `node.args[0]`. Verify this is the case and document it with a comment.

---

### 5. Parsing — safe URL restore (`src/serializer/parse.ts`)

Read the file fully.

For `mediaVideo` and `mediaImage` nodes, the file URL in `args[0]` may be a stale blob URL after reload. The `MediaVideoNode`/`MediaImageNode` constructors already call `loadUrl()` from `VisualizerGraph.sync()` when `args[0]` is non-empty. This will fail silently (the video/image just won't display), which is acceptable.

Add a comment to that effect in the parser. No code change required unless the parser is currently crashing on unknown arg types — verify it does not.

---

### 6. Object renderer — connection state feedback (`src/canvas/ObjectRenderer.ts`)

Read the file fully.

Update the `layer` render branch to show both args and a connection indicator. The label should be:

```
layer
world1 · 0
```

Where `world1` is `node.args[0]` and `0` is `node.args[1]`. If args are missing show `"—"`.

Update the `visualizer` render branch. The label should show:

```
visualizer
"world1"
```

No runtime state is needed in the renderer — it reads from `node.args` only.

---

### 7. CSS — layer and visualizer visual polish (`src/shell.css`)

Read the existing visual object CSS. Add:

```css
/* Layer object — color-code by priority */
.patch-object[data-node-type="layer"] {
  border-color: color-mix(in srgb, var(--pn-accent) 35%, var(--pn-border));
}

/* Visualizer object — accent glow to indicate it is a render context */
.patch-object[data-node-type="visualizer"] {
  border-color: color-mix(in srgb, var(--pn-secondary, #6a91ff) 50%, var(--pn-border));
  box-shadow:
    var(--pn-shadow-soft),
    var(--pn-shadow-inset),
    0 0 18px rgba(106, 145, 255, 0.18),
    0 0 2px rgba(106, 145, 255, 0.55);
}
```

Add `data-node-type` to each rendered object element in `ObjectRenderer.ts`:

```typescript
objectEl.dataset.nodeType = node.type;
```

This is already likely in the code as `data-node-id` — check and add `data-node-type` in the same place if it is not already present.

---

### 8. End-to-end wiring in `src/main.ts`

Read the file fully. Verify these are all present and correct after Phases A and B:

```typescript
vizGraph = new VisualizerGraph(vizRuntime, graph);
objectInteraction.setVisualizerGraph(vizGraph);
vizGraph.setObjectInteraction(objectInteraction);  // NEW — for outlet firing
canvas.setVisualizerGraph(vizGraph);
const vizUI = new VisualizerObjectUI(panGroup, graph, vizGraph);
```

In the `beforeunload` handler, verify `vizGraph?.destroy()` and `vizUI.destroy()` are both present.

---

### 9. Destroy cleanup in `VisualizerGraph.destroy()`

Read the `destroy()` method. Ensure it:

1. Calls `this.unsubscribe()`
2. Stops all position loops: `for (const id of this.positionLoops.values()) cancelAnimationFrame(id)`
3. Destroys all `MediaVideoNode`s: `for (const mvn of this.mediaVideoNodes.values()) mvn.destroy()`
4. Destroys all `MediaImageNode`s: `for (const min of this.mediaImageNodes.values()) min.destroy()`
5. Destroys all `VisualizerNode`s (closes popups): `for (const vn of this.vizNodes.values()) vn.destroy()`
6. Clears all maps

---

## Acceptance criteria

1. Connect `mediaVideo` (with a loaded file) → `layer` → `visualizer`: bang the visualizer, video plays inside the popup
2. Connect `mediaImage` → `layer` → `visualizer`: bang the visualizer, image displays inside the popup
3. Connect two media objects to two `layer` objects with different priorities → one renders on top of the other correctly (priority 0 = topmost)
4. Changing `layer` args (context name or priority) live-updates the compositing without restart
5. Deleting a `layer` node or disconnecting a cable removes it from compositing
6. `visualizer` outlet 0 fires a bang when the popup opens; outlet 1 fires when it closes
7. `mediaVideo` outlet 1 fires the playback position float while video is playing
8. `npm run build` passes with zero errors

---

## Do not

- Add WebGL or GLSL shader support (future phase)
- Add audio features
- Modify `src/tokens.css`
- Add new npm dependencies
- Add multi-track or timeline features

---

## After completing, append to `AGENTS.md`

Use the standard completion entry format. Note any deviations from this spec and the reasoning behind them.
