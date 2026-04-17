# Cursor Task — Attribute Slider Live Dispatch + Session Persistence

You are working on **patchNet**, a browser-based visual patching environment. Vanilla TypeScript + Vite — no React, no framework.

Read `AGENTS.md` before starting. Append a completion entry when done.

---

## Two Independent Problems to Solve

---

## Problem 1 — Attribute sliders dispatch only on mouse release

### What's happening

In `src/canvas/ObjectInteractionController.ts` there are two event handlers for attribute panel sliders:

- **`handleAttrInput`** — fires on every `input` event (every slider tick during drag). It updates `node.args` and the numeric readout, but does **not** dispatch the value downstream. Comment: "Update readout live — no graph emit so the DOM isn't destroyed mid-drag."
- **`handleAttrChange`** — fires only on the `change` event (mouse release). This one calls `dispatchValue` and `graph.emit("change")`.

Result: the connected object (imageFX, layer, etc.) only responds when you release the mouse. The readout updates live, but the effect doesn't.

### Fix

In `handleAttrInput`, after the readout update block, add a live dispatch call. The goal is to send the value downstream on every tick **without** calling `graph.emit("change")` (which would destroy and re-render the DOM mid-drag).

**Current `handleAttrInput` (lines ~460–489):**
```ts
private handleAttrInput(e: Event): void {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("pn-attrui__slider") &&
      !target.classList.contains("pn-attrui__text")) return;

  const objectEl = target.closest<HTMLElement>(".patch-object");
  if (!objectEl) return;
  const node = this.getNode(objectEl);
  if (!node || node.type !== "attribute") return;

  const input      = target as HTMLInputElement;
  const argIndex   = parseInt(input.dataset.argIndex ?? "0", 10);
  const val        = input.value;
  const targetType = node.args[0] ?? "";

  // Cache value so the next re-render restores the slider to the right position
  node.args[argIndex + 1] = val;

  // Update readout live — no graph emit so the DOM isn't destroyed mid-drag
  const readout = input.closest<HTMLElement>(".pn-attrui__row")
    ?.querySelector<HTMLElement>(".pn-attrui__readout");
  if (readout) {
    const def     = OBJECT_DEFS[targetType];
    const visible = def?.args.filter(a => !a.hidden) ?? [];
    const arg     = visible[argIndex];
    readout.textContent = (arg?.type === "int")
      ? String(Math.round(parseFloat(val)))
      : parseFloat(val).toFixed(3);
  }
}
```

**Add these two lines at the end of `handleAttrInput`, after the readout block:**
```ts
  // Dispatch live so connected objects respond on every tick, not just on release
  const msg = buildArgMessage(targetType, argIndex, val);
  this.dispatchValue(node.id, 0, msg);
```

That's the entire fix for Problem 1. Do not call `graph.emit("change")` here.

---

## Problem 2 — Session state not restored on page refresh

### Background

The patch IS already persisted to `localStorage` on every change (see `main.ts` around line 239). The serializer stores all `node.args` in the text format. On refresh, `loadPatch()` calls `graph.deserialize()` which restores all nodes and edges, then `VisualizerGraph.sync()` runs to recreate runtime objects.

But three things break:

1. **mediaImage loses its image** — blob URLs (`blob:...`) stored in `node.args[0]` are only valid for the current page session. They go stale after refresh.
2. **imageFX filters look wrong** — the filter params ARE serialized and restored, but `fx.process()` runs before the image has finished loading (async). So nothing renders until something else triggers a re-process.
3. **visualizer popup doesn't re-open** — there's no persisted "was open" state, so the popup must be manually re-opened every session.

---

### Fix 2A — Store mediaImage as a data URL, not a blob URL

**File:** `src/runtime/MediaImageNode.ts`

Currently `loadFile()` calls `URL.createObjectURL(file)` which returns a temporary `blob:` URL. This dies on refresh. Replace it with a `FileReader`-based data URL (base64) that is self-contained and survives serialization.

Replace the entire `loadFile` method:

```ts
loadFile(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    this.revokeUrl();
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      this.objectUrl = dataUrl;   // data: URL — survives across page sessions
      this.image.src = dataUrl;
      this.image.onload = () => resolve();
      this.image.onerror = () => reject(new Error("Image failed to load"));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
```

Also update `revokeUrl` — data URLs don't need revocation, so guard it:

```ts
private revokeUrl(): void {
  if (this.objectUrl && this.objectUrl.startsWith("blob:")) {
    URL.revokeObjectURL(this.objectUrl);
  }
  this.objectUrl = null;
}
```

**File:** `src/runtime/VisualizerGraph.ts`, `loadFileForNode` method

`loadFileForNode` currently calls `min.loadFile(file)` synchronously. Now that `loadFile` is async, update the mediaImage branch:

```ts
} else {
  const min = this.mediaImageNodes.get(nodeId);
  if (!min) return;
  min.loadFile(file).then(() => {
    patchNode.args[0] = min.url ?? "";
    this.graph.emit("change");
  });
  return;   // early return — emit happens in the then() callback
}
```

Remove the `patchNode.args[0] = min.url ?? ""` and `this.graph.emit("change")` lines that were below this block (they now live inside `.then()`).

---

### Fix 2B — Re-process imageFX when the restored image loads

**File:** `src/runtime/VisualizerGraph.ts`, `sync()` method, inside the `if (node.type === "mediaImage" ...)` block

When restoring from saved state, `min.loadUrl(node.args[0])` sets the image `src` but loading is async. The `rewireMedia()` call that follows runs immediately and calls `fx.process()` before the image is ready, so nothing renders.

