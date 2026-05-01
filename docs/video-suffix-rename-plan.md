# Video Suffix Rename Plan

## Goal

Mirror the audio convention (`~` suffix on signal-domain objects) for the
video/image domain using the `*` suffix. Objects that operate in **both**
domains carry `~*` (audio first, then video — matches output order in the
codebase: audio outlets come before video outlets on every dual-domain
object).

## Renames

| Domain               | Old           | New           |
| -------------------- | ------------- | ------------- |
| Video / image only   | `frame~`      | `frame*`      |
| Video / image only   | `mediaVideo`  | `mediaVideo*` |
| Video / image only   | `mediaImage`  | `mediaImage*` |
| Video / image only   | `shaderToy`   | `shaderToy*`  |
| Video / image only   | `vfxCRT`      | `vfxCRT*`     |
| Video / image only   | `vfxBlur`     | `vfxBlur*`    |
| Video / image only   | `reaperVideo` | `reaperVideo*`|
| Video / image only   | `imageFX`     | `imageFX*`    |
| Video / image only   | `layer`       | `layer*`      |
| Video / image only   | `visualizer`  | `visualizer*` |
| Audio + video        | `browser~`    | `browser~*`   |
| Audio + video        | `youtube~`    | `youtube~*`   |

`frame~` loses its tilde because it has no audio outlet — that was the
trigger for this rename in the first place.

Pure audio (`dac~`, `adc~`, `click~`, `fft~`, `mixer~`, `buffer~`, `js~`)
is unchanged — `~` already covers them.

## Why `*` and not backtick

`*` is already a registered object name (multiplication). The parser
tokenizes by whitespace, so `frame*` is a distinct token from `*`; no
parse ambiguity. Backtick was the alternative — rejected for shell-injection
optics and visual noise.

The trade-off accepted: typing `*` into autocomplete now matches both the
math op and every video object suffix. Manageable.

## Migration shim — old patches must keep loading

Existing saved patches contain literal type tokens (`frame~`, `mediaVideo`,
etc.) in their text. We do **not** rewrite saved patches — instead we
extend `TYPE_ALIASES` in `src/graph/objectDefs.ts` so `canonicalizeType`
maps every old name to its new key on parse. `canonicalizeType` is already
called in two places: `parse.ts` (load path) and `PatchGraph.addNode`
(create path). Both are covered.

Forward-compat (new patches loading on old patchNet builds) is **not**
supported and not required.

## File-by-file impact

| File                                            | Change                                   |
| ----------------------------------------------- | ---------------------------------------- |
| `src/graph/objectDefs.ts`                       | Rename 12 keys in `OBJECT_DEFS`; extend `TYPE_ALIASES` with the 12 legacy → new mappings |
| `src/serializer/parse.ts`                       | Type-specific branches keyed on old strings (`type === "js~"`, etc.) — most of those types are unchanged; `youtube~`, `reaperVideo` need rename |
| `src/serializer/serialize.ts`                   | Same |
| `src/runtime/VisualizerGraph.ts`                | `node.type === "X"` compares, plus literal-type unions (`"mediaVideo" \| "mediaImage"`) |
| `src/runtime/AudioGraph.ts`                     | `browser~`, `youtube~` compares |
| `src/runtime/rvideo/library.ts`                 | reaperVideo refs |
| `src/canvas/ObjectRenderer.ts`                  | Many `node.type === "X"` branches; display labels (`title.textContent = "imageFX"`) updated to match |
| `src/canvas/ObjectInteractionController.ts`     | Selectors / type compares |
| `src/canvas/CanvasController.ts`                | Type compares |
| `src/canvas/OverlapGuard.ts`                    | Type compares |
| `src/canvas/VisualizerObjectUI.ts`              | Type compares |
| `src/canvas/FramePanelController.ts`            | `node.type !== "frame~"` guard |
| `src/canvas/BrowserPanelController.ts`          | Same |
| `src/canvas/YouTubePanelController.ts`          | Same |
| `src/canvas/ReaperVideoPanelController.ts`      | Same |
| `src/canvas/ReaperVideoPanel.ts`                | Title display string |
| `src/canvas/ImageFXPanel.ts`                    | Type compares |
| `src/control/ControlMessage.ts`                 | Type compares |
| `src/graph/PatchGraph.ts`                       | Type compares |
| `src/shell.css`                                 | `[data-node-type="X"]` selectors and section comments |

## What does NOT change

- Saved patches on disk (handled by alias shim)
- The text panel mirror (re-rendered from current type, so it picks up new names automatically)
- Autocomplete (derived from `OBJECT_DEFS` keys)
- Context menu (same)
- Pure-audio object names (unchanged)
- Math ops (`*`, `+`, etc.)

## Risks

1. **Stale string literal we miss.** Mitigation: full typecheck after the rename — most call sites read `node.type` against typed unions or string literals; mismatched literals will surface as dead branches but won't typecheck-fail. So follow up with a runtime smoke test (load an old patch, drop a new instance of each renamed object, confirm panels render and outputs route).
2. **Display titles.** The `*` will show in the canvas object header. Acceptable — that's the point.
3. **Nothing else surfaces user-visible churn** because the text panel re-derives from current type.

## Acceptance

- [ ] All 12 keys renamed in `OBJECT_DEFS`
- [ ] `TYPE_ALIASES` has 12 legacy mappings
- [ ] `tsc` clean
- [ ] Loading an old patch (with `frame~`, `mediaVideo`, etc. in text) still works
- [ ] Creating each renamed object via autocomplete works
- [ ] Old `frame~` token in autocomplete still resolves (alias)
