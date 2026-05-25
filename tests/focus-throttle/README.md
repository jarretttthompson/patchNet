# Focus-throttle probe — audio analysis under background-rAF throttle

Automated browser-level check that the **meter-loop host swap**
(`src/main.ts:startMeterLoop` + `VisualizerRuntime.onPopupStateChange`) keeps
AnalyserNode reads firing at full rate when the main patchNet window is
backgrounded by a fullscreened visualizer popup.

## Why this exists

Before the fix, all AnalyserNode reads (`fft~`, scopes, mixer meters, all
audio-reactive outlet propagation) ran inside a single `requestAnimationFrame`
loop hosted on `window` (the main patchNet window). When a visualizer popup
went fullscreen and stole focus, Chrome backgrounded the main window and
throttled its rAF to ~1 Hz. The popup's own draw loop kept rendering at 60 fps,
but with frozen audio data — visuals looked "stuck on the last frame" even
though the canvas was drawing fresh frames every time.

After the fix, the meter loop hosts on the first open popup's rAF when one
exists, and falls back to `window` when none is open. The popup's rAF stays
un-throttled because the popup is the foreground window.

`vitest` runs under jsdom — no `window.open`, no real focus model, no
background throttling. This gap can only be closed in a real Chrome.

## How it works

The probe shares the flicker probe's lifecycle pattern (isolated headless
Chrome, OS-assigned debug port, owned `--user-data-dir`).

1. Seeds `localStorage` with a minimal patch:
   `noise~ → fft~ 4 → float`, plus a `visualizer*` object.
2. Loads the app, starts audio (via a CDP-injected user-gesture click).
3. Opens the visualizer popup via the `__patchnetTest` DEV hook (also
   user-gesture-scoped — popup.open requires it).
4. **Positive phase** — host should be `popup`. Monkey-patches `window.requestAnimationFrame`
   to ~1 Hz on the *main* window (simulates Chrome's background-tab throttle
   transparently — preserves the rAF ID/cancel contract). Resets the meter-tick
   counter. Waits 2 seconds. Counter must be ≥30 (proves the meter loop is
   running on the popup's un-throttled rAF, not the throttled main rAF).
5. **Negative-control phase** — closes the popup so the loop re-hosts to the
   throttled main window (handled by the existing 1 Hz watchdog or the popup
   state notification). Resets counter. Waits 2 seconds. Counter must be ≤5
   (proves the throttle simulation is real — the same probe against the
   pre-fix code would land here permanently and fail the positive phase).
6. Verdict: positive ≥30 AND negative ≤5 → PASS. Either threshold violated → FAIL.

The two phases together close the loop: positive proves the host swap works;
negative proves the throttle simulation actually throttles. A single-phase
positive test would silently pass against a no-op fix if the throttle wrapper
were broken — running both at the end of each invocation forecloses that.

## Running it

```bash
# Standalone gate — no vitest. Reuses :5173 if running, else spawns its own.
npm run test:focus-throttle
# == node tests/focus-throttle/run.mjs
```

The probe needs the app to be served by `vite dev` (the `__patchnetTest` hook
is gated on `import.meta.env.DEV` — production builds don't ship it).

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PATCHNET_BASE_URL` | reuse `:5173`, else spawn | Existing dev-server URL. |
| `CHROME_BIN` | `google-chrome` | Path to the Chrome/Chromium binary. |
| `PATCHNET_FT_WINDOW_MS` | `2000` | Measurement window for each phase. |

## Files

- `probe.mjs` — the two-phase test logic.
- `run.mjs` — Chrome + dev-server lifecycle (shares the flicker probe's pattern).
