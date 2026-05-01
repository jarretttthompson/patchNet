---
title: youtube~ Object Plan
type: project
tags: [object-plan, media, audio, video, youtube, browser]
updated: 2026-04-25
---

# `youtube~` — Embedded YouTube Player Object

## Goal

A patch object that takes a YouTube URL, plays the video inside its body, and exposes the same L/R audio + video outlets as `browser~` so the stream is patchable into `dac~`, `fft~`, `vFX.*`, `layer`, `visualizer`, etc.

```
[youtube~ https://youtu.be/dQw4w9WgXcQ]
 │      │      │
 L~     R~     video~
```

- Outlet 0 — audio L (AudioNode)
- Outlet 1 — audio R (AudioNode)
- Outlet 2 — video (`MediaVideoSource`-shaped — patchable into existing video objects with no consumer-side changes)

---

## Feasibility Summary (The Honest Part)

A YouTube embed is a **cross-origin iframe**. The same wall that blocks `browser~` from tapping iframe pixels blocks us here:

- No `captureStream()` on `HTMLIFrameElement`.
- No `MediaElementAudioSourceNode` over a cross-origin `<video>` (CORS taint).
- No `WebAudio` or canvas access to anything `youtube.com` renders.
- YouTube serves `X-Frame-Options`/CSP that *allow* `youtube.com/embed/<id>` but block scraping the inner video element.

**There is exactly one browser-sanctioned path to extract YouTube's audio + pixels from a pure web app: `navigator.mediaDevices.getDisplayMedia()`** — the same path `browser~` uses. The user picks the tab; the browser hands us a `MediaStream`.

So at the outlet layer **`youtube~` is `browser~`**. The object is worth building because it adds YouTube-specific affordances on the *control* and *UX* sides, where cross-origin access is permitted:

| Affordance | Mechanism | Needs capture? |
|---|---|---|
| Display the video inside the panel | `<iframe src="youtube.com/embed/<id>">` | No |
| Play / pause / seek / rate | YouTube **IFrame Player API** via `postMessage` | No |
| Title / thumbnail / duration | YouTube **oEmbed** endpoint (keyless, CORS-OK) | No |
| L/R audio + video to outlets | `getDisplayMedia()` tab capture | **Yes** |

In other words: previewing and controlling are free; tapping the stream still needs one user-approved capture per session, exactly like `browser~`.

### Why not bypass `getDisplayMedia`?
- **Same-tab self-capture (`preferCurrentTab`)** — captures patchNet's own tab. Works mechanically but creates feedback loops: `dac~` output gets re-fed into the graph, and `suppressLocalAudioPlayback` would mute the user's monitoring. Rejected.
- **`yt-dlp` proxy → CORS-anonymous `<video>`** — extracts the real MP4/HLS URL server-side; client uses `MediaElementAudioSourceNode` directly. Technically the cleanest signal path, but requires a backend (patchNet is browser-only) and almost certainly violates YouTube ToS. Listed as a deferred Phase C escape hatch only.
- **Invidious / Piped public instances** — same idea, public infrastructure, fragile and rate-limited. Not worth depending on.

---

## Architecture

### Runtime: `src/runtime/YouTubeNode.ts`

Reuses `BrowserNode`'s capture path verbatim. The only delta is the panel-side IFrame Player API integration, which lives in canvas, not runtime.

Two clean options:
1. **Compose** — `YouTubeNode` holds a `BrowserNode` internally and forwards `connectChannel` / `disconnect` / `video` / `isReady` / `hasError`.
2. **Extend** — `YouTubeNode extends BrowserNode`, adds nothing on the audio/video side.

Recommend **option 1 (composition)**. Keeps `BrowserNode` focused; lets `YouTubeNode` carry YouTube-specific state (`videoId`, `playerState`, `currentTime`) without polluting the generic browser path.

### Canvas: `src/canvas/YouTubePanel.ts` (+ controller)

Follows `BrowserPanel` / `JsEffectPanel` pattern.

