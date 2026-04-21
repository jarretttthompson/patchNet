import type { PatchGraph } from "../graph/PatchGraph";
import type { CableDrawController } from "./CableDrawController";
import type { CableRenderer } from "./CableRenderer";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import { ObjectEntryBox } from "./ObjectEntryBox";
import { CANVAS_LEFT_GUTTER_PX, CANVAS_TOP_GUTTER_PX } from "./canvasSpace";
import { getZoom, setZoomValue, MIN_ZOOM, MAX_ZOOM } from "./zoomState";
import { OBJECT_DEFS, getObjectDef } from "../graph/objectDefs";
import {
  getUserDefaultSize,
  setUserDefaultSize,
  clearUserDefaultSize,
} from "../graph/userObjectDefaults";

// Derived from OBJECT_DEFS — do not maintain a separate list here.
const OBJECT_TYPES = Object.keys(OBJECT_DEFS).sort();

const MENU_STYLE = `
.pn-context-menu {
  position: fixed;
  z-index: 200;
  background: var(--pn-surface-raised);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-sm);
  box-shadow: var(--pn-shadow-panel);
  padding: 4px 0;
  min-width: 120px;
  font-family: var(--pn-font-mono);
  font-size: var(--pn-type-chip);
}
.pn-context-menu-item {
  display: block;
  width: 100%;
  padding: 6px 14px;
  background: none;
  border: none;
  color: var(--pn-text);
  text-align: left;
  cursor: pointer;
  letter-spacing: 0.04em;
  box-sizing: border-box;
}
.pn-context-menu-item:hover {
  background: var(--pn-hover-accent);
  color: var(--pn-accent);
}
`;

function injectMenuStyles(): void {
  if (document.getElementById("pn-context-menu-styles")) return;
  const style = document.createElement("style");
  style.id = "pn-context-menu-styles";
  style.textContent = MENU_STYLE;
  document.head.appendChild(style);
}

/**
 * Handles canvas-level interaction: object selection, deletion, rubber-band
 * multi-select, and right-click context menu for placing new objects.
 */
export class CanvasController {
  // Multi-select state
  private selectedNodeIds = new Set<string>();

  private _active = true;
  private undoManager?: { undo: () => void };
  private menuEl: HTMLElement | null = null;
  private cables: CableRenderer | null = null;
  private cableDraw: CableDrawController | null = null;
  private panGroup: HTMLElement | null = null;
  private scrollSpacer: HTMLElement | null = null;
  private vizGraph: VisualizerGraph | null = null;
  private entryBox: ObjectEntryBox | null = null;
  private isPanning = false;
  private spaceHeld = false;
  private panStartX = 0;
  private panStartY = 0;
  /** scrollLeft / scrollTop at pan-drag start */
  private panOriginX = 0;
  private panOriginY = 0;
  private suppressCanvasClick = false;

  // Rubber-band state
  private isRubberBanding = false;
  private rubberBandEl: HTMLDivElement | null = null;
  private rbStartX = 0;
  private rbStartY = 0;

