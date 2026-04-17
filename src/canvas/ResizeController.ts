import { PatchGraph } from "../graph/PatchGraph";
import { getZoom } from "./zoomState";

const MIN_WIDTH = 28;
const MIN_HEIGHT = 24;

interface ResizeState {
  nodeId: string;
  element: HTMLElement;
  startMouseX: number;
  startMouseY: number;
  startWidth: number;
  startHeight: number;
}

export class ResizeController {
  private readonly panGroup: HTMLElement;
  private readonly graph: PatchGraph;

  private state: ResizeState | null = null;

  private readonly onMouseDown: (event: MouseEvent) => void;
  private readonly onMouseMove: (event: MouseEvent) => void;
  private readonly onMouseUp: (event: MouseEvent) => void;

  constructor(
    panGroup: HTMLElement,
    graph: PatchGraph,
    private readonly onResize?: (nodeId: string, w: number, h: number) => void,
  ) {
    this.panGroup = panGroup;
    this.graph = graph;

    this.onMouseDown = this.handleMouseDown.bind(this);
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseUp = this.handleMouseUp.bind(this);

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

    this.state = {
      nodeId,
      element: objectEl,
      startMouseX: event.clientX,
      startMouseY: event.clientY,
      startWidth: objectEl.offsetWidth,
      startHeight: objectEl.offsetHeight,
    };

    objectEl.classList.add("patch-object--resizing");

    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);
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

    const newWidth  = Math.max(MIN_WIDTH,  this.state.startWidth  + dx);
    const newHeight = lockHeight ? this.state.startHeight : Math.max(MIN_HEIGHT, this.state.startHeight + dy);

    this.state.element.style.width  = `${newWidth}px`;
    this.state.element.style.height = `${newHeight}px`;

    // Silently update node size so CableRenderer can read current dimensions
    this.onResize?.(this.state.nodeId, newWidth, newHeight);
  }

  private handleMouseUp(event: MouseEvent): void {
    if (!this.state) {
      return;
    }

    const z = getZoom();
    const dx = (event.clientX - this.state.startMouseX) / z;
    const dy = (event.clientY - this.state.startMouseY) / z;

    const node = this.graph.nodes.get(this.state.nodeId);
    const lockHeight = node?.type === "attribute" && node.height !== undefined;

    const finalWidth  = Math.max(MIN_WIDTH,  this.state.startWidth  + dx);
    const finalHeight = lockHeight ? this.state.startHeight : Math.max(MIN_HEIGHT, this.state.startHeight + dy);

    this.state.element.style.width  = `${finalWidth}px`;
    this.state.element.style.height = `${finalHeight}px`;
    this.state.element.classList.remove("patch-object--resizing");

    this.graph.setNodeSize(this.state.nodeId, finalWidth, finalHeight);

    this.state = null;

    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
  }

  destroy(): void {
    this.panGroup.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
    this.state = null;
  }
}
