# patchNet — Project Plan

**Director:** Claude Code
**Second in Command:** Cursor
**Development Team:** Cursor (frontend/canvas), Copilot (inline acceleration), Codex (logic/audio engine)
**User:** relays prompts between agents, tests, and gives feedback
**Started:** 2026-04-16

---

## What patchNet Is

A browser-based visual programming environment modeled after **Pure Data** and **Max/MSP**.

Users build programs by placing objects on a canvas and connecting them with patch cables. A synchronized text view on the right side shows the patch as human-readable code, and changes in either panel reflect immediately in the other.

### Prior Art (reference, not copy)
- **WebPd** (`github.com/sebpiq/WebPd`) — PD compiled to JS/WASM; patchNet is a fresh implementation with its own runtime and aesthetic
- **pd.js** — older browser PD port; useful for reference
- patchNet is not a PD runtime. It is its own language with PD/Max as the UX model.

---

## North Star

> A musician or programmer sits down, opens a browser tab, and builds a working click-track with a button to start it and audio output — in under 2 minutes — without reading a manual.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        patchNet app                          │
│                                                              │
│  ┌─────────────────────────┐   ┌──────────────────────────┐  │
│  │     Patch Canvas        │   │    Text / Code View      │  │
│  │  (DOM or SVG layer)     │◄──►  (serialized patch text) │  │
│  │                         │   │                          │  │
│  │  Objects + Cables       │   │  #X obj ... lines        │  │
│  └────────────┬────────────┘   └──────────────────────────┘  │
│               │                                              │
│  ┌────────────▼────────────────────────────────────────┐     │
│  │              Patch Graph (in-memory model)           │     │
│  │  nodes: Map<id, PatchNode>                           │     │
│  │  edges: Map<id, PatchEdge>                           │     │
│  │  serialize() → text   deserialize(text) → graph      │     │
│  └────────────┬────────────────────────────────────────┘     │
│               │                                              │
│  ┌────────────▼────────────────────────────────────────┐     │
│  │              Audio Runtime (Web Audio API)           │     │
│  │  AudioContext, scheduled clock, node graph           │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

### Key Layers

| Layer | Role | Tech |
|-------|------|------|
| **Patch Canvas** | Drag, drop, connect objects visually | Vanilla DOM / SVG overlay for cables |
| **Text View** | Synced serialization panel | Vulf Mono textarea or CodeMirror (later) |
| **Patch Graph** | In-memory model of nodes + edges | TypeScript classes |
| **Audio Runtime** | Executes the patch's audio logic | Web Audio API |
| **Serializer** | patch ↔ text format | Custom parser (PD-inspired syntax) |

---

## Tech Stack

- **TypeScript + Vite** — single-page app, no heavy framework in v1
- **Vanilla DOM** for object rendering (no React in v1 — canvas interaction is too direct)
- **SVG layer** overlay for patch cables (absolute positioned, transparent, sits above canvas)
- **Web Audio API** for all sound
- **CSS custom properties** from `DESIGN_LANGUAGE.md` — zero hardcoded hex
- **Vulf Mono + Vulf Sans** fonts from `fonts/` directory

---

## v1 Object Suite

These are the only objects shipped in Phase 1. Everything else comes later.

| Object | Category | Description |
|--------|----------|-------------|
| `button` | Control | Sends a bang message when clicked. One outlet. |
| `toggle` | Control | Toggles between 0 and 1 on click. One outlet. Displays X when ON. |
| `slider` | Control | Outputs a float 0.0–1.0 as the thumb moves. One outlet. |
| `metro` | Logic | Sends bangs at a regular interval (ms). One inlet (start/stop), one inlet (interval), one outlet. |
| `click~` | Audio | Generates a short click sound when banged. One inlet (bang), connects to `dac~`. |
| `dac~` | Audio | Audio output — passes signal to the browser audio output. One or two inlets (L/R). |

### Message Flow Model (v1 — simplified)

