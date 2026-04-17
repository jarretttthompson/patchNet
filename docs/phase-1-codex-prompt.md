# Phase 1 — Codex Prompt: Patch Graph Model

Paste this into Codex. Complete all tasks before Phase 2.

---

You are building **patchNet**, a browser-based visual programming environment modeled after Pure Data / Max MSP. You are working in `/Users/user/vibing/patchNet/`.

**Your job in Phase 1:** Build the in-memory data model, serializer, parser, and basic object rendering — no interaction, no audio. Just the model and its visual representation.

**Read these files before writing any code:**
- `AGENTS.md` — current project state
- `PLAN.md` — full architecture (Phase 1 section)
- `DESIGN_LANGUAGE.md` — visual tokens (you'll need `--pn-*` vars for object rendering)
- `patchNet-Vault/wiki/concepts/patch-graph-model.md` — full data model spec
- `patchNet-Vault/wiki/concepts/serialization-format.md` — text format spec
- `patchNet-Vault/wiki/concepts/message-passing.md` — port types and object contracts
- `patchNet-Vault/wiki/entities/object-*.md` — all 6 object specs

---

## Tasks

### 1. `src/graph/PatchNode.ts`

```typescript
export type PortType = 'bang' | 'float' | 'signal' | 'any';

export interface PortDef {
  index: number;
  label?: string;
  type: PortType;
}

export interface PatchNodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  args: string[];
  inlets: PortDef[];
  outlets: PortDef[];
}

export class PatchNode implements PatchNodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  args: string[];
  inlets: PortDef[];
  outlets: PortDef[];

  constructor(data: PatchNodeData) { /* assign all fields */ }
}
```

### 2. `src/graph/PatchEdge.ts`

```typescript
export interface PatchEdgeData {
  id: string;
  fromNodeId: string;
  fromOutlet: number;
  toNodeId: string;
  toInlet: number;
}

export class PatchEdge implements PatchEdgeData {
  id: string;
  fromNodeId: string;
  fromOutlet: number;
  toNodeId: string;
  toInlet: number;
  constructor(data: PatchEdgeData) { /* assign */ }
}
```

### 3. `src/graph/objectDefs.ts`

Define the port layout for all 6 v1 objects:

```typescript
import type { PortDef } from './PatchNode';

interface ObjectDef {
  inlets: PortDef[];
  outlets: PortDef[];
  defaultWidth: number;
  defaultHeight: number;
}

export const OBJECT_DEFS: Record<string, ObjectDef> = {
  button:   { inlets: [{index:0,type:'bang'}], outlets:[{index:0,type:'bang'}],    defaultWidth:40,  defaultHeight:40 },
  toggle:   { inlets: [{index:0,type:'bang'}], outlets:[{index:0,type:'float'}],   defaultWidth:40,  defaultHeight:40 },
  slider:   { inlets: [],                      outlets:[{index:0,type:'float'}],   defaultWidth:120, defaultHeight:30 },
  metro:    { inlets: [{index:0,type:'any',label:'start/stop'},{index:1,type:'float',label:'interval ms'}],
              outlets:[{index:0,type:'bang'}],   defaultWidth:80,  defaultHeight:30 },
  'click~': { inlets: [{index:0,type:'bang'}], outlets:[{index:0,type:'signal'}],  defaultWidth:60,  defaultHeight:30 },
  'dac~':   { inlets: [{index:0,type:'signal',label:'L'},{index:1,type:'signal',label:'R'}],
              outlets:[],                        defaultWidth:60,  defaultHeight:30 },
};
```

### 4. `src/graph/PatchGraph.ts`

```typescript
import { PatchNode } from './PatchNode';
import { PatchEdge } from './PatchEdge';
import { OBJECT_DEFS } from './objectDefs';
import { v4 as uuidv4 } from 'uuid'; // add uuid to package.json

type ChangeHandler = () => void;

export class PatchGraph {
  nodes: Map<string, PatchNode> = new Map();
  edges: Map<string, PatchEdge> = new Map();
  private listeners: ChangeHandler[] = [];

  on(event: 'change', handler: ChangeHandler): void {
    this.listeners.push(handler);
  }

  private emit(): void {
    this.listeners.forEach(h => h());
  }

  addNode(type: string, x: number, y: number, args: string[] = []): PatchNode {
    const def = OBJECT_DEFS[type];
    if (!def) throw new Error(`Unknown object type: ${type}`);
    const node = new PatchNode({
      id: uuidv4(),
      type, x, y, args,
      inlets: def.inlets,
      outlets: def.outlets,
    });
    this.nodes.set(node.id, node);
    this.emit();
    return node;
  }

  removeNode(id: string): void {
    // Remove all edges connected to this node first
    for (const [eid, edge] of this.edges) {
      if (edge.fromNodeId === id || edge.toNodeId === id) {
        this.edges.delete(eid);
      }
    }
    this.nodes.delete(id);
    this.emit();
  }

  addEdge(fromNodeId: string, fromOutlet: number, toNodeId: string, toInlet: number): PatchEdge {
    const edge = new PatchEdge({ id: uuidv4(), fromNodeId, fromOutlet, toNodeId, toInlet });
    this.edges.set(edge.id, edge);
    this.emit();
    return edge;
  }

  removeEdge(id: string): void {
    this.edges.delete(id);
    this.emit();
  }

  moveNode(id: string, x: number, y: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.x = x;
    node.y = y;
    this.emit();
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.emit();
  }

  /** Returns nodes in stable insertion order (for serialization) */
  getOrderedNodes(): PatchNode[] {
    return Array.from(this.nodes.values());
  }
}
```

Add `uuid` to `package.json` devDependencies (or just use a simple counter ID for v1 if you prefer — fine either way).

### 5. `src/serializer/serialize.ts`

```typescript
import type { PatchGraph } from '../graph/PatchGraph';

export function serialize(graph: PatchGraph): string {
  const nodes = graph.getOrderedNodes();
  const lines: string[] = ['#N canvas;'];

  for (const node of nodes) {
    const args = node.args.length > 0 ? ' ' + node.args.join(' ') : '';
    lines.push(`#X obj ${Math.round(node.x)} ${Math.round(node.y)} ${node.type}${args};`);
  }

  // Build index map for connect lines
  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));

  for (const edge of graph.edges.values()) {
    const fromIdx = nodeIndex.get(edge.fromNodeId);
    const toIdx   = nodeIndex.get(edge.toNodeId);
    if (fromIdx === undefined || toIdx === undefined) continue;
    lines.push(`#X connect ${fromIdx} ${edge.fromOutlet} ${toIdx} ${edge.toInlet};`);
  }

  return lines.join('\n');
}
```

### 6. `src/serializer/parse.ts`

```typescript
import type { PatchGraph } from '../graph/PatchGraph';

