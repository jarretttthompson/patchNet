import type { PatchGraph } from "../graph/PatchGraph";
import type { CableDrawController } from "./CableDrawController";
import type { CableRenderer } from "./CableRenderer";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import { ObjectEntryBox } from "./ObjectEntryBox";
import {
  CANVAS_LEFT_GUTTER_PX,
  CANVAS_TOP_GUTTER_PX,
  CANVAS_WIDTH_PX,
  CANVAS_HEIGHT_PX,
  GRID_CELL_PX,
} from "./canvasSpace";
import { getZoom, setZoomValue, MIN_ZOOM, MAX_ZOOM } from "./zoomState";
import { getPatchMode, subscribePatchMode } from "./patchModeState";
import { OBJECT_DEFS, audioPortDefaultWidth, deriveAdcPorts, deriveDacPorts, getObjectDef } from "../graph/objectDefs";
import type { AudioGraph } from "../runtime/AudioGraph";
import { startDragSession, type DragSession } from "./dragSession";
import {
  getUserDefaultSize,
  setUserDefaultSize,
  clearUserDefaultSize,
} from "../graph/userObjectDefaults";
import { REFERENCE_PATCHES } from "./referencePatches";

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
.pn-context-menu-note {
  padding: 6px 14px 8px;
  color: var(--pn-text-dim);
  border-bottom: 1px solid var(--pn-border);
  margin-bottom: 4px;
  user-select: text;
  letter-spacing: 0.04em;
}
.pn-context-menu-note strong {
  color: var(--pn-text);
  font-weight: 700;
}
`;

function injectMenuStyles(): void {
  if (document.getElementById("pn-context-menu-styles")) return;
  const style = document.createElement("style");
  style.id = "pn-context-menu-styles";
  style.textContent = MENU_STYLE;
  document.head.appendChild(style);
}

/** Format a world-pixel coord as grid cells, trimming trailing zeros. */
function fmtCells(px: number): string {
  const cells = px / GRID_CELL_PX;
  return cells.toFixed(2).replace(/\.?0+$/, "") || "0";
}

/**
 * Handles canvas-level interaction: object selection, deletion, rubber-band
 * multi-select, and right-click context menu for placing new objects.
 */
export class CanvasController {
  // Multi-select state
  private selectedNodeIds = new Set<string>();

  private _active = true;
  private patchMode = getPatchMode();
  private unsubscribePatchMode: (() => void) | null = null;
  private undoManager?: { undo: () => void };
  private menuEl: HTMLElement | null = null;
  private cables: CableRenderer | null = null;
  private cableDraw: CableDrawController | null = null;
  private panGroup: HTMLElement | null = null;
  private scrollSpacer: HTMLElement | null = null;
  private viewportObserver: ResizeObserver | null = null;
  private vizGraph: VisualizerGraph | null = null;
  private audioGraph: AudioGraph | null = null;
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

  // Cursor tracking for Max-style at-cursor object spawning (n/b/t/s/a/m keys).
  private lastMouseClientX = 0;
  private lastMouseClientY = 0;

  /** Called from the right-click menu when the user picks a bundled reference
   *  patch. main.ts opens (or focuses) a scratch tab with the patch loaded. */
  onOpenReferencePatch?: (objectType: string) => void;

  private readonly onCanvasClick: (e: MouseEvent) => void;
  private readonly onCanvasContextMenu: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onDocClick: (e: MouseEvent) => void;
  private readonly onCableClick: (e: MouseEvent) => void;
  private readonly onPanMouseDown: (e: MouseEvent) => void;
  private readonly onDoubleClick: (e: MouseEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onDocMouseMove: (e: MouseEvent) => void;
  /** Single live drag session for pan + rubber-band. Mutually exclusive
   *  modes (`isPanning` vs `isRubberBanding`); session installs blur +
   *  Escape recovery so an alt-tab mid-pan can't strand the cursor. */
  private panSession: DragSession | null = null;

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
    this.onDoubleClick = this.handleDoubleClick.bind(this);
    this.onWheel = this.handleWheel.bind(this);
    this.onDocMouseMove = (e: MouseEvent) => {
      this.lastMouseClientX = e.clientX;
      this.lastMouseClientY = e.clientY;
    };

    this.canvasEl.addEventListener("click", this.onCanvasClick);
    this.canvasEl.addEventListener("dblclick", this.onDoubleClick);
    this.canvasEl.addEventListener("contextmenu", this.onCanvasContextMenu);
    this.canvasEl.addEventListener("mousedown", this.onPanMouseDown);
    this.canvasEl.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("mousemove", this.onDocMouseMove);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("click", this.onDocClick, true);

    this.unsubscribePatchMode = subscribePatchMode((on) => this.setPatchMode(on));
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

    // Spacer extent depends on viewport size (one-viewport pad past canvas
    // edge so the user can scroll the canvas's far edge to the leading edge
    // of the viewport). Re-sync on viewport resize.
    if (!this.viewportObserver) {
      this.viewportObserver = new ResizeObserver(() => this.updatePanGroupSize());
      this.viewportObserver.observe(this.canvasEl);
    }
  }

  getPan(): { x: number; y: number } {
    return { x: this.canvasEl.scrollLeft, y: this.canvasEl.scrollTop };
  }

  getZoom(): number {
    return getZoom();
  }

  /**
   * Pan-group is a fixed-size world (CANVAS_WIDTH_PX × CANVAS_HEIGHT_PX).
   * Method retained as the single sync point for the scrollSpacer's
   * zoom-dependent extent, so callers don't need to know the difference.
   *
   * The scrollSpacer extends one viewport's worth past the canvas's right
   * and bottom edges, so the user can scroll until any world cell sits at
   * the viewport's leading edge — including the rightmost / bottommost
   * column. Without this padding, max scroll is capped at
   * `CANVAS_*_PX - clientW/H`, leaving the leading-edge ruler short of the
   * canvas's far edge.
   */
  updatePanGroupSize(): void {
    if (!this.panGroup) return;
    const z = getZoom();
    this.panGroup.style.width  = `${CANVAS_WIDTH_PX}px`;
    this.panGroup.style.height = `${CANVAS_HEIGHT_PX}px`;

    if (this.scrollSpacer) {
      const padX = this.canvasEl.clientWidth;
      const padY = this.canvasEl.clientHeight;
      this.scrollSpacer.style.left = `${Math.ceil(CANVAS_LEFT_GUTTER_PX + CANVAS_WIDTH_PX  * z + padX)}px`;
      this.scrollSpacer.style.top  = `${Math.ceil(CANVAS_TOP_GUTTER_PX  + CANVAS_HEIGHT_PX * z + padY)}px`;
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
    controller?.setPatchMode(this.patchMode);
  }

  setPatchMode(on: boolean): void {
    this.patchMode = on;
    this.cableDraw?.setPatchMode(on);
    if (!on) {
      this.cables?.selectEdge(null);
      this.cableDraw?.cancel();
    }
  }

  setUndoManager(um: { undo: () => void }): void {
    this.undoManager = um;
  }

  setVisualizerGraph(vg: VisualizerGraph): void {
    this.vizGraph = vg;
    this.setupDragDrop();
  }

  setAudioGraph(ag: AudioGraph | null): void {
    this.audioGraph = ag;
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
    document.removeEventListener("mousemove", this.onDocMouseMove);
    this.scrollSpacer?.remove();
    this.scrollSpacer = null;
    this.viewportObserver?.disconnect();
    this.viewportObserver = null;
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("click", this.onDocClick, true);
    this.panSession?.end();
    this.panSession = null;
    this.cables?.getSVGElement().removeEventListener("click", this.onCableClick);
    this.cableDraw = null;
    this.unsubscribePatchMode?.();
    this.unsubscribePatchMode = null;
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
    this.openEntryBox(...this.centerEntryBox(x, y));
  }

  /**
   * Local key handler — only gesture state (Space for pan).
   * Command shortcuts (Delete, Mod+Z, Mod+A, zoom, N/B/T/S/A/M, G) are
   * handled by the action keymap so they live in one place and can be
   * rebound. Space is intentionally local because it modifies the cursor
   * and is intimately tied to the pan drag mechanic.
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this._active) return;
    if (this.isEditableTarget(e.target)) return;

    if (e.code === "Space") {
      this.spaceHeld = true;
      this.updateCursor();
      e.preventDefault();
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
    // Every CanvasController (main + each subpatch session) listens on the
    // same shared canvasEl, so without this guard a single Cmd+wheel would
    // zoom N+1 times and compound the global _zoom singleton out of sync
    // with each tab's actual transform — the root of the drift that forces
    // a page reload to recover.
    if (!this._active) return;
    // Cmd/Ctrl + wheel → zoom around cursor. Otherwise let the browser scroll.
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoomBy(factor, e.clientX, e.clientY);
  }

  private handleCableClick(e: MouseEvent): void {
    if (!this.cables) return;
    if (!this.patchMode) return;
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
      () => {
        const seen = new Set<string>();
        for (const node of this.graph.getNodes()) {
          if ((node.type === "s" || node.type === "r") && node.args[0]) {
            seen.add(node.args[0]);
          }
        }
        return Array.from(seen).sort();
      },
    );
  }

  /**
   * Place a new object of `type` at the keyboard spawn anchor: cursor if
   * over canvas, otherwise viewport center. Used by both the legacy
   * inline shortcuts and the action system's canvas.object.create.* family.
   *
   * If `requireCursorOverCanvas` is true and the cursor isn't over the
   * canvas, the call is a no-op (matches legacy n/m behavior — those
   * keys also exist as text characters and shouldn't spawn objects out
   * of nowhere when typed somewhere unrelated).
   */
  placeObject(type: string, opts: { requireCursorOverCanvas?: boolean } = {}): void {
    if (!this._active) return;
    if (opts.requireCursorOverCanvas && !this.isCursorOverCanvas()) return;
    const { x, y } = this.spawnAnchor();
    const def = getObjectDef(type);
    const w = def?.defaultWidth ?? 80;
    const h = def?.defaultHeight ?? 40;
    const nx = x - Math.round(w / 2);
    const ny = y - Math.round(h / 2);
    const node = this.graph.addNode(type, nx, ny);
    this.onObjectPlaced?.(type, node.id);
  }

  /** Open the object entry box at the cursor (N key). No-op if cursor is
   *  off-canvas — N is also a typeable letter. */
  openObjectEntryAtCursor(): void {
    if (!this._active) return;
    if (!this.isCursorOverCanvas()) return;
    const { x, y } = this.getGraphCoords(this.lastMouseClientX, this.lastMouseClientY);
    this.openEntryBox(...this.centerEntryBox(x, y));
  }

  /** Delete every selected node, or the selected edge in patch mode.
   *  Multi-node deletes are batched so the UndoManager records one step. */
  deleteSelection(): void {
    if (!this._active) return;
    if (this.selectedNodeIds.size > 0) {
      const ids = [...this.selectedNodeIds];
      this.selectNode(null);
      this.graph.batchChange(() => {
        for (const id of ids) this.graph.removeNode(id);
      });
    } else if (this.patchMode && this.cables?.getSelectedEdgeId()) {
      const edgeId = this.cables.getSelectedEdgeId()!;
      this.cables.selectEdge(null);
      this.graph.removeEdge(edgeId);
    }
  }

  /** Select every node in the active graph. */
  selectAllNodes(): void {
    if (!this._active) return;
    this.selectNodes(new Set(this.graph.getNodes().map((node) => node.id)));
  }

  /** Dismiss any open entry box and clear node + edge selection. */
  clearSelectionAndEntry(): void {
    if (!this._active) return;
    this.entryBox?.destroy();
    this.entryBox = null;
    this.selectNode(null);
    this.cables?.selectEdge(null);
  }

  /** Group / ungroup selected nodes (G). */
  toggleGroupSelection(): void {
    if (!this._active) return;
    const canGroup = this.selectedNodeIds.size >= 2;
    const canUngroup = this.selectedNodeIds.size >= 1 &&
      [...this.selectedNodeIds].some(id => this.graph.nodes.get(id)?.groupId);
    if (!canGroup && !canUngroup) return;
    this.toggleGroup();
  }

  /** Trigger undo through the bound UndoManager (Mod+Z). */
  undo(): void {
    if (!this._active) return;
    this.undoManager?.undo();
  }

  /**
   * Where a keyboard-triggered spawn (n, b, t, s, a, m) should anchor.
   * Cursor position if it's over the canvas (Max convention), otherwise
   * the center of the currently visible area.
   */
  private spawnAnchor(): { x: number; y: number } {
    if (this.isCursorOverCanvas()) {
      return this.getGraphCoords(this.lastMouseClientX, this.lastMouseClientY);
    }
    const [x, y] = this.viewportCenter();
    return { x, y };
  }

  /** Geometric check at call-time — robust against missed enter/leave events. */
  private isCursorOverCanvas(): boolean {
    const r = this.canvasEl.getBoundingClientRect();
    const x = this.lastMouseClientX;
    const y = this.lastMouseClientY;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /**
   * Offset a world-space anchor so the ~80x24 entry box appears just above
   * the cursor. The cursor hotspot is at the arrow's tip while the arrow's
   * visible body hangs down-right from there, so a pure geometric center
   * reads as "below the cursor" — bias the box upward so the arrow sits
   * near its lower edge instead of overlapping the input.
   */
  private centerEntryBox(x: number, y: number): [number, number] {
    return [x - 40, y - 22];
  }

  /** World-space center of the currently visible canvas area. */
  viewportCenter(): [number, number] {
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
      this.startPanSession();
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

    this.startPanSession();
  }

  /**
   * Shared mousemove/mouseup session for pan and rubber-band. The two are
   * mutually exclusive (gated on `isPanning` / `isRubberBanding`) so a
   * single session covers either one. Installs `window.blur` + Escape
   * recovery so a missed mouseup can't strand the user mid-pan.
   */
  private startPanSession(): void {
    this.panSession?.end();
    this.panSession = startDragSession({
      onMove:   (e) => this.handlePanMouseMove(e),
      onUp:     (e) => this.handlePanMouseUp(e),
      onCancel: ()  => {
        // Pan: just stop. Rubber-band: discard selection (don't commit).
        if (this.isPanning) this.endPan();
        else if (this.isRubberBanding) this.endRubberBand(false);
      },
    });
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
    this.panSession?.end();
    this.panSession = null;
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

    const nameNote = document.createElement("div");
    nameNote.className = "pn-context-menu-note";
    nameNote.append("name: ");
    const nameValue = document.createElement("strong");
    nameValue.textContent = node.name ?? "(unnamed)";
    nameNote.appendChild(nameValue);
    nameNote.append(`  (${fmtCells(node.x)}, ${fmtCells(node.y)})`);
    menu.appendChild(nameNote);

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

    const reference = REFERENCE_PATCHES[node.type];
    if (reference) {
      addItem(`Open ${reference.label}`, () => {
        this.onOpenReferencePatch?.(node.type);
      });
    }

    if ((node.type === "adc~" || node.type === "dac~") && this.audioGraph) {
      const detected = node.type === "adc~"
        ? this.audioGraph.getAdcNode(node.id)?.detectedChannelCount ?? 0
        : this.audioGraph.getMaxOutputChannels();

      const labelN = detected > 0 ? `${detected} ch` : "device not ready";
      addItem(`Rebuild ${node.type} from device (${labelN})`, () => {
        if (detected <= 0) return;
        this.rebuildAudioNodeFromDevice(node.id, detected);
      });
    }

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

  /**
   * Apply detected channel count to an adc~ / dac~ node: rewrite args,
   * regenerate ports, resize, prune now-out-of-range edges.
   */
  private rebuildAudioNodeFromDevice(nodeId: string, channels: number): void {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return;
    if (node.type !== "adc~" && node.type !== "dac~") return;

    const n = Math.max(1, Math.min(32, channels | 0));
    node.args[0] = String(n);

    const derived = node.type === "adc~" ? deriveAdcPorts(node.args) : deriveDacPorts(node.args);
    node.inlets  = derived.inlets;
    node.outlets = derived.outlets;
    node.width   = audioPortDefaultWidth(Math.max(node.inlets.length, node.outlets.length));

    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId === nodeId && edge.fromOutlet >= node.outlets.length) this.graph.removeEdge(edge.id);
      if (edge.toNodeId   === nodeId && edge.toInlet    >= node.inlets.length)  this.graph.removeEdge(edge.id);
    }

    this.graph.emit("change");
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private clearSelectionVisuals(): void {
    for (const id of this.selectedNodeIds) {
      this.canvasEl.querySelector(`[data-node-id="${id}"]`)?.classList.remove("patch-object--selected");
    }
  }

  private endPan(): void {
    this.isPanning = false;
    this.panSession?.end();
    this.panSession = null;
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
      x: Math.round((clientX - rect.left + this.canvasEl.scrollLeft - CANVAS_LEFT_GUTTER_PX) / z),
      y: Math.round((clientY - rect.top + this.canvasEl.scrollTop - CANVAS_TOP_GUTTER_PX) / z),
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
        const node = this.graph.addNode("mediaVideo*", x, y);
        this.onObjectPlaced?.("mediaVideo*", node.id);
        // VisualizerGraph.sync() runs synchronously on addNode's "change" event,
        // so the MediaVideoNode exists by the time we call loadFileForNode.
        this.vizGraph.loadFileForNode(node.id, "mediaVideo*", file);
      } else if (file.type.startsWith("image/")) {
        const node = this.graph.addNode("mediaImage*", x, y);
        this.onObjectPlaced?.("mediaImage*", node.id);
        this.vizGraph.loadFileForNode(node.id, "mediaImage*", file);
      }
    });
  }
}
