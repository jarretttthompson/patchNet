import { renderPorts } from "./PortRenderer";
import { getObjectDef, OBJECT_DEFS, getVisibleArgs, getSequencerCells, sequencerCols, sequencerRows, fftBandCount, bufferMode, videoBufferLoop, videoBufferMaxLen, videoBufferRate, ATTR_SIDE_INLET_HEADER_H, ATTR_SIDE_INLET_ROW_H } from "../graph/objectDefs";
import { renderLocalPluginBody, hasLocalPlugin } from "../graph/localPlugins";
import type { PatchNode } from "../graph/PatchNode";

const LOCK_ICON_SVG = `
      <svg class="pn-lock-icon pn-lock-closed" viewBox="0 0 14 16" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="7" width="10" height="8" rx="1.5" fill="currentColor"/>
        <path d="M4.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <svg class="pn-lock-icon pn-lock-open" viewBox="0 0 14 16" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="7" width="10" height="8" rx="1.5" fill="currentColor"/>
        <path d="M4.5 7V5.5a2.5 2.5 0 0 1 5 0V3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>`;

const MATH_OPS = new Set(["+", "-", "*", "/", "%", "==", "!=", ">", "<", ">=", "<="]);

/** Perimeter move-handle variants. BR is intentionally absent — that corner
 *  belongs to the resize handle. CSS in shell.css positions each variant. */
const MOVE_HANDLE_VARIANTS = ["tl", "tr", "bl", "top", "bottom", "left", "right"] as const;

/** "0" / "-7" / "127" → true. "0.0" / "1." → false. Mirrors the int-form rule
 *  used by the scale/ezScale runtime. */
function isIntForm(s: string): boolean {
  return /^-?\d+$/.test(s.trim());
}

/** Compact numeric label for a slider thumb. Int mode shows the whole number;
 *  float mode trims to ≤3 decimals and strips trailing zeros for tidiness. */
export function formatThumbValue(n: number, intMode: boolean): string {
  if (!Number.isFinite(n)) return "";
  if (intMode) return String(Math.round(n));
  const fixed = n.toFixed(3);
  return fixed.replace(/\.?0+$/, "") || "0";
}

/**
 * Object types whose body content has a fixed "design size" and should be
 * uniformly transform-scaled when the user resizes the object. Excluded:
 *   - flex-reflow types (comment, message, sequencer)
 *   - panel-managed types (codebox, js~, reaperVideo, dmx, mixer~,
 *     browser~, youtube~, frame~, subPatch)
 *   - buffer~ (already manages its own stage)
 *   - attribute (its panel-style scrolling list reflows naturally)
 */
const SCALE_ELIGIBLE_TYPES = new Set<string>([
  "+", "-", "*", "/", "%", "==", "!=", ">", "<", ">=", "<=",
  "s", "r", "t", "metro", "click~", "scale", "timer", "oscillateNumbers",
  "integer", "float",
  "inlet", "outlet",
  "mediaImage*", "mediaVideo*", "visualizer*", "layer*", "shaderToy*", "patchViz", "imageFX*",
  "adc~", "dac~",
]);

/**
 * Wrap whatever the type-specific buildBody branch emitted in a `.pn-stage`
 * so it scales uniformly with the object. The def's defaults act as a
 * minimum size floor — short content stays at design size; long content
 * (e.g. a long object title) grows the stage so nothing clips. After the
 * stage is mounted we measure its actual layout box and feed the values
 * into --pn-stage-w / --pn-stage-h so the transform-scale denominator
 * matches reality.
 */
/** Render a buffer~ maxLen (seconds) as a compact "1m30s" / "45s" label. */
export function formatMaxLen(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return r === 0 ? `${m}m` : `${m}m${r}s`;
}

export function formatFreq(hz: number): string {
  const v = Number.isFinite(hz) ? hz : 0;
  if (v >= 1000) return `${(v / 1000).toFixed(2)}k`;
  if (v >= 100)  return v.toFixed(0);
  if (v >= 10)   return v.toFixed(1);
  return v.toFixed(2);
}

export function formatMorph(v: number): string {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)).toFixed(2) : "0.00";
}

export function formatLevel(v: number): string {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)).toFixed(2) : "0.00";
}

function formatNoiseLevel(v: number): string {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)).toFixed(2) : "0.00";
}

function normalizeNoiseColor(raw: string | undefined): "white" | "pink" | "brown" {
  const color = (raw ?? "white").trim().toLowerCase();
  return color === "pink" || color === "brown" ? color : "white";
}

/** Build a wave~ knob: SVG dial + label + readout. The dial pointer angle
 *  is set inline from the knob's normalized 0..1 fraction. Param-space →
 *  fraction conversion lives in waveKnobFraction(). */
export function waveKnobHtml(
  nodeId: string,
  knob: "freq" | "morph" | "level",
  label: string,
  rawValue: number,
  readout: string,
): string {
  const frac = waveKnobFraction(knob, rawValue);
  // Pointer arc: start at 7 o'clock (angle -135°), sweep 270° clockwise to 5 o'clock (+135°).
  const angleDeg = -135 + frac * 270;
  return `
    <div class="pn-wave-knob" data-wave-node-id="${nodeId}" data-wave-knob="${knob}" data-wave-frac="${frac.toFixed(4)}" data-wave-value="${rawValue}">
      <div class="pn-wave-knob__dial">
        <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
          <circle cx="16" cy="16" r="13" class="pn-wave-knob__ring"></circle>
          <line x1="16" y1="16" x2="16" y2="5" class="pn-wave-knob__pointer" transform="rotate(${angleDeg.toFixed(2)} 16 16)"></line>
        </svg>
      </div>
      <div class="pn-wave-knob__label">${label}</div>
      <div class="pn-wave-knob__value">${readout}</div>
    </div>`;
}

/** Map a wave~ knob value to its 0..1 dial fraction. freq is exponential
 *  over [1, 20000]; morph and level are linear over [0, 1]. */
export function waveKnobFraction(knob: "freq" | "morph" | "level", value: number): number {
  const v = Number.isFinite(value) ? value : 0;
  if (knob === "freq") {
    const lo = Math.log(1);
    const hi = Math.log(20000);
    const x = Math.log(Math.max(1, Math.min(20000, v)));
    return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  }
  return Math.max(0, Math.min(1, v));
}

/** Inverse of waveKnobFraction — turn a 0..1 dial fraction back into a param value. */
export function waveKnobValueFromFraction(knob: "freq" | "morph" | "level", frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  if (knob === "freq") {
    const lo = Math.log(1);
    const hi = Math.log(20000);
    return Math.exp(lo + f * (hi - lo));
  }
  return f;
}

// ── lfo~ tile helpers ──────────────────────────────────────────────────

export function formatRate(hz: number): string {
  const v = Number.isFinite(hz) ? Math.max(0.01, Math.min(20, hz)) : 1;
  return v >= 10 ? `${v.toFixed(1)}Hz` : `${v.toFixed(2)}Hz`;
}

export function formatDepth(v: number): string {
  const d = Number.isFinite(v) ? Math.max(0, Math.min(1000, v)) : 100;
  if (d >= 100) return String(Math.round(d));
  if (d >= 10)  return d.toFixed(1);
  return d.toFixed(2);
}

export function formatShape(v: number): string {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)).toFixed(2) : "0.00";
}

/** Build an lfo~ knob: SVG dial + label + readout. */
export function lfoKnobHtml(
  nodeId: string,
  knob: "rate" | "depth" | "shape",
  label: string,
  rawValue: number,
  readout: string,
): string {
  const frac = lfoKnobFraction(knob, rawValue);
  const angleDeg = -135 + frac * 270;
  return `
    <div class="pn-lfo-knob" data-lfo-node-id="${nodeId}" data-lfo-knob="${knob}" data-lfo-frac="${frac.toFixed(4)}" data-lfo-value="${rawValue}">
      <div class="pn-lfo-knob__dial">
        <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
          <circle cx="16" cy="16" r="13" class="pn-lfo-knob__ring"></circle>
          <line x1="16" y1="16" x2="16" y2="5" class="pn-lfo-knob__pointer" transform="rotate(${angleDeg.toFixed(2)} 16 16)"></line>
        </svg>
      </div>
      <div class="pn-lfo-knob__label">${label}</div>
      <div class="pn-lfo-knob__value">${readout}</div>
    </div>`;
}

/** Map lfo~ knob value to 0..1 dial fraction. rate is log over [0.01, 20];
 *  depth is linear over [0, 1000]; shape is linear over [0, 1]. */
export function lfoKnobFraction(knob: "rate" | "depth" | "shape", value: number): number {
  const v = Number.isFinite(value) ? value : 0;
  if (knob === "rate") {
    const lo = Math.log(0.01);
    const hi = Math.log(20);
    return Math.max(0, Math.min(1, (Math.log(Math.max(0.01, Math.min(20, v))) - lo) / (hi - lo)));
  }
  if (knob === "depth") return Math.max(0, Math.min(1, v / 1000));
  return Math.max(0, Math.min(1, v));
}

