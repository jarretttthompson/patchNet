# patchNet — Agent Communication & Changelog

This file is the shared communication channel for all agents working on patchNet.
**All agents must read this before starting work and append an entry after completing work.**

Director: Claude Code
Second in Command: Cursor
Team: Cursor (canvas/UI), Codex (audio/runtime), Copilot (inline acceleration)

---

## How to Use This File

### Before starting any task:
1. Read all entries below to understand current project state
2. Check what phase is active in `PLAN.md`
3. Note any BLOCKER entries that affect your work

### After completing any task, append an entry in this format:

```
---
## [YYYY-MM-DD] COMPLETED | <task name>
**Agent:** Cursor | Codex | Claude Code | Copilot
**Phase:** Phase N — <phase name>
**Done:**
- bullet list of what was completed

**Changed files:**
- path/to/file.ts — what changed

**Notes / decisions made:**
- any architectural decisions or deviations from PLAN.md

**Next needed:**
- what the next agent or task needs to do
---
```

### When blocked, append a BLOCKER entry:

```
---
## [YYYY-MM-DD] BLOCKER | <description>
**Agent:** <who is blocked>
**Blocking:** <what task is stopped>
**Details:** <what the problem is>
**Needs:** <what is required to unblock>
---
```

---

## Project State

**Current Phase:** DMX Phase 4 landed (reconnect/backoff + auto-reconnect + orphan repoint + profile file I/O + home/blackout shortcuts); Phase 3.5 hardware-verified (inline); Control/Render Split Phase 1 landed + Evaluation Plan Parts 1, 2, 4 still in flight
**Active tasks:** Control/Render Split Phase 1 scaffolding landed (see `docs/CONTROL_RENDER_SPLIT.md`); `deliverPatchVizMessage` migrated to bus as proof path. Phase 2 gated on test infra (resolves BLOCKER-1). Evaluation Plan: Part 1.1/1.2/1.3/1.5 landed; Part 1.4 deferred (BLOCKER-2); Part 2.1 landed; Part 4 recipe + 3 of 21 ref pages landed. Persistence refactor landed earlier.
**Last updated:** 2026-04-19 by Claude Code

---

## Architecture Decisions Log

Agents: append here when making a decision that affects the whole project.

### 2026-04-16 — Claude Code
- **Cable rendering:** Straight SVG lines (not bezier). PD-style. This is non-negotiable per product spec.
- **No React in v1:** Vanilla DOM + TypeScript only. Canvas interaction requires direct DOM control; a vdom layer adds friction. Revisit after v1 if needed.
- **Audio in v1 is not sample-accurate:** `metro` uses `setInterval`, not the Web Audio clock. Good enough for v1 UX. Phase 3+ can upgrade to `AudioWorklet`-based scheduling.
- **Serialization format:** PD-inspired `#X obj x y type [args...]` lines. Human-readable, not JSON. Lets the text panel feel like real code.
- **Object size defaults:** See `DESIGN_LANGUAGE.md`. Objects are fixed-size rectangles in v1; resizable objects are a future feature.
- **No framework for text panel in v1:** Plain `<textarea>` with CSS styling. CodeMirror or Monaco is a Phase 4+ upgrade.

---

## Changelog

Older entries archived to `AGENTS-archive.md`.

---
## [2026-04-22] COMPLETED | dmx object — Phase 4 (robustness + recovery)
**Agent:** Claude Code
**Phase:** DMX Phase 4 — Reconnect-with-backoff, auto-reconnect, orphan repoint, profile file I/O, universe shortcuts
**Done:**
- **Reconnect-with-backoff in transport** (`EnttecProTransport`): write errors and `disconnect` events no longer terminate to `error` directly. If a port was ever successfully selected (`info` is present), transport switches to `reconnecting`, starts a 2s-interval loop that calls `reacquire(vid, pid)` + `port.open()` + `getWriter()` + resume frame loop. Gives up after 30s → `error`. User-initiated `stop()` cancels the reconnect loop. Overlapping-async guard (`this.reconnecting` flag) so setInterval doesn't fire a new attempt on top of a pending one. Frame counter is cumulative across reconnects so users can see transmission resume.
- **Auto-reconnect on patch load**: when `DmxGraph.sync` creates a fresh `DmxNode` whose persisted args[2] (`open`) is `"1"`, it fires `dmx.autoReconnect(vid, pid)`. That calls `transport.reacquire(vid, pid)` — which uses `navigator.serial.getPorts()` and does NOT require a user gesture — and if the port reappears in the granted list, invokes `connect()`. Fails silently with a log entry if permission wasn't granted or the device isn't plugged in. One-click reload-and-resume workflow for patches that were previously connected.
- **Orphan repoint**:
  - `Patch.repoint(name, newProfileId)` — new method with full re-validation. Resolves the new profile, checks the channel span fits in 1..512, and runs byte-level overlap detection against every OTHER instance. Returns a typed `PatchError` on failure; the instance's `profileId` is swapped only on success.
  - `DmxNode.repointFixture(name, newProfileId)` + message selector `repoint <name> <newProfileId>` for patch-driven flows.
  - **Inline UI on orphan rows**: "repoint…" button swaps itself for a native `<select>` listing every available profile; picking one immediately calls repoint and either refreshes the row (no more ⚠) or reports overlap in the status line. Unpatch remains available on orphans as a fallback.
- **Profile file I/O** (Profiles tab):
  - "export user profiles" downloads `patchnet-dmx-profiles-YYYY-MM-DDThh-mm-ss.json` containing the user-profile array (pretty-printed). Nothing happens if there are no user profiles; the status line says so.
  - "import from file…" opens a native file picker, accepts both a single-profile object and an array; bulk-upserts through `importProfile` (reusing all the Phase 2 validation). Result: `imported N, failed M: <first error>` in the status line.
- **Universe shortcuts** on the Patch tab: "home all" invokes `allFixturesDefaults()`; "blackout all" invokes the universe-wide `blackout()`. Same semantics as the `defaults` (no arg) and `blackout` messages but one-click from the panel.
- **Inlet label** on `OBJECT_DEFS.dmx` updated with the `repoint` selector; message spec catalogued.
- `tsc --noEmit` clean. `npm run build` clean (661 KB, +6 KB over Phase 3.5).

**Changed files:**
- src/runtime/dmx/EnttecProTransport.ts — reconnect loop + backoff + overlapping-async guard
- src/runtime/dmx/Patch.ts — repoint() with overlap re-validation
- src/runtime/DmxNode.ts — autoReconnect(), repointFixture()
- src/runtime/DmxGraph.ts — fires autoReconnect on node creation when args[2]==="1"
- src/canvas/ObjectInteractionController.ts — repoint dispatch
- src/canvas/DmxPanel.ts — orphan repoint inline flow, export/import file handlers, home/blackout shortcuts
- src/graph/objectDefs.ts — repoint message spec
- src/shell.css — shortcut row + inline-select sizing
- AGENTS.md — this entry + header

