/**
 * Flicker probe — verifies the Tier 1.3 "source-unchanged skip" optimization
 * (commit d129bf3, VfxCrtNode / VfxBlurNode) does not cause visual flicker on
 * a paused video source.
 *
 * The skip path early-returns out of process() when a VFX node's input
 * identity is unchanged (paused video → stable currentTime; chained VFX →
 * stable outputVersion). Correct behaviour: the node keeps its last rendered
 * frame, so the composited output is pixel-stable. A regression — e.g. the
 * skip leaving a cleared/stale canvas — would show as a *changing* pixel hash
 * on a paused source.
 *
 * vitest (jsdom) cannot render canvas, so this gap can only be closed in a
 * real browser. The probe drives the real app over CDP:
 *
 *   1. Seed localStorage with a minimal patch carrying the venue VFX
 *      topology:  mediaVideo → vfxBlur → vfxCRT → vfxCRT → layer → patchViz.
 *   2. Reload; wait for the app + the test video to be ready.
 *   3. PLAY, sample the patchViz canvas hash repeatedly — the hashes MUST
 *      change. This is the probe's own sanity check: it proves the pipeline
 *      renders and that the probe can actually detect motion, so a later
 *      "stable" result cannot be a false pass from a dead/black canvas.
 *   4. PAUSE, let the chain settle, sample the hash N times — every sample
 *      MUST be identical (and the canvas MUST hold real content).
 */

/** Build a minimal .patchnet carrying the venue VFX chain topology. */
export function buildVenuePatch(clipUrl) {
  // Serial indices are object creation order; #X connect references them.
  //   0 mediaVideo  1 vfxBlur  2 vfxCRT  3 vfxCRT  4 layer  5 patchViz
  const lines = [
    "#N canvas;",
    `#X obj 60 60 mediaVideo* ${clipUrl} clip.webm play;`,
    "#X name 0 mediaVideo1;",
    "#X obj 60 180 vfxBlur* 2 1 1;",
    "#X name 1 vfxBlur1;",
    "#X obj 60 300 vfxCRT* 0.35 0.45 1.5 0.15 1;",
    "#X name 2 vfxCRT1;",
    "#X obj 60 420 vfxCRT* 0.35 0.45 1.5 0.15 1;",
    "#X name 3 vfxCRT2;",
    "#X obj 60 540 layer* world1 0 1 1 0 0 1;",
    "#X name 4 layer1;",
    "#X obj 420 60 patchViz world1 1;",
    "#X name 5 patchViz1;",
    "#X connect 0 0 1 0;", // mediaVideo → vfxBlur
    "#X connect 1 0 2 0;", // vfxBlur   → vfxCRT1
    "#X connect 2 0 3 0;", // vfxCRT1   → vfxCRT2  (chained-VFX skip path)
    "#X connect 3 0 4 0;", // vfxCRT2   → layer
  ];
  return lines.join("\n");
}

// In-page sampler: FNV-1a hash over the patchViz canvas RGB bytes, plus
// content stats so the probe can tell "stable real frame" from "stable black".
const SAMPLE_EXPR = `(() => {
  const c = document.querySelector(".pn-patchviz-canvas");
  if (!c) return { error: "no-patchviz-canvas" };
  let data;
  try {
    data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  } catch (e) {
    return { error: "getImageData-failed: " + (e && e.message) };
  }
  let h = 0x811c9dc5, nonBlack = 0, first = -1, uniform = true;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    h ^= r; h = Math.imul(h, 0x01000193);
    h ^= g; h = Math.imul(h, 0x01000193);
    h ^= b; h = Math.imul(h, 0x01000193);
    const px = (r << 16) | (g << 8) | b;
    if (first === -1) first = px; else if (px !== first) uniform = false;
    if (r > 8 || g > 8 || b > 8) nonBlack++;
  }
  return { hash: (h >>> 0).toString(16), uniform, nonBlack, w: c.width, h: c.height };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy, or throw after `timeoutMs`. */
async function pollUntil(fn, { timeoutMs, intervalMs, label }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label} (last=${JSON.stringify(last)})`);
}

/** Navigate to `url` and wait for the page load event. */
async function navigate(session, url) {
  const loaded = session.once("Page.loadEventFired", 30_000);
  await session.send("Page.navigate", { url });
  await loaded;
}

/**
 * Run the full flicker probe on an attached CdpSession.
 *
 * @param {object}  opts
 * @param {import("./cdp.mjs").CdpSession} opts.session  attached CDP session
 * @param {string}  opts.baseUrl   patchNet app URL (e.g. https://localhost:5173/patchNet/)
 * @param {string}  opts.clipUrl   URL of the test video (same origin as baseUrl)
 * @param {number} [opts.pausedSamples]  samples taken while paused (default 24)
 * @param {(s:string)=>void} [opts.log] progress logger
 * @returns {Promise<object>} result with { ok, failure, playing, paused, steps }
 */