  private readonly onCanvasClick: (e: MouseEvent) => void;
  private readonly onCanvasContextMenu: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onDocClick: (e: MouseEvent) => void;
  private readonly onCableClick: (e: MouseEvent) => void;
  private readonly onPanMouseDown: (e: MouseEvent) => void;
  private readonly onPanMouseMove: (e: MouseEvent) => void;
  private readonly onPanMouseUp: (e: MouseEvent) => void;
  private readonly onDoubleClick: (e: MouseEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;

  constructor(
    private readonly canvasEl: HTMLElement,
    private readonly graph: PatchGraph,
    private readonly onObjectPlaced?: (type: string, nodeId: string) => void,
  ) {
    injectMenuStyles();

    this.onCanvasClick = this.handleCanvasClick.bind(this);
    this.onCanvasContextMenu = this.handleContextMenu.bind(this);
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.onKeyUp = this.handleKeyUp.bind(this);
    this.onDocClick = this.handleDocClick.bind(this);
    this.onCableClick = this.handleCableClick.bind(this);
    this.onPanMouseDown = this.handlePanMouseDown.bind(this);
    this.onPanMouseMove = this.handlePanMouseMove.bind(this);
    this.onPanMouseUp = this.handlePanMouseUp.bind(this);
    this.onDoubleClick = this.handleDoubleClick.bind(this);
    this.onWheel = this.handleWheel.bind(this);

    this.canvasEl.addEventListener("click", this.onCanvasClick);
    this.canvasEl.addEventListener("dblclick", this.onDoubleClick);
    this.canvasEl.addEventListener("contextmenu", this.onCanvasContextMenu);
    this.canvasEl.addEventListener("mousedown", this.onPanMouseDown);
    this.canvasEl.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("click", this.onDocClick, true);
  }

  // ── Public API ─────────────────────────────────────────────────────

  setPanGroup(el: HTMLElement): void {
    this.panGroup = el;
    el.style.transformOrigin = "0 0";
    el.style.transform = `scale(${getZoom()})`;

    // Spacer sibling: its far corner drives canvasArea's scroll extent under zoom.
    // panGroup's own layout box stays at intrinsic size; transform only scales visuals.
    this.scrollSpacer = document.createElement("div");
    this.scrollSpacer.className = "pn-scroll-spacer";
    this.scrollSpacer.style.cssText =
      "position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0;";
    this.canvasEl.appendChild(this.scrollSpacer);
  }

  getPan(): { x: number; y: number } {
    return { x: this.canvasEl.scrollLeft, y: this.canvasEl.scrollTop };
  }

  getZoom(): number {
    return getZoom();
  }

  /**
   * Resize the pan-group to fit all nodes plus a generous margin.
   * Call this at the end of every render pass so the scrollable boundary
   * automatically expands as the patch grows.
   */
  updatePanGroupSize(): void {
    if (!this.panGroup) return;
    const z = getZoom();
    const MARGIN  = 600; // px of empty space beyond the furthest object (intrinsic)
    const viewW   = this.canvasEl.clientWidth  / z;
    const viewH   = this.canvasEl.clientHeight / z;
    let maxRight  = viewW;
    let maxBottom = viewH;
    for (const node of this.graph.getNodes()) {
      const r = node.x + (node.width  ?? 100) + MARGIN;
      const b = node.y + (node.height ?? 30)  + MARGIN;
      if (r > maxRight)  maxRight  = r;
      if (b > maxBottom) maxBottom = b;
    }
    this.panGroup.style.width  = `${maxRight}px`;
    this.panGroup.style.height = `${maxBottom}px`;

    if (this.scrollSpacer) {
      this.scrollSpacer.style.left = `${Math.ceil(CANVAS_LEFT_GUTTER_PX + maxRight  * z)}px`;
      this.scrollSpacer.style.top  = `${Math.ceil(CANVAS_TOP_GUTTER_PX  + maxBottom * z)}px`;
    }
  }

  /**
   * Set zoom to `z`, optionally anchoring around a screen point so the world
   * position under the cursor stays put after zoom.
   */
  setZoom(z: number, anchorClientX?: number, anchorClientY?: number): void {
    if (!this.panGroup) return;
    const prev = getZoom();
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (clamped === prev) return;

    const rect = this.canvasEl.getBoundingClientRect();
    const ax = (anchorClientX ?? rect.left + this.canvasEl.clientWidth  / 2) - rect.left;
    const ay = (anchorClientY ?? rect.top  + this.canvasEl.clientHeight / 2) - rect.top;

    // Canvas-content position of the anchor (pre-zoom)
    const contentX = ax + this.canvasEl.scrollLeft;
    const contentY = ay + this.canvasEl.scrollTop;
    // Intrinsic world position under anchor (account for gutter + previous zoom)
    const worldX = (contentX - CANVAS_LEFT_GUTTER_PX) / prev;
    const worldY = (contentY - CANVAS_TOP_GUTTER_PX)  / prev;

    setZoomValue(clamped);
    this.panGroup.style.transform = `scale(${clamped})`;
    this.updatePanGroupSize();

    // Restore the same world point under the anchor at the new zoom
    const newContentX = worldX * clamped + CANVAS_LEFT_GUTTER_PX;
    const newContentY = worldY * clamped + CANVAS_TOP_GUTTER_PX;
    this.canvasEl.scrollLeft = Math.max(0, newContentX - ax);
    this.canvasEl.scrollTop  = Math.max(0, newContentY - ay);

    this.cables?.render();
  }

  zoomBy(factor: number, anchorClientX?: number, anchorClientY?: number): void {
    this.setZoom(getZoom() * factor, anchorClientX, anchorClientY);
  }

  resetZoom(): void {
    this.setZoom(1);
  }

  setActive(active: boolean): void {
    this._active = active;
  }

  setCableRenderer(cables: CableRenderer): void {
    this.cables = cables;
    cables.getSVGElement().addEventListener("click", this.onCableClick);
  }

  setCableDrawController(controller: CableDrawController | null): void {
    this.cableDraw = controller;
  }

  setUndoManager(um: { undo: () => void }): void {
    this.undoManager = um;
  }

  setVisualizerGraph(vg: VisualizerGraph): void {
    this.vizGraph = vg;
    this.setupDragDrop();
  }

  /** Returns the primary selected node ID (first in set), or null. */
  getSelectedNodeId(): string | null {
    return this.selectedNodeIds.values().next().value ?? null;
  }

  /** Returns all selected node IDs — used by DragController for multi-drag. */
  getSelectedNodeIds(): Set<string> {
    return this.selectedNodeIds;
  }

  /** Select a single node, clearing all others. Pass null to deselect all. */
  selectNode(id: string | null): void {
    // No-op if already sole selection
    if (id !== null && this.selectedNodeIds.size === 1 && this.selectedNodeIds.has(id)) return;
    if (id === null && this.selectedNodeIds.size === 0) return;

    this.clearSelectionVisuals();
    this.cables?.selectEdge(null);
    this.selectedNodeIds.clear();

    if (id) {
      this.selectedNodeIds.add(id);
      this.canvasEl.querySelector(`[data-node-id="${id}"]`)?.classList.add("patch-object--selected");
    }
  }

  /** Add or remove a node from the current selection (Shift+click). */
  toggleNodeSelection(id: string): void {
    this.cables?.selectEdge(null);
    if (this.selectedNodeIds.has(id)) {
      this.selectedNodeIds.delete(id);
      this.canvasEl.querySelector(`[data-node-id="${id}"]`)?.classList.remove("patch-object--selected");
    } else {
      this.selectedNodeIds.add(id);
      this.canvasEl.querySelector(`[data-node-id="${id}"]`)?.classList.add("patch-object--selected");
    }
  }

  /** Replace the entire selection (used by rubber-band). */
  selectNodes(ids: Set<string>): void {
    this.clearSelectionVisuals();
    this.cables?.selectEdge(null);
    this.selectedNodeIds = new Set(ids);
    for (const id of this.selectedNodeIds) {
      this.canvasEl.querySelector(`[data-node-id="${id}"]`)?.classList.add("patch-object--selected");
    }
  }

  destroy(): void {
    this.canvasEl.removeEventListener("click", this.onCanvasClick);
    this.canvasEl.removeEventListener("dblclick", this.onDoubleClick);
    this.canvasEl.removeEventListener("contextmenu", this.onCanvasContextMenu);
    this.canvasEl.removeEventListener("mousedown", this.onPanMouseDown);
    this.canvasEl.removeEventListener("wheel", this.onWheel);
    this.scrollSpacer?.remove();
    this.scrollSpacer = null;
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("click", this.onDocClick, true);
    document.removeEventListener("mousemove", this.onPanMouseMove);
    document.removeEventListener("mouseup", this.onPanMouseUp);
    this.cables?.getSVGElement().removeEventListener("click", this.onCableClick);
    this.cableDraw = null;
    this.endPan();
    this.endRubberBand(false);
    this.closeMenu();
  }

  // ── Internal handlers ──────────────────────────────────────────────

  private handleCanvasClick(e: MouseEvent): void {
    if (!this._active) return;
    if (e.button !== 0) return;
    if (this.suppressCanvasClick) {
      this.suppressCanvasClick = false;
      return;
    }
    // Rubber-band mouseup handles selection — don't also process click
    if (this.isRubberBanding) return;

    const target = e.target as Element;
    const objectEl = target.closest<HTMLElement>(".patch-object");

    if (objectEl?.dataset.nodeId) {
      if (e.shiftKey) {
        this.toggleNodeSelection(objectEl.dataset.nodeId);
      } else {
        this.selectNode(objectEl.dataset.nodeId);
      }
    } else {
      this.selectNode(null);
    }
  }

  private handleDoubleClick(e: MouseEvent): void {
    if (!this._active) return;
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest(".patch-object")) return;
    if (target.closest(".pn-cable-svg")) return;

    const { x, y } = this.getGraphCoords(e.clientX, e.clientY);
    this.openEntryBox(x, y);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this._active) return;
    if (this.isEditableTarget(e.target)) return;

