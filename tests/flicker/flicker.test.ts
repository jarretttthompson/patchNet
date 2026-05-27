import { describe, it, expect } from "vitest";
// run.mjs is plain Node (spawns Chrome / a dev server) — no TS build needed.
import { runFlicker } from "./run.mjs";

/**
 * Browser-level regression gate for the Tier 1.3 "source-unchanged skip"
 * optimization (commit d129bf3 — VfxCrtNode / VfxBlurNode).
 *
 * Opt-in: this test spawns a real headless Chrome (and, if no dev server is
 * running, a Vite server), so it is skipped during the normal `npm test`
 * run. Enable it explicitly:
 *
 *   PATCHNET_FLICKER=1 npx vitest run tests/flicker
 *
 * or run the standalone gate, which needs no vitest:
 *
 *   node tests/flicker/run.mjs
 */
const ENABLED = process.env.PATCHNET_FLICKER === "1";

describe.skipIf(!ENABLED)("VFX-chain flicker (Tier 1.3 source-unchanged skip)", () => {
  it(
    "paused VFX chain output is pixel-stable, and the probe detects motion",
    async () => {
      const result = await runFlicker({ log: () => {} });

      // Surface the probe's own failure message verbatim on assertion failure.
      expect(result.failure ?? "no failure").toBe("no failure");
      expect(result.ok).toBe(true);

      // Positive control: output MUST change while playing, otherwise a
      // "stable" paused result would be meaningless.
      expect(result.playing?.distinct ?? 0).toBeGreaterThan(1);

      // The actual assertion: every paused sample hashes identically.
      expect(result.paused?.distinct).toBe(1);
    },
    180_000,
  );
});
