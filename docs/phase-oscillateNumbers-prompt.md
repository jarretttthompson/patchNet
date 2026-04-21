# Phase: oscillateNumbers object

**Owner:** Codex
**Reviewer:** Claude Code (Director)
**Scope:** One new `control`-category object. No runtime-graph registration; no new CSS.

---

## 1. What it does (one sentence)

`oscillateNumbers` emits a continuous stream of floats in `[0.0, 1.0]` following a sine wave whose frequency (Hz) is set by an arg / slider, and which only runs while gated on.

---

## 2. Behavior contract

- **Gating:** Off by default. Starts when inlet 0 receives `1` (or `bang` toggles it). Stops on `0`. Exactly the `metro` pattern — a user's `toggle → oscillateNumbers` patch is the idiomatic enable path.
- **Output:** `0.5 + 0.5 * sin(2π * freq * t)` where `t` = seconds since the most recent start. That gives a smooth 0.0↔1.0 sweep. Output happens on every animation frame (`requestAnimationFrame`). No output while stopped.
- **Freq parameter = oscillation frequency in Hz** (cycles per second). 1 Hz = one full 0→1→0→1 cycle per second. The output is continuous (RAF-driven), not step-quantized by the freq value. Decision recorded: option (A) from the planning discussion.
- **Persistence:** Running state survives text-panel round-trip via a hidden `running` arg, mirroring `metro`.

---

## 3. Spec — add to `src/graph/objectDefs.ts`

Insert the entry into `OBJECT_DEFS`. Place it near `metro` for semantic grouping.

```ts
oscillateNumbers: {
  description: "Continuous sine-wave oscillator that outputs floats in [0.0, 1.0]. Requires a gate (float 1 to start, 0 to stop).",
  category: "control",
  args: [
    { name: "freq",    type: "float", default: "1", min: 0.01, max: 20, step: 0.01,
      description: "Oscillation frequency in Hz (cycles per second)." },
    { name: "running", type: "int",   default: "0", hidden: true,
      description: "Running state (1 = oscillating, 0 = stopped)." },
  ],
  messages: [
    { inlet: 0, selector: "bang",  description: "toggle running on/off" },
    { inlet: 0, selector: "float", description: "1 = start, 0 = stop" },
    { inlet: 0, selector: "freq",  description: "set frequency Hz: freq <float>" },
    { inlet: 1, selector: "float", description: "set frequency Hz (restarts phase if already running)" },
  ],
  inlets: [
    { index: 0, type: "any",   label: "1: start  |  0: stop  |  bang: toggle  |  freq <hz>", temperature: "hot"  },
    { index: 1, type: "float", label: "frequency (Hz)",                                       temperature: "cold" },
  ],
  outlets: [{ index: 0, type: "float", label: "value (0.0–1.0)" }],
  defaultWidth:  160,
  defaultHeight: 40,
},
```

That's the single registration point. Autocomplete (`ObjectEntryBox`) and the context menu (`CanvasController`) derive their lists from `Object.keys(OBJECT_DEFS)` — no allowlist edits needed.

---

## 4. Interaction — `src/canvas/ObjectInteractionController.ts`

Mirror the existing `metro` machinery. Keep the phase (`startT`) independent per node so multiple `oscillateNumbers` can run out of phase.

### 4a. State field (next to `metroTimers`)

```ts
private readonly oscTimers = new Map<string, { rafId: number; startT: number }>();
```

### 4b. Graph-change hook (next to `pruneMetroTimers()` / `restoreMetroTimers()`)

In the existing `graph.on("change", …)` handler, add two calls:
```ts
this.pruneOscTimers();
this.restoreOscTimers();
```

### 4c. `deliverBang` case (next to `case "metro":`)

```ts
case "oscillateNumbers":
  if (inlet === 0) {
    if (this.isOscRunning(node.id)) this.stopOsc(node.id);
    else this.startOsc(node);
  }
  break;
```

### 4d. `deliverMessageValue` case (next to `case "metro": { … }`)

Mirror the metro branch: on inlet 0, parse `float` as start/stop, or `freq <hz>` as a named selector; on inlet 1, set freq and restart-if-running.

```ts
case "oscillateNumbers": {
  const tokens = value.trim().split(/\s+/);
  if (inlet === 0 && tokens[0] === "freq") {
    const hz = parseFloat(tokens[1] ?? "1");
    if (!isNaN(hz)) {
      node.args[0] = String(Math.max(0.01, hz));
      this.graph.emit(this.attrDragging ? "display" : "change");
      if (this.isOscRunning(node.id)) this.startOsc(node);
    }
  } else {
    this.deliverOscValue(node, inlet, value);
  }
  break;
}
```

### 4e. Private methods (put these next to the metro ones, ~line 1400)

