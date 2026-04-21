# Control / Render Split — Architecture Plan

**Status:** plan authored 2026-04-19 — Phase 1 in flight.
**Author:** Claude Code (Director).
**Scope:** visualizer object + canvas-nested patchViz object + render runtime.

---

## 1. Executive Summary

Keep rendering local and browser-based for v1. The real value is not process isolation — it is a clean **control-plane abstraction** between `PatchGraph` events and the renderer. Today that boundary is smeared across `VisualizerGraph.ts`, `LayerNode`, and the runtime node classes. Fix that first.

**Do not** move rendering to a separate process, machine, or WebRTC stream for v1. None of the current bottlenecks (video decode, canvas composite, rAF cadence) are control-path bottlenecks. They are GPU/decoder bottlenecks and moving them to a second machine shifts the cost to network + re-encode — strictly worse.

**Wins available now:**
1. A versioned **ControlBus** (single enum of message types) eliminates the 7+ `deliverXxxMessage` methods on `VisualizerGraph` and makes every sync path testable in isolation.
2. Promote `IRenderContext` into an **`IRenderer` SPI** with pluggable implementations (local-canvas, popup, future remote).
3. Decouple the **visualizer object** (controller concept) from the **render context** (DOM/window concept). Conflated in `VisualizerNode.ts` today.
4. Treat `patchViz` as the **canonical local-preview renderer** — it already is; we stop describing it as a peer of the popup.

**Long term:** once the control protocol is clean + versioned, adding a WebSocket transport for a desktop/Electron or native renderer is a transport swap, not a rewrite.

---

## 2. Proposed Architecture

### 2.1 Four tiers

```
APPLICATION (main.ts, controllers)
  ↓ graph change + message delivery
CONTROLLER / DIRECTOR (new: RenderDirector)
  ↓ ControlMessage[] via transport
TRANSPORT (new: ControlBus — Local / BroadcastChannel / WebSocket)
  ↓ applies control state
RENDERER (IRenderer — CanvasRenderer, PopupRenderer, future RemoteRenderer)
```

### 2.2 Responsibility split

| Concern | Owner |
|---|---|
| Patch graph (nodes/edges) — source of truth | `PatchGraph` |
| Text panel round-trip | serialize/parse |
| User input / drag / cables | canvas controllers |
| Graph → ControlMessage translation | `RenderDirector` (new; replaces most of `VisualizerGraph`) |
| Media binary storage | `VideoStore` / `ImageStore` (unchanged) |
| Scene state | `Renderer` (authoritative per-renderer) |
| Effect parameter values | `Renderer` cache, authoritative in PatchGraph args |
| Transport / playback state | `Renderer`, mirrored to PatchGraph args via `Status` |
| Compositing + rAF | `Renderer` |
| Preset load/save | `main.ts` + serializer |
| Popup keyboard / dblclick fullscreen | `PopupRenderer` |
| Transport timing (metro, rAF) | Controller side — renderers never schedule patch events |

### 2.3 The key reframe

Today `VisualizerGraph.sync()` is **both** a reconciler (create/destroy runtime nodes to match graph) **and** a message router (`deliverVfxMessage`, `deliverLayerMessage`, etc.). Split these. The reconciler becomes `RenderDirector.reconcile()` emitting `SceneAdd` / `SceneRemove`. The router becomes `RenderDirector.dispatch()` emitting `ParamUpdate` / `Command`. No renderer method is called directly from controller code — every touch is a message.

---

## 3. Object Responsibility Redesign

### 3.1 The visualizer object

Today `VisualizerNode` conflates: popup window lifecycle, canvas creation, rAF loop, layer compositing, patch-side callbacks.

**Split:**

| New class | Responsibility |
|---|---|
| `VisualizerObject` (controller) | Patch-side representation. Holds `contextName`, reads args, emits ControlMessages. No DOM, no window. |
| `PopupRenderer` (render, `IRenderer`) | Owns the `Window`, canvas, rAF, fullscreen, resize events. Publishes `Status` messages. |
| `CanvasRenderer` (render, `IRenderer`) | What `PatchVizNode` becomes. Same interface minus windowing. |

