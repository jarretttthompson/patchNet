# patchNet Object Implementation Plan

Phased plan for bringing all 7 objects to Max/MSP behavioral parity.
For agent use. See `docs/object-spec-standard.md` for the spec format.
Last updated: 2026-04-16

---

## Phase A — ObjectSpec Migration

**Goal:** Replace `ObjectDef` with `ObjectSpec` across all 7 existing objects. Zero behavior changes.

### Files

| File | Change |
|------|--------|
| `src/graph/objectDefs.ts` | Add `ArgDef`, `MessageDef`, `ObjectSpec` interfaces. Migrate all 7 `OBJECT_DEFS` entries to `ObjectSpec`. Add `description`, `category`, `args`, `messages` to each. Update `getObjectDef` return type to `ObjectSpec`. Remove `ObjectDef` or re-export as alias. |
| `src/canvas/ObjectRenderer.ts` | Replace `UI_TYPES` Set with `spec.category === "ui"` check. Otherwise no changes. |
| `src/serializer/parse.ts` | No logic changes — type flows through automatically. |

### ObjectSpec values for each object

```
button:   category: "ui",      args: [],                messages: [{ inlet:0, selector:"bang", description:"flash + dispatch bang" }]
toggle:   category: "ui",      args: [{ name:"value", type:"int", default:"0" }], messages: [...]
slider:   category: "ui",      args: [{ name:"value", type:"float", default:"0" }], messages: [...]
message:  category: "ui",      args: [{ name:"content", type:"symbol" }], messages: [...] (see docs/objects/message.md)
metro:    category: "control", args: [{ name:"interval", type:"float", default:"500" }], messages: [...]
click~:   category: "audio",   args: [], messages: [{ inlet:0, selector:"bang", description:"output click signal" }]
dac~:     category: "audio",   args: [], messages: []
```

### Acceptance criteria
- `tsc --noEmit` passes
- `npm run build` passes
- All 7 objects render and behave identically to pre-migration
- `ObjectSpec` is the single exported interface; `ObjectDef` removed or deprecated

---

## Phase B — Per-Object Behavior Fixes

**Goal:** Fix behavioral gaps in slider, toggle, button, and message.

### B1 — Slider: add inlets

**Files:** `src/graph/objectDefs.ts`, `src/canvas/ObjectInteractionController.ts`

Add to slider definition:
```
inlets: [
  { index: 0, type: "float", label: "set value (0.0–1.0)", temperature: "hot" },
  { index: 1, type: "bang",  label: "output current value", temperature: "hot" },
]
```

In `deliverValue` slider case (inlet 0):
- Parse float, clamp to [0, 1]
- `node.args[0] = value.toFixed(3)`
- Update thumb DOM: `thumbEl.style.left = "${value * 100}%"`
- `graph.emit("change")`
- `dispatchValue(node.id, 0, node.args[0])`

In `deliverBang` slider case (inlet 1):
- `dispatchValue(node.id, 0, node.args[0])` — output current value without changing it

Acceptance criteria:
- `message "0.5"` wired to slider inlet 0 → thumb moves to 50%
- `button` wired to slider inlet 1 → outputs current value downstream

### B2 — Toggle: float I/O and float input

**Files:** `src/canvas/ObjectInteractionController.ts`

In `toggleNode`: after flipping, `dispatchValue(node.id, 0, isOn ? "1.0" : "0.0")`

In `deliverValue` toggle case:
- `parseFloat(value) === 0` → set `"0"`, dispatch `"0.0"`
- any nonzero → set `"1"`, dispatch `"1.0"`

Acceptance criteria:
- Toggle click dispatches `"1.0"` or `"0.0"` on outlet 0
- Receiving `"0"` turns toggle off; receiving `"0.5"` turns it on

### B3 — Button: accept int/float

**Files:** `src/canvas/ObjectInteractionController.ts`

In `deliverValue` button case:
- `parseFloat(value) !== 0` → flash + `dispatchBang(node.id, 0)`
- `"0"` or `"0.0"` → no-op

Acceptance criteria:
- `message "1"` → button: flashes and dispatches bang
- `message "0"` → button: no reaction

### B4 — Message: dollar args + set/append/prepend + bang fix

**Files:** `src/canvas/ObjectInteractionController.ts`

#### Bang hot inlet fix

In `deliverBang` message case (inlet 0):
- Do NOT overwrite `node.args` — output stored content unchanged
- If stored content is already `"bang"` or empty, dispatch bang downstream
- Otherwise dispatch stored value downstream, flash

#### Dollar arg substitution

