# patchNet — Project Plan

**Started:** 2026-04-16
**Last updated:** 2026-05-12

**Conversation recap (2026-05-12):** User clarified direction — patchNet is now a general creative coding platform (not just PD/Max audio). Performance targets: sub-5ms audio RTL via native CPAL, 60fps video via native GPU. Full platform abstraction confirmed (two backends per domain). De-prioritized peer networking / DMX expansion / mobile in favor of foundational architecture work. Six new active milestones replace old pending phases. See `## Current Direction` below. \
**Workflow:** Solo dev (user) collaborating with Claude Code, Cursor, Codex. Append work entries to `CHANGELOG.md` as phases complete.

---

## What patchNet Is

A **general-purpose creative coding platform for computer-aided art** — audio, video, lighting, and peer collaboration. One platform, many domains.

Users build programs by placing objects on a canvas and connecting them with patch cables. A synchronized text view on the right side shows the patch as human-readable code, and changes in either panel reflect immediately in the other.

patchNet draws UX inspiration from **Pure Data** and **Max/MSP**, but it is its own language and runtime, not a PD clone.

### Prior Art (reference, not copy)

- **Pure Data** / **Max/MSP** — UX model (canvas + cables + objects)
- **WebPd** (`github.com/sebpiq/WebPd`) — PD compiled to JS/WASM; useful reference
- **pd.js** — older browser PD port; useful reference
- **TouchDesigner** — node-based visual programming for media arts
- **vvvv** — visual live-programming environment
- **nannou** / **openFrameworks** — creative coding frameworks (reference for domain coverage)

---

## North Star

> A creative coder sits down — in a browser tab or a native desktop app — and builds a working patch that makes sound, processes video, controls lighting, or talks to another instance — in under 2 minutes — without reading a manual.

---

## Current Direction (2026-05-12)

The project grew organically beyond its original scope. This section captures the strategic decisions made to align the architecture with the broader vision.

### Core Identity

> A **general-purpose creative coding platform for computer-aided art** — patchNet is not just an audio patcher, a video mixer, or a lighting console. It is all of these things, because art-making doesn't respect domain boundaries.

### Target Delivery

| Tier                  | Platform                        | Performance                         | Audience                           |
| --------------------- | ------------------------------- | ----------------------------------- | ---------------------------------- |
| 🥇 **Desktop native** | Tauri (macOS / Windows / Linux) | Sub-5ms audio RTL, native GPU video | Live performance, pro users        |
| 🥈 **Browser**        | Any modern browser              | Web Audio API, canvas/WebGL         | Prototyping, education, casual use |

**Architecture decision:** Full platform abstraction with two backends for every domain (audio, video, fs). See Phases 8C–8D.

### Forward Priority Stack

Before adding new objects or domains, the foundation must be solid. Priority order:

| Priority | Milestone                                                                                     | Why                                                                         |
| -------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1        | **Object API Contract** — strict types, written spec, canonical examples, runtime validation  | Everything depends on the object spec. Lock it first.                       |
| 2        | **Serialization Stability** — versioned .patchnet format, migration path                      | Every new object serializes differently. Stability prevents patch breakage. |
| 3        | **Audio Backend Abstraction** — interface with browser (Web Audio) + native (CPAL) impls      | Core performance bottleneck. Sub-5ms requires native.                       |
| 4        | **Video Backend Abstraction** — interface with browser (canvas/WebGL) + native (GPU) impls    | Second performance bottleneck. Needed for reliable video.                   |
| 5        | **Plugin System Maturity** — well-documented LocalPlugin API so objects can live outside core | Allows contributors to add objects without touching core code.              |
| 6        | **Test Coverage + CI** — tests for every object, audio routing, serialization round-trip      | Without tests, refactoring the foundation breaks things silently.           |

### Performance Targets

| Domain                       | Browser                  | Desktop Native                 |
| ---------------------------- | ------------------------ | ------------------------------ |
| **Audio round-trip latency** | ~10–30ms (Web Audio API) | <3ms (CPAL + CoreAudio)        |
| **Video frame rate**         | 30fps (canvas/WebGL)     | 60fps (native GPU compositing) |
| **UI responsiveness**        | Snappy at ~100 objects   | Snappy at ~1000 objects        |

