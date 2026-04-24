---
title: browser~ Object Plan
type: project
tags: [object-plan, media, audio, video, browser]
updated: 2026-04-23
---

# `browser~` — Embedded Web Browser Object

## Goal

A patch object that displays a live web page and exposes its audio and video to the rest of the patch.

```
[browser~ https://example.com]
 │      │      │
 L~     R~     video~
```

- Outlet 0 — audio L (AudioNode, patchable into `*~`, `dac~`, `fft~`, etc.)
- Outlet 1 — audio R (AudioNode)
- Outlet 2 — video (media-typed, patchable into `vFX.blur`, `vFX.crt`, `layer`, future video objects)

---

## Feasibility Summary (The Honest Part)

Browser security blocks the naive "embed a page, tap its audio/video pins" approach on two fronts:

1. **Iframes don't expose pixels or audio across origins.** There is no `captureStream()` on an `HTMLIFrameElement`. Even when a cross-origin iframe renders, its DOM, canvas, and audio are opaque to the host page.
2. **Most major sites refuse iframe embedding entirely** via `X-Frame-Options: DENY` or a `frame-ancestors` CSP (Google, YouTube, Twitter, most SaaS, all banks). Roughly half the web will render blank in the iframe view.

The one path the browser *does* sanction: **`navigator.mediaDevices.getDisplayMedia()`**. The user picks a tab from a native OS prompt; the browser returns a `MediaStream` with video + tab audio. It is cross-origin safe *because the user authorized it*, and it works on every site. This is the Zoom / Google Meet / OBS-browser-source path.

Design consequence: **viewing** (the iframe preview inside the object) and **capturing** (the L/R + video outlets) are two linked-but-separate mechanisms. The iframe is a convenience preview; the outlets are driven by `getDisplayMedia`. In practice this is one extra click on object creation (approve the tab capture) and then it behaves like any other source.

---

## Architecture

### Runtime: `src/runtime/BrowserNode.ts`

Composes the two existing patterns:

**Audio side (mirrors `AdcNode`):**
```
getDisplayMedia({audio:true}) → MediaStream
  → audioCtx.createMediaStreamSource(stream)
  → ChannelSplitter(2) → outlet 0 (L) / outlet 1 (R)
                       → analyserL/R (meter taps)
```

**Video side (mirrors `MediaVideoNode`):**
```
getDisplayMedia({video:true}) → MediaStream
  → hidden <video>.srcObject = stream
  → LayerNode.drawImage(video) via outlet 2
```

Because the video outlet exposes a `MediaVideoNode`-compatible shape (a ready `HTMLVideoElement` + `isReady` + no `hasError`), **existing video-processing objects (`vFX.blur`, `vFX.crt`, `layer`) work with it for free**. No changes to consumer nodes.

### Canvas: `src/canvas/BrowserPanel.ts` (+ controller)

Follows the `JsEffectPanel` pattern — an attached panel UI for the object's body:

- **URL bar** — editable; enter navigates the iframe.
- **Iframe preview** — sandboxed `<iframe sandbox="allow-scripts allow-same-origin allow-forms">`. Shows the page when the site allows framing; shows a friendly "This site blocks embedding — use Capture Tab below" fallback on load failure / CSP block (detected via `onerror` + load-timeout + `document.domain` probe).
- **Capture button** — triggers `getDisplayMedia()` and shows the chosen tab's title. User can re-pick at any time.
- **Status pills** — "Audio ●●" (L/R meter), "Video ●" (frame tick), "Not captured" before the user approves.

### Graph: `src/graph/objectDefs.ts`

```ts
"browser~": {
  kind: "audio",  // has ~ suffix; also produces media out
  description: "Embedded web browser. Captures the audio (L/R) and video of a browser tab via user-approved getDisplayMedia().",
  args: [{ name: "url", type: "string", default: "about:blank" }],
  inlets: [
    { index: 0, type: "message", label: "url / navigate / capture / release" },
  ],
  outlets: [
    { index: 0, type: "signal", label: "audio L" },
    { index: 1, type: "signal", label: "audio R" },
    { index: 2, type: "media",  label: "video out" },
  ],
  hasPanel: true,
}
```

Message inlet accepts: `navigate <url>`, `capture` (opens the tab picker), `release` (stops capture), `reload`.

### Serializer

Only the URL and a `captureOnLoad: boolean` attribute are serialized. The `MediaStream` itself cannot be persisted — on patch reload, if `captureOnLoad` is set, the panel shows a "Click to resume capture" button (browser requires a fresh user gesture per session).

---

## Phase Plan

### Phase A — Audio outlets only (1 session, Codex)

**Scope:** Smallest viable slice that proves the capture path.

- `BrowserNode.ts` with `start()` doing `getDisplayMedia({audio:true, video:false})`, splitter → L/R. No video yet. No iframe yet. No panel yet — temp inspector-style button in the object body.
- Register `browser~` in `objectDefs.ts` with only L/R outlets.
- `AudioGraph` wiring: treat like `adc~` in the connect/disconnect helpers.
- Manual QA: `[browser~] → [dac~]`, play a YouTube tab, confirm audio flows. Patch `→ [fft~]`, confirm spectrum reacts.

**Exit criteria:** Sound from a captured tab hits speakers through the patch graph, L and R patched independently.

### Phase B — Video outlet + iframe preview + panel UI (1 session, Codex + Cursor)

**Scope:** Round out to the full three-outlet design.

- Extend `BrowserNode` to request `{audio:true, video:true}`, route stream into hidden `<video>`, expose as `mediaVideo`-compatible outlet 2.
- `BrowserPanel.ts` + controller (Cursor): URL bar, iframe preview with CSP-block fallback, capture button, status pills.
- Serializer: persist `url`, `captureOnLoad`.
- Manual QA: `[browser~] outlet 2 → [vFX.crt] → [layer] → [visualizer]`. Tab video appears on the visualizer with CRT effect applied. Reload patch, confirm URL persists and a "resume capture" prompt appears.

**Exit criteria:** All three outlets functional, preview visible, patch round-trips.

### Phase C (optional, deferred) — Polish

- Cached tab thumbnail so the patch shows *something* before the user re-approves capture.
- Per-tab label persistence so the resume prompt says "Resume capture of 'YouTube — Song Name'".
- URL autocomplete from recent captures.

---

## Non-Goals

- **Actual browser engine embedding** (Electron `<webview>`, CEF). patchNet is pure browser; out of scope forever in v1.
- **Proxy-based iframe unblocking** (rewriting CSP via a server). Breaks auth, breaks modern SPAs, legal grey area; not worth it.
- **Headless / automated capture** without user gesture. Browser won't allow it.

---

## Open Questions for the Director

1. **Is `browser~` the right name?** Alternatives: `web~`, `tab~`, `site~`. `browser~` is clearest; `tab~` is more accurate to the capture mechanism.
2. **Should video be its own object (`browser.video`) alongside an audio-only `browser~`?** Cleaner separation but double the capture prompts. Current plan bundles for one-prompt UX — recommend keeping bundled.
3. **Panel size.** Iframe preview wants real estate (at least 320×180 to be useful). Biggest patch object so far. OK?
