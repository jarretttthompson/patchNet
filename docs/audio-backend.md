# patchNet Audio Backend

**The contract every audio implementation satisfies.** Source of truth is the
code; this document mirrors it with `file:line` citations. If this doc and
the code disagree, the code wins — fix the doc.

- **Milestone:** M3 (Audio Backend Abstraction).
- **Interface:** `src/platform/audio.ts` — `AudioBackend`, `AudioCapabilities`.
- **Implementations:** `BrowserAudioBackend` (`src/runtime/BrowserAudioBackend.ts`,
  M3/b) wraps the existing Web Audio code; `NativeAudioBackend`
  (`src/runtime/NativeAudioBackend.ts`, M3/c) is a stub today (M3/f will land
  the real CPAL implementation).
- **Selection:** `getAudioBackend()` (`src/platform/registry.ts`, M3/d) returns
  the singleton for the current platform.
- **Companion:** `docs/object-api.md` defines the object contract; this doc
  defines what audio-flavored objects talk to at runtime.

---

## 1. Overview

An audio backend is the *only* thing outside `src/runtime/` and `src-tauri/`
that has the right to start the audio engine, route audio through the graph,
or report engine state. Controllers, panels, and main.ts wire-up call into
the backend; they do not touch `AudioContext` / `AudioWorkletNode` / CPAL
directly.

Two implementations exist:

| Backend | Where | When | Latency target |
|---|---|---|---|
| `BrowserAudioBackend` | `src/runtime/BrowserAudioBackend.ts` | `isBrowser` (default) | ~10–20 ms (Web Audio) |
| `NativeAudioBackend`  | `src/runtime/NativeAudioBackend.ts` | `isNative` (Tauri shell) | <3 ms (CPAL, M3/f) |

Today the native backend is a skeleton — `start()`/`sync()`/`destroy()` are
non-throwing no-ops; `isStarted` stays `false`; `latencyMs`/`sampleRate`
return `0`. This is intentional: the registry must be able to return *some*
backend on native immediately so the rest of the app boots. Real CPAL audio
lands in M3/f.

---

## 2. The `AudioBackend` interface

Verbatim from `src/platform/audio.ts:19-58`:

```ts
export interface AudioBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isStarted: boolean;
  readonly sampleRate: number;
  readonly latencyMs: number;
  sync(graph: PatchGraph): void;
  destroy(): void;
}
```

| Member | Contract |
|---|---|
| `start()` | Must be called from a user gesture (Web Audio policy; same rule for native for consistency). Resolves when audio is processing. Idempotent — second call after `isStarted: true` is a no-op. |
| `stop()` | Releases hardware. After this, `isStarted: false`. Can be followed by `start()` to resume. |
| `isStarted` | `true` between a successful `start()` and the next `stop()` / `destroy()`. |
| `sampleRate` | Hz. Valid only when `isStarted`. Reading before start returns `0` (not throws — UI can render a "—" without try/catch). |
| `latencyMs` | Round-trip latency estimate for display in the Audio Status panel. Browser: `baseLatency + outputLatency` if available, else fixed estimate. Native: queried from CPAL stream once started. `0` before start. |
| `sync(graph)` | Reconcile the audio graph with the current patch state. Called automatically on every `PatchGraph` `"change"` event. **Must be idempotent** — safe to call multiple times per frame. |
| `destroy()` | Tear down everything: audio nodes, hardware, event subscriptions. After this the backend should be discarded; create a new one to resume audio. |

The interface is **deliberately minimal**. New methods get added here only
when a caller outside `src/runtime/` genuinely needs one — see §6 for what
to do when a caller needs richer access.

---

## 3. `AudioCapabilities`

Reported by `getAudioCapabilities(isNative)`
(`src/platform/audio.ts:81-90`). Used at object-registration time to filter
out objects that don't work on the current platform.