export function parse(text: string, graph: PatchGraph): void {
  graph.clear();

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const nodeList: string[] = []; // track insertion order for connect

  for (const line of lines) {
    if (line.startsWith('#N canvas')) continue;

    if (line.startsWith('#X obj')) {
      // #X obj <x> <y> <type> [args...];
      const body = line.slice('#X obj'.length).replace(/;$/, '').trim();
      const parts = body.split(/\s+/);
      const x    = parseInt(parts[0], 10);
      const y    = parseInt(parts[1], 10);
      const type = parts[2];
      const args = parts.slice(3);
      const node = graph.addNode(type, x, y, args);
      nodeList.push(node.id);
    }

    if (line.startsWith('#X connect')) {
      // #X connect <srcIdx> <srcOutlet> <dstIdx> <dstInlet>;
      const body = line.slice('#X connect'.length).replace(/;$/, '').trim();
      const [si, so, di, dti] = body.split(/\s+/).map(Number);
      const fromId = nodeList[si];
      const toId   = nodeList[di];
      if (fromId && toId) {
        graph.addEdge(fromId, so, toId, dti);
      }
    }
  }
}
```

Note: `parse` calls `graph.clear()` which fires change events. This is intentional — the whole graph rebuilds when the text changes. Batch the events if performance becomes an issue (Phase 4+).

### 7. `src/canvas/ObjectRenderer.ts`

Renders a single `PatchNode` as a DOM element. Returns the element; the caller appends it to the canvas.

```typescript
import type { PatchNode } from '../graph/PatchNode';
import { OBJECT_DEFS } from '../graph/objectDefs';

