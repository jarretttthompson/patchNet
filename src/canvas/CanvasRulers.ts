/**
 * Coordinate rulers along the top (X) and left (Y) edges of the canvas
 * viewport. Rulers are pinned to the viewport corner regardless of scroll —
 * they show the world position of whatever is currently in view.
 *
 * Units are grid cells (1 cell = GRID_CELL_PX world pixels). Major ticks
 * (every GRID_MAJOR_EVERY cells) are labelled with the cell index.
 *
 * The rulers are children of canvasEl. A single wrapper element is offset
 * via CSS transform to follow scrollLeft/scrollTop so the rulers visually
 * stay glued to the viewport's top-left corner. The wrapper is decoupled
 * from per-session pan-groups: one ruler instance covers all sessions on
 * the same canvas.
 */

import {
  CANVAS_HEIGHT_PX,
  CANVAS_WIDTH_PX,
  GRID_CELL_PX,
  GRID_MAJOR_EVERY,
  GRID_SUBDIVISIONS,
  GRID_SUB_PX,
  RULER_THICKNESS_PX,
} from "./canvasSpace";
import { getZoom, subscribeZoom } from "./zoomState";

const TICK_SUB = 2;
const TICK_CELL = 4;
const TICK_MAJOR = 9;

export class CanvasRulers {
  private readonly wrapper: HTMLDivElement;
  private readonly xCanvas: HTMLCanvasElement;
  private readonly yCanvas: HTMLCanvasElement;
  private readonly corner: HTMLDivElement;
  private readonly onScroll: () => void;
  private readonly onResize: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribeZoom: () => void;
  private rafScheduled = false;

  constructor(private readonly canvasEl: HTMLElement) {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "pn-rulers";
    this.wrapper.style.cssText = [
      "position:absolute",
      "top:0",
      "left:0",
      "pointer-events:none",
      "z-index:90",
      "will-change:transform",
    ].join(";");

    this.corner = document.createElement("div");
    this.corner.className = "pn-rulers-corner";
    this.corner.style.cssText = [
      "position:absolute",
      "top:0",
      "left:0",
      `width:${RULER_THICKNESS_PX}px`,
      `height:${RULER_THICKNESS_PX}px`,
    ].join(";");
    this.wrapper.appendChild(this.corner);

    this.xCanvas = document.createElement("canvas");
    this.xCanvas.className = "pn-rulers-x";
    this.xCanvas.style.cssText = [
      "position:absolute",
      "top:0",
      `left:${RULER_THICKNESS_PX}px`,
      `height:${RULER_THICKNESS_PX}px`,
      "display:block",
    ].join(";");
    this.wrapper.appendChild(this.xCanvas);

    this.yCanvas = document.createElement("canvas");
    this.yCanvas.className = "pn-rulers-y";
    this.yCanvas.style.cssText = [
      "position:absolute",
      `top:${RULER_THICKNESS_PX}px`,
      "left:0",
      `width:${RULER_THICKNESS_PX}px`,
      "display:block",
    ].join(";");
    this.wrapper.appendChild(this.yCanvas);

    canvasEl.appendChild(this.wrapper);

    this.onScroll = () => this.scheduleDraw();
    this.onResize = () => this.scheduleDraw();
    canvasEl.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    this.resizeObserver = new ResizeObserver(() => this.scheduleDraw());
    this.resizeObserver.observe(canvasEl);
    this.unsubscribeZoom = subscribeZoom(() => this.scheduleDraw());

    this.draw();
  }

  /** Force redraw — call after zoom changes. */
  redraw(): void {
    this.scheduleDraw();
  }

  destroy(): void {
    this.canvasEl.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    this.resizeObserver.disconnect();
    this.unsubscribeZoom();
    this.wrapper.remove();
  }

