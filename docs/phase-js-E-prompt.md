# Phase E — `js~` Effect Library + Lock

**Read first:** `CLAUDE.md`, `AGENTS.md` (Project State + the Phase A / A.5 / B / D entries for `js~`), `docs/JS_OBJECT_PLAN.md`, `DESIGN_LANGUAGE.md`.

Two related features in one phase:
1. **Per-patch effect library** — saved effects reachable from a dropdown on the object header. Optional global (localStorage) library shared across patches.
2. **Lock / unlock** — toggle to disable code editing + dropdown so the object can be dragged from anywhere on its body. Sliders stay interactive in both states.

**Locked-in decisions from chat before you start coding:**
- Default `locked` = 0 (unlocked). User explicitly unlocks to drag.
- Effect names derived from `desc:`. No desc → save dialog prompts for a name.
- Rename / delete buttons live in the dropdown *and* in a dedicated "manage library" popup dialog.
- Library scope: per-patch primary, global (localStorage) secondary. Each entry carries an explicit scope.

---

## Data model

Extend `js~` args:

| idx | name | type | default | description |
|---|---|---|---|---|
| 0 | `code` | symbol, hidden, base64 | `""` | current active JSFX source (existing) |
| 1 | `library` | symbol, hidden, base64 | `""` | JSON array of `{name, code}` — per-patch entries |
| 2 | `locked` | int, hidden | `"0"` | "0" unlocked, "1" locked |

