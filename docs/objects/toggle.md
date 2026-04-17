---
type: toggle
category: ui
version: 1
---

# toggle

Two-state UI toggle that outputs `0.0` or `1.0`.

---

## Arguments

| # | name | type | default | description |
|---|------|------|---------|-------------|
| 0 | `value` | int | `0` | Initial on/off state (`0` or `1`). |

---

## Inlets

| # | type | temperature | accepts | description |
|---|------|-------------|---------|-------------|
| 0 | any | hot | `bang`, `float`, `value <0\|1>` | `bang` flips state; `float` sets state from zero/nonzero; `value` attribute sets explicitly. |

---

## Outlets

| # | type | description |
|---|------|-------------|
| 0 | float | Current state as `0.0` (off) or `1.0` (on). Emitted whenever state changes. |

---

## Messages

| inlet | selector | args | effect |
|-------|----------|------|--------|
| 0 | `bang` | — | Flip current state and output float. |
| 0 | `float` | `<number>` | Zero → off; nonzero → on. Output float. |
| 0 | `value` | `0` or `1` | Attribute-style setter — sets state without toggling. |

---

## Examples

```
#N canvas;
#X obj 100 100 button;
#X obj 100 160 toggle 0;
#X obj 100 220 message on;
#X connect 0 0 1 0;
#X connect 1 0 2 0;
```

Each button press flips the toggle; the toggle's float output drives downstream logic.

---

## Notes

- Clicking the toggle is equivalent to sending it a `bang`.
- Unlike `button`, the toggle's visual state persists — the filled X mark reflects the stored value.
- Useful as a gate upstream of `metro` (`float 1` starts, `float 0` stops).
- For a momentary trigger instead of a latched state, use `button`.