  private scheduleDraw(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.draw();
    });
  }

  private draw(): void {
    const sl = this.canvasEl.scrollLeft;
    const st = this.canvasEl.scrollTop;
    this.wrapper.style.transform = `translate3d(${sl}px, ${st}px, 0)`;

    const cw = this.canvasEl.clientWidth;
    const ch = this.canvasEl.clientHeight;
    const z = getZoom();
    const dpr = window.devicePixelRatio || 1;

    // ── X ruler (top) ──────────────────────────────────────────────
    const xVisW = Math.max(0, cw - RULER_THICKNESS_PX);
    const xCssH = RULER_THICKNESS_PX;
    sizeCanvas(this.xCanvas, xVisW, xCssH, dpr);
    const xctx = this.xCanvas.getContext("2d");
    if (xctx) {
      drawRuler(xctx, {
        axis: "x",
        cssWidth: xVisW,
        cssHeight: xCssH,
        scrollPx: sl,
        zoom: z,
        worldExtent: CANVAS_WIDTH_PX,
        // Within the X-canvas, content x = 0 corresponds to scrollLeft + RULER_THICKNESS_PX in canvasEl.
        // World x in cells: (sl + RULER_THICKNESS_PX + screenX) - LEFT_GUTTER (== RULER_THICKNESS_PX) = sl + screenX
        // That maps screenX_in_canvas → world_screen_x = sl + screenX, so worldX = (worldScreenX) / zoom.
        screenToWorld: (s) => (sl + s) / z,
        worldToScreen: (w) => w * z - sl,
      });
    }

    // ── Y ruler (left) ─────────────────────────────────────────────
    const yVisH = Math.max(0, ch - RULER_THICKNESS_PX);
    const yCssW = RULER_THICKNESS_PX;
    sizeCanvas(this.yCanvas, yCssW, yVisH, dpr);
    const yctx = this.yCanvas.getContext("2d");
    if (yctx) {
      drawRuler(yctx, {
        axis: "y",
        cssWidth: yCssW,
        cssHeight: yVisH,
        scrollPx: st,
        zoom: z,
        worldExtent: CANVAS_HEIGHT_PX,
        screenToWorld: (s) => (st + s) / z,
        worldToScreen: (w) => w * z - st,
      });
    }
  }
}

function sizeCanvas(c: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): void {
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  const w = Math.max(1, Math.floor(cssW * dpr));
  const h = Math.max(1, Math.floor(cssH * dpr));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
}

interface DrawArgs {
  axis: "x" | "y";
  cssWidth: number;
  cssHeight: number;
  scrollPx: number;
  zoom: number;
  worldExtent: number;
  screenToWorld: (s: number) => number;
  worldToScreen: (w: number) => number;
}

