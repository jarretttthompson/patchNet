---
type: metro
category: control
version: 1
---

# metro

Interval timer that emits bangs at a fixed rate using `setInterval`.

---

## Arguments

| # | name | type | default | description |
|---|------|------|---------|-------------|
| 0 | `interval` | float | `500` | Interval in milliseconds (min `1`, max `10000`). |
| 1 | `running` | int | `0` | Hidden — timer running state (`1` = running, `0` = stopped). Persisted for round-trip. |

---

## Inlets

| # | type | temperature | accepts | description |
|---|------|-------------|---------|-------------|
| 0 | any | hot | `bang`, `float`, `interval <ms>` | `bang` toggles start/stop; `float 1`/`float 0` starts/stops explicitly; `interval` sets rate. |
| 1 | float | cold | `float` | Sets interval in ms. Restarts the timer if it was already running. |

---

## Outlets

| # | type | description |
|---|------|-------------|
| 0 | bang | Emits `bang` on each tick while running. |

---

## Messages

| inlet | selector | args | effect |
|-------|----------|------|--------|
| 0 | `bang` | — | Toggle timer: starts if stopped, stops if running. |
| 0 | `float` | `1` or `0` | `1` starts, `0` stops. |
| 0 | `interval` | `<ms>` | Set interval in milliseconds. |
| 1 | `float` | `<ms>` | Set interval in milliseconds; restart if running. |

---

## Examples

```
#N canvas;
#X obj 100 100 toggle 0;
#X obj 100 160 metro 250;
#X obj 100 220 button;
#X connect 0 0 1 0;
#X connect 1 0 2 0;
```

Flipping the toggle on starts a 250 ms metronome that fires the button four times a second.

---

## Notes

- Uses `setInterval` — not sample-accurate. For audio-rate timing, use a signal-domain object (when available).
- Interval clamps to `[1, 10000]` ms. Values outside the range are rejected at arg set.
- The hidden `running` arg round-trips through serialization, so a metro saved while running comes back running on reload.
- `bang` as a toggle verb is a Pure Data convention — Max/MSP uses `int 1 / int 0` instead.
- For one-shot delayed bangs, use `delay` (not yet implemented) rather than start/stop-gating a metro.
