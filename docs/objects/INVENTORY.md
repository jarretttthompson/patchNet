# patchNet Object Inventory

Single source of truth for which object types exist and how deeply each is wired through the stack.
Generated 2026-04-17 as part of `docs/EVALUATION_PLAN.md` Part 1.2.

Sources scanned:
- `src/graph/objectDefs.ts` — `OBJECT_DEFS` registry
- `src/canvas/ObjectEntryBox.ts` — `VALID_TYPES` allowlist
- `src/canvas/ObjectRenderer.ts` — per-type DOM branches
- `src/canvas/ObjectInteractionController.ts` — mousedown / message routing
- `src/runtime/AudioGraph.ts` — audio runtime nodes
- `src/runtime/VisualizerGraph.ts` — visualizer runtime nodes
- `src/canvas/VisualizerObjectUI.ts` — media double-click handlers
- `docs/objects/*.md` — reference pages

Legend for columns:
- **spec** — entry in `OBJECT_DEFS`
- **allowlist** — entry in `VALID_TYPES`
- **renderer** — explicit branch in `renderObject()` / `buildBody()` (vs. generic text label fallthrough)
- **runtime** — has a backing runtime node class
- **interaction** — has mouse/value/bang handling branch
- **ref doc** — `docs/objects/<type>.md` exists
- **tests** — no test infrastructure exists in the repo yet; column is a placeholder

| type | category | spec | allowlist | renderer | runtime | interaction | ref doc | tests |
|------|----------|:----:|:---------:|:--------:|:-------:|:-----------:|:-------:|:-----:|
| `button`      | ui        | ✓ | ✓ | OR:96  | —                                | OIC:186 | ✓ | — |
| `toggle`      | ui        | ✓ | ✓ | OR:102 | —                                | OIC:188 | ✓ | — |
| `slider`      | ui        | ✓ | ✓ | OR:147 | —                                | OIC:138 | ✗ | — |
| `message`     | ui        | ✓ | ✓ | OR:140 | —                                | OIC:190 + main.ts:87 | ✓ | — |
| `attribute`   | ui        | ✓ | ✓ | OR:187 | —                                | OIC attr sync (via syncAttributeNode) | ✗ | — |
| `integer`     | control   | ✓ | ✓ | OR:134 (shared numbox)           | —                                | OIC:152 | ✗ | — |
| `float`       | control   | ✓ | ✓ | OR:134 (shared numbox)           | —                                | OIC:152 | ✗ | — |
| `metro`       | control   | ✓ | ✓ | OR:302 (default + meta)          | interval timer in OIC:1104       | OIC:1104 | ✓ | — |
| `scale`       | control   | ✓ | ✓ | default text label (no branch)   | —                                | generic message | ✗ | — |
| `s`           | control   | ✓ | ✓ | OR:279 (shared s/r)              | —                                | OIC:548 broadcast | ✗ | — |
| `r`           | control   | ✓ | ✓ | OR:279 (shared s/r)              | —                                | OIC:548 broadcast | ✗ | — |
| `click~`      | audio     | ✓ | ✓ | OR:307                           | AudioGraph:61 (ClickNode)        | — | ✗ | — |
| `dac~`        | audio     | ✓ | ✓ | OR:312                           | AudioGraph:64 (DacNode)          | — | ✗ | — |
| `codebox`     | scripting | ✓ | ✓ | OR:164 (CodeMirror mount)        | CodeboxController                | OIC (bang/value routed to CodeboxController) | ✗ | — |
| `visualizer`  | visual    | ✓ | ✓ | OR:252                           | VisualizerGraph:234 (VisualizerNode) | VisualizerObjectUI | ✗ | — |
| `mediaVideo`  | visual    | ✓ | ✓ | OR:264                           | VisualizerGraph:296 (MediaVideoNode) | VisualizerObjectUI:35 | ✗ | — |
| `mediaImage`  | visual    | ✓ | ✓ | OR:211                           | VisualizerGraph:333 (MediaImageNode) | VisualizerObjectUI:39 | ✗ | — |
| `layer`       | visual    | ✓ | ✓ | OR:260                           | VisualizerGraph:280 (LayerNode)  | — | ✗ | — |
| `imageFX`     | visual    | ✓ | ✓ | OR:190                           | VisualizerGraph:343 (ImageFXNode)| OIC:847 | ✗ | — |
| `vfxCRT`      | visual    | ✓ | ✓ | default text label (no branch)   | VisualizerGraph:359 (VfxCrtNode) | generic message (VG:598) | ✗ | — |
| `vfxBlur`     | visual    | ✓ | ✓ | default text label (no branch)   | VisualizerGraph:365 (VfxBlurNode)| generic message (VG:609) | ✗ | — |

Abbreviations: **OR** = `src/canvas/ObjectRenderer.ts`, **OIC** = `src/canvas/ObjectInteractionController.ts`, **VG** = `src/runtime/VisualizerGraph.ts`.

---

## Gaps surfaced by this pass

### Reference docs
20 of 21 object types have no `docs/objects/<type>.md`. Only `message.md` exists. Backfilling these is a prerequisite for Part 5 (Reference tab) and is tracked in Part 4 of `EVALUATION_PLAN.md`.

### Renderer branches
`scale`, `vfxCRT`, and `vfxBlur` render as plain text labels only. That is currently intentional — they are message-processing nodes with no state worth visualizing — but future UI on any of them (e.g., a live value readout for `scale`) will require a new branch.

### Runtime drift
None detected. Every audio/video object type has a matching runtime node class. Every runtime node switch/dispatch handles at least the selectors declared in its `OBJECT_DEFS.messages` array.

### Registry/allowlist sync
`OBJECT_DEFS` and `VALID_TYPES` are currently in perfect sync (both list the same 21 types). The Part 4.3 CI lint is still worth adding because that parity is enforced only by human review today.

### Tests
No test infrastructure exists in the repo (no vitest/jest config, no `*.test.ts` files, no `tests/`). Smoke-testing is manual at present. Adding even a single round-trip serialize→parse test per object would catch a large class of future regressions cheaply.
