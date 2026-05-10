# patchNet

**A browser-native visual programming environment for live performance, composition, and audiovisual work.**

Live: **[thejrummer.art/patchNet](http://thejrummer.art/patchNet/)** — open the URL, you're patching. No install, no license, no plugin folder.

patchNet takes the dataflow language of Pure Data and Max/MSP — objects on a canvas, patch cables between them, a text mirror that round-trips losslessly — and rebuilds it natively for the browser. Web Audio handles DSP. WebGL/Canvas handles video. WebRTC handles peer networking. Everything runs in a tab.

---

## Why this exists

Max and Pd are decades-old, deeply capable, and bound to the desktop. patchNet borrows their mental model — *"a patch is a graph; the graph is the program"* — and asks what changes when the runtime is a tab instead of a binary:

- **Send anyone a working patch as a URL.** Share state lives in the link.
- **Capture a live YouTube tab, your laptop camera, or a browser window** and route it through the same graph as your synth voices.
- **Run on any laptop, phone, or kiosk with a modern browser.** No DAW, no JACK, no `pd-extended` install.
- **Hack the runtime in TypeScript** — every object is ~100 lines. Forks ship as static files.

It is not a Pd port. It is its own language, with Pd/Max as the UX template.

---

## What you can do with it

### Live performance

- **Build instruments on stage.** A patch is reactive: drop in a `wave~`, drag a `mixer~` strip, route `adc~ 8` from a multichannel interface, and you're playing.
- **`vbuf*` and `buffer~` are tape-style live samplers.** Both record from anything upstream — mic, video tab, synth voice — and play back at variable rate, reverse (audio), looped, with a draggable sub-range window. Persisted to the browser's OPFS so a soundcheck capture is still there after a tab reload.
- **Multichannel I/O up to 32 channels.** `adc~ 32` and `dac~ 32` route directly to physical inputs/outputs on interfaces like a Behringer X32 in Chrome on macOS Core Audio. The Audio Status modal (double-click `dac~`) exposes device pickers, sample rate, and detected channel counts.
- **Patch mode toggle** locks the cable layer once a patch is performance-ready, so accidental clicks don't blow up your set.
- **Scratch tabs** (`⌘T`) let you build a side patch without disturbing the main one. Each tab has its own audio graph; a global `s`/`r` bus crosses tab boundaries so a controller in one tab can drive a voice in another.
- **Send/receive over the network.** Peer-to-peer patching via WebRTC — share a session URL, two browsers patch the same canvas. Useful for ensemble pieces, remote rehearsal, or audience interaction.
- **`dmx` drives stage lighting from the same patch.** DMX512 output via an ENTTEC DMXUSB PRO over Web Serial — 512-channel universe streamed at 10–44 Hz. Patch fixtures by start address, drive intensity/color/pan/tilt from any signal in the graph, blackout or home all from a `button`. Bundled fixture profiles plus user import/export; orphaned fixtures can be repointed to a new profile in place. Auto-reconnects to the last-used port on patch reload.

### Composition

- **The text panel is the score.** Every patch round-trips losslessly to PD-inspired text. Version it in git. Diff two versions. Paste a snippet into a chat message.
- **Sub-patches and scratch tabs** let you nest voices, abstractions, and sketches. Move a working idea into a sub-patch, name it, and reuse it.
- **`adsr~`, `transientFollower~`, `lfo~`, `wave~`** — modular DSP primitives with the live editor on the object face. Drag handles on the ADSR shape, drag knobs on the LFO. The face is the control surface.
- **`js~`** runs JSFX (REAPER's JS effect language) sample-by-sample in an AudioWorklet. Drop existing JSFX code into a patch and it plays.
- **`fft~`** drives spectral analysis into control land — band levels become floats, drive synth params, drive video.
- **Patches save as `.patchnet` files** and load right back. Nothing is locked into a vendor format.

### Audiovisual

A first-class video/visual layer parallels the audio layer. Same patching model, different signal type:

- **`cam*`** — getUserMedia camera input as a video stream.
- **`frame*`** — capture a region of your own browser tab. Drag the rectangle on the canvas, the pixels under it stream out.
- **`browser~*` / `youtube~*`** — capture and route any browser tab's audio + video into the patch (via `getDisplayMedia`). Live YouTube tab → spectral analyzer → modulate your synth.
- **`mediaVideo*` / `mediaImage*`** — load files; play, scrub, loop.
- **`shaderToy*`** — paste GLSL fragment-shader code (ShaderToy `mainImage()` style); it renders to a texture you can layer.
- **`reaperVideo*`** — paste REAPER video processor code; `@param` declarations populate knobs; runs per-frame in Canvas2D.
- **`vfxCRT*`, `vfxBlur*`, `imageFX*`** — chainable post-processing.
- **`visualizer*` + `layer*`** — opens a popup render window; route any number of media sources through `layer*` objects with priority, scale, opacity, and offset to composite a final image. The popup can be dragged to a second display for projection.

Audio and video share the same canvas, the same cable model, and the same text serialization. A `wave~` outlet and a `cam*` outlet are both just outlets — what you do with them is your business.

---

## How patchNet differs from Max/MSP and Pure Data

| | Max/MSP | Pure Data | patchNet |
|---|---|---|---|
| **Runtime** | Native binary, paid license | Native binary, free | Browser tab, free, MIT-licensed |
| **Install** | Cycling '74 installer | Compile or `apt install` | Open a URL |
| **Sharing** | Send `.maxpat`, recipient needs Max | Send `.pd`, recipient needs Pd | Send a link |
| **Sandboxed** | No (full system access) | No | Yes (browser sandbox; mic/camera/MIDI by user grant) |
| **Cables** | Bezier curves | Straight | Straight (PD lineage) |
| **Text mirror** | No | `.pd` is the file format, not a live mirror | Live bidirectional panel — edit either side |
| **Video** | Jitter (paid extension) | GEM (compile-it-yourself extension) | First-class, in core |
| **Tab capture** | N/A | N/A | Yes — any browser tab is a media source |
| **Networked patching** | OSC over local network | netsend/netreceive | WebRTC peer sessions, share URL |
| **Stage lighting** | Third-party externals (e.g. `ml.dmxusbpro`) | Externals | `dmx` in core — ENTTEC over Web Serial, fixture profiles, 512-ch universe |
| **Hot-loadable code** | gen~, JS object | externals | `js~` (JSFX), `reaperVideo*`, `shaderToy*` |
| **Forking** | Closed source | Open, but C codebase | Open, ~30k lines of TypeScript, no framework |
| **Live coding** | External (e.g. node.script) | Manual edits | Edit the text panel, hit save — patch updates |

### What patchNet does *not* (yet) match

- Max's `gen~` for low-level DSP authoring (use `js~` / JSFX or AudioWorklet for now).
- Pd's vast community library of externals.
- Multichannel routing on browsers other than Chrome — Safari and Firefox tend to clamp Web Audio output at 2ch regardless of the device.
- Hard real-time guarantees. Web Audio buffer sizes are good but not Max-on-CoreAudio good. Most live performance works fine; surgical microsecond-accurate work does not.

---

## Why "browser-hosted" actually matters

This is more than a deployment detail. It changes how the tool gets used:

1. **Zero-friction collaboration.** A patch is a URL. Send it in a Discord message, paste it into a class chat, drop it in a livestream. Whoever clicks is now editing the same graph.
2. **Teaching and onboarding.** A student doesn't have to install anything before they're patching. Open a tab, follow the tutorial. The barrier between "interested" and "playing a sine wave" is one click.
3. **The web is the patch.** A `youtube~*` object captures a YouTube tab as a signal source. A `browser~*` captures any tab. The web becomes raw material, not a separate world.
4. **Forkable as a static site.** `git clone`, `npm install`, `npm run dev`. Build is `tsc && vite build`. Deploy is "drop the `dist` folder anywhere." No native build chain, no audio framework to compile.
5. **Crash-safe.** Tab dies, you reload, the autosave brings the patch back. OPFS persists buffers and recordings across sessions.
6. **Modern web APIs as first-class objects.** WebRTC (`s/r` over the network), WebGL (`shaderToy*`), Web MIDI, Web Serial (`dmx` → ENTTEC lighting widget), getUserMedia (`cam*`), getDisplayMedia (`browser~*`), OPFS (`buffer~` / `vbuf*` persistence), AudioWorklet (`js~`, `transientFollower~`).
7. **Mobile and tablet are first-class targets.** Patching on an iPad in a lecture or on a phone backstage is a real workflow.

---

## Object suite (May 2026)

**Control / utility:** `button`, `toggle`, `slider`, `ezSlider`, `ezScale`, `metro`, `timer`, `count`, `drunk`, `pack`, `unpack`, `prepend`, `append`, `trigger`, `int`, `float`, `f`, `+`, `-`, `*`, `/`, `s`, `r`, `comment`, `message`.

**Audio:** `click~`, `noise~`, `wave~`, `lfo~`, `adsr~`, `transientFollower~`, `mixer~`, `buffer~`, `vbuf*`, `fft~`, `js~` (JSFX), `adc~ N`, `dac~ N`.

**Video / visuals:** `cam*`, `frame*`, `browser~*`, `youtube~*`, `mediaVideo*`, `mediaImage*`, `imageFX*`, `vfxCRT*`, `vfxBlur*`, `shaderToy*` (GLSL), `reaperVideo*`, `layer*`, `visualizer*`.

**Lighting:** `dmx` — DMX512 over Web Serial via ENTTEC DMXUSB PRO, with fixture profiles and a patched 512-channel universe.

Every object is a single TypeScript file under `src/runtime/` or rendered via a single branch in `src/canvas/ObjectRenderer.ts`. New objects are registered exactly once in `src/graph/objectDefs.ts` — autocomplete, context menu, and serialization all derive from there.

---

## Run it locally

```bash
git clone https://github.com/jarretttthompson/patchNet.git
cd patchNet
npm install
npm run dev
```

Open `http://localhost:5173`. Edit anything in `src/`, the page hot-reloads.

```bash
npm run typecheck   # tsc --noEmit
npm run test        # vitest
npm run build       # tsc + vite build → dist/
```

---

## Contributing / forking

I want help with this. Concretely:

- **New objects.** Audio, video, control. Every existing object is a worked example — copy `src/runtime/LfoNode.ts` or `src/runtime/WaveNode.ts` and modify. Register in `src/graph/objectDefs.ts`. Open a PR.
- **Cross-browser audio.** Multichannel output and AudioWorklet behavior diverge across Chrome, Safari, Firefox. Bug reports with browser/OS/device info are gold.
- **Mobile UX.** The canvas is keyboard-and-trackpad-first today. Touch and pen workflows are open territory.
- **Object docs.** Each object spec has a `description` field that becomes the help-panel copy. Better text helps everyone.
- **Patches.** Build something interesting, save the `.patchnet` file or share URL, open a PR adding it to a `patches/` folder.

The codebase is vanilla TypeScript with vanilla DOM. No React, no framework lock-in. `PLAN.md` has the longer-term direction; `CHANGELOG.md` is the work log.

If you fork it, tag me — I'd love to see what you build.

---

## Status

Active solo development. Phase 7A (peer networking) is shipped. Recent work: `dmx` lighting (Phase 4 — reconnect, auto-resume, profile import/export, orphan repoint), multichannel I/O, scratch tabs, patch mode lock, `wave~` / `lfo~` / `adsr~` / `transientFollower~`. See `CHANGELOG.md` for the full log.

## License

MIT. Do whatever you want.
