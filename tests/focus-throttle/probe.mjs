/**
 * Focus-throttle probe — verifies the meter-loop host swap keeps audio
 * analysis firing at full rate when the main window's rAF is throttled by
 * background-tab focus loss.
 *
 * See README.md for the design. Two phases per run:
 *   POSITIVE: popup open + main rAF throttled → meter counter ≥ floor
 *   NEGATIVE: popup closed + main rAF throttled → meter counter ≤ ceiling
 *
 * Negative phase doubles as a sanity check that the throttle simulation
 * actually throttles — without it, a no-op fix could silently pass.
 */

/** Build a minimal patch: noise~ → fft~ 4, plus a visualizer for the popup. */
export function buildFocusThrottlePatch() {
  // Serial indices are object creation order; #X connect references them.
  //   0 noise~   1 fft~   2 visualizer*
  const lines = [
    "#N canvas;",
    "#X obj 60 60 noise~;",
    "#X name 0 noise1;",
    "#X obj 60 180 fft~ 4;",
    "#X name 1 fft1;",
    "#X obj 60 320 visualizer* world1 0 0;",
    "#X name 2 visualizer1;",
    "#X connect 0 0 1 0;", // noise~ → fft~
  ];
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function navigate(session, url) {
  const loaded = session.once("Page.loadEventFired", 30_000);
  await session.send("Page.navigate", { url });
  await loaded;
}

/** Runtime.evaluate with a user-gesture activation. Needed for popup.open. */
async function evalUserGesture(session, expression) {
  const res = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const text = d.exception?.description || d.text || "page exception";
    throw new Error(`Page evaluation (userGesture) failed: ${text}`);
  }
  return res.result?.value;
}

/**
 * Wrap window.requestAnimationFrame/cancelAnimationFrame on the main window
 * so rAF callbacks fire at ~throttleHz instead of 60 Hz when enabled.
 * Preserves the rAF ID/cancel contract by tracking our own IDs and the
 * underlying setTimeout/raf handles in a Map. Toggleable via the returned
 * setter — no reload required.
 */
const INSTALL_THROTTLE_EXPR = `(() => {
  if (window.__rafThrottleInstalled) return "already-installed";
  window.__rafThrottleInstalled = true;
  window.__rafThrottleEnabled = false;
  window.__rafThrottleHz = 1;
  const origRaf = window.requestAnimationFrame.bind(window);
  const origCaf = window.cancelAnimationFrame.bind(window);
  const idMap = new Map();
  let nextId = 1_000_001;
  window.requestAnimationFrame = (cb) => {
    if (!window.__rafThrottleEnabled) {
      const real = origRaf(cb);
      const our = nextId++;
      idMap.set(our, { kind: "raf", real });
      return our;
    }
    const delayMs = Math.max(16, Math.round(1000 / window.__rafThrottleHz));
    const real = setTimeout(() => {
      try { cb(performance.now()); } catch (e) { console.error(e); }
    }, delayMs);
    const our = nextId++;
    idMap.set(our, { kind: "timeout", real });
    return our;
  };
  window.cancelAnimationFrame = (id) => {
    const entry = idMap.get(id);
    if (!entry) { try { origCaf(id); } catch {} return; }
    idMap.delete(id);
    if (entry.kind === "raf") origCaf(entry.real);
    else clearTimeout(entry.real);
  };
  return "installed";
})()`;

const SET_THROTTLE = (enabled, hz = 1) =>
  `(() => { window.__rafThrottleEnabled = ${enabled ? "true" : "false"}; window.__rafThrottleHz = ${hz}; return { enabled: window.__rafThrottleEnabled, hz: window.__rafThrottleHz }; })()`;

/**
 * Run the full focus-throttle probe.
 *
 * @param {object} opts
 * @param {import("../flicker/cdp.mjs").CdpSession} opts.session
 * @param {string} opts.baseUrl
 * @param {number} [opts.windowMs]      measurement window per phase (default 2000)
 * @param {number} [opts.posFloor]      positive-phase counter floor (default 30)
 * @param {number} [opts.negCeiling]    negative-phase counter ceiling (default 5)
 * @param {(s:string)=>void} [opts.log]
 */