/** Inverse of lfoKnobFraction. */
export function lfoKnobValueFromFraction(knob: "rate" | "depth" | "shape", frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  if (knob === "rate") {
    const lo = Math.log(0.01);
    const hi = Math.log(20);
    return Math.exp(lo + f * (hi - lo));
  }
  if (knob === "depth") return f * 1000;
  return f;
}

// ── adsr~ envelope editor ──────────────────────────────────────────────
// Fixed SVG layout. The viewBox is 160×50 with a 2px inner padding so
// handles at x=0 / x=158 don't clip. Time axis spans [PAD_X, ADSR_W - PAD_X];
// envelope amplitude maps top=ADSR_TOP (1.0) to bottom=ADSR_BOTTOM (0.0).
export const ADSR_W = 160;
export const ADSR_H = 50;
export const ADSR_PAD_X = 2;
export const ADSR_TOP = 4;
export const ADSR_BOTTOM = 46;
export const ADSR_USABLE_W = ADSR_W - 2 * ADSR_PAD_X;

/** Compact time readout: "50" / "1.2s" / "10s". */
export function formatAdsrTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (ms < 1000) return Math.round(ms).toString();
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/** Sustain-level readout: 0..1 with two decimals. */
export function formatAdsrLevel(v: number): string {
  if (!Number.isFinite(v)) return "0.00";
  return Math.max(0, Math.min(1, v)).toFixed(2);
}

/** transientFollower~ sensitivity readout: 0..64, max one decimal,
 *  trailing zeros stripped ("1", "2.5", "16"). */
export function formatTfSensitivity(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const c = v < 0 ? 0 : v > 64 ? 64 : v;
  return c.toFixed(1).replace(/\.?0+$/, "") || "0";
}

/** Update transientFollower~ face readouts in place from current node.args.
 *  Called during attribute-panel drag so the face stays in sync without
 *  waiting for a full re-render at commit time. */
export function refreshTransientFollowerReadouts(bodyEl: HTMLElement, node: PatchNode): void {
  const a    = parseFloat(node.args[0] ?? "5");
  const r    = parseFloat(node.args[1] ?? "80");
  const sens = parseFloat(node.args[2] ?? "1");
  const flr  = parseFloat(node.args[3] ?? "0");
  const set = (key: string, text: string) => {
    const el = bodyEl.querySelector<HTMLElement>(`.pn-tf-readouts[data-tf-node-id="${node.id}"] [data-tf-readout="${key}"]`);
    if (el) el.textContent = text;
  };
  set("attack",      `A:${formatAdsrTime(a)}`);
  set("release",     `R:${formatAdsrTime(r)}`);
  set("sensitivity", `S:${formatTfSensitivity(sens)}`);
  set("floor",       `F:${formatAdsrLevel(flr)}`);
}

/** Compute the SVG geometry for an ADSR envelope so the editor and the
 *  drag handler agree on pixel↔time mapping. `sustainTime` is the real
 *  one-shot hold duration in ms (drag-controlled by the user, persisted
 *  into args). */
export function adsrGeometry(
  attackMs: number,
  decayMs: number,
  sustain: number,
  releaseMs: number,
  sustainTimeMs: number,
) {
  const a  = Math.max(0, attackMs);
  const d  = Math.max(0, decayMs);
  const r  = Math.max(0, releaseMs);
  const sh = Math.max(0, sustainTimeMs);
  const s  = Math.max(0, Math.min(1, sustain));
  const displayedTime = a + d + sh + r;
  const pxPerMs = ADSR_USABLE_W / Math.max(0.0001, displayedTime);
  const xA   = ADSR_PAD_X + a * pxPerMs;
  const xAD  = xA + d * pxPerMs;
  const xADS = xAD + sh * pxPerMs;
  const xEnd = xADS + r * pxPerMs;
  const ySustain = ADSR_TOP + (1 - s) * (ADSR_BOTTOM - ADSR_TOP);
  return { a, d, r, s, sh, displayedTime, pxPerMs, xA, xAD, xADS, xEnd, ySustain };
}

/** Inner SVG markup for the adsr~ envelope editor. */
export function adsrEditorSvg(node: PatchNode): string {
  const a  = parseFloat(node.args[0] ?? "50");
  const d  = parseFloat(node.args[1] ?? "100");
  const s  = parseFloat(node.args[2] ?? "0.7");
  const r  = parseFloat(node.args[3] ?? "200");
  const sh = parseFloat(node.args[4] ?? "200");
  const g = adsrGeometry(a, d, s, r, sh);
  const points = [
    `${ADSR_PAD_X},${ADSR_BOTTOM}`,
    `${g.xA.toFixed(2)},${ADSR_TOP}`,
    `${g.xAD.toFixed(2)},${g.ySustain.toFixed(2)}`,
    `${g.xADS.toFixed(2)},${g.ySustain.toFixed(2)}`,
    `${g.xEnd.toFixed(2)},${ADSR_BOTTOM}`,
  ].join(" ");
  return `
    <polyline class="pn-adsr-line" points="${points}" fill="none"></polyline>
    <circle class="pn-adsr-handle" data-adsr-handle="attack"     cx="${g.xA.toFixed(2)}"   cy="${ADSR_TOP}" r="3.5"></circle>
    <circle class="pn-adsr-handle" data-adsr-handle="decay"      cx="${g.xAD.toFixed(2)}"  cy="${g.ySustain.toFixed(2)}" r="3.5"></circle>
    <circle class="pn-adsr-handle" data-adsr-handle="sustainEnd" cx="${g.xADS.toFixed(2)}" cy="${g.ySustain.toFixed(2)}" r="3.5"></circle>
    <circle class="pn-adsr-handle" data-adsr-handle="release"    cx="${g.xEnd.toFixed(2)}" cy="${ADSR_BOTTOM}" r="3.5"></circle>`;
}

/** Update the line + handle positions in an existing SVG without rebuilding
 *  the wrapping DOM. Called by the drag handler to redraw live. */
export function refreshAdsrEditorDom(svgEl: SVGSVGElement, node: PatchNode): void {
  const a  = parseFloat(node.args[0] ?? "50");
  const d  = parseFloat(node.args[1] ?? "100");
  const s  = parseFloat(node.args[2] ?? "0.7");
  const r  = parseFloat(node.args[3] ?? "200");
  const sh = parseFloat(node.args[4] ?? "200");
  const g = adsrGeometry(a, d, s, r, sh);
  const line = svgEl.querySelector<SVGPolylineElement>("polyline.pn-adsr-line");
  if (line) {
    const points = [
      `${ADSR_PAD_X},${ADSR_BOTTOM}`,
      `${g.xA.toFixed(2)},${ADSR_TOP}`,
      `${g.xAD.toFixed(2)},${g.ySustain.toFixed(2)}`,
      `${g.xADS.toFixed(2)},${g.ySustain.toFixed(2)}`,
      `${g.xEnd.toFixed(2)},${ADSR_BOTTOM}`,
    ].join(" ");
    line.setAttribute("points", points);
  }
  const setHandle = (which: string, cx: number, cy: number) => {
    const h = svgEl.querySelector<SVGCircleElement>(`circle.pn-adsr-handle[data-adsr-handle="${which}"]`);
    if (h) {
      h.setAttribute("cx", cx.toFixed(2));
      h.setAttribute("cy", cy.toFixed(2));
    }
  };
  setHandle("attack",     g.xA,   ADSR_TOP);
  setHandle("decay",      g.xAD,  g.ySustain);
  setHandle("sustainEnd", g.xADS, g.ySustain);
  setHandle("release",    g.xEnd, ADSR_BOTTOM);

  // Update the readouts row if it's a sibling of the SVG.
  const panel = svgEl.closest(".pn-adsr-panel");
  if (panel) {
    const readouts = panel.querySelector(".pn-adsr-readouts");
    if (readouts) {
      readouts.innerHTML = `
        <span>A:${formatAdsrTime(a)}</span>
        <span>D:${formatAdsrTime(d)}</span>
        <span>S:${formatAdsrLevel(s)}</span>
        <span>H:${formatAdsrTime(sh)}</span>
        <span>R:${formatAdsrTime(r)}</span>`;
    }
  }
}

function applyStage(body: HTMLDivElement, designW: number, designH: number): void {
  if (body.querySelector(":scope > .pn-stage")) return;  // already staged
  const stage = document.createElement("div");
  stage.className = "pn-stage";
  stage.style.setProperty("--pn-stage-min-w", `${designW}px`);
  stage.style.setProperty("--pn-stage-min-h", `${designH}px`);
  // Initial denominator values so the first paint is roughly correct
  // before the post-layout measurement updates them.
  stage.style.setProperty("--pn-stage-w", `${designW}px`);
  stage.style.setProperty("--pn-stage-h", `${designH}px`);
  while (body.firstChild) stage.appendChild(body.firstChild);
  body.classList.add("pn-stage-host");
  body.appendChild(stage);

  // After layout, sync the transform denominators to the stage's actual
  // pre-transform layout box. offsetWidth/Height honour min-width and
  // max-content sizing without being affected by the transform.
  requestAnimationFrame(() => {
    const w = stage.offsetWidth;
    const h = stage.offsetHeight;
    if (w > 0) stage.style.setProperty("--pn-stage-w", `${w}px`);
    if (h > 0) stage.style.setProperty("--pn-stage-h", `${h}px`);
  });
}

