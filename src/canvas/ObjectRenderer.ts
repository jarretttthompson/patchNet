import { renderPorts } from "./PortRenderer";
import { getObjectDef, OBJECT_DEFS, getVisibleArgs, getSequencerCells, sequencerCols, sequencerRows, ATTR_SIDE_INLET_HEADER_H, ATTR_SIDE_INLET_ROW_H } from "../graph/objectDefs";
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

function buildBody(node: PatchNode): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "patch-object-body";

  if (node.type === "button") {
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
    const sliderMin = parseFloat(node.args[1] ?? "0");
    const sliderMax = parseFloat(node.args[2] ?? "127");
    const sliderRange = sliderMax - sliderMin || 1;
    const pct = ((sliderVal - sliderMin) / sliderRange) * 100;
    thumb.style.left = `${Math.max(0, Math.min(100, pct))}%`;
    track.appendChild(thumb);

    body.appendChild(track);

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

  } else if (node.type === "imageFX") {
    const title = document.createElement("div");
    title.className = "patch-object-visual-label";
    title.textContent = "imageFX";
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

  } else if (node.type === "mediaImage") {
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

  } else if (node.type === "shaderToy") {
    const title = document.createElement("div");
    title.className = "patch-object-visual-label";
    title.textContent = "shaderToy";
    body.appendChild(title);

    const preset = node.args[0] ?? "default";
    const hasCode = (node.args[1] ?? "") !== "";
    const w = node.args[2] ?? "512";
    const h = node.args[3] ?? "512";
    const sub = document.createElement("div");
    sub.className = "patch-object-visual-sub";
    sub.textContent = `${hasCode ? "custom" : preset} · ${w}×${h}`;
    body.appendChild(sub);

  } else if (node.type === "visualizer" || node.type === "mediaVideo" || node.type === "layer") {
    const title = document.createElement("div");
    title.className = "patch-object-visual-label";
    title.textContent = node.type;
    body.appendChild(title);

    let subText = "";
    if (node.type === "visualizer") {
      const nm = node.args[0] ?? "world1";
      const open = (node.args[2] ?? "0") === "1";
      const w = node.args[5];
      const h = node.args[6];
      const bits = [`"${nm}"`, open ? "open" : "closed"];
      if (w && h) bits.push(`${w}×${h}`);
      subText = bits.join(" · ");
    } else if (node.type === "layer") {
      const ctx = node.args[0] ?? "world1";
      const pri = node.args[1] ?? "0";
      subText = `${ctx} · ${pri}`;
    } else if (node.type === "mediaVideo") {
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

  } else if (node.type === "s" || node.type === "r") {
    const row = document.createElement("div");
    row.className = "patch-object-sr";

    const title = document.createElement("div");
    title.className = "patch-object-title";
    title.textContent = node.args[0] ? `${node.type} ${node.args[0]}` : node.type;
    row.appendChild(title);
    body.appendChild(row);

  } else if (node.type === "fft~") {
    body.classList.add("pn-fft-body");
    body.innerHTML = `
      <div class="pn-fft-device">
        <div class="pn-fft-top-label">FFT·SCOPE</div>
        <div class="pn-fft-screen-bezel">
          <div class="pn-fft-screen">
            <div class="pn-fft-mount" data-fft-node-id="${node.id}"></div>
          </div>
        </div>
        <div class="pn-fft-bands">
          <div class="pn-fft-band"><span class="pn-fft-band-label">LO</span><span class="pn-fft-band-val">0.00</span></div>
          <div class="pn-fft-band"><span class="pn-fft-band-label">LM</span><span class="pn-fft-band-val">0.00</span></div>
          <div class="pn-fft-band"><span class="pn-fft-band-label">HM</span><span class="pn-fft-band-val">0.00</span></div>
          <div class="pn-fft-band"><span class="pn-fft-band-label">HI</span><span class="pn-fft-band-val">0.00</span></div>
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
    } else {
      title.textContent = node.type;
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
  el.style.left = `${Math.round(node.x)}px`;
  el.style.top = `${Math.round(node.y)}px`;

  // Use node-level size if set (from resize), else fall back to def default
  const w = (node as PatchNode & { width?: number }).width ?? def.defaultWidth;
  const h = (node as PatchNode & { height?: number }).height ?? def.defaultHeight;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;

  el.setAttribute("aria-label", `${node.type} object`);

  const topInlets = node.inlets.filter(p => !p.side || p.side === "top");
  const sideInlets = node.inlets.filter(p => p.side === "left");
  const topOutlets  = node.outlets.filter(p => !p.side || p.side === "top");
  const sideOutlets = node.outlets.filter(p => p.side === "right");

  el.appendChild(renderPorts("inlet", topInlets));
  el.appendChild(buildBody(node));
  el.appendChild(renderPorts("outlet", topOutlets));

  // Side inlet nubs — absolutely positioned on the left edge, aligned with rows
  for (const port of sideInlets) {
    const nub = document.createElement("div");
    const portY = ATTR_SIDE_INLET_HEADER_H
      + port.index * ATTR_SIDE_INLET_ROW_H
      + ATTR_SIDE_INLET_ROW_H / 2;
    nub.className = `patch-port patch-port-inlet patch-port-type-${port.type} patch-port-hot patch-port-side-left`;
    nub.dataset.portIndex = String(port.index);
    nub.dataset.portType  = port.type;
    nub.dataset.pnLabel   = port.label ?? `inlet ${port.index}`;
    nub.setAttribute("aria-label", `inlet ${port.index}: ${port.label ?? ""}`);
    nub.style.top  = `${portY}px`;
    nub.style.left = "0";
    el.appendChild(nub);
  }

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

  // Resize handle — bottom-right corner drag target
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "pn-resize-handle";
  el.appendChild(resizeHandle);

  return el;
}
