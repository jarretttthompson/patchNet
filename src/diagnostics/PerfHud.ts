// PerfHud — Phase 0 freeze diagnostics overlay (DEV only).
//
// Pure instrumentation: monkeypatches global prototypes and observes the DOM.
// It does NOT alter any app behavior and is removed by deleting the one
// installPerfHud() call in main.ts. Toggle the overlay with Ctrl+Shift+0.
//
// What each number proves (maps to the freeze root-cause list):
//   changes/s + DOM churn/s  -> the "change-storm" full-app rebuild (cause #1)
//   gl ctx (live/peak)       -> WebGL context exhaustion, ~16 cap (cause #2)
//   tex / fbo / buf (live)   -> GPU resource leaks on node delete (cause #2/#5)
//   rAF/s + fps + worst gap  -> too many uncancelled loops / spiral (cause #3)
//   long tasks (>50ms)       -> main-thread blocking on the hot path

interface GraphLike {
  emit(event: string): void;
}

interface Counters {
  // cumulative since last reset
  changeEmits: number;
  rafCalls: number;
  domAdded: number;
  domRemoved: number;
  longTasks: number;
  longestTaskMs: number;
  // GPU live counts (created - deleted)
  texLive: number;
  texPeak: number;
  fboLive: number;
  fboPeak: number;
  bufLive: number;
  bufPeak: number;
  glCtxLive: number;
  glCtxPeak: number;
  glCtxLost: number;
}

let installed = false;
let counters: Counters | null = null;

/** Wire the graph "change" emit counter. Safe to call after installPerfHud(),
 * once the graph exists. */
export function attachGraph(graph: GraphLike): void {
  if (!counters || !graph || typeof graph.emit !== "function") return;
  const c = counters;
  const origEmit = graph.emit.bind(graph);
  graph.emit = function (event: string) {
    if (event === "change") c.changeEmits += 1;
    return origEmit(event);
  };
}