```ts
private deliverOscValue(node: PatchNode, inlet: number, value: string): void {
  if (inlet === 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) return;
    if (parsed === 0) this.stopOsc(node.id);
    else this.startOsc(node);
    return;
  }
  if (inlet === 1) {
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) return;
    node.args[0] = String(Math.max(0.01, parsed));
    this.graph.emit("change");
    if (this.isOscRunning(node.id)) this.startOsc(node);
  }
}

private startOsc(node: PatchNode): void {
  this.stopOsc(node.id, false);
  const startT = performance.now() / 1000;
  const tick = () => {
    const current = this.oscTimers.get(node.id);
    if (!current) return;
    const liveNode = this.graph.nodes.get(node.id);
    if (!liveNode) { this.stopOsc(node.id, false); return; }
    const freq = Math.max(0.01, Number.parseFloat(liveNode.args[0] ?? "1"));
    const t = performance.now() / 1000 - current.startT;
    const value = 0.5 + 0.5 * Math.sin(2 * Math.PI * freq * t);
    this.dispatchValue(node.id, 0, value.toFixed(4));
    current.rafId = requestAnimationFrame(tick);
  };
  const rafId = requestAnimationFrame(tick);
  this.oscTimers.set(node.id, { rafId, startT });
  node.args[1] = "1";
  this.graph.emit("change");
}

private stopOsc(nodeId: string, persist = true): void {
  const current = this.oscTimers.get(nodeId);
  if (current !== undefined) {
    cancelAnimationFrame(current.rafId);
    this.oscTimers.delete(nodeId);
  }
  if (persist) {
    const node = this.graph.nodes.get(nodeId);
    if (node) {
      node.args[1] = "0";
      this.graph.emit("change");
    }
  }
}

private isOscRunning(nodeId: string): boolean {
  return this.oscTimers.has(nodeId);
}

private pruneOscTimers(): void {
  for (const nodeId of this.oscTimers.keys()) {
    if (!this.graph.nodes.has(nodeId)) this.stopOsc(nodeId, false);
  }
}

private restoreOscTimers(): void {
  for (const node of this.graph.getNodes()) {
    if (node.type === "oscillateNumbers" && node.args[1] === "1" && !this.isOscRunning(node.id)) {
      this.startOsc(node);
    }
  }
}
```

### 4f. `destroy()` — cancel any in-flight RAFs

In the existing `destroy()` loop that stops metros, add a sibling loop:
```ts
for (const nodeId of this.oscTimers.keys()) this.stopOsc(nodeId, false);
```

---

## 5. Renderer, CSS, runtime

- **Renderer:** none. Default text-label fallthrough in `ObjectRenderer.buildBody()` handles it.
- **CSS:** none. `defaultWidth: 160` gives enough room for the `oscillateNumbers` label.
- **Runtime node:** none. Output is control-rate floats dispatched via `dispatchValue`. Do NOT register anything in `AudioGraph.ts` or `VisualizerGraph.ts`.

---

## 6. Reference page — `docs/objects/oscillateNumbers.md`

Use `docs/objects/_TEMPLATE.md`. Required sections: frontmatter (`type: oscillateNumbers`, `category: control`, `version: 1`), one-line description, Arguments / Inlets / Outlets / Messages tables, one Example patch snippet (`toggle → oscillateNumbers → float` is the canonical one), and a Notes section calling out:
- Uses `requestAnimationFrame`, so output rate is ~60 Hz regardless of `freq`. `freq` controls how fast the sine oscillates, not how often it emits.
- Phase resets to 0 every time the oscillator (re)starts, including whenever `freq` changes via inlet 1.
- Related: `metro`, `slider`, `scale`.

Flip the `oscillateNumbers` row in `docs/objects/INVENTORY.md` to ✓ for the ref-doc column.

---

## 7. Smoke test

In the browser (`npm run dev`):

1. `n`-key → type `oscillateNumbers` → autocomplete picks it up. Place it.
2. Place a `toggle`, wire `toggle → oscillateNumbers inlet 0`. Place a `float` box, wire `oscillateNumbers → float`.
3. Flip toggle on. `float` should sweep smoothly between 0 and 1 at 1 Hz.
4. Place `slider 1 0.1 5` (or `slider` + `scale`), wire into inlet 1. Drag the slider — cycle speed should respond live.
5. Flip toggle off → float stops updating (last value lingers; that's fine).
6. Save → reload the page. Toggle state + `running` state should persist; oscillator should pick up again if it was on.
7. Round-trip: copy text panel, clear patch, paste text back → same behavior.

---

## 8. Definition of done

- [ ] `OBJECT_DEFS.oscillateNumbers` lands exactly as in §3.
- [ ] Interaction methods land exactly per §4 (no runtime-node fallback path).
- [ ] `docs/objects/oscillateNumbers.md` lands; `INVENTORY.md` row flipped.
- [ ] `npx tsc --noEmit` passes. `npm run build` clean.
- [ ] Manual smoke-test checklist passes.
- [ ] `AGENTS.md` completion entry appended following the standard format.

No architecture decisions required beyond option A (confirmed in planning). If Codex hits an unexpected ambiguity, file a BLOCKER entry rather than inventing semantics.
