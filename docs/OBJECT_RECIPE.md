# patchNet Object Recipe

A numbered checklist for adding a new object type. Follow each step in order.
Every step cites the file to touch. If a step does not apply to your object, skip and note why in the commit message.

Last updated: 2026-04-17

---

## Prerequisites

- Know what your object does in one sentence. If you can't, stop and write that sentence first.
- Know its category: `ui` / `control` / `audio` / `scripting` / `visual`.
- Know its inlets + outlets (number, port types).
- Know its arguments (positional creation args).
- Read `docs/object-spec-standard.md` once — it defines the contracts your code will implement.

---

## 1. Spec

Add an entry to `OBJECT_DEFS` in `src/graph/objectDefs.ts`.

Required fields: `description`, `category`, `args`, `messages`, `inlets`, `outlets`, `defaultWidth`, `defaultHeight`.

- `description` — one-line summary (shown in the Reference tab)
- `args` — array of `ArgDef` with `name`, `type`, optional `default`, `min`, `max`, `step`, `description`, `hidden`
- `messages` — array of `MessageDef` with `inlet`, `selector`, `description`, optional `args`
- `inlets` / `outlets` — array of `PortDef` with `index`, `type`, optional `label`, `temperature`, `side`

Patterns to follow:
- Hot inlet (causes output on receipt) → `temperature: "hot"`.
- Cold inlet (stores only, no output) → `temperature: "cold"`.
- If a port is any of `bang | float | any | symbol | signal | media | message`, set that as the `type`.
- Hidden args (internal state that shouldn't appear in the attribute panel) → `hidden: true`.

---

## 2. Entry-box allowlist

Add the type string to `VALID_TYPES` in `src/canvas/ObjectEntryBox.ts`.

Keep `VALID_TYPES` alphabetically sorted. The `n`-key object-entry autocomplete reads directly from this list.

**Drift check:** `OBJECT_DEFS` keys and `VALID_TYPES` must stay identical. Part 4.3's CI lint enforces this. Until it lands, do the check by eye after any add/remove.

---

## 3. Renderer branch

Open `src/canvas/ObjectRenderer.ts` and extend the `buildBody()` switch.

Decisions:
- **Text-labeled only** (just shows the object name): no branch needed — the default fallthrough at line 295 handles it.
- **Has custom visuals** (glyph, slider track, numbox digits, etc.): add an `else if (node.type === "yourtype")` branch.
- **Falls in the media/visualizer group**: extend the shared branch at line 245 (`visualizer | mediaVideo | layer`).

If your object has new UI, also:
- Add a stable CSS slug: `.patch-object-yourtype` (the renderer auto-generates this from `node.type.replace(/[^a-z0-9]+/gi, "-")`).
- If the object is in a new category not yet handled by `renderObject()`, add the class toggle at line ~384.

---

## 4. Interaction

Open `src/canvas/ObjectInteractionController.ts` (OIC).

Add handling for any of:
- **`handleMouseDown` branch** (OIC:126) — for drag-driven UI (slider, numbox-style objects).
- **`handleClick` branch** (OIC:173) — for click-driven actions (button, toggle, message, visualizer-open).
- **`deliverMessageValue` branch** — for any inlet that accepts typed values from upstream.
- **`deliverBang` branch** — for any inlet that responds to bang.

Rules:
- Write to `node.args` only via `graph.setNodeArg` — this emits the `change` event that keeps the text panel + renderer in sync.
- Call `dispatchBang(nodeId, outlet)` or `dispatchValue(nodeId, outlet, value)` to emit on an outlet.
- Hot inlets trigger output after storing. Cold inlets store only.

If the object has an editable inline text field (like `message`), mirror the pattern in `handleMessageClick` + `startMessageEdit` — don't invent a new one.

---

## 5. Runtime node (audio / video only)

If your object produces or consumes signal / media, add a runtime class.

- **Audio** → subclass pattern in `src/runtime/` (see `ClickNode.ts`, `DacNode.ts`), then register in `AudioGraph.ts` inside the `syncNodes()` switch around line 61.
- **Visual** → subclass in `src/runtime/` (see `MediaVideoNode.ts`, `VfxCrtNode.ts`), then register in `VisualizerGraph.ts` inside `syncNodes()` around line 234.

Runtime nodes are responsible for:
- Creating + teardown of Web Audio / canvas resources in constructor + `destroy()`.
- Implementing any typed setter methods that the runtime-graph message dispatcher will call (e.g. `setLoop(on)`, `seek(t)`).

Do NOT bind DOM events in runtime nodes — they should be DOM-agnostic.

---

## 6. CSS (if new UI)

Add scoped styles to `src/shell.css`.

- Selector: `.patch-object-yourtype { … }` or `.patch-object[data-node-type="yourtype"] { … }`.
- Colors: **only** `--pn-*` CSS custom properties from `src/tokens.css`. See Design Rule 3 in `CLAUDE.md`.
- For tinted borders / glows, use `color-mix(in srgb, var(--pn-accent) X%, var(--pn-border))` — this is the house style.
- Glows via `box-shadow` can use `rgba(…)` when the opacity value is what matters — but prefer `color-mix(…, transparent)` where possible.

Before committing, grep your own diff for `#` followed by hex digits. Any match is a Design Rule 3 violation.

---

## 7. Reference page

Create `docs/objects/<type>.md` using `docs/objects/_TEMPLATE.md` as a starting point.

Required sections:
1. YAML frontmatter (`type`, `category`, `version`)
2. One-line description
3. Arguments table
4. Inlets table
5. Outlets table
6. Messages table
7. Examples (at least one `#X obj` patch snippet)
8. Notes (gotchas, Max/MSP deltas, related objects)

Once the Reference tab lands (Part 5), this page is what the user sees when they select your object on the canvas.

---

## 8. Smoke test

In the browser (`npm run dev`):

1. Open the app.
2. Use the context menu or `n`-key entry box to place your new object.
3. For each inlet: send a bang or a value from a `button` / `slider` / `message` and verify the expected behavior.
4. For each outlet: connect to a `message` box and verify the output.
5. Save the patch (auto-persists to localStorage). Reload the page. Verify the object reappears with the same args and state.
6. If the object has audio / video runtime: enable DSP / open the visualizer popup and confirm the signal / frame arrives.

Round-trip is the one test that catches 80% of first-commit bugs:

- Place object
- Edit one arg
- Serialize (inspect the text panel)
- Clear the patch
- Paste the serialized text back into the text panel
- Confirm object renders with the same args

---

## After you ship

- Append a completion entry to `AGENTS.md` following the existing format.
- If your object introduced a new category or a new design-token, note it in `DESIGN_LANGUAGE.md`.
- Consider whether Part 4.3's CI lint (`npm run lint:objects`) needs an update to cover any new constraint your object type introduces.

---

## Quick-reference: current 21 object types

See `docs/objects/INVENTORY.md` for the full coverage matrix (spec / renderer / runtime / interaction / reference-doc / tests).
