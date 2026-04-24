# `buffer~` Object Plan

**Status:** Planned (2026-04-23).

A patchNet all-in-one tape-recorder object. Records audio into an internal buffer, plays it back at variable rate (including negative for reverse), loops, and switches between mono and stereo. Transport and playback controls are accessible both as clickable buttons on the object body and as messages sent to the control inlet.

---

## Scope (locked)

| Decision | Value | Reason |
|----------|-------|--------|
| Object name | `buffer~` | Tilde suffix = audio-rate convention |
| Recording engine | AudioWorklet processor | Sample-accurate capture; matches `js~` precedent |
| Playback engine | Same AudioWorklet processor | Unified state machine; avoids two worklets per node |
| Max buffer length | 5 minutes (at 48 kHz = ~28 M samples per channel) | Capped to prevent runaway memory; exposed as `maxLen` arg |
| Signal topology | Variable: 1 or 2 signal inlets + 1 control inlet; 1 or 2 signal outlets + 1 position outlet | Derived from `mode` arg |
| Mode switch | `mono` ↔ `stereo` — changes port count | Stereo→mono sums channels; mono→stereo duplicates |
| Prior stereo data | Preserved when switched to mono | Switch back to stereo restores original channels |
| Rate | Float, any value including negative; `0` = frozen | Negative = reverse |
| Loop | Wraps position at buffer boundaries | Works in both forward and reverse directions |
| Persistence | `state` hidden arg stores base64-encoded PCM data | Survives patch save/load (up to max buffer) |
| Design rules | All colors via `--pn-*` tokens; Vulf Mono/Sans only | Non-negotiable per design language |

---

## Port Specification

Ports are **derived from `args[0]` (mode)**. `deriveBufferPorts(args)` in `objectDefs.ts` returns the correct inlet/outlet arrays.

### Stereo mode (default)

| # | Side | Type | Label |
|---|------|------|-------|
| 0 | inlet | `signal` | left channel in (record) |
| 1 | inlet | `signal` | right channel in (record) |
| 2 | inlet | `any` | control: record \| play \| pause \| stop \| rate f \| loop 0\|1 \| stereo \| mono |
| 0 | outlet | `signal` | left channel out (playback) |
| 1 | outlet | `signal` | right channel out (playback) |
| 2 | outlet | `float` | position (0.0–1.0) |

### Mono mode

| # | Side | Type | Label |
|---|------|------|-------|
| 0 | inlet | `signal` | mono in (record) |
| 1 | inlet | `any` | control: record \| play \| pause \| stop \| rate f \| loop 0\|1 \| stereo \| mono |
| 0 | outlet | `signal` | mono out (playback) |
| 1 | outlet | `float` | position (0.0–1.0) |

---

## `OBJECT_DEFS["buffer~"]`

```ts
"buffer~": {
  description: "Audio tape-recorder buffer. Records incoming signal, plays back at variable rate (negative = reverse), with loop and mono/stereo switching.",
  category: "audio",
  args: [
    { name: "mode",    type: "symbol", default: "stereo",
      description: "Channel mode: stereo or mono. Switching sums or duplicates audio." },
    { name: "rate",    type: "float",  default: "1", min: -8, max: 8, step: 0.01,
      description: "Playback rate. 1.0 = normal, -1.0 = reverse, 2.0 = double speed." },
    { name: "loop",    type: "int",    default: "0", min: 0, max: 1, step: 1,
      description: "Loop mode: 1 = loop, 0 = stop at end (or start when reversing)." },
    { name: "maxLen",  type: "float",  default: "10", min: 1, max: 300, step: 1,
      description: "Maximum recording length in seconds (1–300)." },
    { name: "transport", type: "symbol", default: "stop", hidden: true,
      description: "Persisted transport state: record | play | pause | stop." },
    { name: "position",  type: "float",  default: "0",  hidden: true,
      description: "Persisted playback/record position (0.0–1.0)." },
    { name: "bufferL",   type: "symbol", default: "", hidden: true,
      description: "Base64-encoded Float32 PCM — left (or mono) channel." },
    { name: "bufferR",   type: "symbol", default: "", hidden: true,
      description: "Base64-encoded Float32 PCM — right channel (empty in mono mode)." },
    { name: "bufferLStereo", type: "symbol", default: "", hidden: true,
      description: "Preserved stereo-L when in mono mode; allows lossless mono→stereo restore." },
    { name: "bufferRStereo", type: "symbol", default: "", hidden: true,
      description: "Preserved stereo-R when in mono mode; allows lossless mono→stereo restore." },
  ],
  messages: [
    { inlet: 2, selector: "record", description: "begin recording (overwrites from position 0)" },
    { inlet: 2, selector: "play",   description: "begin playback from current position" },
    { inlet: 2, selector: "pause",  description: "pause transport (preserves position)" },
    { inlet: 2, selector: "stop",   description: "stop and rewind position to 0" },
    { inlet: 2, selector: "rate",   description: "set playback rate: rate <float> (negative = reverse)" },
    { inlet: 2, selector: "loop",   description: "set loop mode: loop 0|1" },
    { inlet: 2, selector: "stereo", description: "switch to stereo mode (changes port count)" },
    { inlet: 2, selector: "mono",   description: "switch to mono mode — sums channels; preserves originals" },
    { inlet: 2, selector: "clear",  description: "erase the buffer contents" },
    { inlet: 2, selector: "seek",   description: "jump to normalized position: seek <0.0–1.0>" },
    { inlet: 2, selector: "float",  description: "shorthand for rate: incoming float sets rate directly" },
  ],
  inlets:  [], // derived by deriveBufferPorts(args)
  outlets: [], // derived by deriveBufferPorts(args)
  defaultWidth:  200,
  defaultHeight: 100,
}
```

