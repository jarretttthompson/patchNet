# Object Scaling + No-Overlap Plan

**Status:** Planned (2026-04-28).

Two related quality-of-life improvements that touch every object in the
canvas:

1. **Part A — Uniform body scaling.** Make every object's body content
   scale together when the user resizes the object, the way `buffer~` now
   does. Text should never overflow the object box.
2. **Part B — No-overlap drag/resize/place.** Prevent two objects from
   sharing canvas space, with `frame~` as the documented exception.

The two parts are independent and can land in either order, but both touch
the canvas controllers, so it's cheaper to plan them together.

---

## Part A — Uniform body scaling

### Goal

User-visible: when you resize any object larger, the entire body (title,
ports labels, custom widgets, waveforms, meters, info rows, etc.) scales
together. Nothing overflows. Nothing stays pixel-anchored to a corner.

Non-goal: making every object look identical at every size. We're scaling
the existing visual language, not redesigning bodies.

### Current state

`buffer~` already uses the target pattern:

```css
.patch-object-buffer-body {
  position: relative;
  padding: 0;
  overflow: hidden;
  container-type: size;
}
.pn-buf-stage {
  position: absolute; top: 0; left: 0;
  width:  220px;          /* = defaultWidth  */
  height: 110px;          /* = defaultHeight */
  transform-origin: top left;
  transform: scale(min(calc(100cqw / 220px), calc(100cqh / 110px)));
}
```

The body is a size-container; the stage is a fixed-size design surface
that's transform-scaled uniformly to fill the body. One ratio scales
every font, gap, button, and embedded canvas at once.

### The three object categories

Not every object should use transform-scale. Three real groups:

#### A1. Transform-scale (the `buffer~` pattern)

Objects whose body has a "design size" with fixed content. Apply the
container-type + stage pattern verbatim. This is the bulk of the catalog.

| Object | Notes |
|---|---|
| math ops (`+ - * / %  == != < > <= >=`) | title-only |
| `s`, `r`, `t`, `metro` | title-only (`metro` has a meta value) |
| `click~` | title + `~>` glyph |
| `integer`, `float` | odometer drum columns — currently scale awkwardly |
| `button` | circle face |
| `toggle` | wall-plate rocker |
| `slider` | hslider track |
| `mediaImage` | polaroid frame |
| `mediaVideo`, `visualizer`, `layer`, `shaderToy`, `patchViz`, `imageFX` | visual label + sub-label |
| `fft~` | the device-bezel block |
| `adc~`, `dac~` | meter strips with icon |
| `inlet`, `outlet` | iolet label |
| anonymous default | title-only objects we haven't enumerated |
| `buffer~` | **already done** |

Standard recipe per object:

1. Wrap existing body content in a `<div class="pn-{type}-stage">`.
2. Add `container-type: size` + `overflow: hidden` to the body class.
3. Add the stage CSS with `width`/`height` matching the object's
   `defaultWidth`/`defaultHeight` from `OBJECT_DEFS`.
4. Add `transform: scale(min(calc(100cqw / Wpx), calc(100cqh / Hpx)))`
   on the stage.

A small CSS helper class can centralize the boilerplate so each object
only declares its design size:

```css
.pn-stage {
  position: absolute; top: 0; left: 0;
  box-sizing: border-box;
  transform-origin: top left;
  transform: scale(min(
    calc(100cqw / var(--pn-stage-w)),
    calc(100cqh / var(--pn-stage-h))
  ));
}
.pn-stage-host {                /* applied to the body element       */
  position: relative;
  padding: 0;
  overflow: hidden;
  container-type: size;
}
```

Each object then sets `--pn-stage-w` and `--pn-stage-h` inline (or via a
per-type class), and `ObjectRenderer` wraps content in `<div class="pn-stage">`.
Net: one stylesheet block + a tiny renderer wrapping helper.

#### A2. Flex-reflow — leave alone

These are already responsive-by-content; transform-scale would actually
break them.

| Object | Why it self-fits today |
|---|---|
| `comment` | grows with text length; no body rewrite needed |
| `message` | same; auto-sizes to content |
| `sequencer` | `grid-template-rows/cols` already fills; cells reflow |