Add helper `applyDollarArgs(template: string, values: string[]): string`:
```typescript
return template.replace(/\$(\d)/g, (_, n) => values[parseInt(n) - 1] ?? `$${n}`);
```
Call before dispatching from message outlet when incoming is int/float/list.

#### set/append/prepend selectors

In `deliverValue` message case, check for selector prefix before storing:
- `value.startsWith("set ")` → store `value.slice(4)`, no output
- `value.startsWith("append ")` → append to `node.args[0]`, no output
- `value.startsWith("prepend ")` → prepend to `node.args[0]`, no output
- otherwise → existing store + output behavior

Acceptance criteria:
- `message "vol $1"` + receive float `0.75` → outputs `"vol 0.75"`
- Bang on hot inlet outputs stored content unchanged
- `"set hello"` on inlet 0 stores `"hello"`, no output
- `"append world"` on inlet 1 appends to stored content

---

## Phase C — Message Comma/Semicolon Routing

**Goal:** Comma-separated multi-output from message box.

**Files:** `src/canvas/ObjectInteractionController.ts`

Add helper:
```typescript
function splitOnComma(content: string): string[] {
  return content.split(",").map(s => s.trim()).filter(Boolean);
}
```

In `handleMessageClick` and `deliverBang` message case: if segments.length > 1, dispatch each
segment sequentially on outlet 0. Each segment is dispatched as its own typed message.

Semicolon routing: not implemented. Log a console warning if stored content starts with `";"`.

Acceptance criteria:
- `message "start, 500"` dispatches `"start"` then `"500"` on outlet 0
- Message with no comma behaves identically to Phase B

---

## Phase D — Metro Timer

**Goal:** Metro fires bangs at a specified interval using `setInterval`.

**Files:** `src/canvas/ObjectInteractionController.ts`, `src/graph/objectDefs.ts`

### State

Add to `ObjectInteractionController`:
```typescript
private metroTimers = new Map<string, ReturnType<typeof setInterval>>();
```

### Methods

```typescript
private startMetro(node: PatchNode): void {
  this.stopMetro(node.id);
  const ms = Math.max(1, parseFloat(node.args[0] ?? "500"));
  const handle = setInterval(() => this.dispatchBang(node.id, 0), ms);
  this.metroTimers.set(node.id, handle);
}

private stopMetro(nodeId: string): void {
  const h = this.metroTimers.get(nodeId);
  if (h !== undefined) { clearInterval(h); this.metroTimers.delete(nodeId); }
}
```

### Delivery rules

In `deliverBang` metro case (inlet 0): toggle — if running, stop; if stopped, start.
In `deliverValue` metro case:
- Inlet 0: `"1"` → start, `"0"` → stop
- Inlet 1: update `node.args[0]`; if running, restart with new interval

`destroy()`: call `stopMetro` for all active metro node IDs.

### Acceptance criteria
- `button → metro → button` chain: click button, target flashes at metro interval
- Slider wired to metro inlet 1 adjusts interval in real time
- Bang or `"0"` on inlet 0 stops the metro
- Removing metro node clears its timer (no leak)

---

## Phase E — Audio Runtime (Deferred)

**Goal:** Web Audio graph for `click~` and `dac~`.

**Status:** Deferred. No target date.

### Prerequisites
- User-gesture audio enable (toolbar toggle)
- `src/runtime/AudioRuntime.ts`: `AudioContext` wrapper, start/stop, exposes `context` and `destination`

### Files to create
- `src/runtime/AudioRuntime.ts`
- `src/runtime/nodes/ClickNode.ts` — single-sample click buffer, triggers on bang
- `src/runtime/nodes/DacNode.ts` — holds `destination` ref; signal connections wire to it

### Acceptance criteria
- `button → metro → click~ → dac~` produces audible rhythmic clicks
- `slider → metro inlet 1` changes click rate in real time
- Removing dac~ from graph disconnects audio cleanly

---

## Sequencing

| Phase | Depends on | Complexity |
|-------|------------|------------|
| A: ObjectSpec migration | — | Low — additive types only |
| B: Per-object fixes | A | Medium — interaction logic |
| C: Comma routing | B | Low — string parsing |
| D: Metro timer | B | Medium — stateful timers |
| E: Audio runtime | D | High — Web Audio API |

Run A → B → C → D in order. E is independent of C but requires D.

---

## Reference Docs To Write

One `docs/objects/<type>.md` per object. Written = ✓, Missing = ✗

| Object | Doc |
|--------|-----|
| button | ✗ |
| toggle | ✗ |
| slider | ✗ |
| message | ✓ (`docs/objects/message.md`) |
| metro | ✗ |
| click~ | ✗ |
| dac~ | ✗ |

Write remaining docs before starting Phase B for each object.