Find the mediaImage creation block:
```ts
if (node.type === "mediaImage" && !this.mediaImageNodes.has(node.id)) {
  const min = new MediaImageNode();
  if (node.args[0]) min.loadUrl(node.args[0]);
  this.mediaImageNodes.set(node.id, min);
}
```

Replace with:
```ts
if (node.type === "mediaImage" && !this.mediaImageNodes.has(node.id)) {
  const min = new MediaImageNode();
  if (node.args[0]) {
    min.loadUrl(node.args[0]);
    // Re-wire after async load so imageFX receives the ready image
    min.image.addEventListener("load", () => this.rewireMedia(), { once: true });
  }
  this.mediaImageNodes.set(node.id, min);
}
```

This is safe — `rewireMedia()` is already called synchronously at the end of `sync()`, so this is just a second pass that fires after the image arrives.

> Note: Background removal state (flood-fill `ImageData`) is intentionally not persisted — it is a runtime-only operation that requires the image to be present and the user to have run the panel. Filter parameters (hue, saturation, etc.) are already serialized in `node.args[0..5]` and will now restore correctly thanks to the timing fix above.

---

### Fix 2C — Persist and restore visualizer open/closed state

The visualizer popup window needs to know whether it was open when the page was last saved, so it can re-open automatically on restore.

#### Step 1 — Add a hidden `open` arg to the visualizer spec

**File:** `src/graph/objectDefs.ts`, `visualizer` entry

The current args are `[name, float]`. Add a third hidden arg for the open state:

```ts
visualizer: {
  // ... existing fields unchanged ...
  args: [
    { name: "name", type: "symbol", default: "world1",
      description: "Render context name used by layer objects to target this window." },
    { name: "float", type: "int", default: "0", min: 0, max: 1, step: 1,
      description: "Floating window: 1 = keep popup on top whenever patchNet is focused." },
    { name: "open", type: "int", default: "0", hidden: true,
      description: "Persisted open/closed state — 1 if popup was open when last saved." },
  ],
  // ... rest unchanged ...
```

#### Step 2 — Write open/closed state into args when the popup opens or closes

**File:** `src/runtime/VisualizerGraph.ts`, `deliverMessage` method

Find the `"bang"` and `"close"` cases in the `switch (selector)` block and add args persistence:

```ts
case "bang":
  vn.open();
  if (pn) { pn.args[2] = "1"; this.graph.emit("change"); }
  break;
case "close":
  vn.close();
  if (pn) { pn.args[2] = "0"; this.graph.emit("change"); }
  break;
```

You will need `const pn = this.graph.nodes.get(nodeId);` at the top of `deliverMessage` (before the switch) if it isn't already there.

Also persist via `onClose` (the user can close the popup manually by clicking the X button):

In the `sync()` visualizer creation block, update the `onClose` handler:
```ts
vn.onClose = () => {
  this.fireOutlet(node.id, 1);
  const pn = this.graph.nodes.get(node.id);
  if (pn) { pn.args[2] = "0"; this.graph.emit("change"); }
};
```

#### Step 3 — Auto-open on restore

**File:** `src/runtime/VisualizerGraph.ts`, `sync()` method, inside the `if (node.type === "visualizer" ...)` block

After registering the new `VisualizerNode`, check if it should auto-open:

```ts
if (node.type === "visualizer" && !this.vizNodes.has(node.id)) {
  const contextName = node.args[0] ?? "world1";
  const vn = new VisualizerNode(contextName);
  vn.onOpen  = () => this.fireOutlet(node.id, 0);
  vn.onClose = () => {
    this.fireOutlet(node.id, 1);
    const pn = this.graph.nodes.get(node.id);
    if (pn) { pn.args[2] = "0"; this.graph.emit("change"); }
  };
  vn.setFloat((node.args[1] ?? "0") !== "0");
  this.vizNodes.set(node.id, vn);
  this.runtime.register(contextName, vn);

  // Restore open state — defer one tick so the page is interactive
  if ((node.args[2] ?? "0") === "1") {
    setTimeout(() => vn.open(), 100);
  }
}
```

> **Browser popup note:** Browsers may block `window.open()` on page load if the site hasn't been granted popup permission. Chrome and Safari will silently block it with a popup-blocked icon in the address bar. The user needs to allow popups for `localhost` (or whatever the dev server origin is) once, and then auto-restore will work on subsequent refreshes. The existing `console.warn` in `VisualizerNode.open()` handles the blocked case gracefully — no additional error handling needed.

---

## Constraints — Do Not Violate

- No new dependencies
- `npm run build` must pass with zero TypeScript errors
- No hardcoded hex colors — use `var(--pn-*)` tokens if any CSS changes are needed
- Do not change the serialization text format (the `#X obj ...` PD-style lines) — `node.args` is already serialized as space-separated tokens which covers these new values

---

## When Done

Run `npx tsc --noEmit` and `npm run build`. Then append a completion entry to `AGENTS.md`:

```
---
## [2026-04-16] COMPLETED | Attribute slider live dispatch + session persistence
**Agent:** Cursor
**Phase:** Polish — interactivity + persistence
**Done:**
- bullet list of each fix completed

**Changed files:**
- src/canvas/ObjectInteractionController.ts — [what changed]
- src/runtime/MediaImageNode.ts — [what changed]
- src/runtime/VisualizerGraph.ts — [what changed]
- src/graph/objectDefs.ts — [what changed]

**Notes / decisions made:**
- Background removal (flood-fill ImageData) is not persisted — runtime-only operation
- Visualizer auto-open on restore requires the user to allow popups for localhost once
- Any deviations from this plan

**Next needed:**
- Browser validation: drag attribute slider → connected imageFX updates live
- Refresh page → mediaImage reappears, imageFX filters applied, visualizer re-opens
---
```