**Notes / decisions made:**
- **Reconnect policy**. Only entered when transport already had a successfully-selected port. Fresh-install "no device" → `error` stays terminal so we don't spin on `getPorts()` forever when there's nothing to reconnect to. 30s timeout is arbitrary but matches the "user notices and unplugs the cable" horizon; past that point the patch should reflect the stuck state rather than keep retrying silently. Can raise/lower via constants if hardware reality demands it.
- **Auto-reconnect only via VID/PID match**. Safer than grabbing the first granted port — if the user has multiple serial devices, we'd otherwise potentially open a non-DMX one. VID/PID is the best signal we have without probing the device.
- **Silent auto-reconnect by design**. Web Serial does NOT require a user gesture for `port.open()` on a previously-granted port, only for `requestPort()`. So patch-reload → connected-without-click is actually standards-compliant, not a hack. Users who never granted permission on a fresh browser still see the normal manual-connect flow.
- **Repoint keeps start address**. Changing a fixture's profile without moving its DMX address preserves cabling/DIP-switch state. If the new profile's channel count overflows the universe or overlaps another fixture, the operation fails cleanly — user can shrink or move the other fixture first.
- **Export format matches import format**. Exported JSON is a bare array of FixtureProfile objects. Import accepts the same shape OR a single profile — round-trippable between machines with no wrapper schema.
- **Home/blackout as inline buttons vs. message selectors**. Both forms exist: the Patch tab buttons are for user convenience while building a patch; the message selectors (`defaults`, `blackout`) are for patch-driven automation (e.g., a `button → message defaults` to home everything from a control surface). Buttons wrap the same DmxNode methods the message path uses — no duplicate logic.

**Next needed (user smoke test):**
- **Reconnect**: connect, then yank the USB cable → panel status goes to "reconnecting" (amber pulsing dot). Re-seat the cable → status goes green within ~2s, frames resume. Let it time out: unplug and leave for 30s → status goes red with "Reconnect timed out after 30s". Reseat + click connect → manual reconnect works.
- **Auto-reconnect**: with a connected patch, reload the page. The dmx panel should initialize, log "Auto-reconnect: reacquired 0403:6001", and the status dot should go green within a second — no user action needed. On a fresh browser/incognito (no Web Serial permissions), the log should say "Auto-reconnect skipped" and the normal connect flow works.
- **Orphan repoint**: in the Profiles tab, delete a user profile that spot1 is patched on → Patch tab shows spot1 with ⚠. Click "repoint…" on that row → pick a different profile → row becomes non-orphan, fixture still lives at the same start address. If the new profile overlaps spot2, error surfaces and row stays orphaned.
- **Profile file I/O**: edit a user profile or duplicate a bundled one, then "export user profiles" → a JSON file downloads. On another browser or private session, "import from file…" → pick that JSON → profiles appear in the list. "Import from file" also accepts a single profile object (not just arrays).
- **Shortcuts**: "home all" on the Patch tab writes defaults to both spot1 + spot2 (fixture centers, dimmer 0). "blackout all" zeros the universe.

**Deferred to Phase 5:**
- Multi-universe support (Art-Net/sACN transport backends, universe arg on instances).
- Scene/preset save + recall.
- Fades (`fade spot1 dimmer 0 255 500ms`) and chases.
- MIDI mapping integration.
---

---
## [2026-04-22] COMPLETED | dmx object — Phase 3.5 (inline panel, no popup)
**Agent:** Claude Code
**Phase:** DMX Phase 3.5 — In-object GUI (no double-click modal)
**Done:**
- **DmxPanel refactored to mount inline**: dropped the overlay/modal/close/Esc scaffolding; the panel is now a single `.pn-dmx-panel` root that fills its host element. New `attach(host)` / `detach()` / `destroy()` replace `open()` / `close()`. `attach` is idempotent and re-parents the existing root when called on a new host, preserving all internal state (selected tab, profile editor working copy, log scroll position) across graph re-renders.
- **DmxPanelController** (`src/canvas/DmxPanelController.ts`): mirrors CodeboxController. Holds a `Map<nodeId, DmxPanel>`. `mount(panGroup)` walks every dmx node, ensures a panel exists, and attaches it into the `[data-dmx-panel-host]` slot emitted by ObjectRenderer. `prune(activeIds)` destroys panels whose nodes disappeared.
- **ObjectRenderer.dmx branch** reduced to ~5 lines: a single `pn-dmx-panel-host` div with `data-dmx-panel-host=<nodeId>`. The controller fills it during the same render pass. Old status dot + device line + rate line removed (the Device tab already shows them, and the frame counter moved to the Device-tab status label).
- **DmxGraph simplified**: removed `mountBodies`, `paintBody`, `repaintAll`, `framePaintInterval`, `bodyListenerUnsubs`, `panGroup` field — ~70 lines gone. DmxGraph is now purely a lifecycle manager; live-state paint is the panel's job.
- **Frame counter moved into Device tab status line**: shows `connected · 40 Hz · 1459f` inline. A 2 Hz panel-internal timer drives the tick while attached; it's torn down on detach/destroy so panels in non-rendered graphs don't burn cycles.
- **DmxPanel wheel + mousedown swallow**: `stopPropagation` on the root prevents canvas pan/zoom when scrolling the log, profiles list, or patch table. `mousedown` stop prevents stray drag-init from panel surfaces (belt + suspenders on top of the drag allowlist).
- **DragController allowlist**: added `.pn-dmx-panel-host` as a no-drag region. Also added generic `SELECT`/`TEXTAREA`/`BUTTON` tagName exemptions (previously only `INPUT` was exempt — would've broken the panel's selects and buttons). Object can still be dragged from the top/bottom port stripes and outer border.
- **ObjectInteractionController**: removed the dmx dblclick branch (no popup to open) and the `DmxPanel` import.
- **OBJECT_DEFS.dmx** default size bumped from 160×72 to 560×520 so the inline panel fits without immediate resize. Object remains resizable via the standard resize handle.
- **main.ts**: new `DmxPanelController` instantiated after `DmxGraph`; `mount` + `prune` called inside the existing render() hook; destroyed on beforeunload.
- `tsc --noEmit` clean. `npm run build` clean (~655 KB — actually smaller than Phase 3 because the paintBody machinery is gone).