const SVG_SPEAKER = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <polygon points="2,7 2,13 6,13 11,16.5 11,3.5 6,7" fill="currentColor"/>
  <path d="M13 7 Q15.5 10 13 13" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M15 5 Q19 10 15 15" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

const SVG_MIC = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="7" y="1" width="6" height="10" rx="3" fill="currentColor"/>
  <path d="M4 10 Q4 17 10 17 Q16 17 16 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line x1="10" y1="17" x2="10" y2="19.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <line x1="7" y1="19.5" x2="13" y2="19.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

function buildAttributeBody(node: PatchNode): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "pn-attrui";

  // Header — shows connected target type, or object name when blank
  const header = document.createElement("div");
  header.className = "pn-attrui__header";

  const targetType = node.args[0] ?? "";
  const spec = OBJECT_DEFS[targetType];

  header.textContent = targetType || "attribute";
  wrap.appendChild(header);

  if (!spec) {
    // Empty state — no cable connected yet
    const hint = document.createElement("div");
    hint.className = "pn-attrui__hint";
    hint.textContent = "connect outlet → target";
    wrap.appendChild(hint);
    return wrap;
  }

  // Scrollable row list
  const scroll = document.createElement("div");
  scroll.className = "pn-attrui__scroll";

  // Isolate wheel events so scrolling doesn't pan the canvas
  scroll.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

  const visible = getVisibleArgs(spec);

  visible.forEach((arg, i) => {
    const row = document.createElement("div");
    row.className = "pn-attrui__row";

    const label = document.createElement("span");
    label.className = "pn-attrui__label";
    label.textContent = arg.name;
    label.title = arg.description ?? arg.name;
    row.appendChild(label);

    const currentVal = node.args[i + 1] ?? (arg.default ?? "0");

    if (arg.type === "float" || arg.type === "int") {
      const min  = arg.min  ?? (arg.type === "int" ? 0   : 0.0);
      const max  = arg.max  ?? (arg.type === "int" ? 100 : 1.0);
      const step = arg.step ?? (arg.type === "int" ? 1   : 0.001);
      const numVal = parseFloat(currentVal);
      const safeVal = isNaN(numVal) ? min : Math.max(min, Math.min(max, numVal));

      const slider = document.createElement("input");
      slider.type  = "range";
      slider.className  = "pn-attrui__slider";
      slider.min   = String(min);
      slider.max   = String(max);
      slider.step  = String(step);
      slider.value = String(safeVal);
      slider.dataset.argIndex = String(i);

      const readout = document.createElement("span");
      readout.className = "pn-attrui__readout";
      // Display with appropriate precision
      readout.textContent = arg.type === "int"
        ? String(Math.round(safeVal))
        : safeVal.toFixed(3);

      row.appendChild(slider);
      row.appendChild(readout);

    } else {
      // symbol / list → text input
      const input = document.createElement("input");
      input.type  = "text";
      input.className = "pn-attrui__text";
      input.value = currentVal;
      input.dataset.argIndex = String(i);
      row.appendChild(input);
    }

    scroll.appendChild(row);
  });

  wrap.appendChild(scroll);
  return wrap;
}

/**
 * Build the ezScale body: 4 editable text fields (inMin/inMax/outMin/outMax)
 * and a dual-handle range slider whose handles span [outMin, outMax] and
 * pinch the active output sub-range.
 */
function buildEzScaleBody(node: PatchNode): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "pn-ezscale";

  // Fields display whatever is in args; blank by default on a freshly-created
  // ezScale (the user fills the bounds before the slider becomes interactive).
  const inMinStr  = node.args[0] ?? "";
  const inMaxStr  = node.args[1] ?? "";
  const outMinStr = node.args[2] ?? "";
  const outMaxStr = node.args[3] ?? "";

  const mkField = (label: string, fieldKey: string, valueStr: string) => {
    const cell = document.createElement("label");
    cell.className = "pn-ezscale__cell";
    const lab = document.createElement("span");
    lab.className = "pn-ezscale__label";
    lab.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pn-ezscale__field";
    input.value = valueStr;
    input.dataset.ezscaleField = fieldKey;
    input.spellcheck = false;
    cell.append(lab, input);
    return cell;
  };

  const autoOn    = (node.args[6] ?? "1") !== "0";
  const collapsed = (node.args[8] ?? "0") === "1";
  const inverted  = (node.args[10] ?? "0") === "1";

  if (collapsed) wrap.classList.add("pn-ezscale--collapsed");

  const toolbar = document.createElement("div");
  toolbar.className = "pn-ezscale__toolbar";

  const invertBtn = document.createElement("button");
  invertBtn.type = "button";
  invertBtn.className = "pn-ezscale__invert-btn";
  invertBtn.dataset.ezscaleAction = "toggle-invert";
  invertBtn.setAttribute("aria-pressed", inverted ? "true" : "false");
  invertBtn.textContent = "⇅";
  invertBtn.title = inverted ? "Output is inverted (high → low). Click to restore." : "Invert output direction (low → high becomes high → low).";
  toolbar.appendChild(invertBtn);

  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "pn-ezscale__auto-btn";
  autoBtn.dataset.ezscaleAction = "toggle-auto";
  autoBtn.setAttribute("aria-pressed", autoOn ? "true" : "false");
  autoBtn.textContent = "auto";
  autoBtn.title = "Auto-detect input range from incoming values and output range from connected target.";
  toolbar.appendChild(autoBtn);

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "pn-ezscale__collapse-btn";
  collapseBtn.dataset.ezscaleAction = "toggle-collapse";
  collapseBtn.setAttribute("aria-pressed", collapsed ? "true" : "false");
  collapseBtn.textContent = collapsed ? "▸" : "▾";
  collapseBtn.title = collapsed ? "Expand controls" : "Collapse to slider";
  toolbar.appendChild(collapseBtn);

  wrap.appendChild(toolbar);

  if (!collapsed) {
    const fields = document.createElement("div");
    fields.className = "pn-ezscale__fields";
    fields.appendChild(mkField("in min",  "inMin",  inMinStr));
    fields.appendChild(mkField("in max",  "inMax",  inMaxStr));
    fields.appendChild(mkField("out min", "outMin", outMinStr));
    fields.appendChild(mkField("out max", "outMax", outMaxStr));
    wrap.appendChild(fields);
  }

  // Pre-scale multiplier — visible whether expanded or collapsed.
  const multStr = node.args[7] ?? "1";
  const multRow = document.createElement("div");
  multRow.className = "pn-ezscale__mult-row";
  multRow.appendChild(mkField("× mult", "mult", multStr));
  wrap.appendChild(multRow);

  // Range slider — only interactive once outMin/outMax are both valid numbers.
  // Until then, render a flat empty track with no handles.
  const outMin = parseFloat(outMinStr);
  const outMax = parseFloat(outMaxStr);
  const boundsReady = isFinite(outMin) && isFinite(outMax) && outMin !== outMax;

  const slider = document.createElement("div");
  slider.className = "pn-ezscale__range";
  if (!boundsReady) slider.classList.add("pn-ezscale__range--inert");

  const track = document.createElement("div");
  track.className = "pn-ezscale__track";

  if (boundsReady) {
    // Active range falls back to full bounds when outLo/outHi are blank — the
    // user hasn't pinched the slider yet.
    const outLoNum = parseFloat(node.args[4] ?? "");
    const outHiNum = parseFloat(node.args[5] ?? "");
    const outLo = isFinite(outLoNum) ? outLoNum : outMin;
    const outHi = isFinite(outHiNum) ? outHiNum : outMax;

    const span = outMax - outMin;
    const pct = (v: number) => Math.max(0, Math.min(1, (v - outMin) / span)) * 100;
    const loPct = pct(outLo);
    const hiPct = pct(outHi);

    const fill = document.createElement("div");
    fill.className = "pn-ezscale__fill";
    fill.style.left  = `${Math.min(loPct, hiPct)}%`;
    fill.style.right = `${100 - Math.max(loPct, hiPct)}%`;
    track.appendChild(fill);

    const thumbLo = document.createElement("div");
    thumbLo.className = "pn-ezscale__thumb pn-ezscale__thumb--lo";
    thumbLo.style.left = `${loPct}%`;
    thumbLo.dataset.ezscaleThumb = "lo";
    track.appendChild(thumbLo);

    const thumbHi = document.createElement("div");
    thumbHi.className = "pn-ezscale__thumb pn-ezscale__thumb--hi";
    thumbHi.style.left = `${hiPct}%`;
    thumbHi.dataset.ezscaleThumb = "hi";
    track.appendChild(thumbHi);
  }

  slider.appendChild(track);

  if (boundsReady) {
    // Edge-pinned value labels — stay at the slider's left/right edges so the
    // user can read the active range bounds without the labels riding the thumbs.
    const outLoNum = parseFloat(node.args[4] ?? "");
    const outHiNum = parseFloat(node.args[5] ?? "");
    const outLo = isFinite(outLoNum) ? outLoNum : outMin;
    const outHi = isFinite(outHiNum) ? outHiNum : outMax;
    const intMode = isIntForm(outMinStr) && isIntForm(outMaxStr);

    const edgeLo = document.createElement("span");
    edgeLo.className = "pn-ezscale__edge-label pn-ezscale__edge-label--lo";
    edgeLo.textContent = formatThumbValue(outLo, intMode);
    slider.appendChild(edgeLo);

    const edgeHi = document.createElement("span");
    edgeHi.className = "pn-ezscale__edge-label pn-ezscale__edge-label--hi";
    edgeHi.textContent = formatThumbValue(outHi, intMode);
    slider.appendChild(edgeHi);
  }

  wrap.appendChild(slider);

  return wrap;
}