- **URL bar** — accepts any YouTube URL form. Parser extracts the 11-char video ID and an optional `t=` start time. Invalid → friendly error pill.
  - `https://www.youtube.com/watch?v=ID`
  - `https://youtu.be/ID`
  - `https://www.youtube.com/embed/ID`
  - `https://m.youtube.com/watch?v=ID`
  - `https://www.youtube.com/shorts/ID`
  - `?t=90s`, `?start=90`, `&t=1m30s` → `startSeconds`
- **IFrame preview** — `<iframe src="https://www.youtube.com/embed/<id>?enablejsapi=1&origin=<patchnet>">`. Sized to the object's body. This shows the video **for viewing only** — it does *not* drive the outlets.
- **Player controls** — minimal transport row (play, pause, seek bar, current time / duration). Wired to the IFrame Player API; mirror inbound messages on inlet 0.
- **Capture button + status pills** — identical to `browser~`. Pressing "Capture" opens `getDisplayMedia`; the user picks this same patchNet tab? **No** — they pick a separate YouTube tab. To make this ergonomic, the capture button is a two-step UI:
  1. **"Open in tab"** — `window.open("https://youtube.com/watch?v=<id>&t=<start>", "_blank")`.
  2. **"Capture that tab"** — fires `getDisplayMedia`; the user picks the just-opened tab from the picker.
  Optional convenience: chain step 1 → step 2 with a short delay so the picker shows the new tab as a top hit.
- **Status pills** — "Audio ●●" L/R meter, "Video ●" frame tick, "Not captured" when no stream.

The in-panel iframe and the captured tab are two **independent** YouTube playbacks. We accept this — keeping them in sync (e.g., pausing the iframe also pauses the captured tab) is out of scope. The iframe is for preview/scrubbing; the captured tab is the signal source.

### Graph: `src/graph/objectDefs.ts`

```ts
"youtube~": {
  description: "Embedded YouTube player. Loads any YouTube URL; outputs the tab's audio (L/R) + video via user-approved getDisplayMedia(). In-panel preview + transport via the YouTube IFrame Player API.",
  category: "audio",
  args: [
    { name: "url", type: "symbol", default: "",
      description: "YouTube URL (watch, share, embed, shorts forms accepted)." },
    { name: "videoId", type: "symbol", default: "", hidden: true,
      description: "Parsed 11-char video ID. Derived from url; persisted for fast reload." },
    { name: "startSeconds", type: "int", default: "0", min: 0, hidden: true,
      description: "Start offset in seconds (parsed from ?t= / ?start=)." },
    { name: "captureOnLoad", type: "int", default: "0", min: 0, max: 1, step: 1, hidden: true,
      description: "Reserved: set when a capture was active at save time." },
  ],
  messages: [
    { inlet: 0, selector: "play",     description: "play the embedded player" },
    { inlet: 0, selector: "pause",    description: "pause the embedded player" },
    { inlet: 0, selector: "seek",     description: "seek <seconds>" },
    { inlet: 0, selector: "rate",     description: "rate <0.25..2> playback speed" },
    { inlet: 0, selector: "url",      description: "url <youtube-url> — load a different video" },
    { inlet: 0, selector: "capture",  description: "open the tab picker" },
    { inlet: 0, selector: "release",  description: "stop mirroring" },
  ],
  inlets: [
    { index: 0, type: "any", label: "transport / url / capture / release" },
  ],
  outlets: [
    { index: 0, type: "signal", label: "audio L" },
    { index: 1, type: "signal", label: "audio R" },
    { index: 2, type: "media",  label: "video out (→ layer / vFX)" },
  ],
  defaultWidth: 480,
  defaultHeight: 360,
},
```

Per-feedback rule (`feedback_object_registration.md`): this is the only registration point.

### Serializer

Persist: `url`, `videoId`, `startSeconds`, `captureOnLoad`. Stream itself can't be serialized — on reload, the panel shows a "Resume capture" button. Identical to `browser~`.