export function installPerfHud(graph?: GraphLike): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const c: Counters = {
    changeEmits: 0,
    rafCalls: 0,
    domAdded: 0,
    domRemoved: 0,
    longTasks: 0,
    longestTaskMs: 0,
    texLive: 0,
    texPeak: 0,
    fboLive: 0,
    fboPeak: 0,
    bufLive: 0,
    bufPeak: 0,
    glCtxLive: 0,
    glCtxPeak: 0,
    glCtxLost: 0,
  };
  counters = c;

  const bump = (live: "texLive" | "fboLive" | "bufLive", peak: "texPeak" | "fboPeak" | "bufPeak", d: number) => {
    c[live] += d;
    if (c[live] > c[peak]) c[peak] = c[live];
  };

  // --- 1. WebGL resource instrumentation (textures / framebuffers / buffers) ---
  for (const proto of [
    typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext.prototype : null,
    typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext.prototype : null,
  ]) {
    if (!proto) continue;
    wrap(proto, "createTexture", () => bump("texLive", "texPeak", 1));
    wrap(proto, "deleteTexture", () => bump("texLive", "texPeak", -1));
    wrap(proto, "createFramebuffer", () => bump("fboLive", "fboPeak", 1));
    wrap(proto, "deleteFramebuffer", () => bump("fboLive", "fboPeak", -1));
    wrap(proto, "createBuffer", () => bump("bufLive", "bufPeak", 1));
    wrap(proto, "deleteBuffer", () => bump("bufLive", "bufPeak", -1));
  }

  // --- 2. WebGL context count (the ~16 browser cap) ---
  const countedCtx = new WeakSet<object>();
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    const ctx = (origGetContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
    const isGl = type === "webgl" || type === "webgl2" || type === "experimental-webgl";
    if (isGl && ctx && !countedCtx.has(ctx as object)) {
      countedCtx.add(ctx as object);
      c.glCtxLive += 1;
      if (c.glCtxLive > c.glCtxPeak) c.glCtxPeak = c.glCtxLive;
      this.addEventListener("webglcontextlost", () => {
        c.glCtxLive -= 1;
        c.glCtxLost += 1;
      });
      this.addEventListener("webglcontextrestored", () => {
        c.glCtxLive += 1;
        if (c.glCtxLive > c.glCtxPeak) c.glCtxPeak = c.glCtxLive;
      });
    }
    return ctx as RenderingContext | null;
  } as typeof HTMLCanvasElement.prototype.getContext;

  // --- 3. requestAnimationFrame call rate (one tick per active loop per frame) ---
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb: FrameRequestCallback): number {
    return origRaf((t) => {
      c.rafCalls += 1;
      cb(t);
    });
  };

  // --- 4. graph "change" emit rate (drives the full-app rebuild) ---
  if (graph) attachGraph(graph);

  // --- 5. DOM churn on the patch canvas (visible symptom of rebuild storm) ---
  const attachDomObserver = () => {
    const panGroup = document.querySelector(".pn-pan-group");
    if (!panGroup) {
      setTimeout(attachDomObserver, 500);
      return;
    }
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof HTMLElement && n.classList.contains("patch-object")) c.domAdded += 1;
        }
        for (const n of r.removedNodes) {
          if (n instanceof HTMLElement && n.classList.contains("patch-object")) c.domRemoved += 1;
        }
      }
    });
    mo.observe(panGroup, { childList: true });
  };
  attachDomObserver();

  // --- 6. long-task observer (main-thread blocking >50ms) ---
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        c.longTasks += 1;
        if (e.duration > c.longestTaskMs) c.longestTaskMs = e.duration;
      }
    });
    po.observe({ entryTypes: ["longtask"] });
  } catch {
    // longtask not supported — skip silently
  }

  // --- overlay + per-second sampling ---
  const el = document.createElement("div");
  el.id = "pn-perfhud";
  el.style.cssText = [
    "position:fixed", "top:8px", "right:8px", "z-index:2147483647",
    "font:11px/1.45 monospace", "color:#0f0", "background:rgba(0,0,0,0.82)",
    "padding:8px 10px", "border:1px solid #0f0", "border-radius:4px",
    "white-space:pre", "pointer-events:none", "min-width:188px",
  ].join(";");
  document.body.appendChild(el);

  let visible = true;
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "Digit0") {
      visible = !visible;
      el.style.display = visible ? "block" : "none";
    }
  });

  // snapshot of cumulative counters at last sample, to compute per-second rates
  let last = { t: performance.now(), changeEmits: 0, rafCalls: 0, domAdded: 0, domRemoved: 0 };
  let fpsFrames = 0;
  let worstGapMs = 0;
  let lastFrameT = performance.now();
  const fpsLoop = (t: number) => {
    fpsFrames += 1;
    const gap = t - lastFrameT;
    if (gap > worstGapMs) worstGapMs = gap;
    lastFrameT = t;
    origRaf(fpsLoop);
  };
  origRaf(fpsLoop);

  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
  const sample = () => {
    const now = performance.now();
    const dt = (now - last.t) / 1000;
    const fps = fpsFrames / dt;
    const changesPerS = (c.changeEmits - last.changeEmits) / dt;
    const rafPerS = (c.rafCalls - last.rafCalls) / dt;
    const domAddPerS = (c.domAdded - last.domAdded) / dt;
    const domRemPerS = (c.domRemoved - last.domRemoved) / dt;

    const warn = (v: boolean) => (v ? "  <-- !!" : "");
    el.textContent =
      `PerfHud  (Ctrl+Shift+0)\n` +
      `fps        ${fps.toFixed(0)}${warn(fps < 30)}\n` +
      `worst gap  ${worstGapMs.toFixed(0)}ms${warn(worstGapMs > 100)}\n` +
      `rAF/s      ${rafPerS.toFixed(0)}${warn(rafPerS > 240)}\n` +
      `changes/s  ${changesPerS.toFixed(0)}${warn(changesPerS > 30)}\n` +
      `dom +/s    ${domAddPerS.toFixed(0)}\n` +
      `dom -/s    ${domRemPerS.toFixed(0)}${warn(domRemPerS > 30)}\n` +
      `long tasks ${fmt(c.longTasks)} (max ${c.longestTaskMs.toFixed(0)}ms)\n` +
      `gl ctx     ${c.glCtxLive} (peak ${c.glCtxPeak})${warn(c.glCtxLive > 12)}\n` +
      `  lost     ${c.glCtxLost}${warn(c.glCtxLost > 0)}\n` +
      `tex live   ${fmt(c.texLive)} (peak ${fmt(c.texPeak)})\n` +
      `fbo live   ${fmt(c.fboLive)} (peak ${fmt(c.fboPeak)})\n` +
      `buf live   ${fmt(c.bufLive)} (peak ${fmt(c.bufPeak)})`;

    last = { t: now, changeEmits: c.changeEmits, rafCalls: c.rafCalls, domAdded: c.domAdded, domRemoved: c.domRemoved };
    fpsFrames = 0;
    worstGapMs = 0;
  };
  setInterval(sample, 1000);

  // programmatic access for capturing a "before" profile from the console
  (window as unknown as { __perfhud: unknown }).__perfhud = {
    snapshot: () => ({ ...c, ts: new Date().toISOString() }),
    reset: () => {
      c.changeEmits = 0;
      c.rafCalls = 0;
      c.domAdded = 0;
      c.domRemoved = 0;
      c.longTasks = 0;
      c.longestTaskMs = 0;
      // peaks intentionally preserved; live counts reflect real state
    },
  };

  // eslint-disable-next-line no-console
  console.info("[PerfHud] installed — toggle with Ctrl+Shift+0, dump via window.__perfhud.snapshot()");
}

function wrap(proto: object, key: string, after: () => void): void {
  const obj = proto as Record<string, unknown>;
  const orig = obj[key];
  if (typeof orig !== "function") return;
  obj[key] = function (this: unknown, ...args: unknown[]) {
    const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
    after();
    return r;
  };
}