/**
 * Build the ezSlider body: two text fields pinned above each end of a single-
 * thumb slider. Dragging the thumb interpolates between lo and hi.
 */
function buildEzSliderBody(node: PatchNode): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "pn-ezslider";

  const loStr = node.args[0] ?? "0";
  const hiStr = node.args[1] ?? "1";
  const value = parseFloat(node.args[2] ?? "0.5");
  const thumbPct = Math.max(0, Math.min(1, isNaN(value) ? 0.5 : value)) * 100;

  const fields = document.createElement("div");
  fields.className = "pn-ezslider__fields";

  const mkInput = (fieldKey: string, val: string) => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pn-ezslider__field";
    input.value = val;
    input.dataset.ezsliderField = fieldKey;
    input.spellcheck = false;
    return input;
  };

  fields.appendChild(mkInput("lo", loStr));
  fields.appendChild(mkInput("hi", hiStr));
  wrap.appendChild(fields);

  const lo = parseFloat(loStr);
  const hi = parseFloat(hiStr);
  const boundsReady = isFinite(lo) && isFinite(hi);

  const track = document.createElement("div");
  track.className = "pn-ezslider__track";
  if (!boundsReady) track.classList.add("pn-ezslider__track--inert");

  const thumb = document.createElement("div");
  thumb.className = "pn-ezslider__thumb";
  thumb.style.left = `${thumbPct}%`;
  if (!boundsReady) thumb.style.display = "none";
  track.appendChild(thumb);

  wrap.appendChild(track);

  return wrap;
}

