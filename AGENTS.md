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

**Current Phase:** `js~` object Phase E landed (effect library per-patch + global via localStorage; dropdown selector; lock toggle with sliders-stay-live). Phase D mem[]/@block/bitwise still current; avocado + Stillwell 1175 + waveshaper all confirmed translating. DMX Phase 4 hardware-verified; Control/Render Split Phase 1 landed.
**Active tasks:** `js~` Phase E pending user browser test — save effects into the per-patch library, reload, switch between them via dropdown, lock toggle disables code editing while leaving sliders live. E.4 (.jsfx file import/export) deferred. On greenlight: remaining Phase D-ish gaps (user-defined `function`, multi-channel `spl2..spl63`, `@serialize`) come up on demand. Control/Render Split Phase 2 gated on test infra (BLOCKER-1). Evaluation Plan: Part 1.4 deferred (BLOCKER-2).
**Last updated:** 2026-04-23 by Claude Code

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
## [2026-04-23] COMPLETED | js~ object — Phase E (effect library + dropdown + lock)
**Agent:** Claude Code
**Phase:** `js~` Phase E — per-patch + global effect library with dropdown selector; lock state toggle
**Done:**
- **args model extended**: `args[1]` = per-patch library (JSON array of `{name, code}`, base64 on disk), `args[2]` = lock flag ("0"/"1", default unlocked). Serializer/parser round-trip all three args; "-" used as the on-disk placeholder for empty library so the space-separated token format doesn't collapse.
- **`src/runtime/jsfx/library.ts`** — new module with LibraryEntry type, patch-lib read/write (with graph broadcast across all js~ nodes), localStorage-backed global library, upsert/remove/rename helpers, `deriveNameFromCode` and `uniqueName` utilities.
- **Header redesign**: static `.pn-jseffect-title` replaced with a 4-element flex row: title-as-button (caret ▾ + "js~ — desc") → dropdown; `save` button → inline save prompt; `manage` button → manage-library modal; lock toggle (🔓 / 🔒).
- **Dropdown** (absolute-positioned popover below header): two scope sections (`saved effects (patch)` + `⌂ saved effects (global)`), alphabetical within each, inline × delete on every row. Footer actions duplicate the save/manage buttons. Closes on outside click or Escape.
- **Save prompt**: inline popover anchored below the header. Pre-fills name from `desc:`, scope radio (patch / global), Enter = commit, Escape = cancel. Saves via `upsertEntry` so names collide idempotently (re-saving "gain" just updates the code).
- **Manage dialog** (`src/canvas/JsEffectLibraryDialog.ts`) — new modal overlay, two-column patch/global view. Each row: rename (inline input on click, Enter commit / Escape cancel / blur commit), move between scopes (removes from source + `uniqueName` in destination to dodge collisions), delete with confirm. Re-renders after every mutation so renames reflect immediately. Backdrop click + Esc close.
- **Lock state**:
  - `args[2]` toggles via lock button; live update via `body.dataset.locked = "1"|"0"` so CSS reacts without waiting for a re-render.
  - ObjectRenderer sets `data-locked` on the `.patch-object-jseffect-body` on initial paint.
  - CSS: `[data-locked="1"] .pn-jseffect-code`, `[data-locked="1"] .pn-jseffect-title-btn`, `[data-locked="1"] .pn-jseffect-hdr-btn` → `pointer-events: none; opacity: 0.55`. `.pn-jseffect-lock` and `.pn-jseffect-slider-range` explicitly `pointer-events: auto !important`. Dashed outline on the panel when locked.
  - **DragController override**: when the target is inside `.pn-jseffect-panel-host`, check whether the body is locked. Unlocked → panel interactive (no drag, existing behaviour). Locked → fall through to drag, EXCEPT over the lock button itself or a slider. So a locked js~ can be dragged from the code pane or anywhere non-slider on the body, while sliders and the lock button remain clickable.
- **Cross-object broadcast**: saving/renaming/deleting in the patch library writes to every `js~` node's args[1] via `broadcastPatchLibrary()`, emitting a single graph `change`. Global library is localStorage so no broadcast needed.
- **Verification**: tsx round-trip test — serialize a patch with one js~ (code + 2-entry library + locked=1), deserialize, verify all three args match bit-for-bit. Empty library also round-trips correctly via the `-` placeholder. tsc clean, vite build clean (715 KB, +26 KB from the new dialog + library UI).
- **E.4 deferred**: per-entry .jsfx file export/import not implemented. Dropping from scope — can ship on demand.

**Changed files:**
- src/graph/objectDefs.ts — args[1] library + args[2] locked on js~
- src/serializer/serialize.ts — encodes args[1] as base64 JSON, args[2] as plain int, "-" placeholder for empty library
- src/serializer/parse.ts — mirror decode
- src/runtime/jsfx/library.ts — new module
- src/canvas/JsEffectPanel.ts — full header rewrite, dropdown, save prompt, lock toggle, manage-dialog integration
- src/canvas/JsEffectLibraryDialog.ts — new modal
- src/canvas/ObjectRenderer.ts — body.dataset.locked on js~
- src/canvas/DragController.ts — locked-js~ drag override
- src/shell.css — header/dropdown/save-prompt/lock/dialog styles (~280 lines)
- docs/phase-js-E-prompt.md — execution prompt (written same session)
- AGENTS.md — this entry