const PORT_SIZE = 8;

export class ObjectRenderer {
  el: HTMLElement;
  private node: PatchNode;

  constructor(node: PatchNode) {
    this.node = node;
    this.el = this.build();
  }

  private build(): HTMLElement {
    const def = OBJECT_DEFS[this.node.type];
    const el = document.createElement('div');
    el.className = 'pn-object';
    el.dataset.nodeId = this.node.id;
    el.style.left = `${this.node.x}px`;
    el.style.top  = `${this.node.y}px`;
    el.style.width  = def ? `${def.defaultWidth}px`  : '80px';
    el.style.height = def ? `${def.defaultHeight}px` : '30px';

    // Label
    const label = document.createElement('span');
    label.className = 'pn-object-label';
    const argStr = this.node.args.length ? ' ' + this.node.args.join(' ') : '';
    label.textContent = this.node.type + argStr;
    el.appendChild(label);

    // Inlet ports (top edge)
    this.node.inlets.forEach((port, i) => {
      const p = document.createElement('div');
      p.className = 'pn-port pn-port-in';
      p.dataset.portIndex = String(i);
      p.dataset.portDir = 'in';
      el.appendChild(p);
    });

    // Outlet ports (bottom edge)
    this.node.outlets.forEach((port, i) => {
      const p = document.createElement('div');
      p.className = 'pn-port pn-port-out';
      p.dataset.portIndex = String(i);
      p.dataset.portDir = 'out';
      el.appendChild(p);
    });

    return el;
  }

  updatePosition(): void {
    this.el.style.left = `${this.node.x}px`;
    this.el.style.top  = `${this.node.y}px`;
  }
}
```

### 8. `src/canvas/canvas.css`

Create a new file `src/canvas.css` for object and port styles:

```css
/* Objects */
.pn-object {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--pn-object-bg);
  border: 1px solid var(--pn-object-border);
  border-radius: var(--pn-object-radius);
  cursor: grab;
  user-select: none;
  box-sizing: border-box;
}

.pn-object.selected {
  border-color: var(--pn-object-border-active);
  box-shadow: 0 0 0 1px var(--pn-object-border-active);
}

.pn-object-label {
  font-family: var(--pn-font-mono);
  font-size: var(--pn-type-object-name);
  color: var(--pn-text);
  pointer-events: none;
  white-space: nowrap;
}

/* Ports */
.pn-port {
  position: absolute;
  width: var(--pn-port-size);
  height: var(--pn-port-size);
  border-radius: var(--pn-port-radius);
  border: 1px solid currentColor;
  cursor: crosshair;
  box-sizing: border-box;
}

.pn-port-in {
  color: var(--pn-port-in);
  top: calc(var(--pn-port-size) / -2);
}

.pn-port-out {
  color: var(--pn-port-out);
  bottom: calc(var(--pn-port-size) / -2);
}

/* Port positioning: evenly space along top/bottom edge */
/* JS will set left: % based on port count */

.pn-port:hover {
  background: currentColor;
  opacity: 0.7;
}
```

Add `<link rel="stylesheet" href="/src/canvas.css" />` to `index.html`.

### 9. `src/ui/CanvasView.ts`

Ties graph → DOM rendering and graph → text panel:

```typescript
import { PatchGraph } from '../graph/PatchGraph';
import { ObjectRenderer } from '../canvas/ObjectRenderer';
import { serialize } from '../serializer/serialize';
import { parse } from '../serializer/parse';