function buildBody(node: PatchNode): HTMLDivElement {
  // Local (gitignored) plugins claim the body fully — they own classes,
  // layout, and any inline interactive controls.
  const localBody = renderLocalPluginBody(node);
  if (localBody) return localBody;

  const body = document.createElement("div");
  body.className = "patch-object-body";

  if (node.type === "comment") {
    const text = document.createElement("div");
    text.className = "patch-object-comment-text";
    text.textContent = node.args[0] ?? "";
    body.appendChild(text);

  } else if (node.type === "button") {
    // PD-style bang: just the circle, no label
    const face = document.createElement("div");
    face.className = "patch-object-face patch-object-face-button";
    body.appendChild(face);

  } else if (node.type === "toggle") {
    // Lightswitch-style toggle: wall plate with rocker, I (on) / O (off)
    const isOn = node.args[0] === "1";
    const plate = document.createElement("div");
    plate.className = "patch-object-toggle-plate";

    const screwTop = document.createElement("div");
    screwTop.className = "patch-object-toggle-screw";
    screwTop.textContent = "⊕";

    const rocker = document.createElement("div");
    rocker.className = "patch-object-toggle-rocker";

    const halfOn = document.createElement("div");
    halfOn.className = `patch-object-toggle-half patch-object-toggle-half-on${isOn ? " patch-object-toggle-half--active" : ""}`;
    halfOn.textContent = "I";

    const halfOff = document.createElement("div");
    halfOff.className = `patch-object-toggle-half patch-object-toggle-half-off${!isOn ? " patch-object-toggle-half--active" : ""}`;
    halfOff.textContent = "O";

    const screwBot = document.createElement("div");
    screwBot.className = "patch-object-toggle-screw";
    screwBot.textContent = "⊕";

    rocker.appendChild(halfOn);
    rocker.appendChild(halfOff);
    plate.appendChild(screwTop);
    plate.appendChild(rocker);
    plate.appendChild(screwBot);
    body.appendChild(plate);

  } else if (node.type === "integer" || node.type === "float") {
    const odo = document.createElement("div");
    odo.className = "pn-odometer";
    buildOdometerContent(odo, parseFloat(node.args[0] ?? "0"), node.type === "float", null);
    body.appendChild(odo);

  } else if (node.type === "message") {
    // Max-style message box: displays text content, click to send
    const content = document.createElement("div");
    content.className = "patch-object-message-content";
    content.textContent = node.args.join(" ");
    body.appendChild(content);

  } else if (node.type === "slider") {
    // PD-style hslider: track fills the object, no label
    const track = document.createElement("div");
    track.className = "patch-object-slider-track";

    const thumb = document.createElement("div");
    thumb.className = "patch-object-slider-thumb";
    const sliderVal = parseFloat(node.args[0] ?? "0");
    const pct = Math.max(0, Math.min(1, isNaN(sliderVal) ? 0 : sliderVal)) * 100;
    thumb.style.left = `${pct}%`;
    track.appendChild(thumb);

    body.appendChild(track);

  } else if (node.type === "ezScale") {
    body.appendChild(buildEzScaleBody(node));

  } else if (node.type === "ezSlider") {
    body.appendChild(buildEzSliderBody(node));

  } else if (node.type === "codebox") {
    const codebox = document.createElement("div");
    codebox.className = "patch-object-codebox";

    const header = document.createElement("div");
    header.className = "patch-object-codebox-header";

    const name = document.createElement("span");
    name.className = "patch-object-codebox-name";
    name.textContent = "codebox";

    const badge = document.createElement("span");
    badge.className = "patch-object-codebox-badge";
    badge.textContent = (node.args[0] ?? "js").toUpperCase();

    const host = document.createElement("div");
    host.className = "patch-object-codebox-host";
    host.dataset.codeboxNodeId = node.id;

    header.append(name, badge);
    codebox.append(header, host);
    body.appendChild(codebox);

  } else if (node.type === "attribute") {
    body.appendChild(buildAttributeBody(node));

  } else if (node.type === "imageFX*") {
    const title = document.createElement("div");
    title.className = "patch-object-visual-label";
    title.textContent = "imageFX*";
    body.appendChild(title);

    // Show which effects are non-default as a compact sub-label
    const f = (v: string | undefined, def: number) => { const n = parseFloat(v ?? ""); return isNaN(n) ? def : n; };
    const parts: string[] = [];
    const hue = f(node.args[0], 0);   if (hue  !== 0) parts.push(`H${Math.round(hue)}`);
    const sat = f(node.args[1], 1);   if (sat  !== 1) parts.push(`S${sat.toFixed(1)}`);
    const bri = f(node.args[2], 1);   if (bri  !== 1) parts.push(`B${bri.toFixed(1)}`);
    const con = f(node.args[3], 1);   if (con  !== 1) parts.push(`C${con.toFixed(1)}`);
    const blr = f(node.args[4], 0);   if (blr  >  0)  parts.push(`blur${blr}`);
    const inv = f(node.args[5], 0);   if (inv  >  0)  parts.push(`inv`);

    const sub = document.createElement("div");
    sub.className = "patch-object-visual-sub";
    sub.textContent = parts.length ? parts.join(" ") : "dbl-click to edit";
    body.appendChild(sub);

  } else if (node.type === "mediaImage*") {
    body.classList.add("patch-object-mediaimage-body");

    const polaroid = document.createElement("div");
    polaroid.className = "pn-polaroid";

    const photoArea = document.createElement("div");
    photoArea.className = "pn-polaroid__photo";

    // displayUrl is a transient blob/data URL set by VisualizerGraph after IDB load.
    // args[0] may be an "idb:…" key (not a valid src), so we prefer displayUrl.
    const rawRef = node.args[0] ?? "";
    const imgSrc = node.displayUrl || (rawRef.startsWith("idb:") ? "" : rawRef);
    if (imgSrc) {
      const img = document.createElement("img");
      img.className = "pn-polaroid__img";
      img.src = imgSrc;
      img.draggable = false;
      photoArea.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "pn-polaroid__placeholder";
      photoArea.appendChild(ph);
    }

    polaroid.appendChild(photoArea);

    const base = document.createElement("div");
    base.className = "pn-polaroid__base";
    const label = document.createElement("span");
    label.className = "pn-polaroid__label";
    label.textContent = imgSrc ? (node.args[1] || "dbl-click to change") : "dbl-click to load";
    base.appendChild(label);
    polaroid.appendChild(base);

    body.appendChild(polaroid);

  } else if (node.type === "patchViz") {
    body.classList.add("patch-object-patchviz-body");
    const mount = document.createElement("div");
    mount.className = "pn-patchviz-mount";
    mount.dataset.patchvizNodeId = node.id;
    body.appendChild(mount);
    const label = document.createElement("div");
    label.className = "pn-patchviz-label";
    const enabled = (node.args[1] ?? "1") !== "0";
    label.textContent = `${node.args[0] ?? "world1"} · ${enabled ? "on" : "off"}`;
    body.appendChild(label);

  } else if (node.type === "shaderToy*") {
    const title = document.createElement("div");
    title.className = "patch-object-visual-label";
    title.textContent = "shaderToy*";
    body.appendChild(title);

    const preset = node.args[0] ?? "default";
    const hasCode = (node.args[1] ?? "") !== "";
    const w = node.args[2] ?? "512";
    const h = node.args[3] ?? "512";
    const sub = document.createElement("div");
    sub.className = "patch-object-visual-sub";
    sub.textContent = `${hasCode ? "custom" : preset} · ${w}×${h}`;
    body.appendChild(sub);

  } else if (node.type === "visualizer*" || node.type === "mediaVideo*" || node.type === "layer*") {
    const title = document.createElement("div");
    title.className = "patch-object-visual-label";
    title.textContent = node.type;
    body.appendChild(title);

    let subText = "";
    if (node.type === "visualizer*") {
      const nm = node.args[0] ?? "world1";
      const open = (node.args[2] ?? "0") === "1";
      const w = node.args[5];
      const h = node.args[6];
      const bits = [`"${nm}"`, open ? "open" : "closed"];
      if (w && h) bits.push(`${w}×${h}`);
      subText = bits.join(" · ");
    } else if (node.type === "layer*") {
      const ctx = node.args[0] ?? "world1";
      const pri = node.args[1] ?? "0";
      subText = `${ctx} · ${pri}`;
    } else if (node.type === "mediaVideo*") {
      const url = node.args[0] ?? "";
      const name = node.args[1] ?? "";
      const transport = node.args[2] ?? "stop";
      const label = name || (url ? (url.split("/").pop()?.split("?")[0] ?? url) : "no file");
      subText = `${label} · ${transport}`;
    }

    if (subText) {
      const sub = document.createElement("div");
      sub.className = "patch-object-visual-sub";
      sub.textContent = subText;
      body.appendChild(sub);
    }

  } else if (node.type === "js~") {
    // Inline panel host — JsEffectPanelController mounts the CodeMirror
    // editor + slider GUI here after render(). Empty on initial paint.
    body.classList.add("patch-object-jseffect-body");
    body.dataset.locked = (node.args[2] ?? "0") === "1" ? "1" : "0";
    const host = document.createElement("div");
    host.className = "pn-jseffect-panel-host";
    host.dataset.jseffectPanelHost = node.id;
    body.appendChild(host);

  } else if (node.type === "reaperVideo*") {
    // Inline panel host — ReaperVideoPanelController mounts CodeMirror +
    // knob GUI after render(). args[0]=code, args[1]=library, args[2]=locked.
    body.classList.add("patch-object-rvideo-body");
    body.dataset.locked = (node.args[2] ?? "0") === "1" ? "1" : "0";
    const host = document.createElement("div");
    host.className = "pn-rvideo-panel-host";
    host.dataset.rvideoPanelHost = node.id;
    body.appendChild(host);

  } else if (node.type === "mixer~") {
    const locked = (node.args[3] ?? "0") === "1";
    body.classList.add("patch-object-mixer-body");
    body.dataset.locked = locked ? "1" : "0";
    const host = document.createElement("div");
    host.className = "pn-mixer-panel-host";
    host.dataset.mixerPanelHost = node.id;
    body.appendChild(host);

    const lockBtn = document.createElement("button");
    lockBtn.className = "pn-subpatch-lock";
    lockBtn.dataset.locked = locked ? "1" : "0";
    lockBtn.setAttribute("aria-label", locked ? "Unlock to use controls" : "Lock to move object");
    lockBtn.innerHTML = LOCK_ICON_SVG;
    body.appendChild(lockBtn);

  } else if (node.type === "browser~*") {
    body.classList.add("patch-object-browser-body");
    const host = document.createElement("div");
    host.className = "pn-browser-panel-host";
    host.dataset.browserPanelHost = node.id;
    body.appendChild(host);

  } else if (node.type === "frame*") {
    // Inline panel host — FramePanelController mounts the toolbar +
    // transparent capture rect here. Body itself is transparent so the
    // canvas content beneath the frame remains visible (and capturable).
    body.classList.add("patch-object-frame-body");
    const host = document.createElement("div");
    host.className = "pn-frame-panel-host";
    host.dataset.framePanelHost = node.id;
    body.appendChild(host);

  } else if (node.type === "cam*") {
    // Inline panel host — CamPanelController mounts the live mirror +
    // device picker after render().
    body.classList.add("patch-object-cam-body");
    const host = document.createElement("div");
    host.className = "pn-cam-panel-host";
    host.dataset.camPanelHost = node.id;
    body.appendChild(host);

  } else if (node.type === "youtube~*") {
    body.classList.add("patch-object-youtube-body");
    const locked = (node.args[4] ?? "0") === "1";
    body.dataset.locked = locked ? "1" : "0";
    const host = document.createElement("div");
    host.className = "pn-youtube-panel-host";
    host.dataset.youtubePanelHost = node.id;
    body.appendChild(host);

    const lockBtn = document.createElement("button");
    lockBtn.className = "pn-subpatch-lock";
    lockBtn.dataset.locked = locked ? "1" : "0";
    lockBtn.setAttribute("aria-label", locked ? "Unlock to use URL field + buttons" : "Lock to move object");
    lockBtn.innerHTML = LOCK_ICON_SVG;
    body.appendChild(lockBtn);

  } else if (node.type === "dmx") {
    // Inline panel host — DmxPanelController mounts the live GUI here after
    // render(). Empty on initial paint; the controller fills it in the same
    // frame via main.ts's render() → mountDmxPanels() hook.
    body.classList.add("patch-object-dmx-body");
    const locked = (node.args[8] ?? "0") === "1";
    body.dataset.locked = locked ? "1" : "0";
    const host = document.createElement("div");
    host.className = "pn-dmx-panel-host";
    host.dataset.dmxPanelHost = node.id;
    body.appendChild(host);

    const lockBtn = document.createElement("button");
    lockBtn.className = "pn-subpatch-lock";
    lockBtn.dataset.locked = locked ? "1" : "0";
    lockBtn.setAttribute("aria-label", locked ? "Unlock to use panel" : "Lock to move object");
    lockBtn.innerHTML = LOCK_ICON_SVG;
    body.appendChild(lockBtn);

  } else if (node.type === "peer") {
    body.classList.add("patch-object-peer-body");
    const host = document.createElement("div");
    host.className = "pn-peer-panel-host";
    host.dataset.peerPanelHost = node.id;
    body.appendChild(host);

  } else if (node.type === "phoneTilt") {
    body.classList.add("patch-object-phonetilt-body");
    const host = document.createElement("div");
    host.className = "pn-phonetilt-panel-host";
    host.dataset.phonetiltPanelHost = node.id;
    body.appendChild(host);

  } else if (node.type === "s" || node.type === "r") {
    const row = document.createElement("div");
    row.className = "patch-object-sr";

    const title = document.createElement("div");
    title.className = "patch-object-title";
    title.textContent = node.args[0] ? `${node.type} ${node.args[0]}` : node.type;
    row.appendChild(title);
    body.appendChild(row);

  } else if (node.type === "buffer~") {
    body.classList.add("patch-object-buffer-body");

    const transport = node.args[4] ?? "stop";
    const mode      = bufferMode(node.args);
    const rate      = parseFloat(node.args[1] ?? "1");
    const loop      = (node.args[2] ?? "0") !== "0";
    const maxLen    = parseFloat(node.args[3] ?? "180");

    // Stage = fixed-size inner box (220×110) scaled uniformly via CSS to fill
    // whatever the user resizes the object to. Keeps font-sizes, button paddings,
    // and waveform resolution all in a single visual ratio.
    const stage = document.createElement("div");
    stage.className = "pn-buf-stage";

    const title = document.createElement("div");
    title.className = "pn-buf-title";
    title.textContent = "buffer~";
    stage.appendChild(title);

    const transportRow = document.createElement("div");
    transportRow.className = "pn-buf-transport";
    transportRow.innerHTML = `
      <button type="button" class="pn-buf-btn pn-buf-rec${transport === "record" ? " pn-buf-active" : ""}"   data-buf-action="record" aria-label="Record">⏺</button>
      <button type="button" class="pn-buf-btn pn-buf-play${transport === "play"   ? " pn-buf-active" : ""}"  data-buf-action="play"   aria-label="Play">▶</button>
      <button type="button" class="pn-buf-btn pn-buf-pause${transport === "pause" ? " pn-buf-active" : ""}" data-buf-action="pause"  aria-label="Pause">❚❚</button>
      <button type="button" class="pn-buf-btn pn-buf-stop${transport === "stop"   ? " pn-buf-active" : ""}" data-buf-action="stop"   aria-label="Stop">■</button>
    `;
    stage.appendChild(transportRow);

    const wave = document.createElement("canvas");
    wave.className = "pn-buf-wave";
    wave.dataset.bufNodeId = node.id;
    wave.width  = 200;
    wave.height = 36;
    stage.appendChild(wave);

    const info = document.createElement("div");
    info.className = "pn-buf-info";
    const rateStr = `×${rate.toFixed(2)}`;
    info.innerHTML = `
      <span class="pn-buf-rate">${rateStr}</span>
      <span class="pn-buf-loop${loop ? " pn-buf-loop-on" : ""}">loop:${loop ? "on" : "off"}</span>
      <span class="pn-buf-maxlen" data-buf-maxlen-display title="Max recording length (1s–60m) — click to edit">max:${formatMaxLen(maxLen)}</span>
      <button type="button" class="pn-buf-btn pn-buf-mode" data-buf-action="${mode === "stereo" ? "mono" : "stereo"}">${mode === "stereo" ? "STEREO" : "MONO"}</button>
    `;
    stage.appendChild(info);

    body.appendChild(stage);

  } else if (node.type === "vbuf*") {
    body.classList.add("patch-object-vbuf-body");

    const transport = node.args[3] ?? "stop";
    const rate      = videoBufferRate(node.args);
    const loop      = videoBufferLoop(node.args);
    const maxLen    = videoBufferMaxLen(node.args);

    const stage = document.createElement("div");
    stage.className = "pn-vbuf-stage";

    const title = document.createElement("div");
    title.className = "pn-vbuf-title";
    title.textContent = "vbuf*";
    stage.appendChild(title);

    const transportRow = document.createElement("div");
    transportRow.className = "pn-vbuf-transport";
    transportRow.innerHTML = `
      <button type="button" class="pn-vbuf-btn pn-vbuf-rec${transport === "record" ? " pn-vbuf-active" : ""}"   data-vbuf-action="record" aria-label="Record">⏺</button>
      <button type="button" class="pn-vbuf-btn pn-vbuf-play${transport === "play"   ? " pn-vbuf-active" : ""}"  data-vbuf-action="play"   aria-label="Play">▶</button>
      <button type="button" class="pn-vbuf-btn pn-vbuf-pause${transport === "pause" ? " pn-vbuf-active" : ""}" data-vbuf-action="pause"  aria-label="Pause">❚❚</button>
      <button type="button" class="pn-vbuf-btn pn-vbuf-stop${transport === "stop"   ? " pn-vbuf-active" : ""}" data-vbuf-action="stop"   aria-label="Stop">■</button>
    `;
    stage.appendChild(transportRow);

    // Preview area — playback HTMLVideoElement gets mounted here at runtime.
    // Until we have a recording, it's a dim placeholder. The thumbnail strip
    // (range overlay surface) sits below.
    const preview = document.createElement("div");
    preview.className = "pn-vbuf-preview";
    preview.dataset.vbufNodeId = node.id;
    stage.appendChild(preview);

    const strip = document.createElement("canvas");
    strip.className = "pn-vbuf-strip";
    strip.dataset.vbufNodeId = node.id;
    strip.width  = 260;
    strip.height = 28;
    stage.appendChild(strip);

    const info = document.createElement("div");
    info.className = "pn-vbuf-info";
    info.innerHTML = `
      <span class="pn-vbuf-rate">×${rate.toFixed(2)}</span>
      <button type="button" class="pn-vbuf-loop-btn${loop ? " pn-vbuf-loop-on" : ""}" data-vbuf-action="${loop ? "loop-off" : "loop-on"}" title="Toggle loop">loop:${loop ? "on" : "off"}</button>
      <button type="button" class="pn-vbuf-loop-btn" data-vbuf-action="load" title="Load a local video file into this buffer">load video</button>
      <span class="pn-vbuf-maxlen" data-vbuf-maxlen-display title="Max recording length (1s–10m) — click to edit">max:${formatMaxLen(maxLen)}</span>
    `;
    stage.appendChild(info);

    body.appendChild(stage);

  } else if (node.type === "wave~") {
    body.classList.add("pn-wave-body");
    const freq  = parseFloat(node.args[0] ?? "220");
    const morph = parseFloat(node.args[1] ?? "0");
    const level = parseFloat(node.args[2] ?? "0.5");
    const locked = (node.args[3] ?? "0") !== "0";
    body.dataset.waveLocked = locked ? "1" : "0";
    body.innerHTML = `
      <div class="pn-wave-panel">
        <div class="pn-wave-scope-bezel">
          <canvas class="pn-wave-scope" data-wave-node-id="${node.id}" width="320" height="96"></canvas>
        </div>
        <div class="pn-wave-scope-bezel pn-wave-scope-bezel--live">
          <canvas class="pn-wave-scope-live" data-wave-node-id="${node.id}" width="320" height="96"></canvas>
        </div>
        <div class="pn-wave-knobs">
          ${waveKnobHtml(node.id, "freq",  "FREQ",  freq,  formatFreq(freq))}
          ${waveKnobHtml(node.id, "morph", "MORPH", morph, formatMorph(morph))}
          ${waveKnobHtml(node.id, "level", "LEVEL", level, formatLevel(level))}
        </div>
      </div>`;

  } else if (node.type === "noise~") {
    body.classList.add("pn-noise-body");
    const color = normalizeNoiseColor(node.args[0]);
    const level = parseFloat(node.args[1] ?? "0.25");
    body.innerHTML = `
      <div class="pn-noise-panel">
        <div class="pn-noise-scope-bezel">
          <canvas class="pn-noise-scope-live" data-noise-node-id="${node.id}" width="320" height="96"></canvas>
        </div>
        <div class="pn-noise-readouts">
          <span data-noise-readout="color">${color}</span>
          <span data-noise-readout="level">L:${formatNoiseLevel(level)}</span>
        </div>
      </div>`;

  } else if (node.type === "lfo~") {
    body.classList.add("pn-lfo-body");
    const rate  = parseFloat(node.args[0] ?? "1");
    const depth = parseFloat(node.args[1] ?? "100");
    const shape = parseFloat(node.args[2] ?? "0");
    const locked = (node.args[3] ?? "0") !== "0";
    body.dataset.lfoLocked = locked ? "1" : "0";
    body.innerHTML = `
      <div class="pn-lfo-panel">
        <div class="pn-lfo-scope-bezel">
          <canvas class="pn-lfo-scope" data-lfo-node-id="${node.id}" width="320" height="96"></canvas>
        </div>
        <div class="pn-lfo-scope-bezel pn-lfo-scope-bezel--live">
          <canvas class="pn-lfo-scope-live" data-lfo-node-id="${node.id}" width="320" height="96"></canvas>
        </div>
        <div class="pn-lfo-knobs">
          ${lfoKnobHtml(node.id, "rate",  "RATE",  rate,  formatRate(rate))}
          ${lfoKnobHtml(node.id, "depth", "DEPTH", depth, formatDepth(depth))}
          ${lfoKnobHtml(node.id, "shape", "SHAPE", shape, formatShape(shape))}
        </div>
      </div>`;

  } else if (node.type === "transientFollower~") {
    body.classList.add("pn-tf-body");
    const a    = parseFloat(node.args[0] ?? "5");
    const r    = parseFloat(node.args[1] ?? "80");
    const sens = parseFloat(node.args[2] ?? "1");
    const flr  = parseFloat(node.args[3] ?? "0");
    body.innerHTML = `
      <div class="pn-tf-panel">
        <div class="pn-tf-scope-bezel">
          <canvas class="pn-tf-scope-live" data-tf-node-id="${node.id}" width="320" height="120"></canvas>
        </div>
        <div class="pn-tf-readouts pn-adsr-readouts" data-tf-node-id="${node.id}">
          <span data-tf-readout="attack">A:${formatAdsrTime(a)}</span>
          <span data-tf-readout="release">R:${formatAdsrTime(r)}</span>
          <span data-tf-readout="sensitivity">S:${formatTfSensitivity(sens)}</span>
          <span data-tf-readout="floor">F:${formatAdsrLevel(flr)}</span>
        </div>
      </div>`;

  } else if (node.type === "adsr~") {
    body.classList.add("pn-adsr-body");
    const a  = parseFloat(node.args[0] ?? "50");
    const d  = parseFloat(node.args[1] ?? "100");
    const s  = parseFloat(node.args[2] ?? "0.7");
    const r  = parseFloat(node.args[3] ?? "200");
    const sh = parseFloat(node.args[4] ?? "200");
    const locked = (node.args[5] ?? "0") !== "0";
    body.dataset.adsrLocked = locked ? "1" : "0";
    body.innerHTML = `
      <div class="pn-adsr-panel">
        <div class="pn-adsr-editor-bezel">
          <svg class="pn-adsr-svg" data-adsr-node-id="${node.id}" viewBox="0 0 ${ADSR_W} ${ADSR_H}" preserveAspectRatio="none">
            ${adsrEditorSvg(node)}
          </svg>
        </div>
        <div class="pn-adsr-readouts">
          <span>A:${formatAdsrTime(a)}</span>
          <span>D:${formatAdsrTime(d)}</span>
          <span>S:${formatAdsrLevel(s)}</span>
          <span>H:${formatAdsrTime(sh)}</span>
          <span>R:${formatAdsrTime(r)}</span>
        </div>
      </div>`;

  } else if (node.type === "fft~") {
    body.classList.add("pn-fft-body");
    const n = fftBandCount(node.args);
    const labels: string[] = n === 4
      ? ["LO", "LM", "HM", "HI"]
      : Array.from({ length: n }, (_, i) => String(i + 1));
    const bandsHtml = labels
      .map(label => `<div class="pn-fft-band"><span class="pn-fft-band-label">${label}</span><span class="pn-fft-band-val">0.00</span></div>`)
      .join("");
    body.innerHTML = `
      <div class="pn-fft-device">
        <div class="pn-fft-top-label">FFT·SCOPE${n === 4 ? "" : ` · ${n}`}</div>
        <div class="pn-fft-screen-bezel">
          <div class="pn-fft-screen">
            <div class="pn-fft-mount" data-fft-node-id="${node.id}"></div>
          </div>
        </div>
        <div class="pn-fft-bands" style="grid-template-columns: repeat(${n}, minmax(0, 1fr));" data-band-count="${n}">
          ${bandsHtml}
        </div>
        <div class="pn-fft-controls">
          <div class="pn-fft-dpad">
            <div class="pn-fft-dpad-h"></div>
            <div class="pn-fft-dpad-v"></div>
          </div>
          <div class="pn-fft-power-led"></div>
          <div class="pn-fft-buttons">
            <div class="pn-fft-btn pn-fft-btn-b">B</div>
            <div class="pn-fft-btn pn-fft-btn-a">A</div>
          </div>
        </div>
      </div>`;

  } else if (node.type === "sequencer") {
    body.classList.add("patch-object-sequencer-body");

    const rows = sequencerRows(node);
    const cols = sequencerCols(node);
    const cells = getSequencerCells(node);
    const locked = (node.args[4] ?? "1") !== "0";
    const rawHead = Math.trunc(Number.parseFloat(node.args[2] ?? "0"));
    const playhead = ((rawHead % cols) + cols) % cols;

    const grid = document.createElement("div");
    grid.className = "pn-seq-grid";
    grid.dataset.locked = locked ? "1" : "0";
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows    = `repeat(${rows}, minmax(0, 1fr))`;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement("div");
        cell.className = "pn-seq-cell";
        if (c === playhead) cell.classList.add("pn-seq-cell--active");
        cell.dataset.seqRow = String(r);
        cell.dataset.seqCol = String(c);
        cell.contentEditable = locked ? "false" : "true";
        cell.spellcheck = false;
        cell.textContent = cells[r][c];
        grid.appendChild(cell);
      }
    }
    body.appendChild(grid);

    const lockBtn = document.createElement("button");
    lockBtn.className = "pn-subpatch-lock pn-sequencer-lock";
    lockBtn.dataset.locked = locked ? "1" : "0";
    lockBtn.setAttribute("aria-label", locked ? "Unlock cells to edit" : "Lock cells");
    lockBtn.innerHTML = LOCK_ICON_SVG;
    body.appendChild(lockBtn);

  } else if (node.type === "subPatch") {
    const mount = document.createElement("div");
    mount.className = "pn-subpatch-panel-mount";
    mount.dataset.panelFor = node.id;
    body.appendChild(mount);

    const locked = (node.args[3] ?? "1") !== "0";
    const lockBtn = document.createElement("button");
    lockBtn.className = "pn-subpatch-lock";
    lockBtn.dataset.locked = locked ? "1" : "0";
    lockBtn.setAttribute("aria-label", locked ? "Unlock to reposition GUI objects" : "Lock to interact");
    lockBtn.innerHTML = `
      <svg class="pn-lock-icon pn-lock-closed" viewBox="0 0 14 16" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="7" width="10" height="8" rx="1.5" fill="currentColor"/>
        <path d="M4.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <svg class="pn-lock-icon pn-lock-open" viewBox="0 0 14 16" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="7" width="10" height="8" rx="1.5" fill="currentColor"/>
        <path d="M4.5 7V5.5a2.5 2.5 0 0 1 5 0V3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>`;
    body.appendChild(lockBtn);

  } else if (node.type === "inlet") {
    const idx = node.args[0] ?? "0";
    const d = document.createElement("div");
    d.className = "pn-iolet-label";
    d.textContent = `in ${idx}`;
    body.appendChild(d);

  } else if (node.type === "outlet") {
    const idx = node.args[0] ?? "0";
    const d = document.createElement("div");
    d.className = "pn-iolet-label";
    d.textContent = `out ${idx}`;
    body.appendChild(d);

  } else if (node.type === "dac~" || node.type === "adc~") {
    // Icon above meters
    const icon = document.createElement("div");
    icon.className = "pn-meter-icon";
    icon.innerHTML = node.type === "dac~" ? SVG_SPEAKER : SVG_MIC;
    body.appendChild(icon);

    // Meter-only body — channels identified by L/R labels
    const meters = document.createElement("div");
    meters.className = "pn-meters";

    for (const ch of ["l", "r"] as const) {
      const wrap = document.createElement("div");
      wrap.className = "pn-meter-col";

      const track = document.createElement("div");
      track.className = `pn-meter-track pn-meter-${ch}`;
      const fill = document.createElement("div");
      fill.className = "pn-meter-fill";
      track.appendChild(fill);

      const label = document.createElement("div");
      label.className = "pn-meter-label";
      label.textContent = ch.toUpperCase();

      wrap.appendChild(track);
      wrap.appendChild(label);
      meters.appendChild(wrap);
    }
    body.appendChild(meters);
  } else {
    // All other objects: type label + optional args inline
    const title = document.createElement("div");
    title.className = "patch-object-title";
    if (node.type === "scale") {
      const inLow   = node.args[0] ?? "0";
      const inHigh  = node.args[1] ?? "1";
      const outLow  = node.args[2] ?? "0";
      const outHigh = node.args[3] ?? "127";
      title.textContent = `scale ${inLow} ${inHigh} ${outLow} ${outHigh}`;
      body.classList.add("patch-object-body--args-inline");
    } else if (MATH_OPS.has(node.type)) {
      const rightOp = node.args[0] ?? "0";
      title.textContent = `${node.type} ${rightOp}`;
      body.classList.add("patch-object-body--args-inline");
    } else if (node.type === "t") {
      const letters = node.args.length > 0 ? node.args.join(" ") : "i i";
      title.textContent = `t ${letters}`;
      body.classList.add("patch-object-body--args-inline");
    } else if (node.type === "f") {
      const val = parseFloat(node.args[0] ?? "0");
      title.textContent = `f ${isNaN(val) ? "0" : String(parseFloat(val.toFixed(4)))}`;
    } else {
      // Generic: show non-hidden creation args inline so users can see what
      // values an object was created with. Skipped for types that render
      // their args via a dedicated meta row (metro, click~).
      const def = OBJECT_DEFS[node.type];
      const hasOwnMeta = node.type === "metro" || node.type === "click~";
      const parts: string[] = [];
      if (def && !hasOwnMeta) {
        for (let i = 0; i < def.args.length; i++) {
          if (def.args[i].hidden) continue;
          if (def.args[i].type === "list") {
            // Variadic: consume all remaining node args from this index
            for (let j = i; j < node.args.length; j++) {
              const v = node.args[j];
              if (v !== undefined && v !== "") parts.push(v);
            }
            break;
          }
          const v = node.args[i];
          if (v !== undefined && v !== "") parts.push(v);
        }
      }
      if (parts.length > 0) {
        title.textContent = `${node.type} ${parts.join(" ")}`;
        body.classList.add("patch-object-body--args-inline");
      } else {
        title.textContent = node.type;
      }
    }
    body.appendChild(title);

    if (node.type === "metro") {
      const meta = document.createElement("div");
      meta.className = "patch-object-meta";
      meta.textContent = node.args[0] ?? "500";
      body.appendChild(meta);
    } else if (node.type === "click~") {
      const glyph = document.createElement("div");
      glyph.className = "patch-object-meta patch-object-glyph";
      glyph.textContent = "~>";
      body.appendChild(glyph);
    }
  }

  // Auto-wrap eligible types in a fixed-size .pn-stage so resizing the object
  // uniformly scales the body content. Excluded types either reflow naturally
  // (comment, message, sequencer) or own their own layout (panel-managed
  // types + buffer~). Local plugins own their own layout too.
  if (SCALE_ELIGIBLE_TYPES.has(node.type) && !hasLocalPlugin(node.type)) {
    const def = getObjectDef(node.type);
    applyStage(body, def.defaultWidth, def.defaultHeight);
  }

  return body;
}