**Notes / decisions made:**
- **Library is per-js~-node storage, cross-node synchronised.** Each js~ holds its own copy of `args[1]`, but every mutation goes through `broadcastPatchLibrary()` which writes to every js~ in the graph. Simpler than storing at the PatchGraph level (which would have required a new graph-metadata concept); trivially survives node deletion + creation without orphaned library state.
- **"-" as empty-library placeholder on disk.** The space-separated token format can't handle empty strings (they'd collapse into the next token). `-` is never a valid base64 character, so it's unambiguous as "library absent" and parse distinguishes it cleanly from an actual base64 blob.
- **Default unlocked** per user decision. First-placement UX favours immediate code entry over drag-anywhere. State is sticky via args[2] so a patch reloads in whatever state the user saved it in.
- **Sliders explicitly `pointer-events: auto !important`** overrides the locked-body rule. Per user spec — sliders always interactive, lock or no lock. The lock button itself gets the same treatment so users can always unlock.
- **Dialog reuses ImageFXPanel's overlay shape.** Backdrop click + Esc close; body doesn't propagate. Two-column grid with explicit 1px gap rendered as the outer border colour for a clean "joined columns" look.
- **Name collisions on save = silent upsert.** Re-saving the same name overwrites. On rename the UI refuses if the new name already exists (caller sees no state change and can pick a different name). On move-between-scopes we use `uniqueName` to auto-append " (2)", " (3)".
- **Local-storage global library has no import/export UI yet.** E.4 deferred. Users can still prime the global library via DevTools in the meantime; the key is `patchnet-js-global-library`.

**Next needed (user browser test):**
1. Fresh patch. Drop a `js~`. Default state: unlocked (open-lock icon). Lock button toggles state.
2. Paste Stillwell 1175 → click "save" → prompt shows "1175 Compressor" pre-filled → save to patch. Header dropdown now lists it.
3. Paste avocado → save to patch → dropdown lists both alphabetically.
4. Save one of them to global scope → reload page → open a BLANK new patch → drop a fresh js~ → dropdown shows the global entry under the ⌂ section.
5. Open "manage" → rename an entry → dropdown reflects the new name immediately.
6. Move an entry between scopes → verify it disappears from source and appears in destination.
7. Lock the object → click in the code area → object drags. Click a slider → slider moves, object doesn't. Click the lock icon → unlocks. Click in the code area → cursor lands in editor.
8. Save patch → reload → library + lock state restored.

**Deferred from prompt:**
- E.4: per-entry .jsfx download / bulk JSON export / .jsfx import.
- Cross-tab real-time sync of global library (`storage` event listener).
- Search/filter within the dropdown.
- Per-effect metadata (tags, author, description) beyond name.
---

