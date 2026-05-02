import { PatchGraph } from "../graph/PatchGraph";
import { checkOverlap, type Box } from "./OverlapGuard";
import { getZoom } from "./zoomState";
import { startDragSession, type DragSession } from "./dragSession";

const MIN_WIDTH = 28;
const MIN_HEIGHT = 24;

interface ResizeState {
  nodeId: string;
  element: HTMLElement;
  startMouseX: number;
  startMouseY: number;
  startWidth: number;
  startHeight: number;
  /** Last non-colliding extent. Used to clamp the resize when growing the
   *  object would push it into another node. */
  lastValidWidth: number;
  lastValidHeight: number;
  /** Per-object minimum extent. For stage-wrapped objects this is the
   *  natural layout box of the stage (its measured offsetWidth/Height) so
   *  the user can't shrink past the point where content would clip. For
   *  unstaged bodies it falls back to the global MIN_WIDTH/HEIGHT. */
  minWidth: number;
  minHeight: number;
}

export class ResizeController {
  private readonly panGroup: HTMLElement;
  private readonly graph: PatchGraph;

  private state: ResizeState | null = null;
  private session: DragSession | null = null;

  private readonly onMouseDown: (event: MouseEvent) => void;

  constructor(
    panGroup: HTMLElement,
    graph: PatchGraph,
    private readonly onResize?: (nodeId: string, w: number, h: number) => void,
  ) {
    this.panGroup = panGroup;
    this.graph = graph;

    this.onMouseDown = this.handleMouseDown.bind(this);

    this.panGroup.addEventListener("mousedown", this.onMouseDown);
  }

  private handleMouseDown(event: MouseEvent): void {
    const handle = (event.target as Element).closest(".pn-resize-handle");
    if (!handle) {
      return;
    }

    const objectEl = handle.closest(".patch-object") as HTMLElement | null;
    if (!objectEl) {
      return;
    }

    const nodeId = objectEl.dataset["nodeId"];
    if (!nodeId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // Re-entrancy guard: if a prior resize's mouseup was missed, force-end
    // it before starting a new one.
    if (this.state) {
      this.commitAndEnd();
    }

    // Per-object resize floor — when the body has been wrapped in a
    // .pn-stage, the stage's measured layout box is the natural minimum
    // size below which content would either need to scale below readable
    // size or clip. Use it as the per-object minimum so the user can't
    // squish text into illegibility.
    const stage = objectEl.querySelector<HTMLElement>(":scope > .patch-object-body > .pn-stage");
    const minW = stage ? Math.max(MIN_WIDTH,  stage.offsetWidth)  : MIN_WIDTH;
    const minH = stage ? Math.max(MIN_HEIGHT, stage.offsetHeight) : MIN_HEIGHT;

    this.state = {
      nodeId,
      element: objectEl,
      startMouseX: event.clientX,
      startMouseY: event.clientY,
      startWidth: objectEl.offsetWidth,
      startHeight: objectEl.offsetHeight,
      lastValidWidth: objectEl.offsetWidth,
      lastValidHeight: objectEl.offsetHeight,
      minWidth: minW,
      minHeight: minH,
    };

    objectEl.classList.add("patch-object--resizing");

    this.session = startDragSession({
      onMove:   (e) => this.handleMouseMove(e),
      onUp:     ()  => this.commitAndEnd(),
      onCancel: ()  => this.cancelAndEnd(),
    });
  }

  private handleMouseMove(event: MouseEvent): void {
    if (!this.state) {
      return;
    }

    const z = getZoom();
    const dx = (event.clientX - this.state.startMouseX) / z;
    const dy = (event.clientY - this.state.startMouseY) / z;

    const node = this.graph.nodes.get(this.state.nodeId);
    const lockHeight = node?.type === "attribute" && node.height !== undefined;

    const proposedW = Math.max(this.state.minWidth,  this.state.startWidth  + dx);
    const proposedH = lockHeight ? this.state.startHeight : Math.max(this.state.minHeight, this.state.startHeight + dy);

    // Overlap clamp — if the proposed extent would push this object into a
    // neighbour, freeze at the last non-colliding size. Resize is anchored
    // at top-left, so x/y don't change.
    let newWidth  = proposedW;
    let newHeight = proposedH;
    if (node) {
      const proposed = new Map<string, Box>();
      proposed.set(node.id, { x: node.x, y: node.y, w: proposedW, h: proposedH });
      const result = checkOverlap(this.graph, new Set([node.id]), proposed);
      if (!result.ok) {
        newWidth  = this.state.lastValidWidth;
        newHeight = this.state.lastValidHeight;
      } else {
        this.state.lastValidWidth  = proposedW;
        this.state.lastValidHeight = proposedH;
      }
    }

    this.state.element.style.width  = `${newWidth}px`;
    this.state.element.style.height = `${newHeight}px`;

    // Silently update node size so CableRenderer can read current dimensions
    this.onResize?.(this.state.nodeId, newWidth, newHeight);
  }

  /** Normal mouseup path — commit the last non-colliding extent. */
  private commitAndEnd(): void {
    if (!this.state) return;

    const finalWidth  = this.state.lastValidWidth;
    const finalHeight = this.state.lastValidHeight;
    const { element, nodeId } = this.state;

    element.style.width  = `${finalWidth}px`;
    element.style.height = `${finalHeight}px`;

    // Clear class on live DOM BEFORE setNodeSize emits "change" and
    // potentially rebuilds the element — otherwise the class lands on an
    // orphan and the cursor stays in the resize state.
    element.classList.remove("patch-object--resizing");

    this.graph.setNodeSize(nodeId, finalWidth, finalHeight);

    this.state = null;
    this.session = null;
  }

  /** Recovery path for blur/Escape — restore the pre-resize dimensions. */
  private cancelAndEnd(): void {
    if (!this.state) return;

    const { element, startWidth, startHeight, nodeId } = this.state;
    element.style.width  = `${startWidth}px`;
    element.style.height = `${startHeight}px`;
    element.classList.remove("patch-object--resizing");
    this.onResize?.(nodeId, startWidth, startHeight);

    this.state = null;
    this.session = null;
  }

  destroy(): void {
    this.panGroup.removeEventListener("mousedown", this.onMouseDown);
    this.session?.end();
    this.session = null;
    this.state = null;
  }
}
