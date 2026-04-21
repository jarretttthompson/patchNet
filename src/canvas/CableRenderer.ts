import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import { getObjectDef } from "../graph/objectDefs";
import { getZoom } from "./zoomState";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Max distance (px, cursor → port center) for cable endpoint snapping — keep in sync with UI hint ring. */
export const CABLE_SNAP_RADIUS_PX = 44;

export interface PortPos {
  x: number;
  y: number;
}

/**
 * Compute canvas-coordinate center of a port nub.
 *
 * For top/bottom ports: mirrors the layout formula in PortRenderer.
 * For left-side ports (attribute side inlets): reads the actual DOM position
 * so the cable endpoint tracks the rendered nub exactly.
 */
export function getPortPos(
  node: PatchNode,
  direction: "inlet" | "outlet",
  portIndex: number,
  panGroupEl?: HTMLElement,
): PortPos {
  // Left-side inlet ports: use DOM query for exact position
  if (direction === "inlet" && panGroupEl) {
    const port = node.inlets.find(p => p.index === portIndex);
    if (port?.side === "left") {
      const nub = panGroupEl.querySelector<HTMLElement>(
        `[data-node-id="${node.id}"] .patch-port-side-left[data-port-index="${portIndex}"]`,
      );
      if (nub) {
        const nubRect = nub.getBoundingClientRect();
        const panRect = panGroupEl.getBoundingClientRect();
        const z = getZoom();
        return {
          x: (nubRect.left - panRect.left + nubRect.width  / 2) / z,
          y: (nubRect.top  - panRect.top  + nubRect.height / 2) / z,
        };
      }
    }
  }

  // Right-side outlet ports: mirror the left-side inlet path.
  if (direction === "outlet" && panGroupEl) {
    const port = node.outlets.find(p => p.index === portIndex);
    if (port?.side === "right") {
      const nub = panGroupEl.querySelector<HTMLElement>(
        `[data-node-id="${node.id}"] .patch-port-side-right[data-port-index="${portIndex}"]`,
      );
      if (nub) {
        const nubRect = nub.getBoundingClientRect();
        const panRect = panGroupEl.getBoundingClientRect();
        const z = getZoom();
        return {
          x: (nubRect.left - panRect.left + nubRect.width  / 2) / z,
          y: (nubRect.top  - panRect.top  + nubRect.height / 2) / z,
        };
      }
    }
  }

  // Default: formula-based calculation from node position + size
  const def = getObjectDef(node.type);
  const ports = direction === "inlet" ? node.inlets : node.outlets;
  const topPorts = ports.filter(p => !p.side || p.side === "top");
  const posInTop = topPorts.findIndex(p => p.index === portIndex);
  const total = topPorts.length;
  const pct = total === 0 ? 0.5 : (posInTop + 1) / (total + 1);
  const w = node.width ?? def.defaultWidth;
  const h = node.height ?? def.defaultHeight;
  return {
    x: node.x + pct * w,
    y: direction === "inlet" ? node.y : node.y + h,
  };
}

function cableStrokeColor(portType: string): string {
  return portType === "signal" ? "var(--pn-cable-audio)" : "var(--pn-cable)";
}

function makeLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SVGLineElement {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  return line;
}

/**
 * Manages the SVG overlay that renders patch cables.
 *
 * Usage:
 *   const cables = new CableRenderer(canvasEl, graph);
 *   graph.on("change", () => cables.render());
 *
 * During cable drawing:
 *   cables.startGhost(x1, y1, x2, y2)
 *   cables.updateGhost(x2, y2)   // on mousemove
 *   cables.clearGhost()           // on cancel or commit
 */
export class CableRenderer {
  private readonly svg: SVGSVGElement;
  private readonly cableGroup: SVGGElement;
  private readonly ghostGroup: SVGGElement;
  private readonly snapHintGroup: SVGGElement;
  private snapHintCircle: SVGCircleElement | null = null;
  private ghostLine: SVGLineElement | null = null;
  private selectedEdgeId: string | null = null;

  constructor(
    private readonly canvasEl: HTMLElement,
    private readonly graph: PatchGraph,
  ) {
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("pn-cable-svg");
    // SVG is transparent by default; individual hit areas opt in via pointer-events:stroke
    Object.assign(this.svg.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      overflow: "visible",
      pointerEvents: "none",
      zIndex: "5", // cables render above objects; SVG is still transparent to pointer events
    });
    this.svg.setAttribute("aria-hidden", "true");

    this.cableGroup = document.createElementNS(SVG_NS, "g");
    this.cableGroup.setAttribute("class", "pn-cables");

    this.ghostGroup = document.createElementNS(SVG_NS, "g");
    this.ghostGroup.setAttribute("class", "pn-cable-ghost");

    this.snapHintGroup = document.createElementNS(SVG_NS, "g");
    this.snapHintGroup.setAttribute("class", "pn-cable-snap-hint");
    this.snapHintGroup.style.pointerEvents = "none";

