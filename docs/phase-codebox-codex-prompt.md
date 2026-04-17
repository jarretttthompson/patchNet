# Codex Prompt — patchNet codebox Phase A

You are implementing the `codebox` object for patchNet, a browser-based visual programming environment (vanilla TypeScript + Vite, no React). This is a self-contained implementation task. Read every file mentioned before touching it.

---

## Working directory

`/Users/user/vibing/patchNet`

---

## What you are building

A `codebox` object that:
- Renders with an embedded CodeMirror 6 editor inside the canvas object
- Dynamically derives its inlets/outlets from reserved variable names in the code (`in1`, `out1`, etc.)
- Executes JavaScript on incoming messages
- Persists code through the patch serializer using base64 encoding
- Shows inline error state on syntax/runtime failures
- Integrates into the existing graph, renderer, and message bus

---

## Architecture overview

The existing codebase has:
- `src/graph/objectDefs.ts` — `ObjectSpec` type with `category: "ui" | "control" | "audio"`
- `src/graph/PatchNode.ts` — `PortType = "bang" | "float" | "signal" | "any" | "message"`, mutable `PatchNode` with `.inlets`, `.outlets`, `.args`
- `src/canvas/ObjectRenderer.ts` — renders objects from graph nodes; currently uses `def.category === "ui"` checks
- `src/canvas/ObjectInteractionController.ts` — delivers bangs and values to objects by type; owns `metroTimers`, `deliverBang`, `deliverMessageValue`
- `src/serializer/serialize.ts` — line-oriented `#X obj x y type ...args;` format
- `src/serializer/parse.ts` — parses that format, applies `#X size` lines
- `src/main.ts` — constructs controllers, wires graph `change` event to `render()`
- `src/shell.css` — all CSS; uses `--pn-*` CSS tokens only

---

## Step-by-step deliverables

### 1. Install CodeMirror dependencies

```
npm install @codemirror/state @codemirror/view @codemirror/lang-javascript
```

### 2. `src/graph/objectDefs.ts`

- Add `"scripting"` to the `category` union in `ObjectSpec`
- Add the `codebox` entry to `OBJECT_DEFS`:

```typescript
codebox: {
  description: "Scriptable object with dynamic ports derived from code.",
  category: "scripting",
  args: [
    { name: "language", type: "symbol", default: "js", description: "Active language (js only in Phase A)" },
    { name: "code",     type: "symbol", default: "",   description: "Base64-encoded source" },
  ],
  messages: [
    { inlet: 0, selector: "bang",   description: "execute with bang on inlet 0" },
    { inlet: 0, selector: "float",  description: "execute with a numeric value" },
    { inlet: 0, selector: "symbol", description: "execute with a string value" },
    { inlet: 0, selector: "set",    description: "replace code without executing" },
  ],
  inlets: [],   // dynamic — derived at runtime from code
  outlets: [],  // dynamic — derived at runtime from code
  defaultWidth: 260,
  defaultHeight: 120,
},
```

### 3. `src/canvas/CodeboxController.ts` (new file)

Create the full controller. It is responsible for:

**Editor lifecycle:**
- Keep a `Map<string, EditorView>` keyed by `node.id`
- `mountEditor(node, host)` — creates a CodeMirror 6 `EditorView` inside `host`; idempotent (skip if already mounted)
- `unmountEditor(nodeId)` — destroys the editor and removes it from the map
- `pruneEditors(activeNodeIds)` — removes editors for deleted nodes
- On every code change (debounced 300ms): re-derive ports, update `node.inlets`/`node.outlets`, drop stale edges, persist encoded source to `node.args[1]`, emit `graph.change`

**Port derivation** (use regex, no AST):
```typescript
function derivePortsFromCode(code: string): { inlets: PortDef[]; outlets: PortDef[] }
```
- Scan for `\bin(\d+)\b`, `\bbang(\d+)\b`, `\bout(\d+)\b`
- Port count = highest referenced index for each group
- `inN` → `type: "any"`, `bangN` → `type: "bang"`, `outN` → `type: "any"`
- Gaps (e.g. in1 and in3 but not in2) → fill with `type: "any"` placeholders