---
## [2026-04-23] COMPLETED | js~ object — Phase D (mem[] + @block + bitwise + rand + host-globals stubs)
**Agent:** Claude Code
**Phase:** `js~` Phase D — full EEL2 coverage sufficient to run a buffer-recording, state-machine-heavy JSFX (avocado ducking glitch generator) verbatim
**Done:**
- **User-supplied test case** (Daniel Arena's avocado, remaincalm.org) — parses, translates, compiles, and executes against a scripted input. 11 sliders (including enum slider10 with 5 labels), 4 sections (`@init` / `@slider` / `@block` / `@sample`), 34 unique user vars, 5000 silent + 5000 hot samples processed without error. Array writes via `buffer[max_bufsiz*record_buffer + record_csr] = spl0` succeed; switching the arpeggiator slider writes note ratios to `mem[notedata_offset..]` correctly (`[1, 1.25993, 1.4983, 2]` for Major mode).
- **Parser**: `@block` promoted from "ignored section" to a recognised section. `JsfxProgram.blockBody: string` added; parser joins lines into it like the other sections.
- **Translator (`translate.ts`) — full Phase D grammar**:
  - **Array indexing `name[expr]`** — the headline feature. Postfix-level grammar rule chains `[idx]` accesses after any primary. Emits `mem[((base | 0) + ((idx) | 0))]` with both operands cast to int32 to avoid Float64Array bounds weirdness. Assignable, so `buffer[i] = x` and `buffer[i] *= 0.85` both work as EEL2 expects.
  - **Pointer-offset tracking**: `parsePrimary` returns `{result, pointerish}`. User vars and `mem`/`gmem` are pointerish (indexable); reserved literals (`true`, `tempo`, `srate`) are not. Indexing a non-pointerish base returns a clean translator error.
  - **Bitwise `|` / `&` / `~`** — `|` between comparison and logical-AND; `&` above `|`; unary `~` alongside `- + !`. JS's `|` / `&` / `~` already cast to int32, matching EEL2. Enables the `x | 0` int-cast idiom used heavily in JSFX for sample-index calculations.
  - **`rand(x)`** — special-cased as a builtin (not in the `Math.*` pass-through table). Emits `(Math.random() * (x))` = `[0, x)` per EEL2.
  - **`true` / `false`** — resolved as literal `1` / `0`. Not assignable.
  - **Host globals `tempo`, `beat_position`, `play_position`, `play_state`, `num_ch`, `tsnum`, `tsdenom`** — resolved to literal `0` since patchNet has no DAW transport. Effects that check `tempo > 0` or `slider11 > 0 && tempo > 0` take their free-running path, which is the safe default for a transport-less host.
  - **`mem` / `gmem`** — resolved to literal `0` with `pointerish: true`, so `mem[i]` indexes the shared buffer directly.
  - **Precedence refreshed** (high → low): primary → postfix (array-index) → unary → pow → multi → add → compare → bit-and → bit-or → logAnd → logOr → ternary → assign. Matches C/JS conventions.
- **Worklet (`jsfx-worklet.js`)**:
  - **`Float64Array(8 * 1024 * 1024)` mem buffer** allocated per code-install. 64 MB per js~ instance — expensive but matches REAPER's addressable mem[] range. Avocado uses ~6M slots at 48 kHz; comfortably under 8M.
  - **4-fn compile**: init, slider, block, sample. All take `mem` as an additional argument.
  - **`@block` runs once per `process()` call** — matches REAPER's per-audio-block semantics. Guarded with try/catch so a @block exception falls back to null without killing @sample for that frame.
  - **Install runs all of @init + @slider + @block in order** so a patch-file-loaded effect is "ready to play" the moment audio starts, not after the first render quantum.
  - **Worklet file: ~7 KB** (was ~5.5 KB) — still well under Vite's inline limit for its own module chunk.
- **JsEffectNode** (`JsEffectNode.ts`): `JsEffectCompileInput` gains `block: string`. `setCode` threads it through. Status-error `where` type widened to include `"block"`.
- **Panel (`JsEffectPanel.ts`)**: `compileNow` translates all four sections, unions userVars across all of them, surfaces "@block:" error prefix if that section fails alone.
- **Offline verification** (`tsx` throwaway test, deleted post-run): confirmed avocado's 34 user vars all flow correctly, `@init` offsets are `max_bufsiz=192000 / r_offset=3072001 / notedata_offset=6144002` (all fit in 8M-slot mem), `@sample` state machine transitions into recording mode and writes into mem[], arpeggiator mode switch writes correct note ratios to `mem[notedata_offset..]`.
- `tsc --noEmit` clean. `npm run build` clean — 689 KB bundle (+3 KB over Phase B), worklet chunk still separate.

**Changed files:**
- src/runtime/jsfx/parser.ts — @block as recognised section, JsfxProgram.blockBody
- src/runtime/jsfx/translate.ts — Phase D grammar rewrite (see above)
- src/runtime/jsfx/jsfx-worklet.js — 4-fn install, 8 MB mem per install, @block runs per process()
- src/runtime/JsEffectNode.ts — JsEffectCompileInput.block, where widened
- src/canvas/JsEffectPanel.ts — 4-section compileNow + userVar union
- AGENTS.md — this entry + project-state header

**Notes / decisions made:**
- **8 MB mem buffer per instance.** REAPER's EEL2 mem[] is addressable up to ~8M double-precision slots, and avocado genuinely needs 6M+ at 48 kHz. Going smaller would silently fail OOB. Going larger wastes RAM. 8M is the sweet spot; if a future effect needs more we'll either increase it or expose as a per-object arg.
- **Fresh mem buffer on every code install.** EEL2's convention is that code edits are full resets — no state (neither user vars nor mem) persists across recompiles. Avocado's @init explicitly initialises the state machine, so relying on the fresh-mem contract is safe.
- **Host globals stubbed to 0, not left undefined.** Undefined → NaN in arithmetic → silent propagation of NaN through the whole DSP chain → hard-to-debug silence. `0` matches the "no DAW connected" semantics that DAW-aware JSFX already handle (they check `tempo > 0` etc.).
- **`rand(x)` special-cased** (not in the BUILTINS map). `Math.random()` takes no args and returns `[0,1)`; EEL2's `rand(x)` returns `[0,x)`. Rather than add a trampoline, emit `(Math.random() * x)` inline at call site.
- **Array indexing uses `| 0` int-cast on BOTH base and offset.** Float64Array silently returns `undefined` for non-integer or negative indices; catching that in the generated code is cheaper than a runtime bounds check. Effects that deliberately index with fractional values (e.g. for a linear-interp lookup) already handle the floor themselves.
- **`name[b][c]` chained indexing returns a scalar, not a pointer.** EEL2's memory model is flat; chaining is meaningless. Allowing it for grammar completeness but the second access on a scalar result silently returns `mem[scalar | 0]` — weird but not incorrect.
- **`@block` runs at install AND per process() call.** Install so an effect loaded from a patch file is ready without waiting for a render quantum. Per process() so effects that check tempo / update modulation on a per-block cadence work correctly.
- **user-defined `function` declarations still not supported.** Avocado doesn't need them. If/when a requested JSFX does, it's a separate parser + emitter pass — probably ships as "Phase E" or similar mini-phase.

**Next needed (user browser test):**
1. Paste avocado verbatim into a fresh `js~`. Status should read `compiled · 11 sliders`.
2. Wire `mediaVideo → js~ → dac~` (or any audio source into js~). Feed music.
3. slider1 = 50ms buffer length default; slider2 = 90% mix default; slider8 = 8% threshold default. The effect should duck the signal and splice in glitch-repeats when the input level crosses the moving threshold.
4. Drag slider2 (Mix) to 0 → dry only; to 100 → fully glitched. slider4 (Repeat Probability) at 99% = same buffer repeats forever; at 0% = buffer changes every cycle. slider6 (Reverse) > 0 → some buffers play backwards. slider10 (Arpeg) = 1/2/3/4 → pitch-stepping through major/minor/fifths/octaves.
5. No runtime errors in the status line; save + reload restores code + slider state.

**Still tabled:**
- User-defined `function` declarations.
- Multi-channel `spl2..spl63`.
- `@serialize` (save/restore preset state with the patch — nice to have).
- Bitwise XOR (EEL2 uses `xor` keyword or a function, unclear; not used in avocado).
- Patch-level DAW transport (tempo / beat_position as live values instead of 0) — substantial architectural change; defer until a clear use case.
---

---
## [2026-04-23] COMPLETED | js~ object — Phase B (comparison/logical/ternary/math/blocks/loops + enum sliders)
**Agent:** Claude Code
**Phase:** `js~` Phase B — real-world EEL2 coverage sufficient to run Stillwell 1175 compressor verbatim
**Done:**
- **Stillwell 1175 compressor** (user-supplied test case, the ur-JSFX) parses, translates, compiles, and executes against a scripted input. Confirmed: `threshv = exp(0 × db2log) = 1.0` ✓, ratio selection logic (`(rpos=slider2)>4?rpos-=5:capsc*=...`) routes correctly ✓, nested ternaries for ratio lookup ✓, multi-statement parens-blocks in ternary branches ✓, `abs` / `max` / `min` / `sqrt` / `log` / `exp` builtins ✓, dry/wet mix ✓. `@gfx` silently ignored (already handled in Phase A).
- **Parser (`parser.ts`)**:
  - Enum slider form: `sliderN:default<min,max[,step]{a,b,c,...}>label` — labels populate `SliderDecl.enumLabels: string[]`. Panel renders the label text as the slider readout instead of the numeric value.
  - `IGNORED_HEADER_RE` explicitly swallows `in_pin:` / `out_pin:` / `tags:` / `author:` / `options:` / `filename:` / `import:` / `provides:` / `version:` / `about:`. Previously these fell through silently; explicit tolerance surfaces a clearer error if a real malformed line appears.
- **Translator (`translate.ts`) — full Phase B grammar rewrite**:
  - **New token kinds**: `question`, `colon`, `comma`; `op` now covers two-char `==`, `!=`, `<=`, `>=`, `&&`, `||` as well as the new single chars `<`, `>`, `!`.
  - **Comparison operators** `== != < <= > >=` — emitted via JS `=== !== < <= > >=`. EEL2's value-based equality matches JS strict equality since all EEL2 values are numeric.
  - **Logical operators** `&& ||` — short-circuit, identical emit. EEL2's numeric truthiness aligns with JS's.
  - **Unary `!`** — emitted as `(!x ? 1 : 0)` so the return is a clean 0/1 numeric (matches EEL2's `! x` semantics and avoids leaking JS booleans into further arithmetic).
  - **Ternary `a ? b : c`** plus the EEL2-idiomatic **no-else form** `a ? b` → emitted as `(a ? b : 0)`. The no-else form is used heavily in JSFX for conditional-side-effect patterns (`overdb - rundb > 5 ? (averatio = 4;)`).
  - **Parens-as-blocks**: `(stmt1; stmt2; ... ; last)` now parses as a sequence of statements whose value is the last. Emitted as a JS comma expression. Empty `()` returns 0 (matches EEL2 convention). Single-statement parens still behave as pure grouping.
  - **Math builtins**: `sin cos tan asin acos atan atan2 exp log log10 log2 sqrt abs min max floor ceil round pow sign` — translator recognises identifier-followed-by-lparen as a function call and maps known names to `Math.*`. Unknown function names return a clean translator error that lists the supported builtins + points Phase D for user-defined functions.
  - **`loop(n, body)`** — EEL2 loop construct. Body is a comma-expression (possibly multi-statement). Emitted as `((_n) => { for (let _i = 0; _i < _n; _i++) { body; } return 0; })(n)` so it stays a valid expression.
  - **`while (cond) body`** — the explicit-condition form. Body is any expression. Emitted as an IIFE with a real `while` loop returning 0. The last-statement-is-condition form (e.g. `while ( stmt; stmt; cond; )`) is rejected with a clean error pointing users to the explicit form — ambiguous with plain paren-blocks, too gnarly to support without a lookahead rewrite.
  - **Precedence refreshed** (high → low): primary → unary → pow → multi → add → compare → logAnd → logOr → ternary → assignment. Matches C/JS conventions.
- **Panel (`JsEffectPanel.ts`)**: enum-slider readout — when `enumLabels.length > 0`, the readout shows `labels[(value - min) / step]` instead of a formatted number. Falls back to numeric display if the index goes out of range (e.g. user resized the slider range).
- **Offline verification**: wrote a throwaway `tsx` test that feeds the Stillwell 1175 source through parser + translator + `new Function` + a 10,000-sample @sample loop at 48 kHz. All three sections compile; state after @init + @slider matches expected values (`db2log`, `ratatcoef`, `relcoef`, `threshv`, `ratio`, `cratio`, etc.); @sample produces finite output at every tested amplitude. Script deleted post-verification.
- `tsc --noEmit` clean. `npm run build` clean — 686 KB bundle (+5 KB over A.5).

**Changed files:**
- src/runtime/jsfx/parser.ts — enum slider regex + ignored-header tolerance
- src/runtime/jsfx/translate.ts — full Phase B grammar rewrite (see above)
- src/canvas/JsEffectPanel.ts — `formatSliderReadout(value, decl)` supports enum labels
- AGENTS.md — this entry + project-state header

**Notes / decisions made:**
- **No `if (c) body else body` statement form.** EEL2 uses ternary for all conditionals; the `if` keyword isn't a thing in standard JSFX. Skipped entirely.
- **Last-statement-is-condition `while` form deferred.** Too ambiguous with parens-blocks to disambiguate without lookahead. Rejected with a clear error. Real-world JSFX uses this pattern almost exclusively in @gfx (which we don't compile) — no Phase-B-audio use case lost.
- **`loop(n, body)` emits an IIFE.** `for` is a JS statement, not an expression. Wrapping in an IIFE is ~10 extra chars per loop and keeps EEL2's statement-as-expression semantics. Perf cost is negligible compared to the body.
- **Comparison result is returned as JS boolean, not coerced to 0/1.** JS's truthy/falsy handling in ternary + arithmetic contexts matches EEL2's 0/1 close enough that coercion would just add noise. If a real effect ever does `x = (a > b) + 1`, the boolean auto-coerces to 0 or 1 via JS's `+` — same result as EEL2.
- **Parens-as-blocks reuses the existing `parseParenBlock` entry.** No separate "grouping" vs "block" code path — a 1-statement block is indistinguishable from grouping, which was already the case.
- **Unknown function names are a translator error, not silent failure.** Previous behaviour (all identifiers became user vars) would have silently made `exp(...)` into `state.u_exp(...)`, throwing at runtime with a bad-looking traceback. Now the parse-time error surfaces the Phase B builtin set and points at Phase D for user-defined functions.
- **Enum sliders assume `(value - min) / step` is an integer index**. For well-formed declarations (`0<0,9,1{...}>`) this is always true. Malformed decls fall back to the numeric display — user still sees *something*.
- **Math builtin table is ambient in `translate.ts`**. Adding a builtin is a one-line edit. If Phase D adds a `mem[]` buffer, the indexing form (`mem[i] = x`) will need separate parser work; `pow(a,b)` as a builtin is redundant with `a^b` but matches REAPER exactly so both work.

**Next needed (user browser test):**
1. Copy the user's 1175 compressor source (full script, including `@gfx`) → paste into a fresh `js~` object.
2. Start DSP, wire `adc~ → js~ → dac~`, play material through it.
3. Drag slider1 from 0 dB down to −30 dB while feeding hot signal → audible compression / pumping. Drag slider3 up → makeup gain adds back. Drag slider6 down → dry signal blends in.
4. Status line should show `compiled · 6 sliders`. No red "runtime error" popups unless you modify the code to something invalid.
5. Save patch → reload → source + slider values restored, audio resumes.

**Still tabled (Phase D, not scheduled yet):**
- `mem[]` / `gmem[]` buffers — unlocks delays, reverbs, IIR filters. Biggest remaining feature gap.
- User-defined `function` declarations.
- `@block`, `@serialize`, `@gfx` sections (`@gfx` probably never — use `shaderToy` for custom visuals).
- Last-statement-is-condition `while` form.
- Multi-channel variants (`spl2..spl63`).
- Bitwise operators (`| & ~` for integer masks — needed for some bitcrushers).
---

---
## [2026-04-23] COMPLETED | js~ object — Phase A.5 (@init / @slider / persistent state / ^ pow)
**Agent:** Claude Code
**Phase:** `js~` Phase A.5 — unlock real-world JSFX patterns that rely on cross-section state
**Done:**
- **Root cause of first-smoke-test silence diagnosed**: user's dB-gain JSFX used three deferred-to-Phase-B features — `@init` + `@slider` never ran (Phase A only compiled `@sample`), user var `gain` reset to 0 every sample (my translator declared `let u_gain = 0` inside the per-sample fn), and `^` was rejected by the tokenizer (EEL2 uses `^` for pow, not XOR). Net: `spl0 *= gain` always multiplied by zero.
- **Translator (`translate.ts`)**:
  - `^` added to the operator set. New `parsePow()` grammar level, right-associative, precedence above `* / %`. Emitted as parenthesised JS `**` (guards against `-a ** b` ambiguity).
  - User identifiers now emitted as `state.u_<name>` instead of bare `u_<name>`. State is a shared object the worklet owns per-install, so user vars persist across `@sample` calls AND across sections.
  - Entry renamed from `translateJsfxSample` to `translateJsfxBody` since the same subset translates @init, @slider, and @sample bodies.
  - Tokenizer error message updated to reflect the A.5 subset.
- **Worklet (`jsfx-worklet.js`)** — full protocol refresh:
  - `{type:"code"}` now carries `{init, slider, sample, userVars}`. All three bodies compile via `new Function` into separate fns sharing one `state` object.
  - `installCode` zero-initialises every userVar slot on `state`, then runs `@init` once, then runs `@slider` once (so slider-default-driven DSP constants are live before the first sample, matching REAPER).
  - Slider messages (`{type:"slider"}`) now also fire `@slider` if it's present — any slider drag retriggers the derived-constant recalc, which is exactly the EEL2 contract.
  - Runtime errors include a `where: "init" | "slider" | "sample"` hint so the panel can tell the user which section blew up.
  - File grew past Vite's 4 KB inline threshold, so Vite now emits it as a proper standalone asset (`jsfx-worklet-*.js`) instead of a base64 data URL. Cleaner, no more CSP speculation.
- **JsEffectNode**: `setCode` signature changed to take `{init, slider, sample, userVars}` payload. New exported `JsEffectCompileInput` interface. Status message also carries the `where` runtime-error hint through.
- **Panel (`JsEffectPanel`)** — compile pipeline + binding:
  - `compileNow()` translates all three sections, unions user vars, surfaces "@init:" / "@slider:" / "@sample:" error prefixes so the user sees which section has the problem.
  - Both `compileNow` and `bindJsEffectNode` push current slider values BEFORE `setCode`. Worklet's `installCode` runs `@init` + `@slider` synchronously on receipt, so if sliders arrive after, @slider would run against stale zeros.
  - "start audio to hear" hint shown when compiled-clean but no AudioGraph — same line as before, keeps working.
- `tsc --noEmit` clean. `npm run build` clean — 682 KB bundle, worklet now a separate ~5.5 KB asset (browser fetches it directly).

**Changed files:**
- src/runtime/jsfx/translate.ts — ^ operator, state-based user vars, body rename
- src/runtime/jsfx/jsfx-worklet.js — 3-fn install, @init/@slider execution, shared state, where-tagged errors
- src/runtime/JsEffectNode.ts — setCode payload shape, runtime-error where propagation, JsEffectCompileInput export
- src/canvas/JsEffectPanel.ts — 3-section compile, userVars union, sliders-before-code ordering on install + bind
- AGENTS.md — this entry + project-state header

**Notes / decisions made:**
- **`^` is pow, not XOR, in EEL2.** Confirmed by the ubiquitous `10^(dB/20)` pattern in the wild. Emitted as JS `**` (both right-assoc — match). Did NOT add XOR — user might need it for bitcrushers but can wait for Phase B (`a|b`, `a&b`, integer casts all needed before XOR is useful).
- **State is a plain object, not a typed array.** User vars can collide with `.u_` prefix exactly as before; emit is trivial (`state.u_gain`); serialisation isn't needed since state is per-install. Typed-array indexing would be marginally faster per access but the perf hit of property access is fine for the per-sample loop sizes AudioWorklet gives us (128 frames × 2 channels × O(10) ops).
- **@slider runs on install AND on every slider message.** Matches REAPER: `@slider` is "run when any slider changes, including at startup". This also means if @slider throws, we report and keep running — the last good state survives until the user fixes the code.
- **Slider-before-code ordering is load-bearing.** If the worklet receives `code` before the first `slider` message, `@init`/`@slider` run with sliders[]=0 and any dB→linear math produces wrong constants. The panel now always flushes sliders first, on both `compileNow` (re-send) and `bindJsEffectNode` (first bind).
- **No runtime-error throttling across sections.** If @slider throws and then @sample throws, only one gets reported (via the `runtimeErrorSent` flag). Fine for v1 — the user fixes one, the other surfaces on next reinstall. Debatable whether to unthrottle.
- **Section bodies execute with the same EEL2 subset.** No divergence. The translator doesn't know (or care) which section it's translating. Panel wraps each in its own `new Function` on the worklet side.

**Next needed:**
- User re-tests the dB-gain utility. Should hear unity at 0 dB (default), silent at −60 dB, 2× at +6 dB, 4× at +12 dB. `^` exponent math proves out.
- If good, user greenlights full Phase B: control flow (`if/while/loop`), built-in math fns (`sin cos tan exp log sqrt abs min max floor ceil pow sign`), a 3–5-effect test corpus pulled from REAPER's stock JS bundle.

**Still tabled (Phase B+):**
- `mem[]` / `gmem[]` buffers (enables delays, reverbs, IIR filters with history).
- User-defined `function` declarations.
- `@block`, `@serialize`, `@gfx` sections.
- Multi-channel variants (`spl2..spl63`).
- Comparison + logical operators, ternary.
---

---
## [2026-04-23] COMPLETED | js~ object — Phase A (scaffolding + EEL2 subset + worklet)
**Agent:** Claude Code
**Phase:** `js~` Phase A — JSFX-in-the-browser vertical slice
**Done:**
- **Plan docs** authored: `docs/JS_OBJECT_PLAN.md` (4-phase roadmap, locked scope decisions — stereo-only, EEL2 subset not full, AudioWorklet runtime, CodeMirror editor, inline two-pane expanded body) + `docs/phase-js-A-prompt.md` (execution prompt with explicit out-of-scope list + smoke-test protocol).
- **OBJECT_DEFS.`js~`** registered (audio category). Args: `code` (symbol, hidden, base64 on disk / raw in memory — same encoding as codebox). Inlets: 2× signal (L, R). Outlets: 2× signal (L, R). Default 560×280.
- **Serializer** round-trip: `serialize.ts` base64-encodes `args[0]` for `js~`; `parse.ts` decodes. Whitespace + semicolons in EEL2 survive.
- **JSFX parser** (`src/runtime/jsfx/parser.ts`): splits `desc:`, `sliderN:default<min,max[,step]>label`, and `@init` / `@slider` / `@sample` section bodies. Typed `JsfxProgram`; malformed slider lines surface as `{ok:false, error:{line,message}}` rather than throwing. Sliders sorted by index so declaration order in the GUI is stable.
- **EEL2 translator** (`src/runtime/jsfx/translate.ts`): hand-written recursive-descent. In scope: numeric literals, `spl0`/`spl1`/`sliderN`/`srate`, user identifiers (auto-declared + `u_`-prefixed to dodge JS reserved-word collisions), assignment + compound (`= += -= *= /=`), additive/multiplicative/unary expressions, parenthesised grouping, `;`-separated statements, `//` + `/* */` comments. Anything else returns a typed `JsfxTranslateError` — `if/while/loop/mem[]/functions` all flagged as "Phase B". Output: JS source string to plug into a `(L,R,sliders,srate)=>[L,R]` frame.
- **AudioWorkletProcessor** (`src/runtime/jsfx/jsfx-worklet.js`) — plain JS so Vite ships it as a loadable asset (data: URL under the 4 KB inline threshold; accepted by all modern browsers in `audioWorklet.addModule`). Message protocol: `{type:"code"}` / `{type:"slider"}` / `{type:"reset"}` in; `{type:"compiled"}` / `{type:"compile-error"}` / `{type:"runtime-error"}` out. Passthrough fallback on missing/crashing compiled fn — the audio graph never dies.
- **`JsEffectNode`** (`src/runtime/JsEffectNode.ts`): wraps `AudioWorkletNode` in a channel-merger-in / channel-splitter-out pair so upstream nodes connect stereo inputs via `(merger, fromChannel, toChannel)` and downstream via `connectOutlet(dest, outputChannel, inputIndex)` — same pattern as adc~/dac~. Status listener surface for the panel (compile/runtime errors relayed live).
- **`AudioGraph`** integration: new `jsEffectNodes` map + `jsEffectPending` set + `jsEffectReadyListeners` bus. Lazy worklet-module registration via `ensureJsfxWorklet()` — first `js~` encountered in `sync()` triggers `audioWorklet.addModule(JSFX_WORKLET_URL)`; construction is queued behind that promise, after which `rewireConnections()` runs and ready-listeners fire. `rewireConnections` handles `js~` as both sink (`dest = node.input`) and source (`connectOutlet`).
- **`JsEffectPanel`** (`src/canvas/JsEffectPanel.ts`): inline expanded body. Two-pane flexbox — left is CodeMirror (no language plugin — EEL2 isn't JS), right is the slider GUI. Header = `desc:` title, status footer shows parse/translate/runtime errors. Debounced 300 ms compile path: parse → translate → post to worklet. Slider GUI rebuilt on slider-decl diff; values survive rebuild when index stays. Slider drags flush to worklet immediately (no debounce). `stopPropagation` on wheel/mousedown so code scrolling + slider drags never pan the canvas.
- **`JsEffectPanelController`** (`src/canvas/JsEffectPanelController.ts`): lifecycle manager mirroring `DmxPanelController`. Panels survive graph re-renders via `attach`/`detach` re-parenting. `setAudioGraph()` binds late (AudioGraph isn't built until user starts audio); on bind, `mount()` re-fires so placed-while-DSP-off objects catch up.
- **ObjectRenderer** `js~` branch: emits a `pn-jseffect-panel-host` slot div; controller fills it same-frame.
- **DragController** allowlist: `.pn-jseffect-panel-host` added so clicks inside the code pane / sliders don't initiate object drag.
- **`main.ts`** wiring: controller instantiated early, `setAudioGraph` toggled in `startAudio`/`stopAudio`, `mount` + `prune` in the render pass, `destroy` in `beforeunload`.
- **CSS** (`shell.css`): `.pn-jseffect-*` block appended — panel host, header, two-pane body, CodeMirror styling (Vulf Mono, accent-colored caret, dimmed gutters), slider rows, status line with ok/error kind. All via `--pn-*` tokens; no hardcoded hex beyond a fallback on `--pn-error`.
- **Memory footprint**: `tsc --noEmit` clean. `npm run build` clean — 685 KB bundle, +5 KB over baseline. Vite dev boots clean in 151 ms.

**Changed files:**
- src/graph/objectDefs.ts — OBJECT_DEFS.`js~` entry
- src/serializer/serialize.ts — `js~` base64 encode
- src/serializer/parse.ts — `js~` base64 decode
- src/runtime/jsfx/parser.ts — new
- src/runtime/jsfx/translate.ts — new
- src/runtime/jsfx/jsfx-worklet.js — new (plain JS, not TS)
- src/runtime/JsEffectNode.ts — new
- src/runtime/AudioGraph.ts — jsEffectNodes map + async worklet loader + rewireConnections branches
- src/canvas/JsEffectPanel.ts — new
- src/canvas/JsEffectPanelController.ts — new
- src/canvas/ObjectRenderer.ts — `js~` branch emitting host slot
- src/canvas/DragController.ts — `.pn-jseffect-panel-host` allowlist
- src/main.ts — controller wiring (instantiate, setAudioGraph bindings, mount/prune, destroy)
- src/shell.css — `.pn-jseffect-*` block
- docs/JS_OBJECT_PLAN.md — new (master plan)
- docs/phase-js-A-prompt.md — new (this phase's prompt)
- AGENTS.md — this entry + project-state header

**Notes / decisions made:**
- **Name: `js~`, not `js`.** Tilde-suffix matches patchNet's convention for every audio-rate object (`adc~`, `dac~`, `fft~`, `click~`). REAPER's historical "js" name is cosmetic; the tilde carries real meaning in the patchNet graph model.
- **Plain-JS worklet file, not TS.** `AudioWorkletGlobalScope` has no module system; the file must be self-contained. Vite's `new URL(..., import.meta.url)` on a `.ts` file copies the raw TS verbatim (with type annotations intact — browser-unexecutable). Rewriting as `.js` with JSDoc types sidesteps the issue with zero Vite config changes.
- **Data: URL is fine for `addModule`.** Under Vite's 4 KB inline threshold the worklet gets base64-embedded in the main bundle. Chrome, Firefox, Safari all accept data: URLs in `audioWorklet.addModule()` (documented in the WebAudio spec; data URLs are same-origin). Tried `?url` suffix — still inlines. Can revisit with a Vite asset-inline config if the file ever grows past 4 KB or if a browser starts rejecting.
- **EEL2 subset scoped to what proves the architecture works**. Control flow and math builtins are table-stakes for real JSFX but a lot of parser/emitter code; deferring them to Phase B keeps Phase A a true vertical slice — parse → translate → worklet → audio pipeline proven end-to-end with the bare minimum.
- **User variables prefixed `u_` in emitted JS.** Cheap, complete collision-avoidance with `L`, `R`, `sliders`, `srate`, `Math`, JS reserved words, everything else the translator framework uses. User sees their name in error messages; the worklet sees the prefixed version. Alternative (sealed Proxy / with-block) adds perf cost inside the per-sample loop.
- **Worklet lifecycle is async but surfaced as synchronous to the Panel.** `AudioGraph.onJsEffectReady(nodeId, listener)` fires immediately if the node already exists, or buffers until `ensureJsfxWorklet().then()` resolves and `new JsEffectNode()` completes. Panel can set code / slider values unconditionally — they're cached until bind.
- **Per-sample state reset is acceptable for Phase A.** Real EEL2 variables persist across `@sample` calls; my emitted frame declares `let u_x = 0` every sample, so running averages / feedback lines don't work yet. That rules out chorus/flange/delay-line effects, which in Phase A is fine — those need `mem[]` anyway (Phase D). Memoryless effects (gain, ring mod, bit-reduction, tilt EQ with `@init`-initialised coefficients in Phase B) all work without cross-sample persistence.
- **Four KB inline threshold exposed a real design question.** If the worklet grows past ~4 KB (certain with Phase B builtins), it'll move to a separate asset automatically — no code change needed. Good hygiene, not a blocker.

**Next needed (user smoke test):**
1. Fresh page → drop `adc~` → `js~` → `dac~`, cable them L→L, R→R on both hops.
2. Start audio. The `js~` body should show an empty CodeMirror pane + "no sliders declared" placeholder.
3. Paste:
   ```
   desc:trivial gain
   slider1:1<0,2,0.01>gain

   @sample
   spl0 *= slider1;
   spl1 *= slider1;
   ```
   Within ~300 ms: status line goes green ("ok — 1 slider"), title becomes "js~ — trivial gain", a "gain" slider appears on the right.
4. Drag the slider from 0 → 2. Audio should go silent → 2× gain, smoothly. Passthrough is audible when slider = 1.
5. Paste gibberish (e.g. `spl0 ~= 3`). Status goes red with "line N: unsupported character '~'…". Audio stays at the last good state — does NOT cut out.
6. Fix the typo. Status goes green again; audio resumes with the new code.
7. Save patch to file → reload page → re-open. Code + slider value both restored. Start audio, gain still works.
8. Try a ring mod: `slider1:440<20,2000,1>freq` + `@sample` with `tp = 0; tp += 2*3.14159*slider1/srate; spl0 *= 0; spl1 *= 0;` (a reminder: no persistent vars in Phase A, so a real ring mod needs Phase B). Instead try: `spl0 *= 0.5; spl1 *= 0.5;` — should halve.

**Follow-ups captured as Phase B / C / D in `docs/JS_OBJECT_PLAN.md`:**
- Phase B: `@init` + `@slider` execution, control flow (`if/while/loop`), all built-in math fns, proper variable persistence across `@sample` invocations, 3–5-effect test corpus.
- Phase C: slider type variants (log, enum), proper error pane with line numbers, structured error outlet, `desc:` → object title on canvas.
- Phase D: `mem[]` buffer (unlocks delays/reverbs), user `function`, multi-channel variants, `@block`/`@serialize`.
---

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

---
## [2026-04-23] COMPLETED | `browser~` object (audio L/R + video outlets)
**Agent:** Claude Code
**Phase:** browser~ Phase A + B (see `docs/browser-object-plan.md`)
**Done:**
- `BrowserNode` runtime: getDisplayMedia → ChannelSplitter → L/R outlets (mirrors `AdcNode` shape) + hidden `<video>` srcObject for the video outlet.
- Registered `browser~` in `objectDefs.ts` with 3 outlets (signal L, signal R, media video) and a message inlet (navigate / capture / release).
- Wired into `AudioGraph` sync + rewire (outlets 0/1 audio only; outlet 2 handled downstream).
- Extracted `MediaVideoSource` interface from `MediaVideoNode` so `LayerNode`, `vfxCRT`, `vfxBlur` accept either the file-backed video node OR the captured-tab node structurally.
- Wired `browser~` outlet 2 into `VisualizerGraph.rewireMedia()` at all three consumer sites (layer / vfxCRT / vfxBlur) via a new `setBrowserNodeLookup` setter.
- `BrowserPanel` + `BrowserPanelController`: URL bar, sandboxed iframe preview with CSP-block hint, capture / release buttons, live status line. Follows `JsEffectPanel` lifecycle pattern.
- `ObjectRenderer` emits `[data-browser-panel-host]`; `main.ts` wires the controller like the js~ controller (setAudioGraph, mount, prune, destroy).
- CSS in `shell.css` under the jseffect section.
- Serialization: `args = [url, captureOnLoad]` — plain strings, round-trips through the default serializer/parser branch.

**Changed files:**
- `src/runtime/BrowserNode.ts` (new) — audio+video capture node.
- `src/canvas/BrowserPanel.ts` (new) — inline panel UI.
- `src/canvas/BrowserPanelController.ts` (new) — panel lifecycle manager.
- `src/graph/objectDefs.ts` — registered `browser~`.
- `src/runtime/AudioGraph.ts` — integrated BrowserNode (create/destroy/rewire/meter) + `getBrowserNode()` accessor.
- `src/runtime/MediaVideoNode.ts` — added `MediaVideoSource` interface.
- `src/runtime/LayerNode.ts` — widened `mediaVideo` field to `MediaVideoSource`.
- `src/runtime/VisualizerGraph.ts` — `setBrowserNodeLookup` + `browser~` branches in vfxCRT / vfxBlur / layer wiring.
- `src/canvas/ObjectRenderer.ts` — browser~ body host slot.
- `src/main.ts` — controller lifecycle + browser-node lookup plumbing.
- `src/shell.css` — `.pn-browser-*` styles.

**Notes / decisions made:**
- Browser security requires a user gesture for `getDisplayMedia`, so capture is panel-button-triggered, not auto-started on node creation or DSP start. `captureOnLoad` arg is reserved for a future "resume capture prompt" UX but currently only persists the last known capture state.
- Iframe preview and tab capture are intentionally decoupled: the iframe shows whatever URL the user typed (works for embed-friendly sites), while the outlets are driven by whichever tab the user picked in the native `getDisplayMedia` picker. One bundled object as agreed with Director.
- `setBrowserNodeLookup` pattern (instead of giving VisualizerGraph a direct AudioGraph reference) matches the existing one-way coupling style in the codebase.

**Next needed:**
- Manual smoke test in browser: `[browser~ https://youtube.com] → [dac~]` for audio, `[browser~] outlet 2 → [vFX.crt] → [layer] → [visualizer]` for video.
- Phase C polish (deferred): cached tab thumbnail, resume-capture UX, URL autocomplete.
---