**Note (mono inlet index):** In mono mode the control inlet is index 1; in stereo it is index 2. `ObjectInteractionController` checks `node.args[0]` to determine which inlet index is the control inlet before routing messages.

---

## Message API (all messages → control inlet)

| Message | Action |
|---------|--------|
| `record` | Arm recording. Transport state → `record`. Worklet begins capturing incoming signal into buffer starting at sample 0. Position output starts counting up. |
| `play` | Begin playback from current `position`. Transport → `play`. |
| `pause` | Freeze position. Transport → `pause`. No audio output. |
| `stop` | Reset position to 0. Transport → `stop`. No audio output. |
| `rate <f>` | Set playback rate. Any float. `0` = frozen. Negative = reverse. Takes effect immediately during playback. |
| `<float>` | Alias for `rate <float>`. Lets a slider wire directly to the control inlet. |
| `loop 0\|1` | Enable/disable loop. |
| `seek <f>` | Jump playback/record head to normalized position (0–1). |
| `stereo` | Switch to stereo mode. If audio was recorded mono, duplicate mono→both channels. Port count changes; patch graph re-derives ports. |
| `mono` | Switch to mono mode. Sum L+R → mono. Store originals in `bufferLStereo` / `bufferRStereo` for lossless restore. Port count changes. |
| `clear` | Zero the buffer. Reset position. Transport stays at stop. |

---

## Stereo ↔ Mono Conversion Rules

### Stereo → Mono
1. If buffer was never recorded in stereo (`bufferR` is empty): mono stays as-is; no action needed.
2. If stereo audio exists:
   - Save current `bufferL` → `bufferLStereo`, `bufferR` → `bufferRStereo`.
   - Compute mono = `(L[i] + R[i]) * 0.5` for each sample.
   - Store summed result in `bufferL`; clear `bufferR`.
3. Update `args[0]` to `"mono"`, rebuild ports, emit `"change"`.

### Mono → Stereo
1. If `bufferLStereo` / `bufferRStereo` are non-empty (prior stereo recording preserved):
   - Restore `bufferL` ← `bufferLStereo`, `bufferR` ← `bufferRStereo`.
   - Clear `bufferLStereo` / `bufferRStereo`.
2. If no prior stereo data (audio was always recorded in mono):
   - Duplicate: `bufferR` ← `bufferL` (pseudo-stereo).
3. Update `args[0]` to `"stereo"`, rebuild ports, emit `"change"`.

---

## Object Body UI

The object body shows an inline transport strip and waveform thumbnail. Elements are interactive (like sequencer cells / dmx panel).

```
┌──────────────────────────────────────────────────┐
│ buffer~   [◉ REC] [▶ PLAY] [⏸ PAUSE] [■ STOP]  │
│ ══════════════════════════════════════          │
│  [waveform thumbnail / position bar]            │
│  rate: 1.00   loop: off   STEREO ⇆ MONO         │
└──────────────────────────────────────────────────┘
```