Serialiser (`src/serializer/serialize.ts`) already base64-encodes `args[0]` for `js~`. Extend the same encoding to `args[1]` (but NOT `args[2]` — it's a plain int). Parser mirror in `src/serializer/parse.ts`.

### Global library

Stored in `localStorage` under the key `patchnet-js-global-library` as JSON:
```ts
type GlobalLibraryEntry = { name: string; code: string };
type GlobalLibrary = GlobalLibraryEntry[];
```

New module `src/runtime/jsfx/library.ts`:
- `getPatchLibrary(node: PatchNode): LibraryEntry[]` — decode args[1]
- `setPatchLibrary(node: PatchNode, entries: LibraryEntry[]): void` — encode args[1], emit `change` on the graph so autosave flushes
- `getGlobalLibrary(): GlobalLibraryEntry[]`
- `setGlobalLibrary(entries: GlobalLibraryEntry[]): void`
- `broadcastPatchLibrary(graph, entries)` — walk every `js~` node and set args[1] to the same JSON so all objects stay in sync

Each library entry is typed:
```ts
interface LibraryEntry {
  name: string;
  code: string;  // raw JSFX source (not base64)
  scope: "patch" | "global";  // used only in the UI display; storage scope is implicit
}
```

At render time the Panel merges `getPatchLibrary(node)` + `getGlobalLibrary()` into a single sorted list, tagging each with its scope. `scope` is not serialised — it's derived from which bucket the entry came from.

---

## UI changes

### 1. Header becomes a dropdown trigger

Current header in `JsEffectPanel.ts` is a static `.pn-jseffect-title` div. Replace with a `<button>`:

```
[ ▾ js~ — <desc or "no effect"> ]       [ save... ] [ manage... ] [ 🔒 ]
```

- Click the title area → opens dropdown below the header
- "save..." button → inline prompt for name (pre-filled with `desc:` text) + scope radio (patch / global) → confirm saves to library
- "manage..." → opens the library manager dialog (see §3)
- Lock button (far right) → toggles `args[2]`

### 2. Dropdown menu

Absolute-positioned popover anchored under the header. Closes on outside click / Escape. Items:

```
— saved effects (patch) —
  1175 Compressor              [ ✎ ] [ × ]
  avocado glitch               [ ✎ ] [ × ]
  Simple Gain Utility          [ ✎ ] [ × ]
— saved effects (global) —  ⌂
  Simple Gain Utility          [ ✎ ] [ × ]
  Tilt EQ                      [ ✎ ] [ × ]
— actions —
  ⭑ save current to library…
  ⚙ manage library…
```

- Combined list sorted alphabetically within each scope section
- ⌂ glyph on global header distinguishes from per-patch
- Clicking an entry row loads that code into the editor (same path as pasting fresh code — debounced compile runs)
- `✎` → inline-rename row (replace row with text input until Enter/Escape)
- `×` → delete (confirmation for library entries — a simple `confirm()` is fine)

Empty-state text when library is empty: `no saved effects — click "save current to library…"`.

### 3. Manage library dialog

A modal overlay (mirror `ImageFXPanel` pattern — that's the project's existing modal pattern). Full-library view split into two columns: patch / global. Each row = effect name + actions:

- **Rename** (inline text input)
- **Delete** (confirm)
- **Move to patch / Move to global** (copies between scopes)
- **Export as file** (download per-entry `.jsfx` file — optional, Phase E.5 fine)

Esc / backdrop click closes.

### 4. Lock button

Top-right of the header. Same `LOCK_ICON_SVG` constant `ObjectRenderer` already exposes (it's been added to that file — reuse don't redeclare). Toggle flips `args[2]` and emits `"change"` for autosave.

Lock state styling:
- **Unlocked** (default): everything interactive as today
- **Locked**:
  - `.cm-editor` → `pointer-events: none`
  - `.pn-jseffect-header` (dropdown trigger, save/manage buttons) → `pointer-events: none`
  - `.pn-jseffect-slider-range` → `pointer-events: auto !important` (always live)
  - Lock button itself → always `pointer-events: auto !important`

Set the body-level data attribute so CSS can target scoped rules:
```ts
body.dataset.locked = node.args[2] === "1" ? "1" : "0";
```
Same pattern as `patch-object-dmx-body[data-locked="1"]`.

**DragController**: when `data-locked="1"`, drag-from-anywhere-on-body-except-sliders should work. Easiest: keep the existing allowlist for `.pn-jseffect-panel-host` as no-drag, BUT add an *override* — when the closest `.patch-object-jseffect-body[data-locked="1"]`, DO drag (skip the panel-host allowlist for this object type). Add a check at the top of `handleMouseDown`:

```ts
const jsLocked = target.closest<HTMLElement>('.patch-object-jseffect-body[data-locked="1"]');
// ...later in the allowlist chain...
if (target.closest(".pn-jseffect-slider-range")) return;  // slider stays interactive
if (target.closest(".pn-jseffect-panel-host") && !jsLocked) return;  // only no-drag when unlocked
```

---

## Implementation split

Work in this order. Each sub-phase is a reviewable unit; the commits should roughly follow this boundary.

### E.1 — lock scaffolding (~1 hour)
- Add `args[2] = locked` to OBJECT_DEFS and defaults
- Lock button in `JsEffectPanel` header (top-right)
- CSS rules for locked state
- DragController override for js~
- "Always-interactive slider" behaviour verified

### E.2 — library save/load (patch scope) (~2 hours)
- `src/runtime/jsfx/library.ts` new module: patch-lib encode/decode, broadcast helper
- Serialiser round-trip for args[1]
- Header becomes a dropdown trigger; dropdown renders patch library sorted
- Inline save prompt (button → prompt → append to args[1] + broadcast)
- Rename / delete in dropdown rows
- Selecting an entry loads code into editor

### E.3 — global library + manage dialog (~2 hours)
- localStorage read/write in `library.ts`
- Dropdown grows a "global" section; entries merged + scope-tagged
- Save prompt gains scope radio (patch / global)
- New `src/canvas/JsEffectLibraryDialog.ts` — modal overlay built on the `ImageFXPanel` pattern
- Move-to-patch / move-to-global actions
- Dialog opened from the header "manage…" button AND from the dropdown footer

### E.4 — (optional, if time permits) export/import
- Per-entry "download as .jsfx" button in the dialog
- "Import .jsfx file…" button in the dialog → reads a text file, prompts for name, adds to chosen scope
- Bulk export/import of entire library as JSON

---

## Out of scope for Phase E

- Global library sync across tabs in real time (`storage` event listener — nice but not needed for v1)
- Per-effect metadata beyond name (tags, description, author, version)
- Search/filter within the dropdown
- Keyboard shortcuts for cycling through library entries
- Publishing effects to a shared online library

---

## Smoke test (Director will grade against)

1. Fresh `js~` object, paste the Stillwell 1175 code. Status reads `compiled · 6 sliders`.
2. Click "save…" → prompt shows `1175 Compressor` pre-filled → accept with "patch" scope → dropdown now shows `1175 Compressor` under "saved effects (patch)".
3. Paste the avocado code. Save as `avocado` to patch scope.
4. Click header → dropdown lists `1175 Compressor` and `avocado` alphabetically. Click `1175 Compressor` → editor swaps, compiler re-runs, sliders re-render.
5. Save → reload the patch → both library entries restored, code picks up where it was.
6. Drop a second `js~` on the canvas. Its dropdown should immediately show the same two effects (cross-`js~` sync via broadcast).
7. Save an effect to **global** scope → reload page (full refresh) → open a blank new patch → add a `js~` → that global effect appears in its dropdown.
8. Manage dialog → rename an effect → both dropdown and on-canvas header update.
9. Lock button → code editor becomes non-interactive → try to drag by clicking on the editor area → object moves. Try to drag by clicking a slider → slider scrubs, object doesn't move.
10. Unlock → code editor interactive again. Everything as before.

---

## Deliverable format

Append a COMPLETED entry to `AGENTS.md` with the usual shape. Note any deviations from this prompt. If E.4 (export/import) is cut for time, mark it explicitly in "deferred" — not "done".