### Decision Record

- **2026-05-12:** Full platform abstraction confirmed — every domain gets browser + native implementations
- **2026-05-12:** Object API Contract is the keystone — all other foundation work depends on it
- **2026-05-12:** Plugin system is tier-5 priority — important but downstream of stable object API
- **2026-05-12:** Tests happen in parallel with foundation work, not as a separate phase

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        patchNet app                              │
│                                                                  │
│  ┌─────────────────────────┐   ┌──────────────────────────────┐  │
│  │     Patch Canvas        │   │    Text / Code View          │  │
│  │  (DOM object tiles +    │◄──►  (serialized patch text)     │  │
│  │   SVG cable overlay)    │   │                              │  │
│  │                         │   │  #X obj ... lines            │  │
│  │  Objects + Cables       │   │  Terminal (Shift+T)          │  │
│  └────────────┬────────────┘   └──────────────────────────────┘  │
│               │                                                  │
│  ┌────────────▼──────────────────────────────────────────────┐   │
│  │              Patch Graph (in-memory model)                 │   │
│  │  nodes: Map<id, PatchNode>  edges: Map<id, PatchEdge>     │   │
│  │  undo: UndoManager (batch-aware)                          │   │
│  │  names: nodeNames.ts (human-readable, auto-allocated)     │   │
│  │  serialize() ↔ text   clonePartial() → copy/paste         │   │
│  └──────┬────────────────────────────────────────────────────┘   │
│         │                                                        │
│  ┌──────┴─────────────────────────────────┐  ┌────────────────┐  │
│  │         Audio Runtime (Web Audio)       │  │ Video Runtime  │  │
│  │  AudioGraph + audio node types:         │  │ VisualizerGraph │  │
│  │  ~25 types: wave~, noise~, lfo~, adsr~,│  │ layer*, vfx*,  │  │
│  │  click~, buffer~, js~, mixer~, fft~,   │  │ shaderToy,     │  │
│  │  transientFollower~, adc~/dac~ (N-ch)   │  │ reaperVideo*   │  │
│  └─────────────────────────────────────────┘  └────────────────┘  │
│         │                                                        │
│  ┌──────┴────────────────────────────────────────────────────┐   │
│  │              DMX Lighting Runtime                         │   │
│  │  dmx object + DmxGraph, EnttecProTransport (Web Serial),  │   │
│  │  FixtureProfiles, DmxPanel (inline UI)                    │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────┴────────────────────────────────────────────────────┐   │
│  │              Peer Networking                               │   │
│  │  WebRTC sessions: peer, netsend, netreceive               │   │
│  │  Topic-routed data channel (MessagePack)                   │   │
│  │  7B pending: hosted rendezvous signaling                   │   │
│  │  7C pending: audio/video tracks                            │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────┴──────────────┐                                         │
│  │  Platform Layer      │  browser ↔ Tauri (native desktop)      │
│  │  platform/index.ts   │  isNative, audio/fs abstractions       │
│  └─────────────────────┘                                         │
└──────────────────────────────────────────────────────────────────┘
```

### Key Layers

| Layer               | Role                                  | Tech                                                           |
| ------------------- | ------------------------------------- | -------------------------------------------------------------- |
| **Patch Canvas**    | Drag, drop, connect objects visually  | Vanilla DOM, SVG cables, bounded canvas (2560×1440)            |
| **Text View**       | Synced serialization panel + terminal | Vulf Mono textarea, Shift+T patch terminal                     |
| **Patch Graph**     | In-memory model of nodes + edges      | TypeScript classes, batchChange, UndoManager                   |
| **Action System**   | Keybindings, palette, user overrides  | ActionRegistry, ActionKeymap, ActionListDialog                 |
| **Audio Runtime**   | Executes the patch's audio logic      | Web Audio API, AudioWorklet (js~, transientFollower~)          |
| **Video Runtime**   | Compositing, shader effects           | OffscreenCanvas, WebGL, popup render window                    |
| **DMX**             | Lighting control                      | Web Serial API, Enttec USB Pro protocol                        |
| **Peer Networking** | Inter-instance communication          | WebRTC DataChannel, manual SDP (v1)                            |
| **Serializer**      | patch ↔ text format                   | Custom parser (PD-inspired syntax), lossless round-trip        |
| **Platform**        | Browser vs Tauri abstraction          | Runtime detection, fs/audio interface, platform-tagged objects |

---

## Tech Stack

- **TypeScript + Vite** — single-page app
- **Vanilla DOM** — object tile rendering (no React/canvas render)
- **SVG** — patch cable overlay (straight cables, PD-style)
- **Web Audio API** — all audio, with AudioWorklet for custom DSP
- **Web Serial API** — DMX Enttec USB Pro transport
- **WebRTC** — peer-to-peer data channels for networking
- **Tauri 2** — native desktop shell (macOS/Windows/Linux)
- **CPAL (Rust)** — pending native audio backend for sub-5ms latency
- **CSS custom properties** — `--pn-*` design tokens
- **Vulf Mono + Vulf Sans** — monospace + UI fonts
- **Vitest** — test runner

---

## Shipped Object Suite (~45 objects)

### Control / Math

`button` · `toggle` · `slider` · `ezSlider` · `ezScale` · `metro` · `timer` · `count` · `drunk` · `pack` · `unpack` · `prepend` · `append` · `trigger` · `int` · `float` · `f` · `+` · `-` · `*` · `/` · `s` · `r` · `comment` · `message` · `sequencer` · `oscillateNumbers`

### Audio

`click~` · `noise~` · `wave~` · `lfo~` · `adsr~` · `transientFollower~` · `mixer~` · `buffer~` · `vbuf*` · `fft~` · `js~` (JSFX/EEL2) · `adc~ N` (1–32ch) · `dac~ N` (1–32ch)

### Video

`cam*` · `frame*` · `browser~*` · `youtube~*` · `mediaVideo*` · `mediaImage*` · `imageFX*` · `vfxCRT*` · `vfxBlur*` · `shaderToy*` · `reaperVideo*` · `layer*` · `visualizer*`

### Lighting

`dmx`

### Peer Networking

`peer` · `netsend` · `netreceive`

---

## Phases

Phases are listed in the order they are planned, not necessarily the order they shipped — many shipped ahead of schedule.

### Phase 0 — Scaffold ✅ DONE

**Goal:** bare app shell, design tokens, font loading, two-panel layout

### Phase 1 — Patch Graph Model ✅ DONE

**Goal:** in-memory data model, serializer, basic canvas object rendering (no audio yet)

Tasks expanded well beyond original spec:

- `PatchNode`, `PatchEdge`, `PatchGraph` with batch changes, undo manager
- `serialize.ts` + `parse.ts` — PD-inspired text format, lossless round-trip
- `ObjectRenderer.ts` — DOM-based object tile rendering
- Port rendering, object names (`nodeNames.ts`), persistent aliases

### Phase 2 — Canvas Interaction ✅ DONE

**Goal:** full mouse-driven patch editing

- Right-click context menu → pick object type
- Drag to place, move, select, delete objects
- Cable drawing: click outlet → drag → click inlet (straight SVG lines with preview)
- Cable selection, deletion, hover states
- Canvas pan (Space+drag / middle-click), zoom
- Bounded canvas at 2560×1440 with coordinate rulers + grid
- Patch mode toggle (P key) to lock cables

### Phase 3 — Audio Runtime ✅ DONE

**Goal:** the patch actually makes sound

Original 6 audio objects expanded to ~25 audio node types:

- `click~`, `noise~`, `wave~` (morphing oscillator), `lfo~`, `adsr~`, `transientFollower~`, `mixer~`
- `buffer~` (tape recorder), `vbuf*` (video-rate buffer)
- `fft~`, `js~` (JSFX/EEL2 via AudioWorklet)
- `adc~` / `dac~` multichannel (1–32 channels)
- Audio Status panel (device picker, sample rate, channel config)

### Phase 4 — Polish & Text-to-Patch ✅ DONE

**Goal:** text panel edits reflect back to canvas; overall UX tightening

- Bidirectional sync: text → canvas via parse + re-render
- Syntax highlighting
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z) with compound undo via `batchChange`
- Save/load as `.patchnet` files (download + upload in browser; native dialogs in Tauri)
- Action system replacing scattered keydown handlers
- REAPER-style action list palette (`?`) with search, section filtering, user keymap editing

### Phase 5 — Control / Render Split ✅ DONE

- Split the graph into control-rate (message passing) and audio-rate (signal) domains
- All objects come from a single `OBJECT_DEFS` registry

### Phase 6 — Live Coding Surface ✅ DONE

- **Patch terminal** (Shift+T): type commands to manipulate the patch
- **Patch-phrase DSL** (`{ ... }`): build signal chains in one expression
- **Object names**: auto-allocated human-readable names, persist through save/load
- **Scratch tabs** (⌘T): independent top-level patches alongside the main patch
- **Plugin actions**: `LocalPlugin.actions?()` extension point for searchable palette actions

### Phase 7 — Peer Networking ⚡ PARTIAL

**Phase 7A — Manual-SDP MVP ✅ DONE** (2026-05-01)
Three objects shipped: `peer`, `netsend`, `netreceive`. Topic-routed data channel, manual SDP copy/paste. Browser-to-browser control messages working.

---

## Active Milestones (priority order)

These replace the old Phase 7B–7D and 8C–8E pending items. Foundation work first.

### M1 — Object API Contract

**Goal:** A stable, documented contract that every object must conform to. No more ad-hoc `any` fields or missing hooks.

| #   | Task                        | What                                                                                                         |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1a  | **Strict ObjectSpec types** | Refactor `objectDefs.ts` — proper generics, discriminated port types, runtime `validateObjectDef()` function |
| 1b  | **Written API spec**        | Create `docs/object-api.md` — every interface, lifecycle hook, port type, serialization contract             |
| 1c  | **Canonical examples**      | Pick 1 simple + 1 complex object, refactor them to perfectly exemplify the spec                              |
| 1d  | **Runtime validation**      | `validateObjectDef()` at boot — catches missing ports, wrong types, broken serializers before runtime errors |

**Deliverable:** No new object types until the contract is stable. All ~45 existing objects conform to the validated spec.

---

### M2 — Serialization Stability

**Goal:** The `.patchnet` text format is versioned, every object serializes deterministically, and old patches migrate forward.

- [ ] Version header in `.patchnet` format (`#N patchnet v2`)
- [ ] Format documentation (`docs/serialization-format.md`)
- [ ] Object-level `serialize()` / `deserialize()` hooks in ObjectSpec
- [ ] Migration path from v1 (current) to v2
- [ ] Round-trip tests for every object