### Body elements:

- **Record button** (`◉ REC`): sends `record` message to self, highlights when active (red tint).
- **Play button** (`▶`): sends `play`.
- **Pause button** (`⏸`): sends `pause`. Disabled if transport is stopped.
- **Stop button** (`■`): sends `stop`.
- **Waveform strip**: a `<canvas>` element drawn from the current buffer PCM. Redrawn after recording ends and on buffer load. Position cursor overlaid as a vertical line.
- **Rate readout**: shows current rate value (e.g. `×1.00`, `×-2.00`).
- **Loop indicator**: `loop: on` / `loop: off`.
- **Stereo/mono toggle**: a clickable label that fires `stereo` or `mono` message.

All button clicks in the body call `ObjectInteractionController.deliverBufferMessage(nodeId, selector)`. `DragController` must allowlist the buffer body buttons/canvas so they don't start object drags.

---

## Architecture

### New files

```
src/runtime/BufferNode.ts          — per-object runtime: owns worklet, buffer data, state machine
src/runtime/buffer/buffer-worklet.ts — AudioWorkletProcessor: record + playback DSP
```

### Modified files

```
src/graph/objectDefs.ts            — add buffer~ spec + deriveBufferPorts + ensureBufferArgs
src/runtime/AudioGraph.ts          — add bufferNodes map; sync() + rewireConnections() branches
src/canvas/ObjectRenderer.ts       — buffer~ body branch (transport buttons + waveform canvas)
src/canvas/ObjectInteractionController.ts — deliverBufferMessage + button wiring
src/canvas/DragController.ts       — add .pn-buf-btn and .pn-buf-wave to drag exclusion list
src/graph/PatchGraph.ts            — addNode buffer~ branch: derive ports
src/serializer/parse.ts            — parse buffer~ branch: derive ports + load PCM args
src/shell.css                      — buffer~ body styles
```

---

## `BufferNode` (`src/runtime/BufferNode.ts`)

```ts
class BufferNode {
  readonly input:  ChannelMergerNode   // signal in (2-channel for stereo)
  readonly output: GainNode            // signal out
  private worklet: AudioWorkletNode
  private state: "stop" | "record" | "play" | "pause" = "stop"
  private _rate    = 1.0
  private _loop    = false
  private _mode: "stereo" | "mono" = "stereo"
  private _bufDataL: Float32Array = new Float32Array(0)
  private _bufDataR: Float32Array = new Float32Array(0)
  private _bufDataLStereo: Float32Array = new Float32Array(0)
  private _bufDataRStereo: Float32Array = new Float32Array(0)
  private _position = 0  // in samples

  // Public API
  record(): void
  play(): void
  pause(): void
  stop(): void
  setRate(r: number): void
  setLoop(v: boolean): void
  seek(norm: number): void
  setMode(m: "stereo" | "mono"): void
  clear(): void

  // Called by AudioGraph after rewireConnections
  connectInlet(src: AudioNode, outChannel: number, inChannel: number): void
  connectOutlet(dest: AudioNode, outChannel: number, destInput: number): void
  disconnect(): void
  destroy(): void

  // Called by AudioGraph main loop tick for position outlet
  get position(): number  // 0.0–1.0 normalized, NaN if buffer empty

  // For ObjectRenderer waveform draw
  getWaveformData(): { L: Float32Array, R: Float32Array }

  // Persistence helpers
  serializeBuffers(): { L: string, R: string, LStereo: string, RStereo: string }
  loadBuffers(L: string, R: string, LStereo: string, RStereo: string): void
}
```

The `BufferNode` communicates with the worklet via `postMessage`. Messages to the worklet:
- `{ type: "setMode", mode: "stereo"|"mono" }`
- `{ type: "setBuffer", L: Float32Array, R: Float32Array, sampleRate: number }`
- `{ type: "record", maxSamples: number }`
- `{ type: "play", position: number }`
- `{ type: "pause" }`
- `{ type: "stop" }`
- `{ type: "rate", value: number }`
- `{ type: "loop", value: boolean }`
- `{ type: "seek", position: number }` (samples, integer)
- `{ type: "clear" }`