**Stale edge cleanup:**
- After port re-derive, call `graph.getEdges()` and remove any edge whose `fromOutlet >= node.outlets.length` or `toInlet >= node.inlets.length` via `graph.removeEdge(edge.id)`

**Execution:**
```typescript
executeBang(node: PatchNode, inlet: number): void
executeValue(node: PatchNode, inlet: number, value: string): void
```
- Build a sandboxed runner using `new Function(...)` with ONLY these globals injected: `Math`, `JSON`, `Number`, `String`, `Boolean`, `parseFloat`, `parseInt`, `isNaN`, `isFinite`, `structuredClone`, a restricted `console: { log: console.log, warn: console.warn }`
- Prepare `inN` variables: set `inN = value` for the triggered inlet, all others `undefined`; `bangN = true` if it's a bang inlet
- Pre-declare `let out1, out2, ..., out8;` inside the function body
- Return `{ out1, out2, ..., out8 }` at the end
- After execution, for each `outN` that is not `null`/`undefined`, call `this.dispatchValue(node.id, N-1, normalizeOutput(val))`
- Value normalization: `number` → `String(val)`, `string` → raw, `boolean` → `"1.0"` / `"0.0"`, arrays/objects → `JSON.stringify`, null/undefined → don't dispatch
- On `SyntaxError` or runtime error: set editor error state (red border), log to console, do NOT dispatch anything

**Error state:**
- Add a `StateEffect` or simple compartment to toggle a `errorTheme` extension on the editor
- OR: simpler approach — set a `data-error` attribute on the host element and rely on CSS to show red border + error text

**Constructor signature:**
```typescript
constructor(
  private readonly graph: PatchGraph,
  private readonly dispatchBang: (fromNodeId: string, outlet: number) => void,
  private readonly dispatchValue: (fromNodeId: string, outlet: number, value: string) => void,
)
```

**`destroy()`** — unmount all editors

### 4. `src/canvas/ObjectRenderer.ts`

- Add a branch for `node.type === "codebox"` (or `def.category === "scripting"`)
- Render this structure inside the object body:

```html
<div class="patch-object-codebox">
  <div class="patch-object-codebox-header">
    <span class="patch-object-codebox-name">codebox</span>
    <span class="patch-object-codebox-badge">JS</span>
  </div>
  <div class="patch-object-codebox-host" data-codebox-node-id="[node.id]"></div>
</div>
```

- Do NOT mount CodeMirror here — only create the host div. `CodeboxController` mounts into it.
- The codebox object does NOT get the standard title/glyph treatment.

### 5. `src/canvas/ObjectInteractionController.ts`

Read the file fully before editing. Then:

- Add a `setCodeboxController(cc: CodeboxController)` method
- In `deliverBang(node, inletIndex)`: add a `case "codebox":` that calls `this.codeboxController?.executeBang(node, inletIndex)`
- In `deliverMessageValue(node, inletIndex, value)` (or equivalent): add `codebox` handling that calls `this.codeboxController?.executeValue(node, inletIndex, value)`
- Import `CodeboxController` at the top

### 6. `src/serializer/serialize.ts`

Read the file fully. Then:

When serializing a node where `node.type === "codebox"`:
- `args[0]` = language (plain, e.g. `"js"`)
- `args[1]` = the raw source code, base64-encoded via `btoa(unescape(encodeURIComponent(source)))`