Visualizer object becomes **transport-agnostic**. Does not know whether its renderer is popup, inline, or remote. That decision happens in a `RendererFactory` driven by args (e.g. `visualizer world1 popup`).

It should **not** retain rendering responsibilities.
It **should** subscribe to renderer status messages — that is how it updates patch args (`args[2]` open flag, `args[5]`/`args[6]` size) today via `onResize` / `onMove` closures. Replace closures with a typed `Status` feed.

### 3.2 The canvas-nested patchViz object

Recommended framing: **purely a view / client**, with a tiny adapter for canvas-interaction pass-through.

Reasoning:
- Structurally identical to the popup minus windowing. Already implements `IRenderContext`.
- "Hybrid fallback to local rendering" duplicates state (effect params, preset recall, scene graph). Exactly the sprawl we are refactoring away.
- patchViz = canonical `LocalCanvasRenderer`. Large render → `visualizer` object (popup). Future remote → `visualizer` variant, not a patchViz variant.

Concrete:
- `PatchVizObject` (controller) — mirrors `VisualizerObject`.
- `CanvasRenderer` (render) — inline canvas in patch DOM; same `IRenderer` control messages.

This collapses the `patchVizNodes` branch in `VisualizerGraph.sync()` into the same factory path.

---

## 4. Communication / Protocol Recommendations

### 4.1 Candidates

| Protocol | Best for | In-browser? | Latency | Complexity |
|---|---|---|---|---|
| Direct method call | v1 same JS context | yes | ~0 | none |
| BroadcastChannel | main ↔ popup same-origin | yes | <1ms | low |
| MessagePort / postMessage | main ↔ worker / iframe | yes | <1ms | low |
| WebSocket (JSON) | remote renderer | yes | 1–5ms LAN, 20–80ms WAN | medium |
| OSC | interop with Max/PD/hardware | not native; needs OSC-over-WS bridge | 1–5ms LAN | medium |
| HTTP | preset load/save, health | yes | 5–50ms | trivial |

### 4.2 Rejecting OSC for now

OSC has no advantage over JSON-over-WebSocket when the counterparty is also our code. Its value is interop with existing OSC-speaking tools. Add an OSC adapter later only if needed. Do not build the core protocol around it.

### 4.3 Recommended stack

| Phase | Transport |
|---|---|
| v1 (ship now) | Direct in-process dispatch via `ControlBus` wrapping `renderer.apply(msg)`. |
| v2 (popup isolation) | `BroadcastChannel("patchNet/render/<contextName>")`. Same JSON. |
| v3 (remote renderer) | WebSocket. JSON identical. WebRTC DataChannel / WebTransport only if binary side-channel needed. |

**Channel assignments:**

| Use | Channel |
|---|---|
| Continuous real-time control | `ControlBus` `ParamUpdate`, coalesced per-frame |
| One-shot commands | `ControlBus` `Command` |
| Preset load / save | HTTP or localStorage/IDB. Never on realtime bus. |
| Status / health | `ControlBus` reverse direction — `Status`, `Heartbeat` |
| Sync / timing | `ControlBus` `Tick`, coalesced with params |

---

## 5. Performance Analysis

### 5.1 Same-process split (recommended)
Buys: testability, protocol versioning, future swap. Does **not** buy faster rendering.

### 5.2 Separate process, same machine (Electron / worker)
- Web Worker: no `HTMLVideoElement`. Killer — patchNet's entire video stack is `<video>` → `drawImage`. WebCodecs + `VideoFrame` is a rewrite, not a swap.
- `OffscreenCanvas` in worker: viable for compositing only; you still ship frames across. Saves main-thread rAF time; does not help decode.
- Electron: second process per `BrowserWindow`. Same trade-off as popup + BroadcastChannel, plus packaging cost. Only worth it for native OS features.

Verdict: lots of work, no user-visible gain unless main thread is the bottleneck (it is not — decode + composite are GPU-side).