Messages from the worklet:
- `{ type: "position", value: number }` — sample index, posted ~60 Hz
- `{ type: "recordDone", L: Float32Array, R: Float32Array }` — when buffer full or record stopped
- `{ type: "playDone" }` — when non-looping playback reaches the end

---

## `buffer-worklet.ts` — AudioWorkletProcessor

```ts
class BufferProcessor extends AudioWorkletProcessor {
  private state: "stop" | "record" | "play" | "pause" = "stop"
  private bufL: Float32Array
  private bufR: Float32Array
  private position: number = 0     // fractional sample index
  private rate: number = 1.0
  private loop: boolean = false
  private mode: "stereo" | "mono" = "stereo"
  private maxSamples: number = 0
  private ticksSincePostition: number = 0

  process(inputs, outputs, _params): boolean {
    // inputs[0] = L, inputs[1] = R (stereo) or inputs[0] = mono
    // outputs[0] = L out, outputs[1] = R out
    // ...
  }
}
```

### Recording DSP

Each `process()` frame, if `state === "record"`:
- Copy `inputs[0][0]` (128 samples) into `bufL` at `position`
- Copy `inputs[1][0]` (or `inputs[0][0]` for mono-R) into `bufR`
- Advance `position` by 128
- If `position >= maxSamples`: post `recordDone`, switch to `stop`

### Playback DSP

Each `process()` frame, if `state === "play"`:
- For each output sample `i`:
  - Compute integer and fractional parts of `position`
  - Linear interpolate between `bufL[floor]` and `bufL[ceil]` (and same for R)
  - Write to `outputs[0][0][i]`, `outputs[1][0][i]`
  - Advance `position` by `rate`
  - If `position < 0` (reverse past start): loop → `position = bufLen - 1`, or stop
  - If `position >= bufLen` (forward past end): loop → `position = 0`, or post `playDone` + stop
- Every 512 samples, post `{ type: "position", value: position }`

---

## `AudioGraph` integration

Add to `AudioGraph`:

```ts
private bufferNodes = new Map<string, BufferNode>()
private bufferWorkletReady: Promise<void> | null = null
```

In `sync()`:
```ts
if (node.type === "buffer~" && !this.bufferNodes.has(node.id)) {
  const nodeId = node.id
  this.ensureBufferWorklet().then(() => {
    const bn = new BufferNode(this.runtime, node.args)
    this.bufferNodes.set(nodeId, bn)
    this.rewireConnections()
  })
}
```

In `rewireConnections()`:
- Source `click~`, `adc~`, `js~` that connect to a `buffer~` inlet: call `bn.connectInlet(src, outChannel, inChannel)`
- Destination `dac~`, `fft~`, `js~` that receive from `buffer~` outlet: call `bn.connectOutlet(dest, outChannel, destInput)`

The `AudioGraph` exposes a `getBufferNode(id)` method so `ObjectInteractionController` can call transport methods.

---

## `ObjectInteractionController` additions

New private method `deliverBufferMessage(nodeId: string, selector: string, args: string[])`:

```
"record"  → bufferNode.record()
"play"    → bufferNode.play()
"pause"   → bufferNode.pause()
"stop"    → bufferNode.stop()
"rate"    → bufferNode.setRate(parseFloat(args[0]))
"float"   → bufferNode.setRate(parseFloat(args[0]))   // direct float shorthand
"loop"    → bufferNode.setLoop(args[0] !== "0")
"seek"    → bufferNode.seek(parseFloat(args[0]))
"stereo"  → setBufferMode(nodeId, "stereo")
"mono"    → setBufferMode(nodeId, "mono")
"clear"   → bufferNode.clear()
```

`setBufferMode(nodeId, mode)`:
1. Calls `bufferNode.setMode(mode)`.
2. Updates `node.args[0]` to new mode string.
3. Derives new ports via `deriveBufferPorts(node.args)`.
4. Assigns to `node.inlets` / `node.outlets`.
5. Drops any edges that reference now-removed ports.
6. Emits `"change"` so ObjectRenderer and the text panel update.

**Body button wiring (in `ObjectRenderer`):** Each transport button and the stereo/mono toggle are `<button>` elements with `data-buf-action` attributes. `ObjectInteractionController` attaches a single delegated `click` listener on the `patchGroup` that picks up `data-buf-action` clicks and calls `deliverBufferMessage`. This is the same pattern as the sequencer lock button.

