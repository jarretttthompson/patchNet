---
type: button
category: ui
version: 1
---

# button

Momentary trigger that flashes and sends a bang.

---

## Arguments

| # | name | type | default | description |
|---|------|------|---------|-------------|
| — | — | — | — | No arguments. |

---

## Inlets

| # | type | temperature | accepts | description |
|---|------|-------------|---------|-------------|
| 0 | bang | hot | `bang` | Flashes the button and dispatches a bang on outlet 0. |

---

## Outlets

| # | type | description |
|---|------|-------------|
| 0 | bang | Emits `bang` every time the button is clicked or receives input. |

---

## Messages

| inlet | selector | args | effect |
|-------|----------|------|--------|
| 0 | `bang` | — | Flash + dispatch bang. |

---

## Examples

```
#N canvas;
#X obj 100 100 button;
#X obj 100 160 message hello;
#X connect 0 0 1 0;
```

Clicking the button sends a bang into the `message` box, which then prints `hello`.

---

## Notes

- Click-to-fire is the primary interaction — no drag behavior.
- The flash animation is purely visual; the bang is dispatched synchronously on click.
- Use `toggle` instead if you need a state that persists between clicks.
- Use `metro` upstream if you want automatic periodic bangs.