### 5.3 Separate machine with own GPU
Frees host GPU — useful for laptop editor + VJ-rig renderer. Cost: getting media there. Pre-sync or stream. Streaming video defeats the purpose — now you re-decode what you just encoded. Only sensible when remote renderer is fed by shared assets or is entirely shader-driven.

### 5.4 Frame streaming (WebRTC / NDI)
100–200ms latency, variable. Monitoring preview only. Not recommended without a concrete use case.

### 5.5 Browser-based with clean control logic (recommended)
Measurable wins: unit-testable reconciler, swap renderers without touching controllers, replay-able control stream.

**Does NOT solve:**
- Video decode perf (browser-internal).
- `rewireMedia()` cost — today iterates all edges per graph change. Needs an index (`toNodeId → edge[]`). No architecture change required.
- Layer composite cost — bounded by pixel count and layer count.

---

## 6. Message / Data Model

### 6.1 Envelope

```json
{ "v": 1, "contextName": "world1", "seq": 17324, "messages": [ /* ControlMessage[] */ ] }
```

### 6.2 ControlMessage types

```json
{ "t": "SceneAdd",    "id": "layer-abc", "kind": "layer", "priority": 0 }
{ "t": "SceneRemove", "id": "layer-abc" }
{ "t": "SceneWire",   "layerId": "layer-abc", "source": { "kind": "mediaVideo", "id": "mv-1" } }

{ "t": "ParamUpdate", "id": "vfx-crt-1", "params": { "scanlines": 0.35, "vignette": 0.45 } }

{ "t": "Command", "id": "mv-1",  "cmd": "play" }
{ "t": "Command", "id": "mv-1",  "cmd": "seek", "args": [12.34] }
{ "t": "Command", "id": "viz-1", "cmd": "openWindow", "args": [640, 480, 100, 100] }

{ "t": "Trigger", "id": "viz-1", "event": "bang" }
{ "t": "Tick",    "ts": 1712345678.123, "beat": 42.0 }
{ "t": "ScenePreset", "name": "sunset", "state": { } }
```

### 6.3 Upstream (renderer → controller)

```json
{ "t": "Status",    "id": "viz-1", "state": { "open": true, "w": 640, "h": 480, "x": 100, "y": 100 } }
{ "t": "Telemetry", "id": "viz-1", "fps": 60.0, "droppedFrames": 0 }
{ "t": "Error",     "id": "vfx-crt-1", "code": "SHADER_COMPILE", "msg": "…" }
{ "t": "Heartbeat", "ts": 1712345678.123 }
```

### 6.4 What NOT to send on this bus
Full video frames. Large blobs. Patch text / serialized graph. Media is referenced by `idb:<key>` — same as today.

---

## 7. Synchronization / State Model

- **Source of truth:** `PatchGraph` for structure + args. Transient render state lives in renderer, periodically mirrored to args via `Status`.
- **Optimistic UI:** controller predicts, renderer confirms via `Status`. On divergence (user resized popup), status wins and writes back. Same as today's `onResize` flow, formalized.
- **Reconnect / crash recovery:** controller maintains a snapshot per `contextName`, derived from PatchGraph. On `Hello { contextName, lastSeq }` → reply with snapshot + resume seq.
- **Deltas by default, snapshot on connect / scene load / preset recall.**
- **Preset recall:** via patch text round-trip → graph diff → director reconciles → messages. No parallel preset channel at renderer level.

---

## 8. Phased Implementation Roadmap

### Phase 1 — Control surface extraction *(no behavior change)*

- `src/control/ControlMessage.ts` — discriminated union, zero runtime.
- `src/control/ControlBus.ts` — `LocalBus` direct-dispatch impl.
- `src/control/RenderDirector.ts` — moves `deliverXxx` routing out of `VisualizerGraph`.
- `src/control/IRenderer.ts` — new SPI alongside `IRenderContext`. `VisualizerNode` and `PatchVizNode` implement as thin forwarders.
- `VisualizerGraph.sync()` reconciler unchanged; its *outputs* swap in Phase 2.

Risk: low (1:1 targets). Testing: unit-test director with mock bus — first tests in repo, resolves BLOCKER-1.

