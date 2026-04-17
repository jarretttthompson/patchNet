import { renderPorts } from "./PortRenderer";
import { getObjectDef, OBJECT_DEFS, getVisibleArgs, ATTR_SIDE_INLET_HEADER_H, ATTR_SIDE_INLET_ROW_H } from "../graph/objectDefs";
import type { PatchNode } from "../graph/PatchNode";

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
    const numbox = document.createElement("div");
    numbox.className = "pn-numbox";
    buildNumboxContent(numbox, parseFloat(node.args[0] ?? "0"), node.type === "float", null);
    body.appendChild(numbox);

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
    label.textContent = node.args[0] ?? "world1";
    body.appendChild(label);

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

    const letter = document.createElement("span");
    letter.className = "patch-object-sr-type";
    letter.textContent = node.type;

    const channel = document.createElement("span");
    channel.className = "patch-object-sr-channel";
    channel.textContent = node.args[0] ?? "";

    row.appendChild(letter);
    row.appendChild(channel);
    body.appendChild(row);

  } else {
    // Logic/audio objects: keep text label
    const title = document.createElement("div");
    title.className = "patch-object-title";
    title.textContent = node.type;
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
    } else if (node.type === "dac~") {
      const glyph = document.createElement("div");
      glyph.className = "patch-object-meta patch-object-glyph";
      glyph.textContent = "L R";
      body.appendChild(glyph);
    }
  }

  return body;
}

/**
 * Rebuild the digit spans inside a .pn-numbox element.
 * activePlace: null = no digit highlighted (initial render / integer)
 *              number = power-of-10 place to underline (float drag)
 */
export function buildNumboxContent(
  container: HTMLElement,
  value: number,
  isFloat: boolean,
  activePlace: number | null,
): void {
  container.innerHTML = "";

  const decimals = isFloat
    ? Math.min(10, Math.max(3, activePlace !== null ? Math.max(0, -activePlace) : 3))
    : 0;
  const formatted = isFloat ? value.toFixed(decimals) : String(Math.trunc(value));

  const isNeg = formatted.startsWith("-");
  const absStr = isNeg ? formatted.slice(1) : formatted;
  const dotIdx = absStr.indexOf(".");

  if (isNeg) {
    const sign = document.createElement("span");
    sign.className = "pn-numbox__sign";
    sign.textContent = "−";
    container.appendChild(sign);
  }

  for (let j = 0; j < absStr.length; j++) {
    const ch = absStr[j];
    if (ch === ".") {
      const dot = document.createElement("span");
      dot.className = "pn-numbox__dot";
      dot.textContent = ".";
      container.appendChild(dot);
    } else {
      const place = dotIdx === -1
        ? absStr.length - 1 - j
        : j < dotIdx ? dotIdx - 1 - j : dotIdx - j;
      const span = document.createElement("span");
      span.className = "pn-numbox__digit";
      if (activePlace !== null && place === activePlace) {
        span.classList.add("pn-numbox__digit--active");
      }
      span.dataset.place = String(place);
      span.textContent = ch;
      container.appendChild(span);
    }
  }
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

  el.appendChild(renderPorts("inlet", topInlets));
  el.appendChild(buildBody(node));
  el.appendChild(renderPorts("outlet", node.outlets));

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

  // Resize handle — bottom-right corner drag target
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "pn-resize-handle";
  el.appendChild(resizeHandle);

  return el;
}