**Changed files:**
- src/canvas/DmxPanel.ts — overlay stripped; buildRoot replaces buildOverlay; attach/detach/destroy
- src/canvas/DmxPanelController.ts — new
- src/canvas/ObjectRenderer.ts — dmx branch reduced to a host slot
- src/canvas/ObjectInteractionController.ts — dmx dblclick removed; DmxPanel import removed
- src/canvas/DragController.ts — SELECT/TEXTAREA/BUTTON + .pn-dmx-panel-host allowlist
- src/runtime/DmxGraph.ts — body-paint machinery removed; pure lifecycle manager
- src/graph/objectDefs.ts — dmx default size 560×520; inlet label updated with Phase 2/3 selectors
- src/main.ts — DmxPanelController wiring + mount/prune in render + destroy on unload
- src/shell.css — overlay/modal rules removed; inline panel-host styles; `.pn-dmx-tab-body` max-height dropped (now flexes to fill)
- AGENTS.md — this entry + header

**Notes / decisions made:**
- **Persistent instance across re-renders.** PatchNet's render() nukes `.patch-object` elements and rebuilds them on every `change` emit, which would destroy any DOM-owned state (editor inputs, selected tab, scroll position). The controller pattern — instance in a map, re-parented on each mount — is the established PatchNet idiom (see CodeboxController) and was the only clean way to make an inline complex panel survive patch-level mutations.
- **Drag grab points.** With the panel filling the body, there's no internal "drag surface". Users drag the object via the port stripes (top/bottom) or outer border — same as codebox, which has the same shape. Tested by eye; adequate. A dedicated drag handle can be added later if it proves finicky.
- **Wheel stopPropagation.** The canvas uses wheel for pan/zoom. Without the stop, scrolling inside the log would jump the canvas view. Stopping propagation on the panel root covers every scrollable child (log, profile list, patch table, profile import textarea) without needing per-region handlers.
- **No dedicated title bar.** Considered adding a thin header strip showing "dmx" + optional collapse-to-compact-view button. Dropped: the tab strip already labels the context (device/profiles/patch/monitor), and a title adds vertical space without adding info. If a "minimize to a thin strip" mode is wanted later, it's a few lines on top of this scaffolding.
- **Frame counter in status line, not a separate badge.** Phase 1/2/3 showed frames on the object body; now that the Device tab is always visible, putting it in the status label keeps the single-line status row informative without adding UI chrome.

**Next needed (user smoke test):**
- Existing `dmx` objects from saved patches load with the inline panel populated. Patch tab shows spot1/spot2. Device tab shows connected status + frame counter.
- Adding a fresh `dmx` object places a 560×520 block on the canvas with all four tabs working.
- Drag from the port stripe or outer border moves the object. Resize handle still works.
- Scroll wheel inside log / profile list / patch table does NOT pan the canvas.
- Profile editor mid-edit: add a row, switch to Patch tab, switch back — working copy intact.
---

---
## [2026-04-22] COMPLETED | dmx object — Phase 3 (setall + profile editor + monitor tab)
**Agent:** Claude Code
**Phase:** DMX Phase 3 — Attribute-role control, structured profile editor, live monitor, orphan detection
**Done:**
- **`setall <attr> <value>`** — new `Patch.writeAll(attr, value)` iterates every patched (unmuted) fixture whose profile has an attribute with that name and writes to it. `DmxNode.writeAllFixtures` returns the touched count; controller emits it through outlet 1 as `setall <attr> <n>` so patches can branch on "was there anything to drive?". Logs a one-liner only when no fixture matched.
- **`defaults` no-arg form** — previously required a fixture name; now with no args writes profile defaults for every patched fixture. Returns `defaults <n>` on outlet 1. Matches the "home" ergonomics expected from lighting consoles.
- **Orphan-instance detection** — `Patch.buildPatchRow` receives a `profileResolved` flag; orphaned rows get a ⚠ glyph on the profile id, a tooltip explaining the state, and a `data-orphan="true"` style treatment. Fixture is still unpatch-able from the row actions. Pairs with the Phase 2-late `logWriteError` rate-limited log so silent failures now have both a visual and written trace.
- **Structured profile editor** — user profiles gain an inline editor on the Profiles detail pane:
  - Profile-name input + immutable id readout + channel-count input
  - Attribute-row grid with per-row name, type (8bit/16bit dropdown — toggling clears fineOffset), offset, fineOffset (auto-disabled for 8bit), default, role dropdown (17 options), and remove button
  - Add-row button picks the next contiguous offset automatically
  - Save runs the full `validateProfile` gauntlet; errors surface inline above the footer and block the save
  - Cancel discards the working copy and re-renders the read-only view
  - Bundled profiles are read-only but gain a "duplicate as user profile" button that clones them with a unique id (`<id>-copy`, `-copy-2`, …) and opens the clone in edit mode — the canonical path to tweak a bundled layout without shipping new code
- **Monitor tab** — 4th tab in the Device panel. Fixed 512-cell grid (64 cols × 8 rows) built once on tab open; paint loop runs at 4 Hz (`setInterval(250ms)`) while the tab is active and is torn down when the user switches away or closes the panel. Each cell's background intensity is driven by a CSS custom property `--pn-mon-v` mapped to the byte value / 255; claimed cells get a subtle outline so bare bytes recede. Hover tooltip shows `ch N = V · fixtureName`.
- **OBJECT_DEFS.dmx** gains the `setall` selector for autocomplete / spec discovery.
- **Bundle**: 656 KB (+10 KB over Phase 2). tsc + vite both clean.

**Changed files:**
- src/runtime/dmx/Patch.ts — writeAll(), allFixturesDefaults()
- src/runtime/DmxNode.ts — writeAllFixtures(), allFixturesDefaults()
- src/graph/objectDefs.ts — setall selector
- src/canvas/ObjectInteractionController.ts — setall + defaults-all dispatch
- src/canvas/DmxPanel.ts — monitor tab (build+paint+lifecycle), profile editor (enter/exit/save/cancel/duplicate), orphan flag on patch rows, AttributeRole enum copy for role selector
- src/shell.css — monitor grid (CSS-var-driven brightness), editor row grid, orphan row styling
- AGENTS.md — this entry + header