The existing serializer already appends args to the `#X obj` line. Make sure the base64 arg is written without spaces (it won't contain them so this is safe).

### 7. `src/serializer/parse.ts`

Read the file fully. Then:

When parsing a node where `type === "codebox"`:
- Decode `args[1]` via `decodeURIComponent(escape(atob(encoded)))` inside a try/catch
- If decode fails, set `args[1] = ""` and log a warning
- After the node is built, call the port deriver to populate `node.inlets` and `node.outlets` from the decoded source
- Import `derivePortsFromCode` from `CodeboxController` (or extract it to a shared util if easier)

### 8. `src/main.ts`

Read the file fully. Then:

- Import `CodeboxController`
- Instantiate after the other controllers:

```typescript
const codeboxController = new CodeboxController(
  graph,
  (fromNodeId, outlet) => {
    // dispatch bang downstream — mirror existing bang dispatch in ObjectInteractionController
    const fromNode = graph.nodes.get(fromNodeId);
    if (!fromNode) return;
    // walk edges from this outlet and call objectInteraction.deliverBang on each target
  },
  (fromNodeId, outlet, value) => {
    // dispatch value downstream
    const fromNode = graph.nodes.get(fromNodeId);
    if (!fromNode) return;
    // walk edges from this outlet and call objectInteraction.deliverMessageValue on each target
  },
);
objectInteraction.setCodeboxController(codeboxController);
```

- In the `render()` function, AFTER `panGroup.appendChild(renderObject(node))` for each node, mount codebox editors:

```typescript
for (const node of graph.getNodes()) {
  if (node.type === "codebox") {
    const host = panGroup.querySelector<HTMLElement>(
      `[data-node-id="${node.id}"] [data-codebox-node-id="${node.id}"]`
    );
    if (host) codeboxController.mountEditor(node, host);
  }
}
codeboxController.pruneEditors(new Set(graph.getNodes().map(n => n.id)));
```

- Also call `codeboxController.destroy()` in any teardown path.

### 9. `src/shell.css`

Add at the end (use only `--pn-*` tokens, no hardcoded hex):

```css
/* ── Codebox object ── */
.patch-object-codebox {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.patch-object-codebox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 6px;
  border-bottom: 1px solid var(--pn-border);
  flex-shrink: 0;
}

.patch-object-codebox-name {
  font-family: var(--pn-font-mono);
  font-size: var(--pn-type-chip);
  color: var(--pn-text-dim);
  letter-spacing: 0.06em;
}

.patch-object-codebox-badge {
  font-family: var(--pn-font-mono);
  font-size: 9px;
  color: var(--pn-accent);
  border: 1px solid var(--pn-accent);
  border-radius: 2px;
  padding: 0 3px;
  opacity: 0.8;
}

.patch-object-codebox-host {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

/* CodeMirror reset inside patch objects */
.patch-object-codebox-host .cm-editor {
  height: 100%;
  background: transparent;
  font-family: var(--pn-font-mono);
  font-size: 11px;
}

.patch-object-codebox-host .cm-scroller {
  overflow: auto;
}

.patch-object-codebox-host .cm-content {
  padding: 4px 6px;
}

.patch-object-codebox-host[data-error="true"] .cm-editor {
  outline: 1px solid var(--pn-error, #ff4d4d);
}

.patch-object-codebox-host .pn-codebox-error-msg {
  font-family: var(--pn-font-mono);
  font-size: 10px;
  color: var(--pn-error, #ff4d4d);
  padding: 2px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

### 10. `src/canvas/CanvasController.ts`

Add `"codebox"` to the `OBJECT_TYPES` array so it appears in the right-click context menu.

---

## Constraints

- **No React, no JSX**. Vanilla TypeScript + DOM only.
- **All colors via `--pn-*` CSS tokens**. No hardcoded hex colors anywhere in CSS.
- **Fonts**: `var(--pn-font-mono)` for all codebox text.
- Do not break existing object types (button, toggle, slider, message, metro, click~, dac~).
- `npm run build` must pass with zero TypeScript errors when done.
- Do not modify `src/tokens.css`.
- Keep inline comments minimal — only where logic is non-obvious.

---

## Acceptance criteria

- `codebox` appears in right-click menu
- Placed codebox renders with CodeMirror editor embedded
- Typing `out1 = in1 * 2;` creates 1 inlet and 1 outlet
- Wiring slider → codebox → message, sending a value, doubles it
- Syntax errors do not crash the app; error state shows on editor
- Code persists across page refresh (via localStorage patch save)
- `npm run build` passes

---

## Do not

- Add new PortTypes beyond what's needed
- Build a full JS AST parser
- Add Worker isolation (Phase B)
- Add audio or video support
- Add autocomplete or linting packages
- Invent a second save format