### Phase 2 — Renderer abstraction

- `RenderDirector.reconcile()` emits `SceneAdd`/`SceneRemove`/`SceneWire` instead of calling `runtime.register`, `vn.addLayer`, etc.
- `VisualizerNode` → `PopupRenderer` (controller-free). Replace `onOpen`/`onClose`/`onResize`/`onMove` closures with upstream `Status` messages.
- `PatchVizNode` → `CanvasRenderer`. Same changes.
- `VisualizerObject` / `PatchVizObject` controller classes own `contextName` + subscribe to `Status`.
- `VisualizerGraph` collapses to ~20-line factory, or is deleted.

Risk: the popup open-restore flow (150ms defer in `VisualizerGraph.ts:296-299`) + transport restoration (`applyMediaVideoTransportFromArgs`) are subtle. Behavior-identical migration required. Testing: headless renderer mock asserting message sequences.

### Phase 3 — Popup over BroadcastChannel

- Popup loads minimal `render.html` shell with its own bundle containing `PopupRenderer` only.
- `LocalBus` → `BroadcastChannelBus` for popup contexts only. Inline `CanvasRenderer` stays on `LocalBus`.
- Media transfer: on `SceneWire { kind: "mediaVideo" }` popup fetches from IDB via `VideoStore` (same-origin). No video bytes on the control bus.

Risk: loss of shared `HTMLVideoElement` doubles memory per playing video. Acceptable; forces honest protocol design. Testing: Playwright — open popup, send `ParamUpdate`, read `Telemetry`.

### Phase 4 — Canvas / patchViz unification

- Delete parallel `patchVizNodes` map + branch. Both renderers keyed by `contextName`.
- `mountPatchViz(panGroup)` moves into the renderer factory — controller never touches panGroup.
- Audit `runtime.getFirst()` fallback (`VisualizerGraph.ts:597`): replace with explicit "no renderer available" warning.

Risk: minor cleanup. Testing: existing smoke tests.

### Phase 5 — Optional remote renderer + fallback

- `WebSocketBus` impl. Same `ControlMessage` types.
- State machine: connecting → ready → degraded → offline. On offline, visualizer falls back to local popup with same `contextName`. One fallback path — no hybrid.
- `Heartbeat` every 2s; miss → degraded + backoff reconnect.
- Preset snapshot replay on reconnect.
- Remote media: `GET /media/:key` from controller. Out of v1 scope unless demand.

Risk: remote media handoff. Testing: Electron reference renderer on second machine.

---

## 9. Final Recommendations

| Decision | Recommendation |
|---|---|
| Architecture for v1 | Same-process, clean control plane. `PatchGraph` → `RenderDirector` → `ControlBus` → `IRenderer`. Direct dispatch. No networking. |
| Architecture for long-term growth | Identical shape, with `ControlBus` pluggable (Local / BroadcastChannel / WebSocket). Versioned JSON `ControlMessage` envelopes. |
| Visualizer object evolution | Split into `VisualizerObject` (controller, no DOM) + `PopupRenderer` (render, owns Window/canvas/rAF). Drop callback-closure API for a typed `Status` feed. |
| patchViz object evolution | View-only client. Becomes `CanvasRenderer` impl of `IRenderer`. Never hybrid, never remote. It is the local preview. |
| What stays local | All v1 rendering, inline patchViz forever, text panel, all media storage (IDB). |
| What can go remote | The popup (Phase 3 BroadcastChannel; Phase 5 WebSocket). Never patchViz. Never patch state. |
| Protocol stack (first) | In-process `ControlBus` + versioned JSON-shaped `ControlMessage` enum. Transport-ready so later `BroadcastChannelBus` / `WebSocketBus` is a swap. No OSC in v1. HTTP only for preset I/O. |
| Anti-goals | Frame streaming. OSC. Separate scene graph in patchViz. Hybrid renderers. Per-preset custom channels. |

**One-line summary:** the right v1 move is not to separate processes — it is to separate *concerns*. Once the control plane is versioned and pluggable, going remote is a transport swap the rest of the code does not need to know about.