**Depends on:** M1 (ObjectSpec must be stable first)

---

### M3 — Audio Backend Abstraction

**Goal:** `AudioBackend` interface with two full implementations — browser (Web Audio API) and native (CPAL via Tauri IPC).

- [ ] Finalize `AudioBackend` interface in `platform/audio.ts`
- [ ] Refactor `AudioGraph` to talk to the interface, not Web Audio directly
- [ ] `WebAudioBackend` — wraps current Web Audio API calls
- [ ] `NativeAudioBackend` — CPAL via Tauri IPC commands (`audio_start`, `audio_stop`, `audio_sync_graph`, etc.)
- [ ] Rust side: `cpal` + `cpal-jack` in `Cargo.toml`, IPC command handlers
- [ ] Boot-time injection: `platform/audio.ts` selects backend based on `isNative`
- [ ] Target: <3ms RTL on macOS CoreAudio

**Depends on:** M1 (object port types influence audio routing contract)

---

### M4 — Video Backend Abstraction

**Goal:** `VideoBackend` interface with browser (canvas/WebGL) and native (GPU compositing) implementations.

- [ ] `VideoBackend` interface — frame sources, compositing, shader execution, render targets
- [ ] `BrowserVideoBackend` — wraps current OffscreenCanvas/WebGL code
- [ ] `NativeVideoBackend` — GPU compositing via Tauri (wgpu/metal/vulkan)
- [ ] Refactor `VisualizerGraph`, `LayerNode`, `ShaderToyNode`, etc. to use the interface
- [ ] Target: 60fps native compositing