**Notes / decisions made:**
- Monitor repaint runs at 4 Hz, not 40 Hz: repaint cost is ~512 DOM writes plus a snapshot copy; at 40 Hz that's enough to jitter the DMX tick on slower hardware. 4 Hz is plenty for "is the value moving" diagnostic and keeps the refresh loop lightweight. Grid DOM is built once, not recreated per tick — only the `--pn-mon-v` custom property and `data-claimed` attribute change each paint.
- Editor state lives on the panel as `editorWorkingCopy` (a deep clone) so mid-edit changes don't corrupt the registry. Save calls `validateProfile` before upsert; if validation fails the working copy is preserved so the user can fix typos without losing state.
- `setall` matches on attribute NAME (exact), not role. Role-based setall (`setall :intensity 255`) is deliberately deferred: the name-only form covers the common case where the user's fixtures share a vocabulary, and role-matching adds a mental model ("which of my fixtures map intensity to a differently-named attr?") that's better surfaced in a future "broadcast" UI than shoehorned into selector syntax.
- Duplicate-as-user preserves the source's attributes verbatim (deep-cloned) and appends `-copy` to the id. Users can then rename, edit, or re-id as needed. The remove-user-profile path then restores the bundled version cleanly — the intended "safe sandbox for tweaking" workflow.
- Editor's role dropdown is sourced from a literal of the `AttributeRole` union kept in sync with the type — type-safe union, but still manual sync if the roles enum grows. Acceptable for the v1 set.

**Next needed (user smoke test):**
- Patch tab: confirm spot1 + spot2 rows still show clean (no ⚠) after Phase 3 reload.
- Send `setall dimmer 255` from a message box → both Chauvets should light (both profiles define `dimmer`).
- Send `defaults` (no arg) from a message box → both Chauvets center + dark (profile-default state).
- Profiles tab: click the bundled Chauvet 15ch → "duplicate as user profile" → editor opens on the clone; rename a role or tweak a default → save → row appears in list with "user" badge. Un-patch spot1, re-patch it on the clone, confirm commands still work.
- Monitor tab: open while sending `set spot1 dimmer 255` from a slider → watch cell 11 (dimmer byte) brighten as you drag. Cells outside the 15-byte fixture span (ch 16+) should stay dark.
- Orphan flow: open the Profiles tab, remove your user clone while a fixture is patched on it → flip to Patch tab → that row should now show ⚠; unpatch works regardless.

**Deferred:**
- Phase 4: reconnect-with-backoff, export-all-profiles-as-JSON-file, structured error outlet, migrate-orphan-to-other-profile UI flow.
- Phase 5: multi-universe, Art-Net/sACN transports, scenes, fades, chases.
---