    this.svg.appendChild(this.cableGroup);
    this.svg.appendChild(this.ghostGroup);
    this.svg.appendChild(this.snapHintGroup);
    canvasEl.appendChild(this.svg);
  }

  /** Redraw all cables from current graph state. */
  render(): void {
    // If the selected edge no longer exists, clear it
    if (this.selectedEdgeId) {
      const stillExists = this.graph.getEdges().some(e => e.id === this.selectedEdgeId);
      if (!stillExists) {
        this.clearEndpointHighlights();
        this.selectedEdgeId = null;
      }
    }

    while (this.cableGroup.firstChild) {
      this.cableGroup.removeChild(this.cableGroup.firstChild);
    }

    for (const edge of this.graph.getEdges()) {
      const fromNode = this.graph.nodes.get(edge.fromNodeId);
      const toNode = this.graph.nodes.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;

      const from = getPortPos(fromNode, "outlet", edge.fromOutlet, this.canvasEl);
      const to   = getPortPos(toNode,   "inlet",  edge.toInlet,   this.canvasEl);
      const outletDef = fromNode.outlets[edge.fromOutlet];
      const color = outletDef
        ? cableStrokeColor(outletDef.type)
        : "var(--pn-cable)";
      const isSelected = edge.id === this.selectedEdgeId;

      // Wrapper group carries the edge ID for hit testing
      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("pn-cable-seg");
      g.dataset.edgeId = edge.id;

      // Invisible thick hit area — receives click events
      const hit = makeLine(from.x, from.y, to.x, to.y);
      hit.classList.add("pn-cable-hit");
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", "18");
      hit.style.pointerEvents = "stroke";

      // Visible cable line
      const vis = makeLine(from.x, from.y, to.x, to.y);
      vis.classList.add("pn-cable-vis");
      vis.setAttribute(
        "stroke",
        isSelected ? "var(--pn-cable-selected)" : color,
      );
      vis.setAttribute("stroke-width", isSelected ? "2" : "1.5");
      vis.setAttribute("stroke-linecap", "round");
      vis.style.pointerEvents = "none";

      if (isSelected) {
        vis.setAttribute(
          "filter",
          "drop-shadow(0 0 4px var(--pn-cable-selected))",
        );
      }

      g.appendChild(hit);
      g.appendChild(vis);
      this.cableGroup.appendChild(g);

      hit.addEventListener("mouseenter", () => {
        g.classList.add("pn-cable--hover");
      });
      hit.addEventListener("mouseleave", () => {
        g.classList.remove("pn-cable--hover");
      });
    }
  }

  /** Start drawing a ghost (preview) cable from a port. */
  startGhost(x1: number, y1: number, x2: number, y2: number): void {
    this.clearGhost();
    const line = makeLine(x1, y1, x2, y2);
    line.setAttribute("stroke", "var(--pn-cable)");
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-dasharray", "8 5");
    line.setAttribute("opacity", "0.82");
    this.ghostLine = line;
    this.ghostGroup.appendChild(line);
    this.updateSnapRadiusHint(x2, y2);
  }

  /** Update the endpoint of the ghost cable on mousemove. */
  updateGhost(x2: number, y2: number): void {
    this.ghostLine?.setAttribute("x2", String(x2));
    this.ghostLine?.setAttribute("y2", String(y2));
  }

  /** Remove the ghost cable. */
  clearGhost(): void {
    while (this.ghostGroup.firstChild) {
      this.ghostGroup.removeChild(this.ghostGroup.firstChild);
    }
    this.ghostLine = null;
    this.hideSnapRadiusHint();
  }

  /**
   * Show a dashed ring centered on the cursor with radius = snap distance
   * (matches `CABLE_SNAP_RADIUS_PX` in CableDrawController).
   */
  updateSnapRadiusHint(cx: number, cy: number): void {
    if (!this.snapHintCircle) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", "pn-snap-radius-ring");
      c.setAttribute("fill", "none");
      this.snapHintCircle = c;
      this.snapHintGroup.appendChild(c);
    }
    this.snapHintCircle.setAttribute("cx", String(cx));
    this.snapHintCircle.setAttribute("cy", String(cy));
    this.snapHintCircle.setAttribute("r", String(CABLE_SNAP_RADIUS_PX));
  }

  hideSnapRadiusHint(): void {
    if (this.snapHintCircle) {
      this.snapHintGroup.removeChild(this.snapHintCircle);
      this.snapHintCircle = null;
    }
  }

  /** Highlight a cable by edge ID. Pass null to clear selection. */
  selectEdge(edgeId: string | null): void {
    if (this.selectedEdgeId === edgeId) return;

    // Remove endpoint highlight from previous selection
    this.clearEndpointHighlights();

    this.selectedEdgeId = edgeId;
    this.render();

    // Add endpoint highlight to newly selected edge's ports
    if (edgeId) {
      const edge = this.graph.getEdges().find(e => e.id === edgeId);
      if (edge) {
        this.highlightEndpoint(edge.fromNodeId, "outlet", edge.fromOutlet);
        this.highlightEndpoint(edge.toNodeId,   "inlet",  edge.toInlet);
      }
    }
  }

  private highlightEndpoint(
    nodeId: string,
    direction: "inlet" | "outlet",
    portIndex: number,
  ): void {
    const dirClass = direction === "inlet" ? "patch-port-inlet" : "patch-port-outlet";
    const el = this.canvasEl.querySelector<HTMLElement>(
      `[data-node-id="${nodeId}"] .${dirClass}[data-port-index="${portIndex}"]`,
    );
    el?.classList.add("pn-port--endpoint");
  }

  private clearEndpointHighlights(): void {
    this.canvasEl
      .querySelectorAll<HTMLElement>(".pn-port--endpoint")
      .forEach(el => el.classList.remove("pn-port--endpoint"));
  }

  getSelectedEdgeId(): string | null {
    return this.selectedEdgeId;
  }

  /**
   * Find the edge ID of the cable whose hit area was clicked.
   * Returns null if the click was not on a cable.
   */
  edgeIdFromEvent(event: MouseEvent): string | null {
    const target = event.target as Element | null;
    if (!target) return null;
    const g = target.closest("[data-edge-id]") as HTMLElement | null;
    return g?.dataset.edgeId ?? null;
  }

  getSVGElement(): SVGSVGElement {
    return this.svg;
  }
}