Verify these are not regressed by Part B (no-overlap) and otherwise no work.

#### A3. Panel-managed — owner handles

Objects whose body hosts a controller-managed inline panel. The panel
already manages its own resize behavior. Don't transform-scale the body
(it would also scale the controller's interactive panel, which would
break hit-testing and the controller's own measurement assumptions).

| Object | Owner |
|---|---|
| `codebox` | `CodeboxController` (CodeMirror) |
| `js~` | `JsEffectPanelController` |
| `reaperVideo` | `ReaperVideoPanelController` |
| `dmx` | `DmxPanelController` |
| `mixer~` | `MixerPanelController` |
| `browser~` | `BrowserPanelController` (no resize handle) |
| `youtube~` | `YouTubePanelController` (no resize handle) |
| `frame~` | `FramePanelController` |
| `subPatch` | `SubPatchManager` |

For these, the action is: confirm the controller's layout already fills
its host (`.pn-*-panel-host`). Most do; if any don't, the fix is in the
controller's CSS, not the global pattern.

### Phasing

| Phase | Work | Exit |
|---|---|---|
| **A.1** | Add `.pn-stage` + `.pn-stage-host` helpers to `shell.css`. Migrate one A1 object as the proof (suggest `integer`/`float` since the user has hit it the hardest). | Resize an `integer` from 60×40 to 200×120 — drum digits scale with the object. |
| **A.2** | Migrate the remaining title-only A1 objects (math ops, `s`/`r`/`t`/`metro`, `click~`, default-titled). | All title objects scale uniformly when resized; no text clips. |
| **A.3** | Migrate widget A1 objects (`button`, `toggle`, `slider`, `inlet`/`outlet` labels, `adc~`/`dac~` meter strips). | Same. |
| **A.4** | Migrate visual-label A1 objects (`mediaImage`, `mediaVideo`, `visualizer`, `layer`, `shaderToy`, `patchViz`, `imageFX`). | Same. |
| **A.5** | Migrate `fft~` device frame. | FFT screen + bands + d-pad all scale together. |
| **A.6** | Audit Category A3 panel hosts; fix any that don't fill their host. | All panel-managed objects look correct at any size. |

A.1 is the load-bearing one (proves the pattern + helper). After that
each phase is mechanical.

### Known tradeoffs

- **Canvas bitmaps blur when scaled up.** `buffer~` waveform canvas is
  200×36 intrinsic; transform-scale upsamples it. Acceptable for the
  phosphor aesthetic; if any specific object needs crisp scaling, swap
  to a `ResizeObserver` that resizes the canvas backing store. Not
  blocking.
- **Subpixel font hinting changes.** Vulf Mono renders fine scaled in
  practice. If a specific size is bad we can pin a `font-size` floor.
- **Scaled hit-targets stay clickable** — `transform: scale` does not
  break pointer events (verified on `buffer~`).
- **A.1 design size must match defaults.** If the user has an in-flight
  patch where they previously resized an object, the scale ratio will be
  applied to whatever the saved width/height is. That's correct: their
  custom size still fills; the content scales to fit.

---

## Part B — No-overlap on drag / resize / place

### Goal

Two object AABBs cannot overlap, with documented exceptions. Applies to:
- Single-object drag
- Multi-object drag (selection or group)
- Cmd+drag duplicate
- Resize handle drag
- Object creation (`n` key, autocomplete, paste, undo, deserialize)
- Programmatic `setNodePosition`

### Exceptions (overlap allowed)

| Object | Why |
|---|---|
| `frame~` | Its job is to overlay arbitrary regions and capture their pixels. |
| `comment` | Annotation that points at other objects; should sit on top. |
| `subPatch` panel mount in presentation mode | Panel is meant to overlay GUI children. |

These are configured by a single predicate `objectIgnoresOverlap(type)`
exported from `objectDefs.ts` so the rule is one-touch. An object whose
type is in the ignore set neither blocks others nor is blocked.

(Open question: do we want `subPatch` itself in the exception list, or
only its inner presentation panel? Default proposal: only the inner
panel, since `subPatch` objects on a parent canvas are normal nodes.)

### Geometry rule

Strict AABB overlap. Two boxes overlap when:

```
a.x < b.x + b.w  &&  a.x + a.w > b.x  &&
a.y < b.y + b.h  &&  a.y + a.h > b.y
```

Touching edges (`a.x + a.w === b.x`) are allowed — that's the natural
"snap" feel for densely packed patches.

### Behavior on collision: **block, don't slide**

When a drag would push an object into a collision, the move stops at the
last valid frame. This matches Figma / Affinity / the canvas tooling
users already know. "Soft push" / "slide along the colliding edge" is
nicer but ~3× the code; defer to a v2 if requested.

### Multi-object drag rule

When dragging a multi-selection or a group, evaluate the entire group's
new bounds against the rest of the canvas. If **any** member would
collide with **any** non-member, the whole group stops at its last valid
position. Members within the group don't collide with each other (they
were already overlapping or adjacent).