function drawRuler(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, a.cssWidth, a.cssHeight);

  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--pn-surface-raised").trim() || "#0a0a0a";
  const tickColor = styles.getPropertyValue("--pn-border").trim() || "rgba(0,255,0,0.35)";
  const labelColor = styles.getPropertyValue("--pn-muted").trim() || "rgba(0,255,0,0.55)";
  const axisLine = styles.getPropertyValue("--pn-accent").trim() || "rgba(0,255,0,0.85)";

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, a.cssWidth, a.cssHeight);

  // Walk by smallest subdivision (sub-cells = 0.5 units). Each tick is
  // classified into one of three tiers — major (every N cells), cell
  // (whole units), or sub (fractions). Tiers cull independently based on
  // on-screen density so the ruler stays legible at any zoom.
  const cellPxOnScreen = GRID_CELL_PX * a.zoom;
  const subPxOnScreen  = GRID_SUB_PX  * a.zoom;

  // Major labels: collapse 1×, 2×, 4×, 8× as zoom shrinks them.
  let majorLabelEvery = GRID_MAJOR_EVERY; // in cells
  while (majorLabelEvery * cellPxOnScreen < 36) majorLabelEvery *= 2;

  const showCellLabels = cellPxOnScreen >= 22;
  const showSubLabels  = subPxOnScreen  >= 18; // need ~18px to fit "0.5"
  const showSubTicks   = subPxOnScreen  >= 6;

  const dim = a.axis === "x" ? a.cssWidth : a.cssHeight;
  const worldStart = Math.max(0, a.screenToWorld(0));
  const worldEnd = Math.min(a.worldExtent, a.screenToWorld(dim));
  const firstIdx = Math.floor(worldStart / GRID_SUB_PX);
  const lastIdx  = Math.ceil(worldEnd / GRID_SUB_PX);

  const fontMajor = "9px var(--pn-font-mono, ui-monospace, monospace)";
  const fontMinor = "7px var(--pn-font-mono, ui-monospace, monospace)";
  const fontSub   = "6px var(--pn-font-mono, ui-monospace, monospace)";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  // tier flags: how many sub-cells in a cell, in a major span
  const cellEvery  = GRID_SUBDIVISIONS;                     // every 2 sub-cells
  const majorEvery = GRID_MAJOR_EVERY * GRID_SUBDIVISIONS;  // every 10 sub-cells

  for (let i = firstIdx; i <= lastIdx; i++) {
    const worldPx = i * GRID_SUB_PX;
    if (worldPx < 0 || worldPx > a.worldExtent) continue;

    const isMajor = i % majorEvery === 0;
    const isCell  = !isMajor && i % cellEvery === 0;
    const isSub   = !isMajor && !isCell;

    if (isSub && !showSubTicks) continue;

    const tickLen = isMajor ? TICK_MAJOR : isCell ? TICK_CELL : TICK_SUB;
    const screen = a.worldToScreen(worldPx);
    const p = Math.round(screen) + 0.5;

    ctx.strokeStyle = tickColor;
    ctx.globalAlpha = isSub ? 0.55 : 1.0;
    ctx.beginPath();
    if (a.axis === "x") {
      ctx.moveTo(p, a.cssHeight);
      ctx.lineTo(p, a.cssHeight - tickLen);
    } else {
      ctx.moveTo(a.cssWidth, p);
      ctx.lineTo(a.cssWidth - tickLen, p);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // Decide whether THIS tick gets a label and at what tier.
    const cellIndex = i / GRID_SUBDIVISIONS;
    let label: string | null = null;
    let labelAlpha = 1.0;
    let labelFont = fontMajor;
    if (isMajor && cellIndex % majorLabelEvery === 0) {
      label = String(cellIndex);
    } else if (isCell && showCellLabels) {
      label = String(cellIndex);
      labelAlpha = 0.55;
      labelFont = fontMinor;
    } else if (isSub && showSubLabels) {
      label = cellIndex.toFixed(1);
      labelAlpha = 0.40;
      labelFont = fontSub;
    }
    if (!label) continue;

    ctx.font = labelFont;
    ctx.fillStyle = labelColor;
    ctx.globalAlpha = labelAlpha;

    // Clamp label position so labels at the leading/trailing edge of the
    // ruler (e.g. "0" at world origin) don't render half-clipped.
    const halfW = ctx.measureText(label).width / 2;
    if (a.axis === "x") {
      let lx = screen;
      if (lx - halfW < 1) lx = halfW + 1;
      else if (lx + halfW > a.cssWidth - 1) lx = a.cssWidth - halfW - 1;
      ctx.textAlign = "center";
      ctx.fillText(label, lx, a.cssHeight / 2 - 4);
    } else {
      let ly = screen;
      if (ly - halfW < 1) ly = halfW + 1;
      else if (ly + halfW > a.cssHeight - 1) ly = a.cssHeight - halfW - 1;
      ctx.save();
      ctx.translate(a.cssWidth / 2 - 4, ly);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1.0;
  }

  // Edge line along the inner side of the ruler — separates ruler from canvas.
  ctx.strokeStyle = axisLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (a.axis === "x") {
    const y = a.cssHeight - 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(a.cssWidth, y);
  } else {
    const x = a.cssWidth - 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, a.cssHeight);
  }
  ctx.stroke();
}
