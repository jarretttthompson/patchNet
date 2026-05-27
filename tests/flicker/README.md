# Flicker probe — VFX-chain visual regression gate

Automated browser-level check that the **Tier 1.3 "source-unchanged skip"**
optimization (commit `d129bf3` — `VfxCrtNode` / `VfxBlurNode`) does not cause
visual flicker on a paused video source.

## Why this exists

The skip path early-returns out of `process()` when a VFX node's input
identity is unchanged (paused video → stable `currentTime`; chained VFX →
stable `outputVersion`). When correct, the node keeps its last rendered frame
and the composited output is pixel-stable. A regression — the skip leaving a
cleared or stale canvas — would show as a *changing* pixel hash on a paused
source.

`vitest` runs under a non-rendering DOM, so it cannot see this. The probe
drives the **real app in a real headless Chrome** over the Chrome DevTools
Protocol and hashes actual rendered pixels.

## How it works

1. Seeds `localStorage` with a minimal patch carrying the venue VFX topology:
   `mediaVideo → vfxBlur → vfxCRT → vfxCRT → layer → patchViz`
   (`patchViz` renders inline, so no popup window and no audio graph needed).
2. Reloads; waits for the app + the test video to be ready.
3. **Plays** the video and samples the `patchViz` canvas hash repeatedly — the
   hashes *must* change. This is the probe's own sanity check: it proves the
   pipeline renders and that the probe can detect motion, so a later "stable"
   result cannot be a false pass from a dead/black canvas.
4. **Pauses**, lets the chain settle, samples N times — every sample *must* be
   identical, and the canvas *must* still hold real video content.

The probe owns a **dedicated, isolated Chrome** (its own `--user-data-dir` and
an OS-assigned debug port). Two DevTools clients on one port wedge Chrome —
that is what hung an earlier probe attempt.

## Running it

```bash
# Standalone gate — no vitest. Reuses a running dev server (:5173) or spawns
# its own; spawns + tears down its own Chrome. Exits 0 (pass) / 1 (fail).
npm run test:flicker
# == node tests/flicker/run.mjs

# As a vitest test (opt-in — skipped by default so `npm test` stays fast):
PATCHNET_FLICKER=1 npx vitest run tests/flicker
```

`npm test` skips this suite — it needs a real Chrome and is heavyweight.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PATCHNET_BASE_URL` | reuse `:5173`, else spawn | Existing dev-server URL to test against. |
| `CHROME_BIN` | `google-chrome` | Path to the Chrome/Chromium binary. |
| `PATCHNET_FLICKER_SAMPLES` | `24` | Pixel samples taken while paused. |
| `PATCHNET_FLICKER` | unset | Set to `1` to un-skip the vitest suite. |

## Files

| File | Role |
|------|------|
| `cdp.mjs` | Minimal Chrome DevTools Protocol client over a WebSocket. |
| `gen-clip.mjs` | Generates `clip.webm` in-browser via MediaRecorder (no ffmpeg). |
| `probe.mjs` | The probe: seeds the patch, drives play/pause, hashes pixels. |
| `run.mjs` | Lifecycle runner — server + Chrome + clip + probe + teardown. |
| `flicker.test.ts` | Opt-in vitest wrapper. |
| `clip.webm` | Generated test video (git-ignored; regenerated if missing). |

The test clip is a small VP8/WebM with deliberately distinct frames, encoded
by Chrome itself (this box has no ffmpeg). Delete it to force regeneration.

## Verifying the gate has teeth

The probe was validated by injecting a per-frame draw into
`VfxCrtNode.process()` (a simulated flicker regression): the probe failed with
**23 distinct hashes across 24 paused samples**. Reverting restored a clean
pass (1 distinct hash). The "must change while playing" positive control means
a passing run cannot be a false pass from a blank canvas.