### Where to enforce

Single source of truth: a small `OverlapGuard` module
(`src/canvas/OverlapGuard.ts`) with one entry point:

```ts
overlapGuard.allowMove(
  movingIds: Set<string>,
  proposed: Map<string, {x: number; y: number; w: number; h: number}>,
): boolean
```

Returns `true` iff none of the proposed boxes overlap any non-moving
non-exception object's current box.

Call sites:

| File | Hook | Action on `false` |
|---|---|---|
| `DragController.handleMouseMove` | per-frame, before writing `el.style.left/top` | snap back to last valid x/y for primary + co-movers; don't update |
| `DragController.handleMouseUp` | sanity check before commit | identical — drop to last valid |
| `ResizeController` (commit fn) | before `setNodeSize` commits | clamp w/h to last valid size |
| `PatchGraph.addNode` | before insert | reject (or auto-shift to nearest free slot — see open question) |
| `PatchGraph.duplicateNodes` | before commit | shift clones by `(20, 20)` until non-overlapping |
| `PatchGraph.deserialize` | not enforced | trust the saved file as authoritative |

### Decisions (locked 2026-04-28)

1. **`comment` is exempt** from no-overlap (annotations sit over patches).
2. **Group drag blocks the whole group** — selection moves rigidly; if
   any member would collide, the entire group stops at its last valid
   position.
3. **`addNode` auto-shifts** down-right by 20px until free.
4. **Resize collision clamps** size at the last non-colliding extent.
5. **Blocked-drag visual feedback:** phosphor pulse (~200ms) on the
   edge of the obstacle the move collided with.

Final exception set for no-overlap: `frame~`, `comment`, and the
in-canvas subPatch presentation panel.

### Phasing

| Phase | Work | Exit |
|---|---|---|
| **B.1** | `OverlapGuard.allowMove` + `objectIgnoresOverlap` predicate. Wire into `DragController` only. | Drag a `bang` toward a `metro` — drag stops at the boundary. Drag a `frame~` over the same `metro` — passes through. |
| **B.2** | Wire into `ResizeController` (clamp). | Resize a `metro` rightward — when the right edge hits an adjacent object, it stops growing. |
| **B.3** | Wire into `PatchGraph.addNode` + `duplicateNodes` (auto-shift). | `n bang` over an existing object places ~20px down-right. Cmd+drag-duplicate clones cascade out. |
| **B.4** *(optional)* | Visual feedback flash. | Blocked drag flashes the colliding edge of the obstacle. |

B.1 is the load-bearing phase; B.2–B.4 are independent improvements.

---

## Sequencing recommendation

Do **A.1** (the helper + one object proof) first — it's small, it's the
the highest-information bet, and it locks in the pattern before we
mass-migrate. Then **B.1** — landing the no-overlap drag is a single
controller change with high QoL payoff. After that, A.2–A.5 can stream
in as background work, and B.2–B.4 follow user feedback.

---

*Plan complete. Both parts are mechanically straightforward once the
helper class lands; the open questions in Part B are the only places
that need explicit user direction before coding.*