```ts
export interface AudioCapabilities {
  lowLatencyIO:      boolean;  // sub-5ms hardware I/O
  midiIO:            boolean;  // MIDI device access
  multiChannelProIO: boolean;  // >2-channel pro audio interfaces
  nativeSidecar:     boolean;  // ability to spawn a sidecar (mDNS, etc.)
}
```

**Current matrix:**

| Capability | Browser | Native |
|---|---|---|
| `lowLatencyIO` | ❌ | ✅ |
| `midiIO` | ❌ (Web MIDI excluded by design) | ✅ (M3/f) |
| `multiChannelProIO` | ❌ | ✅ (M3/f) |
| `nativeSidecar` | ❌ | ✅ |

All native capabilities are gated on M3/f shipping. They're declared today
so palette / autocomplete / terminal already filter correctly; the native
backend just no-ops the corresponding `sync` work.

---

## 4. Lifecycle

```
                    user gesture
                         │
                         ▼
        ┌──── start() ───────────────┐
        │                            │
   isStarted: false            isStarted: true
        ▲                            │
        │                  graph.on("change")
   destroy() ◄── stop() ◄──     │
                                ▼
                             sync(graph)
```

- **`start()` must be user-gesture-initiated.** Web Audio policy; chained
  for native so behavior is identical. Calling from anywhere else is a bug
  (silent suspended context, no audio).
- **`sync()` is event-driven, not polled.** Subscribers attach via
  `graph.on("change", () => backend.sync(graph))` exactly once during
  startup. `sync()` is responsible for reconciling create/update/delete on
  every node type the backend cares about.
- **`destroy()` is terminal.** Used by tab-close, scratch-tab teardown, and
  full app shutdown. A new backend instance must be created to resume.

---

## 5. Platform selection

`src/platform/registry.ts` (M3/d) exposes:

```ts
export function getAudioBackend(): AudioBackend;
```

A singleton, lazily-constructed on first call. Returns:

- `BrowserAudioBackend` when `isBrowser` (`src/platform/index.ts:40`).
- `NativeAudioBackend` when `isNative` (`src/platform/index.ts:37`).

Platform detection is build-time-injected (`__PLATFORM__` via Vite
`define`) with a runtime override (presence of `window.__TAURI__`). See
`src/platform/index.ts:18-33`.

The registry is the **only** call site outside `runtime/` that names a
specific backend class. Everywhere else uses the `AudioBackend` interface.

---

## 6. Escape-hatch policy

`AudioGraph` (`src/runtime/AudioGraph.ts`) has a wide public surface
(~40 methods: `getMeterLevels`, `getFftBandLevels`, `getJsEffectNode`,
`triggerAdsr`, etc.). Some controllers genuinely need that detail — the
mixer panel reads channel meters; the FFT analyzer panel reads bands;
the JS-effect panel reaches into per-node worklet state.

Promoting all of those to `AudioBackend` would inflate the interface to
the point where the native backend would need a parallel stub for every
browser-only quirk. That's worse than the alternative.

**Policy:**

- `AudioBackend` covers the universal lifecycle and the most common ask
  (`sync`, `sampleRate`, `latencyMs`).
- Browser-only consumers cast the backend to `BrowserAudioBackend` and
  read `backend.audioGraph` (a public accessor — `src/runtime/BrowserAudioBackend.ts`).
  This is an explicit "I know this is Web-Audio-specific" gesture.
- Native-only consumers cast to `NativeAudioBackend` and reach into its
  internals symmetrically.
- The escape hatch is the *seam* between universal and platform-specific
  code. Code that uses it is signing up to handle the case where the
  active backend is the other kind (typically by feature-gating via
  `getAudioCapabilities()`).

A future cleanup milestone may refactor controllers to subscribe to
backend-agnostic events instead of reaching into `AudioGraph`. That's not
M3 — M3 establishes the seam without disrupting working code.

---

## 7. Implementations

### 7.1 `BrowserAudioBackend` (`src/runtime/BrowserAudioBackend.ts`, M3/b)

