import type { PatchGraph } from "../graph/PatchGraph";
import { CableRenderer, CABLE_SNAP_RADIUS_PX, getPortPos } from "./CableRenderer";
import { getZoom } from "./zoomState";

interface DrawState {
  /** The port the user started dragging from */
  fixedNodeId: string;
  fixedPortIndex: number;
  /** true  = started from an inlet  (snap target must be an outlet)
   *  false = started from an outlet (snap target must be an inlet)  */
  fixedIsInlet: boolean;
  /** Canvas coords of the fixed end (where the ghost cable is anchored) */
  x1: number;
  y1: number;
}

/**
 * Handles drawing cables by dragging from any port to its complementary port.
 *
 * Interaction flow:
 *   1. Mousedown on a port (inlet OR outlet) → enters draw mode, ghost cable appears
 *   2. Mousemove → ghost cable tracks cursor; nearest complementary port highlights
 *   3. Mouseup on a complementary port → creates edge (always outlet→inlet)
 *   4. Mouseup anywhere else → cancels draw
 */

interface SnapTarget {
  nodeId: string;
  portIndex: number;
  isInlet: boolean;
  el: HTMLElement;
  x: number;
  y: number;
}

export class CableDrawController {
  private draw: DrawState | null = null;
  private snapTarget: SnapTarget | null = null;
  /** True while the current draw session began from a cable stroke (not a port). */
  private startedDragFromCableBody = false;
  /** After stroke-drag ends, suppress one SVG cable `click` so selection does not toggle. */
  private suppressCableClick = false;

  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;

  constructor(
    private readonly canvasEl: HTMLElement,
    private readonly graph: PatchGraph,
    private readonly cables: CableRenderer,
  ) {
    this.onMouseDown = this.handleMouseDown.bind(this);
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseUp = this.handleMouseUp.bind(this);

    this.canvasEl.addEventListener("mousedown", this.onMouseDown);
  }

  isDrawing(): boolean {
    return this.draw !== null;
  }

  /**
   * CanvasController calls this on cable `click`. Returns true once after a stroke-drag
   * so the handler can skip select/deselect for that synthetic click.
   */
  consumeCableClickSuppression(): boolean {
    if (!this.suppressCableClick) return false;
    this.suppressCableClick = false;
    return true;
  }

  destroy(): void {
    this.canvasEl.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
    this.cables.clearGhost();
  }

  // ── Handlers ──────────────────────────────────────────────────────

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;

    const target = e.target as Element;

    // ── Drag from cable stroke: nearest endpoint follows cursor (same as re-patch) ──
    if (this.tryBeginDragFromCableStroke(e, target)) return;

    // ── Re-patch: detach a selected cable by clicking/dragging either endpoint ──
    const selectedEdgeId = this.cables.getSelectedEdgeId();
    if (selectedEdgeId) {
      const edge = this.graph.getEdges().find(ed => ed.id === selectedEdgeId);
      const fromNode = edge ? this.graph.nodes.get(edge.fromNodeId) : undefined;
      if (edge && fromNode) {
        const portEl = target.closest<HTMLElement>(".patch-port");
        let shouldRepatch = false;

        if (portEl) {
          const objectEl = portEl.closest<HTMLElement>(".patch-object");
          const nodeId = objectEl?.dataset.nodeId;
          const portIndex = parseInt(portEl.dataset.portIndex ?? "0", 10);
          const isOutletEnd =
            nodeId === edge.fromNodeId &&
            portEl.classList.contains("patch-port-outlet") &&
            portIndex === edge.fromOutlet;
          const isInletEnd =
            nodeId === edge.toNodeId &&
            portEl.classList.contains("patch-port-inlet") &&
            portIndex === edge.toInlet;
          shouldRepatch = isOutletEnd || isInletEnd;
        }

        if (shouldRepatch) {
          if (!portEl) return;

          e.preventDefault();
          e.stopImmediatePropagation();

          this.graph.removeEdge(edge.id);
          this.cables.selectEdge(null);

          const clickedInlet =
            portEl.classList.contains("patch-port-inlet") &&
            portEl.closest<HTMLElement>(".patch-object")?.dataset.nodeId ===
              edge.toNodeId &&
            parseInt(portEl.dataset.portIndex ?? "0", 10) === edge.toInlet;

          const canvasRect = this.canvasEl.getBoundingClientRect();
          const z = getZoom();
          const cursorX = (e.clientX - canvasRect.left) / z;
          const cursorY = (e.clientY - canvasRect.top)  / z;

          if (clickedInlet) {
            const toNode = this.graph.nodes.get(edge.toNodeId);
            if (!toNode) return;
            const anchor = getPortPos(toNode, "inlet", edge.toInlet);
            this.draw = {
              fixedNodeId: edge.toNodeId,
              fixedPortIndex: edge.toInlet,
              fixedIsInlet: true,
              x1: anchor.x,
              y1: anchor.y,
            };
            this.cables.startGhost(anchor.x, anchor.y, cursorX, cursorY);
          } else {
            const anchor = getPortPos(fromNode, "outlet", edge.fromOutlet);
            this.draw = {
              fixedNodeId: edge.fromNodeId,
              fixedPortIndex: edge.fromOutlet,
              fixedIsInlet: false,
              x1: anchor.x,
              y1: anchor.y,
            };
            this.cables.startGhost(anchor.x, anchor.y, cursorX, cursorY);
          }

          document.addEventListener("mousemove", this.onMouseMove);
          document.addEventListener("mouseup", this.onMouseUp);
          return;
        }
      }
    }

