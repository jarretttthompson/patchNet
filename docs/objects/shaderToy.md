---
type: shaderToy
category: visual
version: 1
---

# shaderToy

GLSL fragment-shader media source. Renders a ShaderToy-style `mainImage()` function onto an offscreen WebGL2 canvas and emits it as a media surface that `layer` (and therefore `visualizer` / `patchViz`) can composite.

---

## Arguments

| # | name    | type   | default   | description |
|---|---------|--------|-----------|-------------|
| 0 | preset  | symbol | `default` | Built-in preset. One of `default`, `plasma`, `warp`, `grid`. Overridden by `code` when present. |
| 1 | code    | symbol | (empty)   | Base64-encoded GLSL source — set via the `code` or `glsl` message. Hidden in the attribute panel. |
| 2 | width   | int    | `512`     | Render surface width in pixels. |
| 3 | height  | int    | `512`     | Render surface height in pixels. |
| 4 | mouseX  | float  | `0.5`     | Normalized `iMouse.x` (0–1). Hidden. |
| 5 | mouseY  | float  | `0.5`     | Normalized `iMouse.y` (0–1). Hidden. |

---

## Inlets

| # | type | temperature | accepts | description |
|---|------|-------------|---------|-------------|
| 0 | any  | hot         | `preset <name>`, `code <base64>`, `glsl <source>`, `mouse <x> <y>`, `size <w> <h>`, `reset`, `bang` | Control inlet. `bang` resets `iTime` to 0. |

---

## Outlets

| # | type  | description |
|---|-------|-------------|
| 0 | media | Shader render surface. Connect to a `layer` inlet. |

---

## Messages

| inlet | selector | args           | effect |
|-------|----------|----------------|--------|
| 0     | preset   | `<name>`       | Switch to a built-in preset (`default` / `plasma` / `warp` / `grid`). Clears any custom `code`. |
| 0     | code     | `<base64>`     | Replace fragment source. Input is base64-encoded GLSL — safe for round-trip through the text panel. |
| 0     | glsl     | `<source...>`  | Replace fragment source with the rest of the message as raw GLSL. Convenient for hand-typed patches; internally re-encoded as base64. |
| 0     | mouse    | `<x> <y>`      | Set normalized `iMouse` position (0–1). |
| 0     | size     | `<w> <h>`      | Resize the render surface. |
| 0     | reset    | —              | Reset `iTime` and `iFrame` to zero. |
| 0     | bang     | —              | Equivalent to `reset`. |

### Uniforms exposed to the shader

The shader sees the ShaderToy-compatible subset:

| uniform      | type  | meaning |
|--------------|-------|---------|
| `iResolution`| vec3  | Render surface size (w, h, 1). |
| `iTime`      | float | Seconds since the last `reset` / shader recompile. |
| `iTimeDelta` | float | Seconds since the previous frame. |
| `iFrame`     | int   | Frame counter since the last reset. |
| `iMouse`     | vec4  | `(mouseX * w, mouseY * h, clickX, clickY)`. |
| `iDate`      | vec4  | `(year, month0, day, secondsSinceMidnight)`. |

Multi-pass rendering and `iChannel*` texture inputs are not supported in v1.

---

## Examples

Default preset, wired through a layer into a `patchViz`:

```
#N canvas;
#X obj 80 80 shaderToy;
#X obj 80 140 layer world1 0 1 1 0 0;
#X obj 80 220 patchViz world1 1;
#X connect 0 0 1 0;
```

Switch preset at runtime from a message box:

```
#N canvas;
#X obj 80 80 shaderToy;
#X obj 80 40 message preset plasma;
#X connect 1 0 0 0;
```

Inline GLSL via the `glsl` message (pasted from a ShaderToy snippet):

```
#N canvas;
#X obj 80 80 shaderToy;
#X obj 80 40 message glsl void mainImage(out vec4 c,in vec2 p){c=vec4(fract(p/iResolution.xy),0,1);};
#X connect 1 0 0 0;
```

Drive the `iMouse` uniform from two sliders:

```
#N canvas;
#X obj 80 80 shaderToy;
#X obj 80 40 message mouse $1 0.5;
#X obj 80 10 slider;
#X connect 2 0 1 0;
#X connect 1 0 0 0;
```

---

## Notes

- **Same layer path as video FX.** `shaderToy → layer` uses the same `VideoFXSource` slot as `vfxCRT` / `vfxBlur`, so a layer can hold a shader **or** a video **or** an image — not both. Swap sources by re-cabling.
- **Works with both render contexts.** Because the layer is context-agnostic, the shader composites identically into a popup `visualizer` and an inline `patchViz` — just set the layer's `context` arg to match the one you want.
- **ShaderToy URL / ID fetching is intentionally out of scope.** The official ShaderToy API requires a per-user key and CORS is not universally configured. Paste the fragment source directly via `glsl` or `code` — that path is deterministic and persists with the patch.
- **Persistence.** Custom GLSL is base64-encoded into `args[1]` so the PD-style text line stays single-line. Clearing a patch and pasting the text back restores the shader exactly.
- **Compilation errors do not bind.** A failed compile is logged to the console; the previous good shader stays running. Check `console.warn` for GLSL error messages.
- **Unsupported ShaderToy features.** No `iChannel*` samplers, no multi-pass buffers, no audio textures. Single-pass shaders only.

---

<!--
Keep this file parseable by the Reference tab loader (Part 5).
Required frontmatter: type, category, version.
Section headings (Arguments / Inlets / Outlets / Messages / Examples / Notes)
are read by the loader — do not rename them.
-->
