---
type: noise~
category: audio
version: 1
---

# noise~

Continuous procedural noise source. Outputs white, pink, or brown noise at audio rate.

## Arguments

| # | name | type | default | description |
|---|------|------|---------|-------------|
| 0 | color | symbol | white | Noise color: `white`, `pink`, or `brown`. |
| 1 | level | float | 0.25 | Output level, clamped to 0..1. |

## Inlets

| # | type | description |
|---|------|-------------|
| 0 | any | Control inlet. Accepts `color <name>`, `level <float>`, a bare color name, or a bare float as level shorthand. |

## Outlets

| # | type | description |
|---|------|-------------|
| 0 | signal | Continuous noise signal. |

## Messages

| inlet | selector | args | description |
|-------|----------|------|-------------|
| 0 | color | `white\|pink\|brown` | Set the generated noise spectrum. |
| 0 | level | `float` | Set output level, clamped to 0..1. |
| 0 | float | `float` | Shorthand for `level <float>`. |
| 0 | white/pink/brown | none | Shorthand for `color <name>`. |

## Examples

```text
#N canvas;
#X obj 80 80 noise~ white 0.25;
#X obj 240 80 dac~ 2;
#X connect 0 0 1 0;
#X connect 0 0 1 1;
```

```text
#N canvas;
#X obj 80 80 noise~ pink 0.4;
#X obj 240 80 adsr~ 20 80 0.6 180 250;
#X obj 460 80 dac~ 2;
#X connect 0 0 1 0;
#X connect 1 0 2 0;
```

## Notes

- `white` is full-band random noise.
- `pink` uses a lightweight 1/f filter, useful for smoother modulation or less harsh broadband sound.
- `brown` uses integrated noise, weighted toward low frequencies.
- `noise~` starts producing signal as soon as DSP is on; keep `level` low when patching directly to `dac~`.