    // ── Normal draw: outlet or inlet ──────────────────────────────────

    const outletEl = target.closest<HTMLElement>(".patch-port-outlet");
    const inletEl  = target.closest<HTMLElement>(".patch-port-inlet");
    const portEl   = outletEl ?? inletEl;
    if (!portEl) return;

    const objectEl = portEl.closest<HTMLElement>(".patch-object");
    if (!objectEl?.dataset.nodeId) return;

    const portIndex   = parseInt(portEl.dataset.portIndex ?? "0", 10);
    const nodeId      = objectEl.dataset.nodeId;
    const node        = this.graph.nodes.get(nodeId);
    if (!node) return;

    const fixedIsInlet = portEl === inletEl;
    const direction    = fixedIsInlet ? "inlet" : "outlet";
    const from         = getPortPos(node, direction, portIndex, this.canvasEl);

    e.preventDefault();
    e.stopPropagation();

    this.draw = {
      fixedNodeId:   nodeId,
      fixedPortIndex: portIndex,
      fixedIsInlet,
      x1: from.x,
      y1: from.y,
    };

    const canvasRect = this.canvasEl.getBoundingClientRect();
    const z = getZoom();
    const cursorX    = (e.clientX - canvasRect.left) / z;
    const cursorY    = (e.clientY - canvasRect.top)  / z;
    this.cables.startGhost(from.x, from.y, cursorX, cursorY);

    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);
  }

  /**
   * Mousedown on the cable hit line (not a port). The end closest to the cursor is
   * treated as the moving end; the opposite end stays fixed while dragging to a new port.
   */
  private tryBeginDragFromCableStroke(e: MouseEvent, target: Element): boolean {
    if (e.altKey) return false;

    const g = target.closest<HTMLElement>("[data-edge-id]");
    const edgeId = g?.dataset.edgeId;
    if (!edgeId) return false;

    const edge = this.graph.getEdges().find(ed => ed.id === edgeId);
    const fromNode = edge ? this.graph.nodes.get(edge.fromNodeId) : undefined;
    const toNode = edge ? this.graph.nodes.get(edge.toNodeId) : undefined;
    if (!edge || !fromNode || !toNode) return false;

    const from = getPortPos(fromNode, "outlet", edge.fromOutlet, this.canvasEl);
    const to   = getPortPos(toNode,   "inlet",  edge.toInlet,   this.canvasEl);

    const canvasRect = this.canvasEl.getBoundingClientRect();
    const z = getZoom();
    const cx = (e.clientX - canvasRect.left) / z;
    const cy = (e.clientY - canvasRect.top)  / z;

    const distOutlet = Math.hypot(cx - from.x, cy - from.y);
    const distInlet = Math.hypot(cx - to.x, cy - to.y);
    const moveOutletEnd = distOutlet <= distInlet;

    e.preventDefault();
    e.stopPropagation();

    this.graph.removeEdge(edge.id);
    this.cables.selectEdge(null);

    if (moveOutletEnd) {
      const anchor = getPortPos(toNode, "inlet", edge.toInlet, this.canvasEl);
      this.draw = {
        fixedNodeId: edge.toNodeId,
        fixedPortIndex: edge.toInlet,
        fixedIsInlet: true,
        x1: anchor.x,
        y1: anchor.y,
      };
      this.cables.startGhost(anchor.x, anchor.y, cx, cy);
    } else {
      const anchor = getPortPos(fromNode, "outlet", edge.fromOutlet, this.canvasEl);
      this.draw = {
        fixedNodeId: edge.fromNodeId,
        fixedPortIndex: edge.fromOutlet,
        fixedIsInlet: false,
        x1: anchor.x,
        y1: anchor.y,
      };
      this.cables.startGhost(anchor.x, anchor.y, cx, cy);
    }

    this.startedDragFromCableBody = true;

    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);
    return true;
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.draw) return;
    const canvasRect = this.canvasEl.getBoundingClientRect();
    const z = getZoom();
    const rawX = (e.clientX - canvasRect.left) / z;
    const rawY = (e.clientY - canvasRect.top)  / z;

    // Snap to the complementary port type
    const snap = this.draw.fixedIsInlet
      ? this.findNearestOutlet(rawX, rawY)
      : this.findNearestInlet(rawX, rawY);

    // Update snap highlight
    if (this.snapTarget && this.snapTarget.el !== snap?.el) {
      this.snapTarget.el.classList.remove("pn-port--snap");
    }
    if (snap) {
      snap.el.classList.add("pn-port--snap");
      this.cables.updateGhost(snap.x, snap.y);
    } else {
      this.cables.updateGhost(rawX, rawY);
    }
    this.snapTarget = snap;
    this.cables.updateSnapRadiusHint(rawX, rawY);
  }

  private findNearestInlet(canvasX: number, canvasY: number): SnapTarget | null {
    return this.findNearest(canvasX, canvasY, ".patch-port-inlet", false);
  }

  private findNearestOutlet(canvasX: number, canvasY: number): SnapTarget | null {
    return this.findNearest(canvasX, canvasY, ".patch-port-outlet", true);
  }

  private findNearest(
    canvasX: number,
    canvasY: number,
    selector: string,
    isOutlet: boolean,
  ): SnapTarget | null {
    const canvasRect = this.canvasEl.getBoundingClientRect();
    const z = getZoom();
    const ports = this.canvasEl.querySelectorAll<HTMLElement>(selector);
    let best: SnapTarget | null = null;
    let bestDist = CABLE_SNAP_RADIUS_PX / z;

    for (const port of ports) {
      const objectEl = port.closest<HTMLElement>(".patch-object");
      if (!objectEl?.dataset.nodeId) continue;
      if (objectEl.dataset.nodeId === this.draw?.fixedNodeId) continue;

      const rect = port.getBoundingClientRect();
      const px   = (rect.left + rect.width  / 2 - canvasRect.left) / z;
      const py   = (rect.top  + rect.height / 2 - canvasRect.top)  / z;
      const dist = Math.sqrt((canvasX - px) ** 2 + (canvasY - py) ** 2);

      if (dist < bestDist) {
        bestDist = dist;
        best = {
          nodeId:    objectEl.dataset.nodeId,
          portIndex: parseInt(port.dataset.portIndex ?? "0", 10),
          isInlet:   !isOutlet,
          el:        port,
          x:         px,
          y:         py,
        };
      }
    }
    return best;
  }

  private handleMouseUp(e: MouseEvent): void {
    if (!this.draw) return;
    if (e.button !== 0) return;

    let snapNodeId:    string | undefined;
    let snapPortIndex: number | undefined;
    let snapIsInlet:   boolean | undefined;

    if (this.snapTarget) {
      snapNodeId    = this.snapTarget.nodeId;
      snapPortIndex = this.snapTarget.portIndex;
      snapIsInlet   = this.snapTarget.isInlet;
    } else {
      // DOM hit-test fallback
      const target   = e.target as Element;
      const inletEl  = target.closest<HTMLElement>(".patch-port-inlet");
      const outletEl = target.closest<HTMLElement>(".patch-port-outlet");
      const hitPort  = inletEl ?? outletEl;
      if (hitPort) {
        const objectEl = hitPort.closest<HTMLElement>(".patch-object");
        if (objectEl?.dataset.nodeId) {
          snapNodeId    = objectEl.dataset.nodeId;
          snapPortIndex = parseInt(hitPort.dataset.portIndex ?? "0", 10);
          snapIsInlet   = hitPort === inletEl;
        }
      } else if (!this.draw.fixedIsInlet) {
        // Dropped on object body → connect to first inlet (Max/MSP behavior)
        const objectEl = target.closest<HTMLElement>(".patch-object");
        if (objectEl?.dataset.nodeId) {
          const firstInlet = objectEl.querySelector<HTMLElement>(".patch-port-inlet");
          if (firstInlet) {
            snapNodeId    = objectEl.dataset.nodeId;
            snapPortIndex = parseInt(firstInlet.dataset.portIndex ?? "0", 10);
            snapIsInlet   = true;
          }
        }
      }
    }

    // Validate: the snap target must be the complementary port type
    const validTarget =
      snapNodeId !== undefined &&
      snapPortIndex !== undefined &&
      snapNodeId !== this.draw.fixedNodeId &&
      snapIsInlet !== this.draw.fixedIsInlet; // inlet↔outlet only

    if (validTarget) {
      // Always create the edge as outlet → inlet regardless of draw direction
      const fromNodeId  = this.draw.fixedIsInlet ? snapNodeId!    : this.draw.fixedNodeId;
      const fromOutlet  = this.draw.fixedIsInlet ? snapPortIndex! : this.draw.fixedPortIndex;
      const toNodeId    = this.draw.fixedIsInlet ? this.draw.fixedNodeId : snapNodeId!;
      const toInlet     = this.draw.fixedIsInlet ? this.draw.fixedPortIndex : snapPortIndex!;

      try {
        this.graph.addEdge(fromNodeId, fromOutlet, toNodeId, toInlet);
      } catch {
        // Invalid connection — silently cancel
      }
    }

    this.cancel();
  }

  private cancel(): void {
    if (this.snapTarget) {
      this.snapTarget.el.classList.remove("pn-port--snap");
      this.snapTarget = null;
    }
    if (this.startedDragFromCableBody) {
      this.suppressCableClick = true;
      this.startedDragFromCableBody = false;
      // If the follow-up `click` does not hit the cable SVG, still clear the flag.
      setTimeout(() => {
        this.suppressCableClick = false;
      }, 0);
    }
    this.cables.clearGhost();
    this.draw = null;
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
  }
}