export async function runFocusThrottleProbe({
  session,
  baseUrl,
  windowMs = Number(process.env.PATCHNET_FT_WINDOW_MS) || 2000,
  posFloor = 30,
  negCeiling = 5,
  log = () => {},
}) {
  const steps = [];
  const step = (s) => { steps.push(s); log(s); };
  const result = { ok: false, failure: null, positive: null, negative: null, steps };

  try {
    await session.send("Page.enable");
    await session.send("Runtime.enable");

    // ── 1. Load + seed + reload ────────────────────────────────────────
    step(`loading app shell: ${baseUrl}`);
    await navigate(session, baseUrl);

    const patch = buildFocusThrottlePatch();
    const payload = JSON.stringify({ v: 1, main: patch, scratchTabs: [] });
    await session.evaluate(
      `localStorage.setItem("patchnet-patch", ${JSON.stringify(payload)}), "ok"`,
    );
    step("seeded localStorage with noise~ → fft~ + visualizer* patch");

    step("reloading app with seeded patch");
    await navigate(session, baseUrl);

    // ── 2. Wait for app + test hook ────────────────────────────────────
    await pollUntil(
      async () => {
        const r = await session.evaluate(`(() => {
          const t = window.__patchnetTest;
          return {
            hook: !!t,
            audioBtn: !!document.getElementById("audio-toggle-btn"),
            runtime: !!(t && t.runtime),
          };
        })()`);
        return r.hook && r.audioBtn && r.runtime ? r : null;
      },
      { timeoutMs: 15_000, intervalMs: 200, label: "__patchnetTest hook + audio button" },
    );
    step("app ready: __patchnetTest hook present, audio button mounted");

    // ── 3. Install throttle wrapper (initially disabled) ───────────────
    const installRes = await session.evaluate(INSTALL_THROTTLE_EXPR);
    step(`rAF throttle wrapper: ${installRes}`);

    // ── 4. Start audio (user gesture required for AudioContext.resume) ──
    await evalUserGesture(session, `document.getElementById("audio-toggle-btn").click(), "ok"`);
    await pollUntil(
      async () => {
        const r = await session.evaluate(`(() => {
          const t = window.__patchnetTest;
          return { host: t.getMeterHost(), count: t.getMeterTickCount() };
        })()`);
        // Meter loop must be running before we trust the counter for measurement
        return r.count > 0 ? r : null;
      },
      { timeoutMs: 8_000, intervalMs: 200, label: "meter loop ticking (audio started)" },
    );
    step("audio on, meter loop ticking");

    // ── 5. Open the visualizer popup (user gesture required) ───────────
    await evalUserGesture(session, `(() => {
      const ctx = window.__patchnetTest.runtime.get("world1");
      if (!ctx) throw new Error("no visualizer context named world1");
      ctx.open();
      return "opened";
    })()`);
    await pollUntil(
      async () => {
        const r = await session.evaluate(`(() => {
          const t = window.__patchnetTest;
          return {
            host: t.getMeterHost(),
            popupOpen: !!t.runtime.getFirstOpenPopupWindow(),
          };
        })()`);
        return r.host === "popup" && r.popupOpen ? r : null;
      },
      { timeoutMs: 5_000, intervalMs: 100, label: "meter host swapped to popup" },
    );
    step("popup open, meter host = popup");

    // ── 6. POSITIVE PHASE — popup open, main rAF throttled ─────────────
    await session.evaluate(SET_THROTTLE(true, 1));
    await session.evaluate(`window.__patchnetTest.resetMeterTickCount(), "ok"`);
    step(`positive phase: throttling main rAF to 1 Hz, sampling ${windowMs}ms…`);
    await sleep(windowMs);
    const posCount = await session.evaluate(
      `window.__patchnetTest.getMeterTickCount()`,
    );
    const posHost = await session.evaluate(`window.__patchnetTest.getMeterHost()`);
    result.positive = { count: posCount, host: posHost, windowMs, floor: posFloor };
    step(`positive: ${posCount} ticks in ${windowMs}ms on host=${posHost} (floor ${posFloor})`);

    if (posHost !== "popup") {
      result.failure =
        `positive phase invalid — meter host was "${posHost}", not "popup". ` +
        `The popup state notification or pickMeterHost() is broken.`;
      return result;
    }
    if (posCount < posFloor) {
      result.failure =
        `POSITIVE PHASE FAILED — only ${posCount} meter ticks fired in ${windowMs}ms ` +
        `with the popup open (floor ${posFloor}). The host swap is not actually ` +
        `delivering popup-rate analysis; audio-reactive visuals will freeze when ` +
        `the patchNet window is backgrounded by a fullscreen popup.`;
      return result;
    }

    // ── 7. NEGATIVE PHASE — popup closed → host returns to main ────────
    // Disable the throttle briefly so the host-swap notification flush isn't
    // itself throttled. Re-enable after the swap settles.
    await session.evaluate(SET_THROTTLE(false));
    await session.evaluate(`(() => {
      const ctx = window.__patchnetTest.runtime.get("world1");
      if (ctx && ctx.isOpen()) ctx.close();
      return "closed";
    })()`);
    await pollUntil(
      async () => {
        const r = await session.evaluate(
          `({ host: window.__patchnetTest.getMeterHost(),
              popupOpen: !!window.__patchnetTest.runtime.getFirstOpenPopupWindow() })`,
        );
        return r.host === "main" && !r.popupOpen ? r : null;
      },
      { timeoutMs: 5_000, intervalMs: 100, label: "meter host returned to main" },
    );
    step("popup closed, meter host = main");

    await session.evaluate(SET_THROTTLE(true, 1));
    await session.evaluate(`window.__patchnetTest.resetMeterTickCount(), "ok"`);
    step(`negative phase: throttling main rAF to 1 Hz, sampling ${windowMs}ms…`);
    await sleep(windowMs);
    const negCount = await session.evaluate(
      `window.__patchnetTest.getMeterTickCount()`,
    );
    const negHost = await session.evaluate(`window.__patchnetTest.getMeterHost()`);
    result.negative = { count: negCount, host: negHost, windowMs, ceiling: negCeiling };
    step(`negative: ${negCount} ticks in ${windowMs}ms on host=${negHost} (ceiling ${negCeiling})`);

    if (negHost !== "main") {
      result.failure =
        `negative phase invalid — meter host was "${negHost}", not "main" after popup close.`;
      return result;
    }
    if (negCount > negCeiling) {
      result.failure =
        `NEGATIVE-CONTROL FAILED — ${negCount} meter ticks fired in ${windowMs}ms ` +
        `on the throttled main rAF (ceiling ${negCeiling}). The throttle simulation ` +
        `isn't actually throttling, so the positive phase isn't a meaningful test.`;
      return result;
    }

    result.ok = true;
    step(
      `PASS — positive ${posCount}≥${posFloor} (popup host) AND ` +
      `negative ${negCount}≤${negCeiling} (throttled main host)`,
    );
    return result;
  } catch (err) {
    result.failure = `probe error: ${err && err.message ? err.message : err}`;
    return result;
  }
}