/**
 * Rebuild the odometer drum columns inside a .pn-odometer element.
 * Each digit gets its own column showing the digit above, current, and below,
 * recreating the look of a vintage rolling-cylinder odometer.
 *
 * activePlace: null  = no column highlighted (initial render)
 *              number = place value being dragged (column brightens)
 */
export function buildOdometerContent(
  container: HTMLElement,
  value: number,
  isFloat: boolean,
  activePlace: number | null,
): void {
  container.innerHTML = "";

  const isNeg = value < 0;
  const absVal = Math.abs(value);
  const decimals = isFloat
    ? Math.min(6, Math.max(3, activePlace !== null ? Math.max(0, -activePlace) : 3))
    : 0;
  const formatted = absVal.toFixed(decimals);
  const dotIdx = formatted.indexOf(".");
  const intPart = dotIdx === -1 ? formatted : formatted.slice(0, dotIdx);
  const decPart = dotIdx === -1 ? "" : formatted.slice(dotIdx + 1);

  // Inner window — digit display area sits inside the frame
  const inner = document.createElement("div");
  inner.className = "pn-odo-inner";

  // Sign column
  const sign = document.createElement("span");
  sign.className = "pn-odo-sign";
  sign.textContent = isNeg ? "−" : "+";
  inner.appendChild(sign);

  // Helper: one rolling drum column
  const addDrum = (ch: string, place: number) => {
    const d = parseInt(ch, 10);
    const col = document.createElement("div");
    col.className = "pn-odo-col";
    col.dataset.place = String(place);
    if (activePlace !== null && place === activePlace) col.classList.add("pn-odo-col--active");

    const above = document.createElement("div");
    above.className = "pn-odo-above";
    above.textContent = String((d + 1) % 10);

    const curr = document.createElement("div");
    curr.className = "pn-odo-curr";
    curr.textContent = ch;

    const below = document.createElement("div");
    below.className = "pn-odo-below";
    below.textContent = String((d + 9) % 10);

    col.append(above, curr, below);
    inner.appendChild(col);
  };

  // Integer digits
  for (let i = 0; i < intPart.length; i++) {
    addDrum(intPart[i], intPart.length - 1 - i);
  }

  if (isFloat) {
    const dot = document.createElement("span");
    dot.className = "pn-odo-dot";
    dot.textContent = ".";
    inner.appendChild(dot);

    for (let i = 0; i < decPart.length; i++) {
      addDrum(decPart[i], -(i + 1));
    }
  }

  container.appendChild(inner);
}