**Depends on:** M1 (object port types for video frames), M3 (shared IPC infrastructure)

---

### M5 — Plugin System Maturity

**Goal:** A well-documented `LocalPlugin` API so third-party objects can live outside core.

- [ ] Document `LocalPlugin.actions?()`, `LocalPlugin.objects?()`, lifecycle hooks
- [ ] Plugin loading from external files / directories
- [ ] Plugin dependency management
- [ ] Example plugin with full docs

**Depends on:** M1 (plugin API is the ObjectSpec contract exposed to outsiders)

---

### M6 — Test Coverage + CI

**Goal:** Test every object, every audio routing pattern, serialization round-trip, and edge case.

- [ ] Object-level unit tests (serialize/deserialize per type)
- [ ] Audio routing integration tests (signal chain correctness)
- [ ] Canvas interaction tests (drag, cable, selection)
- [ ] Serialization round-trip tests (all objects)
- [ ] CI pipeline (GitHub Actions)
- [ ] Coverage target: >80%

**Runs in parallel with** M1–M5 (add tests as each milestone ships)

---

## Backlog (de-prioritized)

These features exist from the original plan and remain desirable, but are blocked by the foundation work above.

### Peer Networking Expansion

| Item                                                                          | Depends on                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| **7B — Hosted rendezvous** (WebSocket signaling, auto-connect)                | M1 (object spec for `peer`), M6 (tests for existing peer) |
| **7C — Audio/video variants** (`netsend~`, `netreceive~`, audio/video tracks) | M3, M4 (audio + video abstractions must exist first)      |
| **7D — Native discovery** (mDNS, LAN sidecar)                                 | M3 (audio backend stability), M6                          |