- Messages are synchronous and immediate (no sample-accurate scheduling in v1 except `metro`)
- `metro` uses `setInterval` internally, fires bangs on its outlet
- `click~` on bang creates a short `AudioBufferSourceNode` click and plays it
- `dac~` is a passthrough — it holds the `AudioContext.destination` reference
- All connections are typed `any` in v1 (no strict type checking between ports yet)

---

## Phases

### Phase 0 — Scaffold (Claude Code leads)
**Goal:** bare app shell, design tokens, font loading, two-panel layout

Tasks:
- [ ] `index.html` — app shell with toolbar, canvas area, text panel, status bar
- [ ] `src/tokens.css` — all `--pn-*` design tokens from `DESIGN_LANGUAGE.md`
- [ ] `src/fonts.css` — `@font-face` declarations for Vulf Mono + Vulf Sans
- [ ] `src/shell.css` — toolbar, status bar, split-panel layout, CRT overlay
- [ ] `src/canvas.css` — canvas surface, dot grid
- [ ] `vite.config.ts` + `tsconfig.json` + `package.json`
- [ ] Static placeholder: "patchNet" title in toolbar, empty canvas, empty text panel

Completion signal: app runs at `localhost:5173`, shows two-panel layout with correct fonts and colors.

---

### Phase 1 — Patch Graph Model (Claude Code / Codex)
**Goal:** in-memory data model, serializer, and basic canvas object rendering (no audio yet)

Tasks:
- [ ] `src/graph/PatchNode.ts` — node class: id, type, x, y, inlets[], outlets[]
- [ ] `src/graph/PatchEdge.ts` — edge class: id, fromNode, fromPort, toNode, toPort
- [ ] `src/graph/PatchGraph.ts` — graph: add/remove nodes and edges, serialize/deserialize
- [ ] `src/serializer/serialize.ts` — graph → text format
- [ ] `src/serializer/parse.ts` — text format → graph (basic, no error recovery yet)
- [ ] `src/canvas/ObjectRenderer.ts` — renders a PatchNode as a DOM element on canvas
- [ ] `src/canvas/PortRenderer.ts` — renders inlet/outlet port nubs on objects
- [ ] Text view updates when graph changes

Completion signal: add a `button` node programmatically, see it on canvas, see it in text panel.

---

### Phase 2 — Canvas Interaction (Cursor leads)
**Goal:** drag to create objects, drag to move, click ports to draw cables

Tasks:
- [ ] Object palette / context menu — right-click canvas → pick object type
- [ ] Drag to place object on canvas
- [ ] Click and drag objects to reposition
- [ ] Select object (click) — highlighted border
- [ ] Delete selected object (Backspace/Delete)
- [ ] Click outlet → drag → click inlet → creates cable (straight SVG line)
- [ ] Cable preview while dragging (ghost line follows cursor)
- [ ] Click cable to select, Backspace to delete
- [ ] Canvas pan (middle-mouse drag or Space+drag)
- [ ] Text view updates live as objects/cables are added/moved/removed

Completion signal: user can build `button → metro → click~ → dac~` entirely by mouse.

---

### Phase 3 — Audio Runtime (Codex leads)
**Goal:** the patch actually makes sound

Tasks:
- [ ] `src/runtime/AudioRuntime.ts` — wraps AudioContext, start/stop
- [ ] `src/runtime/nodes/MetroNode.ts` — setInterval-based bang emitter
- [ ] `src/runtime/nodes/ClickNode.ts` — creates AudioBufferSourceNode click on bang
- [ ] `src/runtime/nodes/DacNode.ts` — holds destination, connects incoming audio
- [ ] Message passing: outlet fires → walks graph edges → calls inlet handler on target node
- [ ] `button` click → bang propagates through graph
- [ ] `toggle` click → sends 0 or 1 downstream
- [ ] `slider` move → sends float downstream
- [ ] `metro` receives bang/0/1 on inlet 0 to start/stop, inlet 1 to set interval
- [ ] Audio on/off toggle in toolbar (starts/stops AudioContext)