Wraps the existing `AudioRuntime` (`src/runtime/AudioRuntime.ts`) and
`AudioGraph` (`src/runtime/AudioGraph.ts`) without changing either's
behavior:

- `start()` calls `AudioRuntime.start()` then constructs `AudioGraph` on
  the running runtime (today done in `main.ts:705`).
- `stop()` calls `audioGraph.destroy()` then `runtime.stop()`.
- `sync(graph)` delegates to `audioGraph.sync()` (no-arg — graph is captured
  at construction).
- `latencyMs` = `(ctx.baseLatency + ctx.outputLatency) * 1000`, falling back
  to a fixed estimate when neither is reported.
- `audioGraph` accessor exposes the underlying `AudioGraph` for the escape
  hatch (§6).

Behavior is unchanged from the pre-M3 code path; this is a wrapping
refactor, not a rewrite.

### 7.2 `NativeAudioBackend` (`src/runtime/NativeAudioBackend.ts`, M3/c)

Stub implementation that lets the rest of the app boot cleanly on native
without real audio. Method-by-method:

| Member | Today (M3/c) | Future (M3/f) |
|---|---|---|
| `start()` | logs "native audio not yet wired"; resolves; flips `_started: true` | `invoke("audio_start", { sampleRate, bufferSize })` |
| `stop()` | flips `_started: false`; resolves | `invoke("audio_stop")` |
| `isStarted` | tracks the flag above | same |
| `sampleRate` | `0` before start; `48000` after (placeholder) | reported by CPAL stream |
| `latencyMs` | `0` | reported by CPAL after start |
| `sync(graph)` | no-op | `invoke("audio_sync_graph", { nodes, edges })` plus per-object channel ops |
| `destroy()` | no-op | release CPAL stream, drop IPC handle |

The stub never throws — calling it on native is harmless. Users see no
audio (correct for today) and the Audio Status panel reports zero everything.
When M3/f lands, only this file changes (plus Rust); consumers don't notice.

---

## 8. Native roadmap (M3/f, deferred)

Sketched here so the eventual implementation doesn't reinvent the contract:

- **Rust dependencies:** `cpal` (cross-platform audio I/O), `cpal-jack`
  (Linux pro audio), `crossbeam-channel` (worker thread comms).
- **Tauri commands** (declared in `src-tauri/src/audio/mod.rs`):
  - `audio_start(sample_rate, buffer_size) -> Result<StreamInfo>`
  - `audio_stop() -> Result<()>`
  - `audio_sync_graph(serialized_graph) -> Result<()>`
  - `audio_meter_levels() -> Vec<f32>` (called from rAF)
- **Per-object sync:** the serialized graph is a compact subset of the
  patch — only audio-relevant nodes + their connections + their args.
  The Rust side maintains its own node map and recomputes routing on
  each sync.
- **Latency target:** sub-3 ms RTL on macOS CoreAudio with a 64-sample
  buffer at 48 kHz. Linux ALSA / Windows WASAPI follow.
- **Out of scope for M3/f:** sidecar processes for mDNS / OSC bridging
  (those are M5+ plugin territory).

---

## 9. Compatibility surface

What's permanent:

- The `AudioBackend` interface shape (start/stop/sync/destroy + readonly
  getters). Adding a new method is a breaking change for downstream
  backends; do not add lightly.
- `AudioCapabilities` keys (renaming a flag breaks the palette filter).
- The platform-selection rule: `isNative` ⇒ native backend, `isBrowser` ⇒
  browser backend.

What can change without coordination:

- Internal `AudioGraph` API (it's behind the escape hatch — consumers
  already know they're coupling to it).
- Latency estimation formula (read-only display value).
- The Native backend's IPC command names, until M3/f ships and they
  become a Rust↔TS contract.

The interface is intentionally **boring**. The audio engine evolves
through implementations, not through the contract.
