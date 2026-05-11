# patchNet — Project Plan

**Started:** 2026-04-16
**Workflow:** Solo dev (user) collaborating with Claude Code. Append work entries to `CHANGELOG.md` as phases complete.

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

### Phase 1 — Patch Graph Model
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

### Phase 2 — Canvas Interaction
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

### Phase 3 — Audio Runtime
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

### Phase 4 — Polish & Text-to-Patch
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
  PLAN.md
  DESIGN_LANGUAGE.md
  CHANGELOG.md
```

---

## Workflow

- **Before starting any task:** read the latest `CHANGELOG.md` entries to know current state
- **After completing any task:** append a completion entry to `CHANGELOG.md`
- **When blocked:** note the blocker in `CHANGELOG.md` and stop; don't guess past a blocker
- **When making an architecture decision:** note it in the Architecture Decisions Log inside `CHANGELOG.md` and update this `PLAN.md`

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
- **Peer networking** — see Phase 7 below

---

### Phase 7 — Peer Networking (planned)

**Goal:** Two users running patchNet on different machines can exchange control messages, audio, and video. Same implementation covers wireless (Wi-Fi / internet) and wired (Thunderbolt-bridge / USB-C between TB4-capable machines). See `patchNet-Vault/wiki/concepts/peer-networking.md` for the full architecture.

**Object family** (specced in `patchNet-Vault/wiki/entities/`):
- `peer` — owns one WebRTC session, exposes connection state and peer-list outlets
- `netsend` / `netreceive` — control-rate (data channel)
- `netsend~` / `netreceive~` — audio (MediaStream audio track)
- `netsend*` / `netreceive*` — video (MediaStream video track)

#### Phase 7A — Manual-SDP minimum viable peer (closed-loop demo)

Tasks:
- [ ] `src/runtime/peer/PeerSession.ts` — wraps `RTCPeerConnection`, owns one data channel + media track set
- [ ] `src/graph/localObjects/peer.ts` — peer object def + lifecycle controller
- [ ] `src/graph/localObjects/netsend.ts` / `netreceive.ts` — control-rate variants, MessagePack payload, reliable mode only
- [ ] Manual SDP copy/paste UI in the peer object panel (Tier-2 only — no server yet)
- [ ] Topic routing: data channels keyed by topic prefix; multiple netsend/netreceive multiplex over one session

Completion signal: two browser tabs (or two laptops) can paste SDP blobs into each other's `peer` object and exchange `netsend "foo" 42` → `netreceive "foo"` reliably.

#### Phase 7B — Hosted rendezvous (Tier-1 discovery)

Tasks:
- [ ] Tiny WebSocket signaling server (deploy target TBD — Cloudflare Worker / Fly / Railway)
- [ ] `peer` object `signaling=default` mode connects on load, announces room code
- [ ] Peer-list outlet emits other peers in the same room
- [ ] One-click connect from peer-list UI
- [ ] Reliability mode arg on `netsend` (reliable / unreliable / lifetime ms)
- [ ] Auto-rebind on reconnect

Completion signal: user types a room code into the `peer` object on two machines; they connect with no copy/paste.

#### Phase 7C — Audio + video variants

Tasks:
- [ ] `netsend~` taps inlet via `MediaStreamAudioDestinationNode`, adds track to peer connection
- [ ] `netreceive~` consumes incoming track via `ontrack`, exposes Web Audio output
- [ ] `netsend*` accepts a `MediaVideoSource` (same interface every video sink already understands), adds video track
- [ ] `netreceive*` exposes a `MediaVideoSource` outlet — slots into existing sinks (`layer*`, `vfxCRT*`, `reaperVideo*`, `vbuf*`, `shaderToy*`) with no sink-side changes
- [ ] Bandwidth/codec attribute panel (Opus bitrate; VP9/H.264 video preference)
- [ ] Hold-last-frame on disconnect for `netreceive*`; mute-on-disconnect for `netreceive~`

Completion signal: send `cam*` from machine A to a `reaperVideo*` chain on machine B over Wi-Fi; same patch unchanged works over a Thunderbolt bridge with sub-ms latency (ICE auto-prefers the bridge).

#### Phase 7D — Native helper sidecar (Tier-3 discovery, optional)

Tasks (defer until 7A–7C are stable):
- [ ] Tauri or Go sidecar binary doing real mDNS on every interface, including `bridge0`
- [ ] Localhost JSON API for the patchNet tab to query
- [ ] `peer` object `signaling=localhost:<port>` mode
- [ ] Installer / packaging story

Completion signal: closed-LAN setup with no internet; two machines on a Thunderbolt bridge auto-discover each other; patchNet shows them in a peer list without any copy/paste.

#### Non-goals for Phase 7

- Multi-peer mesh (>1 remote peer simultaneously) — out of scope; v1 networking is 1:1.
- TURN relay infrastructure — for v1, NAT-blocked peers fall back to manual SDP. Adding TURN is an ops decision, not an architecture decision.
- Tight musical synchronization (clock alignment, sub-frame timing) — transport is best-effort; tight sync is a patch-design problem solved on top.

---

### Phase 8 — Dual-target: Browser + Native Desktop (Tauri)

**Goal:** Ship patchNet as both a browser app and a high-performance native
desktop app from a single codebase. Browser = accessible, shareable, ~10–20ms
latency. Native = sub-3ms latency, MIDI, pro audio I/O, native file dialogs,
future sidecar processes. Same patch format, same terminal DSL, same visual
language across both.

**Architecture:** See `src/platform/` — already built (Phase 8A complete).

#### Phase 8A — Platform abstraction layer ✅ DONE (2026-05-10)

- [x] `src/platform/index.ts` — `PLATFORM` / `isNative` / `isBrowser` constants,
      resolved at build time via `__PLATFORM__` Vite `define` + runtime
      `window.__TAURI__` fallback.
- [x] `src/platform/audio.ts` — `AudioBackend` interface + `AudioCapabilities`
      capability flags. All audio callers will talk to this interface; the
      concrete implementation (Web Audio vs native CPAL) is injected at boot.
- [x] `src/platform/fs.ts` — `saveTextFile` / `openTextFile` abstraction.
      Browser: download link / `<input type=file>`. Native: Tauri dialog + fs
      write (dynamic imports, `@ts-ignore` until `tauri init`).
- [x] `ObjectSpec.platforms?: PlatformTarget[]` field — tags objects as
      `"browser"` / `"native"` / both (omit = both).
- [x] `isAvailableOnPlatform()` + `getAvailableObjectDefs()` helpers in
      `objectDefs.ts` — filter the palette, autocomplete, and terminal by
      current platform.
- [x] `renderUnavailableObject()` in `ObjectRenderer.ts` — renders a dimmed
      amber-outlined stub for native-only objects loaded in the browser.
- [x] `__PLATFORM__` injected by `vite.config.ts` from `VITE_PLATFORM` env var.
- [x] `tauri:dev` + `tauri:build` scripts in `package.json`
      (`VITE_PLATFORM=native tauri dev/build`).

#### Phase 8B — Tauri shell + native file I/O

Tasks:
- [ ] `npm install @tauri-apps/cli @tauri-apps/api @tauri-apps/plugin-dialog @tauri-apps/plugin-fs`
- [ ] `npx tauri init` — scaffold `src-tauri/` pointing at existing Vite build
- [ ] Wire `platform/fs.ts` native path through (remove `@ts-ignore` stubs)
- [ ] Replace `Cmd+S` save and `Cmd+O` open in `builtinActions.ts` to call
      `platform/fs.ts` instead of current browser download flow
- [ ] Native window title reflects current patch name
- [ ] `npm run tauri:dev` opens a desktop window running patchNet with native
      file dialogs

Completion signal: `Cmd+S` in the desktop build opens a native Save As dialog
and writes a real `.patchnet` file to disk; `Cmd+O` opens a real file picker.
Browser build still uses download/upload unchanged.

#### Phase 8C — Native audio backend (CPAL)

Tasks:
- [ ] Add `cpal` + `cpal-jack` (optional) to `src-tauri/Cargo.toml`
- [ ] Implement `AudioBackend` trait in Rust: start/stop, CPAL stream,
      per-node signal graph execution
- [ ] Tauri IPC commands: `audio_start`, `audio_stop`, `audio_sync_graph`,
      `audio_trigger_click`, `audio_trigger_adsr`, `audio_set_param`
- [ ] `NativeAudioBackend` TypeScript class implementing `AudioBackend`
      interface — forwards calls to IPC commands
- [ ] Boot-time injection: `isNative ? NativeAudioBackend : AudioGraph` wired
      through a single `getAudioBackend()` factory in `src/platform/audio.ts`
- [ ] `dac~` / `adc~` use CoreAudio direct on macOS — achieve <3ms latency

Completion signal: `wave~ → dac~` in the desktop build has measurably lower
latency than in the browser; RTL (round-trip latency) measured via loopback
reaches <5ms on macOS with default CoreAudio buffer.

#### Phase 8D — Native-only objects

First objects to tag `platforms: ["native"]` and implement natively:
- [ ] `midi` — MIDI device list outlet; connect/disconnect messages
- [ ] `midiIn` — receives MIDI from a device; note/cc/pitchbend outlets
- [ ] `midiOut` — sends MIDI to a device
- [ ] `dac~` 32ch pro-interface mode — DirectWire/ASIO on Windows, CoreAudio
      aggregate device on macOS for professional multi-channel interfaces

Completion signal: `midiIn → metro` — MIDI clock drives a metro object.

#### Phase 8E — Distribution

- [ ] macOS `.dmg` + code signing via Tauri
- [ ] Windows `.msi` installer
- [ ] Auto-update via Tauri's built-in updater
- [ ] Browser version deployed to a stable public URL
- [ ] `README.md` updated with two install paths: browser (URL) and desktop
      (download)

#### Non-goals for Phase 8

- iOS / Android mobile native app — the phone sensor objects (`phoneTilt` etc)
  already cover the mobile use case via the browser.
- Linux distribution in Phase 8E — CPAL supports it, Tauri supports it;
  defer until there’s a user asking for it.
- Replacing Web Audio in the browser build — browser stays on Web Audio;
  native gets CPAL. No WASM audio engine in between.