    if (e.code === "Space") {
      this.spaceHeld = true;
      this.updateCursor();
      e.preventDefault();
      return;
    }

    if (e.key === "Escape") {
      this.entryBox?.destroy();
      this.entryBox = null;
      this.selectNode(null);
      this.cables?.selectEdge(null);
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedNodeIds.size > 0) {
        e.preventDefault();
        const ids = [...this.selectedNodeIds];
        this.selectNode(null);
        for (const id of ids) this.graph.removeNode(id);
      } else if (this.cables?.getSelectedEdgeId()) {
        e.preventDefault();
        const edgeId = this.cables.getSelectedEdgeId()!;
        this.cables.selectEdge(null);
        this.graph.removeEdge(edgeId);
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      this.undoManager?.undo();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.selectNodes(new Set(this.graph.getNodes().map((node) => node.id)));
      return;
    }

    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      this.zoomBy(1.15);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "-") {
      e.preventDefault();
      this.zoomBy(1 / 1.15);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "0") {
      e.preventDefault();
      this.resetZoom();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key.toLowerCase()) {
      case "n":
        e.preventDefault();
        this.openEntryBox(...this.viewportCenter());
        break;
      case "b":
        e.preventDefault();
        this.placeObject("button");
        break;
      case "t":
        e.preventDefault();
        this.placeObject("toggle");
        break;
      case "s":
        e.preventDefault();
        this.placeObject("slider");
        break;
      case "a":
        e.preventDefault();
        this.placeObject("attribute");
        break;
      case "m":
        e.preventDefault();
        this.placeObject("message");
        break;
      case "g": {
        const canGroup = this.selectedNodeIds.size >= 2;
        const canUngroup = this.selectedNodeIds.size >= 1 &&
          [...this.selectedNodeIds].some(id => this.graph.nodes.get(id)?.groupId);
        if (canGroup || canUngroup) {
          e.preventDefault();
          this.toggleGroup();
        }
        break;
      }
    }
  }

  private toggleGroup(): void {
    const ids = [...this.selectedNodeIds];

    // Single node in a group — dissolve the entire group
    if (ids.length === 1) {
      const groupId = this.graph.nodes.get(ids[0])?.groupId;
      if (!groupId) return;
      for (const node of this.graph.getNodes()) {
        if (node.groupId === groupId) node.groupId = undefined;
      }
      this.graph.emit("change");
      return;
    }

    if (ids.length < 2) return;

    const firstGroupId = this.graph.nodes.get(ids[0])?.groupId;
    const allSameGroup = !!firstGroupId &&
      ids.every(id => this.graph.nodes.get(id)?.groupId === firstGroupId);

    if (allSameGroup) {
      for (const id of ids) {
        const node = this.graph.nodes.get(id);
        if (node) node.groupId = undefined;
      }
    } else {
      const groupId = crypto.randomUUID();
      for (const id of ids) {
        const node = this.graph.nodes.get(id);
        if (node) node.groupId = groupId;
      }
    }

    this.graph.emit("change");
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (!this._active) return;
    if (e.code !== "Space") return;
    this.spaceHeld = false;
    this.updateCursor();
  }

  private handleWheel(e: WheelEvent): void {
    // Cmd/Ctrl + wheel → zoom around cursor. Otherwise let the browser scroll.
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoomBy(factor, e.clientX, e.clientY);
  }

  private handleCableClick(e: MouseEvent): void {
    if (!this.cables) return;
    if (this.cableDraw?.consumeCableClickSuppression()) return;

    const edgeId = this.cables.edgeIdFromEvent(e);
    if (!edgeId) return;

    if (e.altKey) {
      this.cables.selectEdge(null);
      this.graph.removeEdge(edgeId);
      return;
    }

    this.selectNode(null);
    this.cables.selectEdge(
      this.cables.getSelectedEdgeId() === edgeId ? null : edgeId,
    );
  }

  // ── Object placement ──────────────────────────────────────────────

  private openEntryBox(x: number, y: number): void {
    if (!this.panGroup) return;
    this.entryBox?.destroy();
    this.entryBox = new ObjectEntryBox(
      this.panGroup,
      x,
      y,
      (type, args) => {
        this.entryBox = null;
        const node = this.graph.addNode(type, x, y, args);
        this.onObjectPlaced?.(type, node.id);
      },
      () => {
        this.entryBox = null;
      },
    );
  }

  private placeObject(type: string): void {
    const [x, y] = this.viewportCenter();
    const node = this.graph.addNode(type, x, y);
    this.onObjectPlaced?.(type, node.id);
  }

  /** World-space center of the currently visible canvas area. */
  private viewportCenter(): [number, number] {
    const z = getZoom();
    const x = Math.max(0, Math.round((this.canvasEl.scrollLeft + this.canvasEl.clientWidth  / 2 - CANVAS_LEFT_GUTTER_PX) / z));
    const y = Math.max(0, Math.round((this.canvasEl.scrollTop  + this.canvasEl.clientHeight / 2 - CANVAS_TOP_GUTTER_PX) / z));
    return [x, y];
  }

  // ── Pan + rubber-band mousedown ────────────────────────────────────

  private handlePanMouseDown(e: MouseEvent): void {
    if (!this._active) return;
    const isMiddle = e.button === 1;
    const isSpacePrimary = e.button === 0 && this.spaceHeld;

    if (isMiddle || isSpacePrimary) {
      e.preventDefault();
      this.isPanning = true;
      this.panStartX  = e.clientX;
      this.panStartY  = e.clientY;
      this.panOriginX = this.canvasEl.scrollLeft;
      this.panOriginY = this.canvasEl.scrollTop;
      this.suppressCanvasClick = true;
      this.closeMenu();
      this.updateCursor();
      document.addEventListener("mousemove", this.onPanMouseMove);
      document.addEventListener("mouseup", this.onPanMouseUp);
      return;
    }

    // Left click on empty canvas (not on any object or cable) → rubber-band
    if (e.button === 0) {
      const target = e.target as Element;
      if (target.closest(".patch-object")) return;
      if (target.closest(".pn-cable-svg")) return;
      if (target.closest(".pn-context-menu")) return;

      this.startRubberBand(e);
    }
  }

  private handlePanMouseMove(e: MouseEvent): void {
    if (this.isPanning) {
      // Drag right → content moves right → scrollLeft decreases (hand-tool convention)
      this.canvasEl.scrollLeft = this.panOriginX - (e.clientX - this.panStartX);
      this.canvasEl.scrollTop  = this.panOriginY - (e.clientY - this.panStartY);
    } else if (this.isRubberBanding) {
      this.updateRubberBand(e);
    }
  }

  private handlePanMouseUp(_e: MouseEvent): void {
    if (this.isPanning) {
      this.endPan();
    } else if (this.isRubberBanding) {
      this.endRubberBand(true);
      this.suppressCanvasClick = true;
    }
  }

  // ── Rubber-band ────────────────────────────────────────────────────

  private startRubberBand(e: MouseEvent): void {
    const rect = this.canvasEl.getBoundingClientRect();
    // Positions are in panGroup (content) space so the element sits in the right
    // place when the parent scroll container is scrolled.
    this.rbStartX = e.clientX - rect.left + this.canvasEl.scrollLeft;
    this.rbStartY = e.clientY - rect.top  + this.canvasEl.scrollTop;
    this.isRubberBanding = true;

    const el = document.createElement("div");
    el.className = "pn-rubber-band";
    el.style.left = `${this.rbStartX}px`;
    el.style.top = `${this.rbStartY}px`;
    el.style.width = "0px";
    el.style.height = "0px";
    this.canvasEl.appendChild(el);
    this.rubberBandEl = el;

    document.addEventListener("mousemove", this.onPanMouseMove);
    document.addEventListener("mouseup", this.onPanMouseUp);
  }

  private updateRubberBand(e: MouseEvent): void {
    if (!this.rubberBandEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const curX = e.clientX - rect.left + this.canvasEl.scrollLeft;
    const curY = e.clientY - rect.top  + this.canvasEl.scrollTop;

    const x = Math.min(curX, this.rbStartX);
    const y = Math.min(curY, this.rbStartY);
    const w = Math.abs(curX - this.rbStartX);
    const h = Math.abs(curY - this.rbStartY);

    this.rubberBandEl.style.left = `${x}px`;
    this.rubberBandEl.style.top = `${y}px`;
    this.rubberBandEl.style.width = `${w}px`;
    this.rubberBandEl.style.height = `${h}px`;
  }

  private endRubberBand(commit: boolean): void {
    if (!this.isRubberBanding) return;
    this.isRubberBanding = false;

    if (commit && this.rubberBandEl && this.panGroup) {
      const rbRect = this.rubberBandEl.getBoundingClientRect();
      const selected = new Set<string>();

      const objects = this.panGroup.querySelectorAll<HTMLElement>(".patch-object");
      for (const obj of objects) {
        const objRect = obj.getBoundingClientRect();
        const overlaps =
          objRect.left < rbRect.right &&
          objRect.right > rbRect.left &&
          objRect.top < rbRect.bottom &&
          objRect.bottom > rbRect.top;
        if (overlaps && obj.dataset.nodeId) {
          selected.add(obj.dataset.nodeId);
        }
      }

      this.selectNodes(selected);
    }

    this.rubberBandEl?.remove();
    this.rubberBandEl = null;
    document.removeEventListener("mousemove", this.onPanMouseMove);
    document.removeEventListener("mouseup", this.onPanMouseUp);
  }

  // ── Context menu ───────────────────────────────────────────────────

  private handleContextMenu(e: MouseEvent): void {
    if (!this._active) return;
    e.preventDefault();
    const target = e.target as Element;
    const objectEl = target.closest<HTMLElement>(".patch-object");
    if (objectEl?.dataset.nodeId) {
      this.openObjectMenu(e.clientX, e.clientY, objectEl.dataset.nodeId);
      return;
    }

    const { x: canvasX, y: canvasY } = this.getGraphCoords(e.clientX, e.clientY);
    this.openMenu(e.clientX, e.clientY, canvasX, canvasY);
  }

  private handleDocClick(e: MouseEvent): void {
    if (!this.menuEl) return;
    if (!this.menuEl.contains(e.target as Node)) {
      this.closeMenu();
    }
  }

  private openMenu(
    screenX: number,
    screenY: number,
    canvasX: number,
    canvasY: number,
  ): void {
    this.closeMenu();

    const menu = document.createElement("div");
    menu.className = "pn-context-menu";
    menu.style.left = `${screenX}px`;
    menu.style.top = `${screenY}px`;

    for (const type of OBJECT_TYPES) {
      const btn = document.createElement("button");
      btn.className = "pn-context-menu-item";
      btn.textContent = type;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const node = this.graph.addNode(type, canvasX, canvasY);
        this.onObjectPlaced?.(type, node.id);
        this.closeMenu();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    this.menuEl = menu;

    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) menu.style.left = `${screenX - menuRect.width}px`;
    if (menuRect.bottom > window.innerHeight) menu.style.top = `${screenY - menuRect.height}px`;
  }

  private openObjectMenu(screenX: number, screenY: number, nodeId: string): void {
    this.closeMenu();

    const node = this.graph.nodes.get(nodeId);
    if (!node) return;

    const def = getObjectDef(node.type);
    const width  = Math.round(node.width  ?? def.defaultWidth);
    const height = Math.round(node.height ?? def.defaultHeight);
    const hasUserDefault = !!getUserDefaultSize(node.type);

    const menu = document.createElement("div");
    menu.className = "pn-context-menu";
    menu.style.left = `${screenX}px`;
    menu.style.top = `${screenY}px`;

    const addItem = (label: string, onClick: () => void): void => {
      const btn = document.createElement("button");
      btn.className = "pn-context-menu-item";
      btn.textContent = label;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onClick();
        this.closeMenu();
      });
      menu.appendChild(btn);
    };

    addItem(`Set default size for ${node.type} (${width}×${height})`, () => {
      setUserDefaultSize(node.type, width, height);
      this.graph.emit("change");
    });

    if (hasUserDefault) {
      addItem(`Reset ${node.type} to built-in default`, () => {
        clearUserDefaultSize(node.type);
        this.graph.emit("change");
      });
    }

    document.body.appendChild(menu);
    this.menuEl = menu;

    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right  > window.innerWidth)  menu.style.left = `${screenX - menuRect.width}px`;
    if (menuRect.bottom > window.innerHeight) menu.style.top  = `${screenY - menuRect.height}px`;
  }

  private closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private clearSelectionVisuals(): void {
    for (const id of this.selectedNodeIds) {
      this.canvasEl.querySelector(`[data-node-id="${id}"]`)?.classList.remove("patch-object--selected");
    }
  }

  private endPan(): void {
    this.isPanning = false;
    document.removeEventListener("mousemove", this.onPanMouseMove);
    document.removeEventListener("mouseup", this.onPanMouseUp);
    this.updateCursor();
  }

  private updateCursor(): void {
    const b = document.body.classList;
    if (this.isPanning) {
      b.add("pn-state-panning");
      b.remove("pn-state-pan-ready");
    } else if (this.spaceHeld) {
      b.add("pn-state-pan-ready");
      b.remove("pn-state-panning");
    } else {
      b.remove("pn-state-panning", "pn-state-pan-ready");
    }
  }

  private getGraphCoords(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvasEl.getBoundingClientRect();
    const z = getZoom();
    return {
      x: Math.max(
        0,
        Math.round((clientX - rect.left + this.canvasEl.scrollLeft - CANVAS_LEFT_GUTTER_PX) / z),
      ),
      y: Math.max(
        0,
        Math.round((clientY - rect.top + this.canvasEl.scrollTop - CANVAS_TOP_GUTTER_PX) / z),
      ),
    };
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT"
    );
  }

  // ── Drag-and-drop file import ────────────────────────────────────

  private setupDragDrop(): void {
    this.canvasEl.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      this.canvasEl.classList.add("pn-drag-over");
    });

    this.canvasEl.addEventListener("dragleave", (e) => {
      // Only clear when leaving the canvas entirely (not a child element)
      if (!this.canvasEl.contains(e.relatedTarget as Node)) {
        this.canvasEl.classList.remove("pn-drag-over");
      }
    });

    this.canvasEl.addEventListener("drop", (e) => {
      e.preventDefault();
      this.canvasEl.classList.remove("pn-drag-over");

      const file = e.dataTransfer?.files[0];
      if (!file || !this.vizGraph) return;

      const { x, y } = this.getGraphCoords(e.clientX, e.clientY);

      if (file.type.startsWith("video/")) {
        const node = this.graph.addNode("mediaVideo", x, y);
        this.onObjectPlaced?.("mediaVideo", node.id);
        // VisualizerGraph.sync() runs synchronously on addNode's "change" event,
        // so the MediaVideoNode exists by the time we call loadFileForNode.
        this.vizGraph.loadFileForNode(node.id, "mediaVideo", file);
      } else if (file.type.startsWith("image/")) {
        const node = this.graph.addNode("mediaImage", x, y);
        this.onObjectPlaced?.("mediaImage", node.id);
        this.vizGraph.loadFileForNode(node.id, "mediaImage", file);
      }
    });
  }
}