**Position outlet:** In the main `requestAnimationFrame` loop (same place `fft~` band values are pushed), call `audioGraph.getBufferPositions()` → for each buffer node, if playing/recording, emit the position float through outlet (last outlet index).

---

## Port Derivation in `objectDefs.ts`

```ts
export function deriveBufferPorts(args: string[]): { inlets: PortDef[]; outlets: PortDef[] } {
  const mode = (args[0] ?? "stereo") === "mono" ? "mono" : "stereo"
  if (mode === "stereo") {
    return {
      inlets: [
        { index: 0, type: "signal", label: "left channel in (record)" },
        { index: 1, type: "signal", label: "right channel in (record)" },
        { index: 2, type: "any",    label: "record | play | pause | stop | rate f | loop 0|1 | stereo | mono", temperature: "hot" },
      ],
      outlets: [
        { index: 0, type: "signal", label: "left channel out (playback)" },
        { index: 1, type: "signal", label: "right channel out (playback)" },
        { index: 2, type: "float",  label: "position (0.0–1.0)" },
      ],
    }
  } else {
    return {
      inlets: [
        { index: 0, type: "any",    label: "mono in (record)" },
        { index: 1, type: "any",    label: "record | play | pause | stop | rate f | loop 0|1 | stereo | mono", temperature: "hot" },
      ],
      outlets: [
        { index: 0, type: "signal", label: "mono out (playback)" },
        { index: 1, type: "float",  label: "position (0.0–1.0)" },
      ],
    }
  }
}

export function ensureBufferArgs(args: string[]): string[] {
  if (args[0] === undefined) args[0] = "stereo"
  if (args[1] === undefined) args[1] = "1"
  if (args[2] === undefined) args[2] = "0"
  if (args[3] === undefined) args[3] = "10"
  if (args[4] === undefined) args[4] = "stop"
  if (args[5] === undefined) args[5] = "0"
  if (args[6] === undefined) args[6] = ""
  if (args[7] === undefined) args[7] = ""
  if (args[8] === undefined) args[8] = ""
  if (args[9] === undefined) args[9] = ""
  return args
}
```

`PatchGraph.addNode` and `parse.ts` call `deriveBufferPorts` when the node type is `"buffer~"` and assign the result to `node.inlets` / `node.outlets`. Same pattern as `sequencer` and `fft~`.

---

## ObjectRenderer body branch

```
buffer~
 ├── title row: "buffer~"
 ├── transport row: [◉ REC] [▶] [⏸] [■]   (buttons with data-buf-action attributes)
 ├── waveform canvas (200 × 40 px, redrawn post-record)
 ├── info row: "×1.00  loop:off  STEREO" (or MONO)
 └── mode-toggle: clicking STEREO/MONO dispatches stereo/mono message
```

Active state styling:
- Record active: `◉ REC` button gets `.pn-buf-active-rec` (red tint via `--pn-accent-rec`)
- Play active: `▶` gets `.pn-buf-active-play` (green tint via `--pn-accent-play`)
- Paused: `⏸` gets `.pn-buf-active-pause` (amber)
- Stopped: `■` gets `.pn-buf-active-stop` (no tint — stop is the resting state)

---

## Persistence

On every transport-state or buffer-content change, `deliverBufferMessage` persists back to the node's args:
- `node.args[4]` ← current transport state string
- `node.args[5]` ← current position (normalized, as string)
- `node.args[6]`, `node.args[7]` ← `bufferNode.serializeBuffers().L / .R` (base64 Float32)
- `node.args[8]`, `node.args[9]` ← `.LStereo / .RStereo`
- Emit `"display"` (not `"change"`) — same pattern as sequencer playhead ticks — so position updates don't trigger a full re-render.

On load (`AudioGraph.sync`), after `BufferNode` construction, call `bn.loadBuffers(args[6], args[7], args[8], args[9])` and restore transport state from `args[4]` / `args[5]`.

**Size warning:** 10 seconds of stereo 48 kHz Float32 = 3.84 MB of raw PCM. Base64 encodes to ~5.1 MB. This is stored in the patch node's args and embedded in the `.patchnet` save file. Users should be warned that long recordings make large files. The `maxLen` arg caps this. For v1 this is acceptable; a future version could store to IndexedDB (same approach as `mediaVideo`).

---

