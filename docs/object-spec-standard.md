# patchNet Object Spec Standard

Working spec for AI agents implementing objects. Not user-facing.
Last updated: 2026-04-16

---

## 1. ObjectSpec Interface

`ObjectSpec` extends the existing `ObjectDef` in `src/graph/objectDefs.ts`.

```typescript
// src/graph/objectDefs.ts

export interface ArgDef {
  name: string;
  type: "float" | "int" | "symbol" | "list";
  default?: string;
  description: string;
}

export interface MessageDef {
  inlet: number;        // which inlet accepts this message
  selector: string;     // "bang" | "int" | "float" | "list" | "symbol" | "set" | "append" | "prepend" | ...
  args?: string;        // short arg description, e.g. "$1: float value"
  description: string;
}

export interface ObjectSpec extends ObjectDef {
  description: string;                    // one-line summary
  category: "ui" | "control" | "audio";  // rendering category
  args: ArgDef[];                         // positional creation arguments (node.args[])
  messages: MessageDef[];                 // typed inlet messages the object responds to
}
```

`ObjectDef` (retained as-is):
```typescript
export interface ObjectDef {
  inlets: PortDef[];
  outlets: PortDef[];
  defaultWidth: number;
  defaultHeight: number;
}
```

`OBJECT_DEFS` becomes `Record<string, ObjectSpec>`. `getObjectDef` return type upgrades to `ObjectSpec`.
No callers break — all `ObjectDef` fields are still present.

---

## 2. Reference Doc Format

One file per object: `docs/objects/<type>.md`

Filename: use the object type slug — `message.md`, `toggle.md`, `dac-.md`, etc.

Sections (in order):
1. **Description** — one paragraph max
2. **Arguments** — table: `| # | name | type | default | description |`
3. **Inlets** — table: `| # | type | temperature | accepts | description |`
4. **Outlets** — table: `| # | type | description |`
5. **Messages** — table: `| inlet | selector | args | effect |`
6. **Examples** — 1–3 patch text snippets using `#X obj` format
7. **Implementation Status** — what is done vs. missing in patchNet
8. **Max/MSP Delta** — behaviors in Max not yet in patchNet

---

## 3. Rendering Contract (ObjectRenderer.ts)

`renderObject(node)` must:

- Call `getObjectDef(node.type)` — returns `ObjectSpec`
- Use `spec.category` to assign the CSS class variant:
  - `"ui"` → add `patch-object--ui` (button, toggle, slider, message)
  - `"control"` → add `patch-object--control` (metro)
  - `"audio"` → add `patch-object--audio` (click~, dac~)
- DOM structure per object type:

| Type | Root class | Body contents |
|------|------------|---------------|
| `button` | `patch-object-button` | `.patch-object-face.patch-object-face-button` (circle) |
| `toggle` | `patch-object-toggle` | `.patch-object-toggle-plate` > screws + `.patch-object-toggle-rocker` > two halves |
| `slider` | `patch-object-slider` | `.patch-object-slider-track` > `.patch-object-slider-thumb` |
| `message` | `patch-object-message` | `.patch-object-message-content` (text) |
| `metro` | `patch-object-metro` | `.patch-object-title` ("metro") + `.patch-object-meta` (interval arg) |
| `click~` | `patch-object-click-` | `.patch-object-title` + `.patch-object-meta.patch-object-glyph` ("~>") |
| `dac~` | `patch-object-dac-` | `.patch-object-title` + `.patch-object-meta.patch-object-glyph` ("L R") |

Node-level `width`/`height` override `spec.defaultWidth`/`spec.defaultHeight` if set (resize support).

---

## 4. Interaction Contract (ObjectInteractionController.ts)

Message delivery is two-stage: dispatch from source → deliver to target.

**dispatch(fromNodeId, fromOutlet, message):**
- Walks `graph.getEdges()`, finds matching `fromNodeId` + `fromOutlet`
- Calls `deliver(targetNode, toInlet, message)` for each connected inlet

**deliver(node, inlet, message):**
- Each object type handles the message per its `ObjectSpec.messages` table
- Hot inlets (temperature === "hot" or undefined) trigger output after storing
- Cold inlets store only, no output

**Current dispatch functions:**
- `dispatchBang(nodeId, outlet)` — sends a bang message
- `dispatchValue(nodeId, outlet, value: string)` — sends a raw string value

Phase B target: replace raw-string dispatch with a typed `PatchMessage` union so delivery
handlers can pattern-match on type (bang / int / float / symbol / list).

---

## 5. Acceptance Criteria for Migration

A phase is complete when:
- `tsc --noEmit` passes with zero errors
- `npm run build` succeeds
- All 7 existing objects render and interact identically to pre-migration behavior (or better)
- New `ObjectSpec` fields (`description`, `category`, `args`, `messages`) are populated for all 7 objects