Completion signal: `button → metro → click~ → dac~` produces a rhythmic click sound.

---

### Phase 4 — Polish & Text-to-Patch (Cursor + Codex)
**Goal:** text panel edits reflect back to canvas; overall UX tightening

Tasks:
- [ ] Parse text panel on change (debounced) → update graph → re-render canvas
- [ ] Syntax highlighting in text panel (`--pn-accent` for keywords)
- [ ] Error state on parse failure (red border on text panel, status bar message)
- [ ] Object labels editable (double-click to rename / set argument)
- [ ] `metro` argument editable inline (e.g. `metro 500`)
- [ ] Slider shows current value as Vulf Mono readout
- [ ] Save/load patch as `.patchnet` text file (download/upload)
- [ ] Basic undo/redo (Ctrl+Z / Ctrl+Shift+Z)

Completion signal: user can edit the text view and see the patch update on canvas in real time.

---

## File Structure (target end of Phase 4)

```
patchNet/
  index.html
  vite.config.ts
  tsconfig.json
  package.json
  fonts/
    VulfMono-Regular.woff2
    VulfMono-Bold.woff2
    VulfSans-Regular.woff2
    VulfSans-Bold.woff2
  src/
    main.ts
    tokens.css
    fonts.css
    shell.css
    canvas.css
    graph/
      PatchNode.ts
      PatchEdge.ts
      PatchGraph.ts
    serializer/
      serialize.ts
      parse.ts
    canvas/
      CanvasView.ts
      ObjectRenderer.ts
      PortRenderer.ts
      CableRenderer.ts
      DragController.ts
    runtime/
      AudioRuntime.ts
      nodes/
        ButtonNode.ts
        ToggleNode.ts
        SliderNode.ts
        MetroNode.ts
        ClickNode.ts
        DacNode.ts
    ui/
      Toolbar.ts
      TextPanel.ts
      StatusBar.ts
  docs/
    object-reference.md
  AGENTS.md
  PLAN.md
  DESIGN_LANGUAGE.md
  CHANGELOG.md
```

---

## Agent Roles & Responsibilities

| Agent | Owns |
|-------|------|
| **Claude Code** | Architecture decisions, data model, serializer, runtime message-passing design, code review, this PLAN.md |
| **Cursor** | All canvas interaction (drag, cable drawing, selection), UI shell (toolbar, status bar, text panel), CSS/layout, design token implementation |
| **Codex** | Audio runtime, Web Audio API nodes, graph traversal for message dispatch |
| **Copilot** | Inline acceleration when Cursor or Codex are moving fast through boilerplate |

---

## Communication Protocol

All agents read and write `AGENTS.md` in this directory.

- **Before starting any task:** read the latest `AGENTS.md` entries to know current state
- **After completing any task:** append a completion entry (see `AGENTS.md` format)
- **When blocked:** note the blocker in `AGENTS.md` and stop; don't guess past a blocker
- **When making an architecture decision:** note it in `AGENTS.md` and in this `PLAN.md`

---

## Definition of Done (Phase 1 MVP)

- [ ] App loads in browser with correct fonts and colors
- [ ] User can place all 6 v1 objects on canvas by right-clicking
- [ ] User can connect objects with straight patch cables
- [ ] Patch serializes to text panel in real time
- [ ] `button → metro → click~ → dac~` chain produces rhythmic click audio
- [ ] `toggle` starts/stops `metro`
- [ ] `slider` can control `metro` interval

---

## Future Phases (post-v1, not planned yet)

- Number box object
- Message box object
- Print / console object
- Oscillator (`osc~`)
- Gain (`*~`)
- Low-pass filter (`lop~`)
- MIDI input
- Multiple patches / subpatches
- Curved cable option (Max style, toggle)
- Export to standalone HTML
- Collaborative editing