export class CanvasView {
  private graph: PatchGraph;
  private canvasEl: HTMLElement;
  private textEl: HTMLTextAreaElement;
  private renderers: Map<string, ObjectRenderer> = new Map();

  constructor(graph: PatchGraph, canvasEl: HTMLElement, textEl: HTMLTextAreaElement) {
    this.graph = graph;
    this.canvasEl = canvasEl;
    this.textEl = textEl;

    graph.on('change', () => this.render());
  }

  private render(): void {
    // Sync text panel
    this.textEl.value = serialize(this.graph);

    // Rebuild DOM objects (simple full-redraw for Phase 1)
    // Remove objects not in graph
    for (const [id, renderer] of this.renderers) {
      if (!this.graph.nodes.has(id)) {
        renderer.el.remove();
        this.renderers.delete(id);
      }
    }
    // Add new objects
    for (const [id, node] of this.graph.nodes) {
      if (!this.renderers.has(id)) {
        const r = new ObjectRenderer(node);
        this.renderers.set(id, r);
        this.canvasEl.appendChild(r.el);
      }
      // Update position
      this.renderers.get(id)!.updatePosition();
    }
  }
}
```

### 10. Update `src/main.ts`

Wire everything together with a simple test to verify it works:

```typescript
import { PatchGraph } from './graph/PatchGraph';
import { CanvasView } from './ui/CanvasView';

const graph = new PatchGraph();
const canvasEl = document.querySelector('.canvas-area') as HTMLElement;
const textEl   = document.querySelector('.text-panel textarea') as HTMLTextAreaElement;

const view = new CanvasView(graph, canvasEl, textEl);

// Phase 1 smoke test — add the reference patch programmatically
graph.addNode('button',  100, 80);
graph.addNode('metro',   100, 160, ['500']);
graph.addNode('click~',  100, 240);
graph.addNode('dac~',    100, 320);

const nodes = graph.getOrderedNodes();
graph.addEdge(nodes[0].id, 0, nodes[1].id, 0);
graph.addEdge(nodes[1].id, 0, nodes[2].id, 0);
graph.addEdge(nodes[2].id, 0, nodes[3].id, 0);

console.log('patchNet Phase 1 — graph loaded');
```

---

## Port Positioning CSS

Add this to `canvas.css` — positions ports evenly along top/bottom edge based on their index and count. You'll need to set `--port-count` and `--port-index` via inline style in `ObjectRenderer`:

```css
.pn-port-in  { left: calc((var(--port-index) + 1) / (var(--port-count) + 1) * 100% - 4px); }
.pn-port-out { left: calc((var(--port-index) + 1) / (var(--port-count) + 1) * 100% - 4px); }
```

In `ObjectRenderer.build()`, set on each port element:
```typescript
p.style.setProperty('--port-index', String(i));
p.style.setProperty('--port-count', String(this.node.inlets.length)); // or outlets
```

---

## Completion Check

Run `npm run dev`. In the browser you should see:
- Four object boxes on the canvas at their x/y positions
- Each box has its class name in Vulf Mono
- Inlet ports visible on top edges, outlet ports on bottom edges
- Text panel shows the serialized patch text
- No JS errors in console

---

## Completion Instructions

1. Append to `AGENTS.md`:

```
---
## [DATE] COMPLETED | Phase 1 — Patch Graph Model
**Agent:** Codex
**Phase:** Phase 1
**Done:**
- [list]
**Changed files:**
- [list]
**Notes:**
- [decisions]
**Next needed:**
- Claude Code review → Phase 2 (Cursor: canvas interaction)
---
```

2. Reply with:

COMPLETED: Phase 1 — Patch Graph Model
AGENT: Codex
TASKS DONE:
- [bullets]
TASKS SKIPPED: [anything and why]
NEXT NEEDED: Claude Code review, then Phase 2 canvas interaction prompt for Cursor