### Native Desktop Expansion

| Item                                                              | Depends on                           |
| ----------------------------------------------------------------- | ------------------------------------ |
| **8C — CPAL audio backend**                                       | M3 (already captured above — see M3) |
| **8D — MIDI objects** (`midi`, `midiIn`, `midiOut`)               | M1 + M3 foundation stable            |
| **8E — Distribution** (`.dmg`, `.msi`, auto-update, code signing) | M3, M4, M6 (all backends tested)     |

### DMX Expansion

| Item                          | Depends on |
| ----------------------------- | ---------- |
| Multi-universe DMX            | M1, M6     |
| Art-Net / sACN over UDP       | M1         |
| Fixture library import (GDTF) | M1         |
| Curve editor                  | M1         |

### Live Performance Mode

| Item                          | Depends on                    |
| ----------------------------- | ----------------------------- |
| Full-screen presentation mode | M4 (stable video)             |
| Scene recall / cue list       | M2 (stable serialization)     |
| Performer UI                  | M1                            |
| MIDI / OSC binding            | M3 (audio backend), 8D (MIDI) |

### Mobile / Touch

| Item                   | Depends on        |
| ---------------------- | ----------------- |
| Multi-touch, phone mic | Foundation stable |
| Responsive canvas      | M4                |
| Gesture cable drawing  | M1                |

### Collaborative Editing

| Item                         | Depends on                   |
| ---------------------------- | ---------------------------- |
| Real-time multi-user editing | M6 (tests), 7B (stable peer) |
| CRDT / OT                    | 7B                           |
| Shared cursors               | 7B                           |