export function renderObject(node: PatchNode): HTMLDivElement {
  const def = getObjectDef(node.type);
  const el = document.createElement("div");

  const slug = node.type.replace(/[^a-z0-9]+/gi, "-");
  el.className = `patch-object patch-object-${slug}`;
  if (def.category === "ui") el.classList.add("patch-object--ui");
  if (node.type === "comment") el.classList.add("patch-object--comment");
  if (node.type === "message") el.classList.add("patch-object--message");
  if (node.type === "attribute") el.classList.add("patch-object--attribute");
  if (def.category === "scripting") el.classList.add("patch-object--scripting");
  if (node.groupId) {
    el.classList.add("patch-object--grouped");
    el.dataset.groupId = node.groupId;
    const badge = document.createElement("div");
    badge.className = "pn-group-badge";
    el.appendChild(badge);
  }

  el.dataset.nodeId   = node.id;
  el.dataset.nodeType = node.type;
  if (node.name) el.dataset.nodeName = node.name;
  el.style.left = `${Math.round(node.x)}px`;
  el.style.top = `${Math.round(node.y)}px`;

  // Use node-level size if set (from resize), else fall back to def default
  const w = (node as PatchNode & { width?: number }).width ?? def.defaultWidth;
  const h = (node as PatchNode & { height?: number }).height ?? def.defaultHeight;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;

  el.setAttribute("aria-label", node.name ? `${node.name}: ${node.type} object` : `${node.type} object`);
  if (node.name) el.title = `${node.name} (${node.type})`;

  const topInlets = node.inlets.filter(p => !p.side || p.side === "top");
  const sideInlets = node.inlets.filter(p => p.side === "left");
  const topOutlets  = node.outlets.filter(p => !p.side || p.side === "top");
  const sideOutlets = node.outlets.filter(p => p.side === "right");

  el.appendChild(renderPorts("inlet", topInlets));
  el.appendChild(buildBody(node));
  el.appendChild(renderPorts("outlet", topOutlets));

  // Side inlet nubs — absolutely positioned on the left edge. Nub index
  // within the side-inlet strip = position in the filtered array (NOT the
  // raw port.index), so Phase C's secondary media inlets on reaperVideo
  // don't shift the param-knob nubs. All consumers (attribute, js~,
  // reaperVideo) use the same 22px header + 24px row grid; panels must
  // lay out their rows to match so this formula alone is authoritative —
  // no runtime sync required.
  sideInlets.forEach((port, slot) => {
    const nub = document.createElement("div");
    const portY = ATTR_SIDE_INLET_HEADER_H
      + slot * ATTR_SIDE_INLET_ROW_H
      + ATTR_SIDE_INLET_ROW_H / 2;
    nub.className = `patch-port patch-port-inlet patch-port-type-${port.type} patch-port-hot patch-port-side-left`;
    nub.dataset.portIndex = String(port.index);
    nub.dataset.portType  = port.type;
    nub.dataset.pnLabel   = port.label ?? `inlet ${port.index}`;
    nub.setAttribute("aria-label", `inlet ${port.index}: ${port.label ?? ""}`);
    nub.style.top  = `${portY}px`;
    nub.style.left = "0";
    el.appendChild(nub);
  });

  // Side outlet nubs — absolutely positioned on the right edge, row-centered.
  // Vertical position is a percentage of the object height so the nubs track
  // the grid rows even after the object is resized.
  const sideOutletCount = sideOutlets.length;
  for (const port of sideOutlets) {
    const nub = document.createElement("div");
    nub.className = `patch-port patch-port-outlet patch-port-type-${port.type} patch-port-hot patch-port-side-right`;
    nub.dataset.portIndex = String(port.index);
    nub.dataset.portType  = port.type;
    nub.dataset.pnLabel   = port.label ?? `outlet ${port.index}`;
    nub.setAttribute("aria-label", `outlet ${port.index}: ${port.label ?? ""}`);
    nub.style.top  = `${((port.index + 0.5) / Math.max(1, sideOutletCount)) * 100}%`;
    nub.style.left = "100%";
    el.appendChild(nub);
  }

  // Resize handle — bottom-right corner drag target. Suppressed for objects
  // whose panel UI assumes a fixed layout (browser~, youtube~).
  if (node.type !== "browser~*" && node.type !== "youtube~*") {
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "pn-resize-handle";
    el.appendChild(resizeHandle);
  }

  // Move-handles — invisible perimeter regions. Mousedown on one of these
  // initiates an object drag; mousedown on the body interior does not.
  // Bottom-right is reserved for resize (no --br variant). Ports and the
  // resize handle sit above via z-index, so port/resize hits win where
  // they overlap a move-handle.
  for (const variant of MOVE_HANDLE_VARIANTS) {
    const handle = document.createElement("div");
    handle.className = `pn-move-handle pn-move-handle--${variant}`;
    el.appendChild(handle);
  }

  return el;
}

/**
 * Grow the object's width so its inline-args title is never clipped.
 * Objects like `route`, `select`, `unpack`, `pack`, `t` carry args that
 * map directly to outlet identity — the user must be able to read them
 * to know which outlet does what. Must run after the element is in the
 * DOM (needs layout to measure scrollWidth).
 */
export function autoFitInlineArgsWidth(objectEl: HTMLElement): void {
  const body = objectEl.querySelector<HTMLElement>(".patch-object-body--args-inline");
  if (!body) return;
  // Skip while user is editing — typing handler grows the box live.
  if (objectEl.classList.contains("patch-object--editing")) return;
  const title = body.querySelector<HTMLElement>(".patch-object-title");
  if (!title) return;
  const overflow = title.scrollWidth - title.clientWidth;
  if (overflow <= 0) return;
  const currentWidth = objectEl.offsetWidth;
  // +2 keeps a hairline buffer so sub-pixel rounding doesn't trip the ellipsis.
  objectEl.style.width = `${currentWidth + overflow + 2}px`;
}