## Phase Plan

### Phase 1 — Core record + stereo playback + transport buttons

**Deliverables:**
- `buffer-worklet.ts`: `record` + `play` + `pause` + `stop` + `seek`. Stereo only in Phase 1.
- `BufferNode.ts`: owns worklet, exposes transport methods, position getter.
- `OBJECT_DEFS["buffer~"]`: full spec. `deriveBufferPorts` + `ensureBufferArgs` exported.
- `AudioGraph`: bufferNodes map, `ensureBufferWorklet`, sync + rewire branches.
- `ObjectRenderer`: transport buttons + mode label (no waveform canvas yet).
- `ObjectInteractionController`: `deliverBufferMessage` + body button wiring.
- `DragController`: allowlist `.pn-buf-btn`.
- `PatchGraph` + `parse.ts`: port derivation on create/load.
- `shell.css`: transport button styles (recording state = red, play = green).

**Exit bar:** `adc~ → buffer~ → dac~`. Record 5 seconds of mic, stop, press play, hear the recording back. Stop rewinds. Pause/play preserves position.

### Phase 2 — Rate control + reverse + loop

**Deliverables:**
- Worklet: variable rate (fractional sample pointer, linear interpolation), negative rate (reverse), loop wrapping.
- `BufferNode.setRate()` + `setLoop()` wired through.
- `deliverBufferMessage` handles `rate`, `float` (shorthand), `loop` selectors.
- Position outlet updated from worklet `position` messages.
- Rate and loop shown in info row on object body.
- `seek` message implemented.

**Exit bar:** `slider → rate inlet (×−2 to ×2 mapped)`. Drag slider past 0 → hear reverse. `toggle → loop inlet`. Loop wraps cleanly at both ends in both directions.

### Phase 3 — Mono/stereo switching + waveform thumbnail + persistence

**Deliverables:**
- Worklet: mono mode (1 input/output channel, mono buffer).
- `BufferNode.setMode()`: stereo→mono sum (preserve originals), mono→stereo restore/duplicate.
- `deliverBufferMessage` handles `stereo` / `mono`, rebuilds ports, emits `"change"`.
- `ObjectRenderer`: waveform `<canvas>` drawn from `getWaveformData()` after record ends. Position cursor as overlaid vertical line, updated via `"display"` event.
- `DragController`: allowlist `.pn-buf-wave`.
- Persistence: serialize/deserialize all four buffer args on record-end and mode-change.
- `AudioGraph.sync`: load buffers from args on node creation.

**Exit bar:**
- Record stereo. Switch to mono → hear summed mono on one outlet. Switch back to stereo → original stereo restored (no re-recording needed).
- Record mono (mono mode) → switch to stereo → hear duplicated pseudo-stereo.
- Save patch. Reload. Buffer preserved. Transport still plays.
- Waveform thumbnail shows recorded content. Cursor moves during playback.

---

## CSS tokens needed

Add to `shell.css`:
```css
--pn-accent-rec:   /* recording red   — e.g. var(--pn-red, #c0392b) */
--pn-accent-play:  /* playback green  — e.g. var(--pn-green, #27ae60) */
--pn-accent-pause: /* pause amber     — e.g. var(--pn-amber, #e67e22) */
```

All existing `--pn-*` color token names should be checked in `shell.css` before choosing specific values — reuse what exists.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Worklet code-update latency for large buffers | Buffer transfer is done once (record→stop), not per-frame. Use `Transferable` (transfer ownership of `SharedArrayBuffer` or `ArrayBuffer`) to avoid copying. |
| Reverse playback aliasing | Linear interpolation is sufficient for v1 ear test; cubic can be added later. |
| Large args crashing the serializer | Cap `maxLen` at 300 s; warn in the info row when file will exceed 50 MB. Future: move buffer storage to IndexedDB à la `mediaVideo`. |
| Port count change mid-patch | Mode switch must drop orphan edges via the same `syncSequencerPorts` pattern. Emit `"change"` so PatchGraph updates edge validity. |
| Stereo→mono data loss concern | Originals are always preserved in `bufferLStereo`/`bufferRStereo` until a new stereo recording overwrites them. |

---

*Plan complete. Assign Phase 1 to Claude Code (recent pattern: dmx / shaderToy / sequencer / js~). Phase 3 can overlap with js~ Phase B work.*