## File Structure (current)

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
  src-tauri/              # Tauri desktop shell
    Cargo.toml
    tauri.conf.json
    capabilities/
    src/
      main.rs
      lib.rs
  src/
    main.ts
    tokens.css
    fonts.css
    shell.css
    actions/
      ActionRegistry.ts
      ActionKeymap.ts
      ActionDispatcher.ts
      ActionListDialog.ts
      builtinActions.ts
      objectCreateActions.ts
      types.ts
      index.ts
    canvas/
      CanvasController.ts
      ObjectRenderer.ts
      ObjectInteractionController.ts
      CableRenderer.ts
      CableDrawController.ts
      DragController.ts
      ResizeController.ts
      CanvasRulers.ts
      TabManager.ts
      ScratchTabSession.ts
      SubPatchSession.ts
      SubPatchManager.ts
      patchModeState.ts
      zoomState.ts
      canvasSpace.ts
      AudioConfigPanel.ts
      DmxPanel.ts
      JsEffectPanel.ts
      JsEffectLibraryDialog.ts
      ImageFXPanel.ts
      ReaperVideoPanel.ts
      YouTubePanel.ts
    control/
      ShareLoadController.ts
    graph/
      PatchNode.ts
      PatchEdge.ts
      PatchGraph.ts
      objectDefs.ts
      nodeNames.ts
      userObjectDefaults.ts
      localPlugins.ts
      InteractableNode.ts
    platform/
      index.ts
      audio.ts
      fs.ts
    runtime/
      AudioGraph.ts
      AudioRuntime.ts
      AdcNode.ts / DacNode.ts / WaveNode.ts / LfoNode.ts
      AdsrNode.ts / ClickNode.ts / NoiseNode.ts
      BufferNode.ts / MixerNode.ts / FftAnalyzerNode.ts
      JsEffectNode.ts / BrowserNode.ts
      LayerNode.ts / FrameNode.ts
      ImageFXNode.ts / MediaImageNode.ts / MediaVideoNode.ts
      VisualizerGraph.ts / VisualizerNode.ts / PatchVizNode.ts
      ShaderToyNode.ts / ReaperVideoNode.ts
      dmx/ — DmxGraph, DmxNode, EnttecProTransport, FixtureProfile
      peer/ — WebRTC session management
      phoneSensor/ — PhoneSensorRegistry
      buffer/ — streaming PCM, worklet ring
      jsfx/ — JSFX library management
      eel2/ — EEL2 parser/interpreter
    serializer/
      serialize.ts
      parse.ts
    terminal/
      PatchTerminalController.ts
      PatchTerminalEngine.ts
    share/
      shareUrl.ts
    cursors/
    control/
    crtOverlaySync.ts
    IRenderContext.ts
    ImageStore.ts
  docs/
    objects/              # ~9 of ~45 objects documented
  tests/
    actions.test.ts
    batch-change.test.ts
    jsfx-compat.test.ts
    noise-object.test.ts
    node-names.test.ts
    round-trip.test.ts
    terminal.test.ts
  autosaves/
    *.patchnet            # auto-saved patches
  PLAN.md
  DESIGN_LANGUAGE.md
  CHANGELOG.md
  README.md
```

---

## Workflow

- **Before starting any task:** read the latest `CHANGELOG.md` entries to know current state
- **After completing any task:** append a completion entry to `CHANGELOG.md`
- **When blocked:** note the blocker in `CHANGELOG.md` and stop; don't guess past a blocker
- **When making an architecture decision:** note it in the Architecture Decisions Log inside `CHANGELOG.md` and update this `PLAN.md`
- **For cross-LLM agent handoff** (Claude Code / Cursor / Codex): use the `patchNet-Vault/wiki/` for detailed object specs, concept docs, and research notes

---

## Open Items & Known Gaps

### Documentation

- [ ] Object reference docs: only 9 of ~45 objects have pages in `docs/objects/`
- [ ] Objects needing docs: `ezScale`, `sequencer`, `drunk`, `pack`/`unpack`/`prepend`/`append`, `trigger`, `mixer~`, `fft~`, `dmx`, `shaderToy*`, `cam*`, `frame*`, `layer*`, `vfx*`, `reaperVideo*`, `peer`/`netsend`/`netreceive`, `buffer~`, `vbuf*`, `phoneTilt`, `timer`, `count`, `oscillateNumbers`, `imageFX*`, `mediaVideo*`, `mediaImage*`, `browser~*`, `youtube~*`, `visualizer*`, `message`, `comment`, `int`, `float`, `f`, `+`, `-`, `*`, `/`, `s`, `r`

### Testing

- [ ] Only 8 test files — many objects lack round-trip or unit coverage
- [ ] No integration tests for audio routing, DMX, video, or peer networking
- [ ] No automated browser/visual regression tests

### Polish & Quality of Life

- [ ] Per-tab text panel sync (currently only main patch shown)
- [ ] Multi-tab save-to-file format (scratch tabs persist via localStorage only)
- [ ] Rename object UX (names set only via `add ... as ...` or auto-allocated)
- [ ] Tab completion in terminal
- [ ] Saved phrase macros (disabled "New action…" button in action list)
- [ ] Find shortcut feature in action list
- [ ] Coordinate-input flow (slash-command for `(x,y)` object placement)
- [ ] Dynamic native window title from patch name
