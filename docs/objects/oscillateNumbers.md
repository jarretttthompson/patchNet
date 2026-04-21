---
type: oscillateNumbers
category: control
version: 1
---

# oscillateNumbers

Continuous sine-wave oscillator that outputs floats in `[0.0, 1.0]`. Requires a gate (float `1` to start, `0` to stop).

---

## Arguments

| # | name    | type  | default | description |
|---|---------|-------|---------|-------------|
| 0 | freq    | float | 1       | Oscillation frequency in Hz (cycles per second). |
| 1 | running | int   | 0       | Hidden. Persisted running state (1 = oscillating, 0 = stopped). |

---

## Inlets

| # | type  | temperature | accepts                                  | description |
|---|-------|-------------|------------------------------------------|-------------|
| 0 | any   | hot         | `float 1` / `float 0` / `bang` / `freq <hz>` | Gate + frequency control. Nonzero float starts, zero stops, bang toggles. |
| 1 | float | cold        | `float`                                  | Set frequency (Hz). Restarts phase if already running. |

---

## Outlets

| # | type  | description |
|---|-------|-------------|
| 0 | float | Current oscillator value in `[0.0, 1.0]`, emitted once per animation frame. |

---

## Messages

| inlet | selector | args     | effect |
|-------|----------|----------|--------|
| 0     | bang     | —        | Toggle running on/off. |
| 0     | float    | `<0\|1>` | `1` starts, `0` stops. |
| 0     | freq     | `<hz>`   | Set frequency; restarts phase if currently running. |
| 1     | float    | `<hz>`   | Set frequency; restarts phase if currently running. |

---

## Examples

Canonical gated-oscillator patch: a `toggle` enables the oscillator, a `slider` controls frequency, a `float` box displays the output.

```
#N canvas;
#X obj 100 100 toggle;
#X obj 180 100 oscillateNumbers 1 0;
#X obj 180 160 float;
#X obj 180 60 slider 10 1 2000;
#X connect 0 0 1 0;
#X connect 1 0 2 0;
#X connect 3 0 1 1;
```

---

## Notes

- Output rate is driven by `requestAnimationFrame` (~60 Hz), independent of `freq`. The `freq` parameter controls how fast the sine wave oscillates, not how often values are emitted.
- Phase resets to 0 whenever the oscillator (re)starts — including when `freq` changes via inlet 1 while running. If you need phase continuity through frequency changes, use a downstream smoother.
- The oscillator does nothing while the gate is off — no residual output, last emitted value lingers on any downstream display.
- Related: `metro` (discrete bang ticks), `slider` (manual value source), `scale` (remap output to a different range).

---

<!--
Keep this file parseable by the Reference tab loader (Part 5).
Required frontmatter: type, category, version.
Section headings (Arguments / Inlets / Outlets / Messages / Examples / Notes)
are read by the loader — do not rename them.
-->