export async function runFlickerProbe({
  session,
  baseUrl,
  clipUrl,
  pausedSamples = 24,
  log = () => {},
}) {
  const steps = [];
  const step = (s) => { steps.push(s); log(s); };
  const sample = () => session.evaluate(SAMPLE_EXPR);
  const result = { ok: false, failure: null, playing: null, paused: null, steps };

  try {
    await session.send("Page.enable");
    await session.send("Runtime.enable");

    // ── 1. Seed the patch and load it ──────────────────────────────────
    step(`loading app shell: ${baseUrl}`);
    await navigate(session, baseUrl);

    const patch = buildVenuePatch(clipUrl);
    const payload = JSON.stringify({ v: 1, main: patch, scratchTabs: [] });
    await session.evaluate(
      `localStorage.setItem("patchnet-patch", ${JSON.stringify(payload)}), "ok"`,
    );
    step("seeded localStorage with venue VFX-chain patch");

    step("reloading app with seeded patch");
    await navigate(session, baseUrl);

    // ── 2. Wait for the app, the video and the render surface ──────────
    await pollUntil(
      async () => {
        const r = await session.evaluate(`(() => {
          const v = document.querySelector("video");
          const c = document.querySelector(".pn-patchviz-canvas");
          return {
            video: !!v,
            ready: v ? v.readyState : -1,
            vw: v ? v.videoWidth : 0,
            canvas: !!c,
            err: v ? v.error && v.error.code : null,
          };
        })()`);
        if (r.err) throw new Error(`test video failed to load (error code ${r.err})`);
        return r.video && r.ready >= 2 && r.vw > 0 && r.canvas ? r : null;
      },
      { timeoutMs: 20_000, intervalMs: 250, label: "app + video + patchViz ready" },
    );
    step("app ready: video decoded, patchViz canvas present");

    // ── 3. PLAY — positive control: output MUST change ────────────────
    await session.evaluate(
      `(async () => { const v = document.querySelector("video");
         v.muted = true; try { await v.play(); } catch (e) {} })()`,
    );
    await pollUntil(
      async () => {
        const v = await session.evaluate(`(() => { const v = document.querySelector("video");
          return { paused: v.paused, t: v.currentTime }; })()`);
        return !v.paused && v.t > 0 ? v : null;
      },
      { timeoutMs: 8_000, intervalMs: 150, label: "video playing (currentTime advancing)" },
    );
    // Wait until the chain has actually painted real content.
    await pollUntil(
      async () => {
        const s = await sample();
        if (s.error) throw new Error(`sampler: ${s.error}`);
        return s.nonBlack > 50 ? s : null;
      },
      { timeoutMs: 8_000, intervalMs: 150, label: "VFX chain rendering content" },
    );

    const playHashes = [];
    for (let i = 0; i < 6; i++) {
      const s = await sample();
      if (s.error) throw new Error(`sampler: ${s.error}`);
      playHashes.push(s.hash);
      await sleep(130);
    }
    const playDistinct = new Set(playHashes).size;
    result.playing = { hashes: playHashes, distinct: playDistinct };
    step(`playing: ${playHashes.length} samples, ${playDistinct} distinct hashes`);
    if (playDistinct < 2) {
      result.failure =
        "positive control failed — patchViz output did not change while " +
        "the video was playing; the probe cannot prove it detects flicker " +
        "(pipeline may be dead or the video not decoding).";
      return result;
    }

    // ── 4. PAUSE — the actual test: output MUST be stable ─────────────
    await session.evaluate(`document.querySelector("video").pause(), "ok"`);
    await pollUntil(
      async () => {
        const p = await session.evaluate(
          `document.querySelector("video").paused`,
        );
        return p ? true : null;
      },
      { timeoutMs: 5_000, intervalMs: 100, label: "video paused" },
    );
    // Let the skip path settle: one last process() renders the paused frame,
    // then every subsequent process() early-returns.
    await sleep(700);
    step("video paused; chain settled — sampling for flicker");

    const pausedHashes = [];
    let lastStats = null;
    for (let i = 0; i < pausedSamples; i++) {
      const s = await sample();
      if (s.error) throw new Error(`sampler: ${s.error}`);
      pausedHashes.push(s.hash);
      lastStats = s;
      await sleep(70);
    }
    const pausedDistinct = new Set(pausedHashes).size;
    result.paused = {
      hashes: pausedHashes,
      distinct: pausedDistinct,
      nonBlack: lastStats.nonBlack,
      uniform: lastStats.uniform,
      canvas: `${lastStats.w}x${lastStats.h}`,
    };
    step(
      `paused: ${pausedHashes.length} samples over ~${
        ((pausedSamples * 70) / 1000).toFixed(1)
      }s, ${pausedDistinct} distinct hash(es)`,
    );

    // ── 5. Verdict ────────────────────────────────────────────────────
    if (lastStats.uniform || lastStats.nonBlack < 50) {
      result.failure =
        "paused canvas holds no real frame (uniform/near-black) — cannot " +
        "trust the stability result; the VFX chain was not compositing video.";
      return result;
    }
    if (pausedDistinct !== 1) {
      result.failure =
        `FLICKER DETECTED — paused patchViz output changed across ${
          pausedHashes.length
        } samples (${pausedDistinct} distinct hashes). The Tier 1.3 ` +
        `source-unchanged skip is leaving an unstable frame.`;
      return result;
    }

    result.ok = true;
    step("PASS — paused VFX-chain output is pixel-stable (no flicker)");
    return result;
  } catch (err) {
    result.failure = `probe error: ${err && err.message ? err.message : err}`;
    return result;
  }
}