---
## [2026-04-22] COMPLETED | dmx object — Phase 2 (profiles + patch + attribute control)
**Agent:** Claude Code
**Phase:** DMX Phase 2 — Fixture profiles + instance patching + `set <name> <attr> <value>` control
**Done:**
- **FixtureProfile schema** (`src/runtime/dmx/FixtureProfile.ts`): typed `FixtureProfile` / `AttributeDef` / `AttributeRole`. 8-bit and 16-bit channels (coarse + fine offsets). Validator with discriminated-union `ProfileValidationError` and `describeValidationError` for UI copy. 11 validation rules covering id format, channel count, attr-name regex, offset bounds, fine-offset requirements for 16-bit, default in range, and byte-level occupancy overlap detection.
- **FixtureRegistry** (`src/runtime/dmx/FixtureRegistry.ts`): per-dmx-node library. Bundled profiles are always-available; user profiles layer on top (user id can override bundled of the same id; `remove` restores bundled). Deep-clones on upsert so mutations don't corrupt state. Export-wholesale API for persistence round-trip.
- **Bundled profiles** (`src/runtime/dmx/bundledProfiles.ts`): 5 starters — `generic-dimmer-1ch`, `generic-rgb-3ch`, `generic-rgbw-4ch`, `generic-rgbaw-uv-6ch`, and `chauvet-intimidator-spot-375z-irc-13ch` (user's real fixture, 16-bit pan + tilt, 11 attributes including shutter/dimmer/focus/macro). Defaults keep dimmer at 0 so `defaults <name>` returns the fixture to a safe "centered + shutter open + dark" home.
- **Patch class** (`src/runtime/dmx/Patch.ts`): instance collection + write routing. `patch/unpatch/rename/setMuted/writeAttr/blackoutFixture/fixtureDefaults/occupancy`. Byte-level overlap detection. Typed `PatchError` union. 16-bit attr writes split into coarse/fine bytes automatically.
- **DmxNode API extensions** (`src/runtime/DmxNode.ts`): owns a `FixtureRegistry` + `Patch`. 11 new public methods delegating to them, plus `exportUserProfiles/exportInstances/loadUserProfiles/loadInstances` for arg round-trip. Writes via `writeFixtureAttr` deliberately do NOT log (hot path at 40 Hz would drown the log) — all other mutations log.
- **DmxGraph rehydration**: `sync()` reads `args[6]` (profiles) and `args[7]` (instances) as base64 JSON at node-creation time, loads profiles first (so instances can resolve their profileId).
- **OBJECT_DEFS.dmx** extended: two hidden args (`userProfiles`, `patches`) + six new message selectors. All message forms documented in the spec for autocomplete / attribute panel discovery.
- **ObjectInteractionController.deliverDmxMessage** extended with: `blackout [name]`, `defaults <name>`, `patch <name> <profileId> <addr>`, `unpatch <name>`, `rename <old> <new>`, `mute <name> 0|1`, `set <name> <attr> <v> [<attr> <v>…]`, `profile import <base64>|remove <id>|list`. After any mutation that changes profiles/instances, `persistDmxState` writes base64 JSON back to `args[6]`/`args[7]` and emits `display`.
- **DmxPanel** rewritten with 3-tab shell: **Device** (unchanged), **Profiles** (left list of bundled+user profiles with channel-map detail pane, textarea JSON paste import, per-user-profile remove button), **Patch** (instance table with mute/defaults/unpatch per row, 64×8 occupancy strip showing claimed bytes of the universe, add-fixture form with inline error surfacing).
- **shell.css** adds tab strip, profiles split view, patch table, occupancy grid, and form input styling — all via `--pn-*` tokens; no hardcoded colors.
- **Phase 1 polish**: `formatPortLabel` returns whitespace-free `"0403:6001"` instead of `"USB 0403:6001"`. Earlier label corrupted the tokenized serialization (the space broke the label across two args on round-trip).
- `tsc --noEmit` clean. `npm run build` clean (646 KB bundle, +28 KB for all of Phase 2).

**Changed files:**
- src/runtime/dmx/FixtureProfile.ts — new
- src/runtime/dmx/FixtureRegistry.ts — new
- src/runtime/dmx/Patch.ts — new
- src/runtime/dmx/bundledProfiles.ts — new
- src/runtime/dmx/EnttecProTransport.ts — label format fix
- src/runtime/DmxNode.ts — patch/profile delegation + rehydration API
- src/runtime/DmxGraph.ts — rehydrate profiles + instances from args
- src/graph/objectDefs.ts — userProfiles + patches args; 6 new message selectors in the spec
- src/canvas/ObjectInteractionController.ts — new selectors + persistDmxState helper
- src/canvas/DmxPanel.ts — full rewrite with 3-tab structure
- src/shell.css — panel tab styles
- AGENTS.md — this entry

**Notes / decisions made:**
- Persistence lives entirely in the dmx object's args (base64 JSON) — no localStorage coupling. Moving a .patchnet file to another machine carries profiles + instances with it. Trade-off: args grow with fixture count; for 50 fixtures the base64 payload is ~5 KB. Acceptable.
- Bundled profiles shipped as const, not persisted. User overrides layer on top and ARE persisted. `remove` on a user-override id restores the bundled version — a safe undo.
- Fixture name regex matches attr name regex (`/^[a-z][a-zA-Z0-9_-]*$/`) so patch syntax is consistent between `patch <name>` and `set <name> <attr>`.
- `set` is multi-attr in a single message: `set spot1 pan 32768 tilt 32768 shutter 255 dimmer 255`. Standard Max-style convention.
- `blackout` with no arg = universe zero; `blackout <name>` = one-fixture zero. `defaults` requires a name (whole-universe defaults would need a scene/preset which is Phase 3+).
- `writeFixtureAttr` is the hot path — deliberately does not pushLog so a `metro 25 → set dimmer $1` chain at 40 Hz doesn't flood. The Device log is for user-initiated actions and errors.
- Profile editor UI (structured channel-row editor) intentionally out of Phase 2 scope. Phase 2 accepts JSON-paste import only. Phase 3 adds the editor.
- Monitor tab (live 512-cell grid) also deferred to Phase 3.
- Attribute-based validation happens at write time (unknown fixture / attr / out-of-range value). Write errors flow to outlet 1 as `error <name>.<attr>` so patches can react programmatically.

**Hardware validation (2026-04-22, user's bench):**
- Two Chauvet Intimidator Spot 375Z IRCs patched as `spot1` + `spot2` on one `dmx` object, both driving end-to-end via the `chauvet-intimidator-spot-375z-irc-15ch` bundled profile.
- Channel layout for both Chauvet profiles (9ch + 15ch) reverified against the manual (`lightingManuals/Intimidator_Spot_375Z_IRC_UM_Rev7.pdf`) — corrected ch11 = dimmer / ch12 = shutter in 15ch (previously had them swapped; symptom was masked during Phase 1 because the smoke-test sent 255 to both). 9ch corrected to have no separate dimmer (shutter is the sole intensity control per the manual).
- One gotcha surfaced: deleting a bundled profile while an instance is still patched on it leaves the instance unresolvable and silently no-ops all writes. `writeFixtureAttr` now logs errors (rate-limited to once per 2s per unique key) so the failure mode is visible. User resolved by deleting the stale `dmx` object and starting fresh; long-term fix is a Phase 4 item (orphan-instance detection + one-click migrate).

**Next needed (user smoke test):**
- Reload page → `dmx` object remains. Open panel → Profiles tab → see 5 bundled profiles including "Chauvet Intimidator Spot 375Z IRC".
- Patch tab → add form: name=`spot1`, profile=`chauvet-intimidator-spot-375z-irc-13ch`, addr=1 → "patch". Row appears; occupancy strip shows 13 claimed bytes at the start.
- Device tab → connect. Then send to dmx inlet: `defaults spot1` — fixture should center, shutter open, dimmer off.
- Send: `set spot1 dimmer 255` — fixture lights at full.
- Send: `set spot1 pan 16384 tilt 49152 dimmer 128` — fixture moves, half-brightness.
- Test validation: try `patch spot2 chauvet-intimidator-spot-375z-irc-13ch 5` — should fail with "channel 5 already claimed by spot1". Patch at addr 14 instead.
- Save patch (cmd+S → file) → reload → re-open → profiles + instances should all round-trip.

**Deferred:**
- Phase 3: structured profile editor, monitor tab, `setall` by role, fades.
- Phase 4: reconnect backoff, export-all profiles as JSON file, structured error outlet.
- Phase 5: multi-universe, Art-Net/sACN transports, scenes/presets, chases.
---

---
## [2026-04-22] COMPLETED | dmx object — Phase 1 (transport + raw control)
**Agent:** Claude Code
**Phase:** DMX Phase 1 — ENTTEC DMXUSB PRO connection + raw channel control
**Done:**
- Design doc in chat (executive summary, layered architecture, fixture-profile schema, message API, phased roadmap). User greenlit Phase-1-alone for hardware-reality check.
- New runtime module `src/runtime/dmx/`:
  - `Universe.ts` — 512-byte buffer, 1-based `writeChannel`/`writeRange`, `snapshot()`, version counter, `blackout()`.
  - `DmxTransport.ts` — transport interface + `TransportState` + `TransportInfo` types.
  - `EnttecProTransport.ts` — Web Serial implementation. Label-6 framing `[0x7E | 0x06 | lenLSB | lenMSB | 0x00 | ch1..ch512 | 0xE7]`. Inline minimal Web Serial type declarations (avoids TS lib coupling). Default 57600 baud (configurable). 40 Hz default refresh via `setInterval`; clamped 10–44 Hz. Disconnect listener wired for device-loss. Silent `reacquire(vid,pid)` path for previously-granted ports.
- `src/runtime/DmxNode.ts` — per-object runtime shell. Owns transport + universe. Methods for `connect/disconnect/writeChannel/writeRange/blackout/setRateHz/requestDevice/reacquire`. In-memory 32-entry log ring buffer. Listener bus for UI + DOM live-patch.
- `src/runtime/DmxGraph.ts` — AudioGraph-style lifecycle manager. Creates/destroys DmxNode per `dmx` patch node. `mountBodies(panGroup)` attaches transport listeners that patch `.patch-object-dmx-dot[data-state]` + device + rate lines live (no graph re-render needed for state transitions).
- `OBJECT_DEFS.dmx` added (control category). Args: `rate` (40), `baud` (57600), and hidden `open/vid/pid/label`. Inlet: `any`. Outlets: bang (state change) + message (status replies).
- `ObjectRenderer` dmx branch: status dot + title + device line + rate line. Derives initial state from persisted `open` arg to avoid flash on re-render.
- `ObjectInteractionController`:
  - `setDmxGraph` setter + `dmxGraph` field.
  - `deliverMessageValue` dmx case tokenizes + routes to `deliverDmxMessage`.
  - `deliverBang` dmx case emits status reply through outlet 1.
  - `handleDblClick` dmx case opens `DmxPanel`.
  - `deliverDmxMessage` private method: dispatches `connect/disconnect/dmx/blackout/rate/status`. `connect` tries silent reacquire first, falls back to picker, writes VID/PID/label back to args, dispatches bang + status reply on success.
- `DmxPanel` floating overlay (ImageFXPanel-pattern): Web Serial unsupported banner, status row (dot + label + device), pick + connect buttons, rate slider, last-16 log. Esc/backdrop close.
- `main.ts` wires `DmxGraph` + `setDmxGraph` + `mountBodies` call in render + `destroy` on unload.
- shell.css: full dmx object body + panel styles, all via `--pn-*` tokens. Added `pn-dmx-pulse` + `pn-dmx-blink` keyframe animations.
- `tsc --noEmit` clean. `npm run build` clean (618 KB bundle, +32 KB over baseline).

**Changed files:**
- src/runtime/dmx/Universe.ts — new
- src/runtime/dmx/DmxTransport.ts — new
- src/runtime/dmx/EnttecProTransport.ts — new
- src/runtime/DmxNode.ts — new
- src/runtime/DmxGraph.ts — new
- src/canvas/DmxPanel.ts — new
- src/graph/objectDefs.ts — dmx ObjectSpec
- src/canvas/ObjectRenderer.ts — dmx body branch
- src/canvas/ObjectInteractionController.ts — dmx dispatch, dblclick, deliverDmxMessage
- src/main.ts — DmxGraph wiring, mountBodies call, destroy hook
- src/shell.css — dmx body + panel styles
- AGENTS.md — this entry + header update

**Notes / decisions made:**
- Transport abstraction kept minimal but real (`DmxTransport` interface). Phase 5 can drop in `ArtNetTransport` / `SacnTransport` without touching `DmxNode` or the object layer.
- Continuous 40 Hz frame emission (not dirty-only) — moving-head fixtures stutter without continuous refresh; cost is negligible.
- Web Serial types declared inline rather than adding `@types/w3c-web-serial` — keeps devDeps clean, and Vite's TS 5.4 target doesn't require the polyfill types for the usage we have.
- Auto-reconnect on patch load intentionally out of Phase 1 scope (Phase 4 robustness work). Today: `args[2]` persists but user must click connect after reload.
- No fixture profiles, no `patch` / `set <name> <attr>` — Phase 2.
- No structured profile editor, no monitor tab — Phase 3.
- `baud` arg exposed (not hidden) so users with older/newer ENTTEC Pro firmware can override 57600 from the attribute inspector if needed.

**Next needed:**
- Phase 2 greenlight pending user decision: fixture profiles (JSON schema + validator + bundled starters), `patch <name> <profileId> <addr>` + `set <name> <attr> <value>` dispatch, Patch tab in the Device panel.

**Post-ship fixes (same day, same phase):**
- **Baud default**: shipped at 57600 → hardware failed → raised to **250000** (matches the widget's internal DMX clock; OLA/node-dmx canonical value). `baud` arg remains exposed for 57600/115200 fallback. User's fixture ultimately ran at 115200 after they dragged the attribute slider; any of 115200/250000 works.
- **Baud never actually threaded**: `baud` arg was defined in OBJECT_DEFS but DmxGraph created `new DmxNode()` with no options, so the transport always used its internal default. Added `DmxNodeOptions { baudRate }`, DmxGraph.sync now reads `node.args[1]` and passes it. Baud takes effect on (re)connect.
- **Frame-length off-by-one**: `encodeDmxFrame` allocated `5 + payloadLen + 1` = 519 bytes and placed EOM at index 518, leaving a stray `0x00` at index 517 *between* the last channel byte and EOM. Pro firmware consumed the declared 513 data bytes, looked for EOM at the next offset, found `0x00` — frame silently rejected/misaligned. Fixed to `4 + payloadLen + 1` = 518 bytes with EOM at index 517. **This was the root cause — no DMX output reached fixtures until this was fixed.** Replaced bare numbers with `HEADER_SIZE` / `FOOTER_SIZE` constants so the intent is readable.
- **Frame-counter diagnostic**: added `framesSent` counter on transport, exposed via `DmxNode.getFramesSent()`, painted into the object body every 500ms as `"40 Hz · connected · 1459f"`. Lets users see at a glance whether frames are flowing. Added write-logging in DmxNode so single/range writes show up in the Device-panel log as `ch 1 = 255` / `ch 1..10 set (10 bytes)` — useful for diagnosing dispatch vs. wire issues.

**Hardware validation (2026-04-22, user's bench):**
- Interface: ENTTEC DMX USB PRO (USB 0403:6001, FTDI FT245)
- Fixture: Chauvet Intimidator Spot 375Z IRC (13-channel moving head, mode default)
- Confirmed: frame counter advances at 40 Hz, pan/tilt respond to individual channel writes, full 13-channel message (`dmx 1 128 0 128 0 0 0 0 0 0 0 255 255 128`) centered the head and opened shutter+dimmer — visible beam. Phase 1 validated end-to-end.
- Ran at 115200 baud (user-chosen via attribute panel); 250000 default would also work. Older Pro firmwares may want 57600 — `baud` arg is the escape hatch.
---

---
## [2026-04-21] COMPLETED | shaderToy object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new visual-category fragment-shader source
**Done:**
- Added `shaderToy` to `OBJECT_DEFS` (`src/graph/objectDefs.ts`). Visual-category. Args: `preset` (symbol default "default"), `code` (symbol, hidden — base64-encoded GLSL), `width`/`height` (int, default 512×512), `mouseX`/`mouseY` (hidden floats, default 0.5). Single `any` inlet; one `media` outlet → `layer`.
- New runtime node: `src/runtime/ShaderToyNode.ts`. WebGL2 renderer wrapping an offscreen `<canvas>`; implements the existing `VideoFXSource` interface (same SPI as `VfxCrtNode`/`VfxBlurNode`) so `LayerNode.setVideoFX(...)` picks it up with zero changes to LayerNode. Exposes the ShaderToy-compatible uniform subset: `iResolution` (vec3), `iTime`, `iTimeDelta`, `iFrame`, `iMouse` (vec4), `iDate` (vec4). User source is expected to define `void mainImage(out vec4 fragColor, in vec2 fragCoord)`; the prelude + a trivial `main()` are added automatically.
- Four built-in presets live in `SHADERTOY_PRESETS` (default rainbow gradient, plasma, warp, grid) so the object shows visible output immediately on placement.
- Messages (hot inlet 0): `preset <name>` (switches built-in, clears inline code), `code <base64>` (sets fragment source from base64), `glsl <rest-of-line>` (convenience path for hand-typed GLSL — re-encoded to base64 for persistence), `mouse <x> <y>` (normalized 0–1), `size <w> <h>` (resize render surface), `reset` / `bang` (reset `iTime`).
- `VisualizerGraph` wiring: new `shaderToyNodes` map; `rewireMedia()` gains a `shaderToy` branch calling `layer.setVideoFX(stn)`; mutable-state sync reads `width`/`height` + `mouseX`/`mouseY` every graph change; `deliverShaderToyMessage` handler.
- `ObjectInteractionController`: `deliverBang` + `deliverMessageValue` branches; `glsl <rest-of-line>` carve-out preserves spaces in GLSL body.
- `ObjectRenderer`: `shaderToy` branch with visual-label + sub (preset-or-"custom" and resolution). Reuses existing CSS classes.
- Reference docs: `docs/objects/shaderToy.md` + `docs/objects/INVENTORY.md` row.
- `tsc --noEmit` passes. `npm run build` clean (586 KB bundle).

**Changed files:**
- src/runtime/ShaderToyNode.ts — new
- src/graph/objectDefs.ts — shaderToy ObjectSpec
- src/runtime/VisualizerGraph.ts — create/destroy, rewireMedia branch, deliverShaderToyMessage, helpers
- src/canvas/ObjectInteractionController.ts — deliverBang + deliverMessageValue branches (incl. glsl rest-of-line carve-out)
- src/canvas/ObjectRenderer.ts — shaderToy body branch (visual-label + sub)
- docs/objects/shaderToy.md — new reference page
- docs/objects/INVENTORY.md — new row
- AGENTS.md — this entry

**Notes / decisions made:**
- shaderToy is a *media source* (not a layer itself) so it composes with the existing `shaderToy → layer → (visualizer | patchViz)` graph shape. Reused `VideoFXSource` / `LayerNode.setVideoFX` — trade-off: a layer holds shader OR video/image but not both (acceptable in v1).
- WebGL2 (not WebGL1). Base64 code storage in `args[1]` for round-trip safety.
- ShaderToy URL/ID fetching intentionally NOT implemented — requires per-user API key and CORS is not universal. Users paste fragment source directly via `glsl` or `code`.
- Multi-pass / `iChannel*` out of scope for v1. Compile failures keep previous good shader.

**Next needed:**
- Browser smoke test: `shaderToy → layer → patchViz` (default rainbow), swap to `visualizer` popup, `message preset plasma`, `message glsl ...`, two sliders → `message mouse $1 $2`, round-trip.
- Follow-up candidates: `iChannel0` input slot, compile-error state in node DOM, more presets, live thumbnail.
---

---
## [2026-04-20] COMPLETED | sequencer object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new control-category step sequencer
**Done:**
- Added `sequencer` to `OBJECT_DEFS`. Control-category. Args: `rows` (int 1–32, default 4), `cols` (int 1–64, default 8), `playhead` (hidden int), `cells` (hidden base64 JSON matrix), `locked` (hidden int 0/1, default 1). Single bang inlet; one `any` outlet per row (derived).
- Port derivation: `deriveSequencerPorts(args)` rebuilds outlets from the row arg. Called from `PatchGraph.addNode`, `parse.ts`, and at every arg-mutation site.
- `ensureSequencerArgs` backfills sparse arg slots before serialization.
- Cell storage: `getSequencerCells` / `setSequencerCells` helpers; base64 JSON in `args[3]`.
- Renderer: CSS-grid of `.pn-seq-cell` divs, active column marked, lock button at top-right.
- Interaction: `advanceSequencer` wraps playhead, dispatches each row's active-column value, patches DOM in place (no full re-render), emits `"display"`. Lock-button handler mirrors subPatch toggle. Cell commit via `focusout`/`keydown` (Enter commits, Escape reverts). `syncSequencerPorts` rebuilds outlets and drops orphan edges.
- `DragController`: `pn-seq-cell` added to click-through allowlist.
- `tsc --noEmit` passes. `npm run build` clean (574 KB bundle).

**Changed files:**
- src/graph/objectDefs.ts — sequencer ObjectSpec + derivation/ensure/cells helpers
- src/graph/PatchGraph.ts — addNode sequencer branch
- src/serializer/parse.ts — sequencer parse branch
- src/canvas/ObjectRenderer.ts — sequencer body branch + shared `LOCK_ICON_SVG`
- src/canvas/ObjectInteractionController.ts — bang/value delivery, lock toggle, cell commit, port sync, focusout/keydown wiring
- src/canvas/DragController.ts — pn-seq-cell drag exclusion
- src/shell.css — sequencer grid / cell / playhead / lock-button styles
- AGENTS.md — this entry

**Notes / decisions made:**
- Single bang inlet (not one per row) per Max `coll`/`counter`/`matrixctrl` convention.
- Cells serialize as base64 JSON (raw JSON breaks PD-style format; base64 is the codebox/subPatch precedent).
- Shrink→grow preserves cell content (getSequencerCells pads missing slots).
- Playhead advance emits `"display"` not `"change"` — skips re-render so grid DOM, cables, focused cell survive bang cadence.

**Next needed:**
- Browser smoke test: unlock, type values, lock, `metro → sequencer`, confirm playhead walks. Round-trip test. Attribute panel: drag `rows` slider, confirm outlet count tracks and orphan cables clean up.
- Follow-up: `docs/objects/sequencer.md` reference page + `INVENTORY.md` row.
---

---
## [2026-04-19] COMPLETED | oscillateNumbers object
**Agent:** Claude Code
**Phase:** Out-of-band user request — new control-category object
**Done:**
- Added `oscillateNumbers` to `OBJECT_DEFS`. Control-category. Args: `freq` (0.01–20 Hz, default 1), `running` (hidden). Hot inlet 0 accepts `1/0/bang/freq <hz>`; cold inlet 1 is a dedicated float-Hz inlet. Outlet 0 emits a float in `[0.0, 1.0]`.
- RAF-driven oscillator in `ObjectInteractionController`: `oscTimers` map, `pruneOscTimers`/`restoreOscTimers` survive text-panel diff deserialize, `destroy()` cancels in-flight RAFs.
- Output: `0.5 + 0.5 * sin(2π * freq * t)`, emitted every frame as `toFixed(4)`.
- Reference page `docs/objects/oscillateNumbers.md` + `INVENTORY.md` row.
- `tsc --noEmit` + `npm run build` clean (560 KB bundle).

**Changed files:**
- src/graph/objectDefs.ts — OBJECT_DEFS.oscillateNumbers
- src/canvas/ObjectInteractionController.ts — oscTimers field, hooks, deliverBang/deliverMessageValue branches, private osc methods
- docs/objects/oscillateNumbers.md — new reference page
- docs/objects/INVENTORY.md — new row
- docs/phase-oscillateNumbers-prompt.md — implementation prompt
- AGENTS.md — this entry

**Notes / decisions made:**
- `freq` = cycle Hz (RAF-decoupled output rate). Gate semantics mirror `metro` exactly.
- Phase resets on (re)start including freq changes via inlet 1 — documented explicitly.
- No runtime node, no AudioGraph/VisualizerGraph registration, no renderer branch (default text-label handles it).
- Single `OBJECT_DEFS` entry — autocomplete and context menu derive automatically.

**Next needed:**
- Browser smoke test: `toggle → oscillateNumbers → float` + `slider → oscillateNumbers inlet 1`. Round-trip test.
- Follow-up: `docs/OBJECT_RECIPE.md` step 2 ("Add to VALID_TYPES") is obsolete — recipe should be updated.
---

---
## [2026-04-19] COMPLETED | Control/render split — plan authored + Phase 1 scaffold landed
**Agent:** Claude Code
**Phase:** Control/Render Split — Phase 1 (Control surface extraction)
**Done:**
- Authored architecture plan at `docs/CONTROL_RENDER_SPLIT.md`. Firm recommendation: v1 stays browser-based in-process; real win is a clean control-plane abstraction. Popup → BroadcastChannel is v2; WebSocket is v3.
- Vault: `patchNet-Vault/wiki/concepts/control-render-split.md` + `visualizer-object.md` + `patchviz-object.md`. Index + log updated.
- Phase 1 scaffolding in `src/control/`: `ControlMessage.ts` (discriminated union), `IRenderer.ts`, `ControlBus.ts` (`LocalBus` impl), `RenderDirector.ts`.
- `VisualizerNode.apply()` handles `Command { close | size | move | setFloat | fullscreen }`.
- `PatchVizNode.apply()` handles `Command { enable | disable | toggle }` + `Trigger { bang }`.
- `VisualizerGraph` owns `LocalBus` + `RenderDirector`; renderers attach on create, detach on destroy.
- Proof path: `deliverPatchVizMessage` routes through `director.trigger` / `director.command` → `bus.publishDown` → `PatchVizNode.apply`.
- `tsc --noEmit` passes. `npm run build` clean (558 KB bundle).

**Changed files:**
- docs/CONTROL_RENDER_SPLIT.md — new
- patchNet-Vault/wiki/concepts/control-render-split.md — new
- patchNet-Vault/wiki/concepts/visualizer-object.md — new
- patchNet-Vault/wiki/concepts/patchviz-object.md — new
- patchNet-Vault/wiki/index.md — bumped + 3 new concept links
- patchNet-Vault/wiki/log.md — new entry
- src/control/ControlMessage.ts — new
- src/control/IRenderer.ts — new
- src/control/ControlBus.ts — new
- src/control/RenderDirector.ts — new
- src/runtime/VisualizerNode.ts — IRenderer forwarder `apply`
- src/runtime/PatchVizNode.ts — IRenderer forwarder `apply`
- src/runtime/VisualizerGraph.ts — owns bus+director; attach/detach on renderer lifecycle; deliverPatchVizMessage via director

**Notes / decisions made:**
- `rendererId` is opaque to the bus (Phase 1 uses `patchNodeId`; Phase 4 may unify to `contextName`).
- Conservative migration: only `deliverPatchVizMessage` went through the bus. Other `deliverXxx` paths remain on the pre-refactor direct-call path until Phase 2 adds test infra (BLOCKER-1).
- `openAndRestore` stays on direct path — reads patch-side args mid-open, a controller concern.
- No automated tests — Phase 2 adds vitest + mock `IRenderer` harness before migrating further.

**Next needed:**
- Browser smoke test: `patchViz` bang/enable/disable still works. Other five `deliverXxx` paths unchanged.
- Phase 2 greenlight: add vitest + `tests/control/RenderDirector.test.ts`, then migrate `deliverMessage`.
---

---
## [2026-04-17] COMPLETED | Evaluation Plan — Part 1 audit (partial)
**Agent:** Claude Code
**Phase:** Evaluation Plan — Part 1 (Project Evaluation)
**Done:**
- Added `knip` as devDependency; findings in `docs/AUDIT.md` §1.1
- Cataloged all 21 object types with renderer/runtime/doc coverage → `docs/objects/INVENTORY.md`
- CSS/token audit: 6 hex violations in `shell.css`, 44 `!important`, 96 `rgba()` literals → `docs/AUDIT.md` §1.5
- Filed 4 BLOCKERs for items too big to fix inline

**Deferred:**
- Part 1.3 Controller responsibility map — resolved same day (see archive)
- Part 1.4 Runtime graph audit — requires browser profiling; captured as BLOCKER-2

**Changed files:**
- package.json / package-lock.json — added knip devDependency
- docs/AUDIT.md — created (Part 1 synthesis doc)
- docs/objects/INVENTORY.md — created (21-row coverage table)
- AGENTS.md — this entry + BLOCKERs + project state header

**Next needed:**
- BLOCKER-3 resolved (see archive). Remaining: BLOCKER-1 (test infra) gates Phase 2; BLOCKER-2 (runtime profiling) gates Part 3.
- Part 4 (OBJECT_RECIPE + ref-page template) landed — see archive.
---

---
## [2026-04-17] BLOCKER | No test infrastructure
**Agent:** Director (filed on behalf of Part 2 work)
**Blocking:** Dead-code deletions in Part 2 have no regression safety net beyond manual smoke tests. Control/Render Split Phase 2 also gated here.
**Details:** No vitest/jest config, no `*.test.ts`, no `tests/` dir anywhere in repo.
**Needs:** Decision on vitest (likely — matches Vite) + one serialize→parse round-trip test per object type as starting bar.
---

---
## [2026-04-17] BLOCKER | Runtime graph rewire behavior unmeasured
**Agent:** Director (filed on behalf of Codex / Part 3 work)
**Blocking:** Part 3 efficiency work cannot start without numbers.
**Details:** `VisualizerGraph` and `AudioGraph` both re-walk upstream topology on every edit. Cost is unknown; whether non-topology edits (drag, arg change) trigger rewire is unknown.
**Needs:** Add counter in `rewireMedia()`, run against a scripted 20-node patch, record results in `docs/AUDIT.md` §1.4. Delete counter after.
---

---
## [2026-04-17] BLOCKER | dist/ committed to repo
**Agent:** Director (hygiene)
**Blocking:** Nothing functional — knip reports false-positive unused files.
**Details:** `dist/assets/index-D4hyy6T0.js` shows up as an unused file.
**Needs:** Add `dist/` to `.gitignore`, remove committed files. Trivial.
---