---

## Phase Plan

### Phase A — Real-snippet slice (1 session, Codex)

Per `feedback_dsl_object_phasing.md`, scope the first phase around a **real, representative URL** end-to-end rather than infrastructure alone. Target snippet: a normal `https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s` URL, played in-panel with audible L/R + video flowing through the patch graph to `dac~` and `layer → visualizer`.

- `YouTubeNode.ts` composing a `BrowserNode` (so audio/video paths inherit unchanged).
- URL parser supporting all five URL forms in the table above + `?t=` parsing.
- `objectDefs.ts` registration as specified.
- Minimal `YouTubePanel`: URL bar, in-panel `<iframe>` (no JS Player API yet — just the static embed), "Open + capture" two-step button, status pills.
- Wire into `AudioGraph` connect/disconnect helpers identically to `browser~` / `adc~`.
- Serializer: `url` and `videoId` round-trip.
- **Manual QA against the target snippet:**
  1. Drop `[youtube~ https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s]`. URL bar shows the URL; iframe loads at 0:43.
  2. Click "Open in tab". A new tab opens, video starts.
  3. Click "Capture". Pick that tab. Status pills go live.
  4. Patch L/R → `dac~`. Audible.
  5. Patch L → `fft~`. Spectrum reacts.
  6. Patch video out → `vFX.crt` → `layer` → `visualizer`. Visualizer shows YouTube with CRT.
  7. Save patch, reload. URL persists. "Resume capture" button visible.

**Exit criteria:** All three outlets functional against the target snippet, round-trip OK.

### Phase B — IFrame Player API integration (1 session, Codex + Cursor)

- Add `enablejsapi=1` + `postMessage` bridge in `YouTubePanelController`.
- Implement message handlers for `play`, `pause`, `seek`, `rate`, `url` on inlet 0.
- Transport row UI: play/pause toggle, scrubber bound to `getCurrentTime()` polling, duration label.
- Title fetched via oEmbed (`https://www.youtube.com/oembed?url=<url>&format=json`) and shown above the iframe.
- **Manual QA:** `[metro 4000] → [youtube~]` with a sequence of `seek` messages cycles through timestamps. Scrubber follows. `pause` / `play` from a `[button]` works.

**Exit criteria:** Transport controls work both from panel UI and from inlet messages; metadata visible.

### Phase C (optional, deferred) — Polish + escape hatches

- Cached thumbnail (oEmbed `thumbnail_url`) shown when not captured, so the patch isn't a blank box on reload.
- "Resume capture" pre-fills the same tab hint.
- *(Sketch only)* Optional local `yt-dlp` proxy mode behind a flag — direct MP4 in a CORS-anonymous `<video>`, no `getDisplayMedia` prompt. Off by default; requires user-run sidecar; documented as ToS-grey.

---

## Non-Goals

- **Capturing without `getDisplayMedia`** in the default path. There is no other browser-sanctioned way.
- **Sync between in-panel iframe and captured tab.** Two independent playbacks; user accepts this.
- **YouTube login / age-gated / DRM content.** If the embed refuses, we surface the error and stop.
- **Playlist / queue support.** One URL per object; chain multiple `youtube~` for sequencing.
- **API-key features** (search, related videos). oEmbed is the only YouTube endpoint we touch.

---

## Open Questions for the Director

1. **Compose vs. extend `BrowserNode`?** Recommend compose. Confirm.
2. **Single capture button or the two-step "open + capture" flow?** Two-step is more honest about what's happening (separate tab is the source). One-button hides this and may confuse on reload.
3. **Should `youtube~` *replace* the URL field in `browser~` for YouTube URLs (auto-upgrade), or stay strictly separate?** Recommend strictly separate — `browser~` is the generic primitive; `youtube~` is the convenience wrapper.
4. **Default panel size.** 480×360 matches a 16:9 embed at usable scale; consistent with `browser~`. OK?
