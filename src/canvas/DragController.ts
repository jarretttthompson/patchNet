import type { PatchGraph } from "../graph/PatchGraph";
import { getZoom } from "./zoomState";

interface DragState {
  nodeId: string;
  el: HTMLElement;
  /** Offset from object top-left to the mousedown point */
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  /** Mouse canvas coords at drag start — used to compute delta for co-movers */
  mouseStartX: number;
  mouseStartY: number;
  moved: boolean;
}

interface CoMover {
  nodeId: string;
  el: HTMLElement;
  startX: number;
  startY: number;
}

/**
 * Handles dragging objects on the canvas to reposition them.
 *
 * During drag:
 *   - Object position is updated directly in the DOM (no re-render)
 *   - graph.setNodePosition() is called only on mouseup to commit
 *
 * This avoids triggering graph "change" events mid-drag, which would
 * destroy and recreate the dragged element.
 */
export class DragController {
  private drag: DragState | null = null;
  private coMovers: CoMover[] = [];

  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;

  constructor(
    private readonly canvasEl: HTMLElement,
    private readonly graph: PatchGraph,
    /** Optional callback fired on mouseup after position committed */
    private readonly onDragEnd?: (nodeId: string) => void,
    /** Optional callback fired on every mousemove during drag */
    private readonly onMove?: (nodeId: string, x: number, y: number) => void,
    /** Returns the full set of selected node IDs for multi-drag */
    private readonly getSelection?: () => Set<string>,
    /** Called immediately after Cmd+drag clones nodes, with the new ID set */
    private readonly onDuplicated?: (newIds: Set<string>) => void,
  ) {
    this.onMouseDown = this.handleMouseDown.bind(this);
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseUp = this.handleMouseUp.bind(this);

    this.canvasEl.addEventListener("mousedown", this.onMouseDown);
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  destroy(): void {
    this.canvasEl.removeEventListener("mousedown", this.onMouseDown);
    this.endDrag();
  }

  // ── Handlers ──────────────────────────────────────────────────────

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;

    // Only drag the object body — not port nubs, resize handle, cable SVG,
    // native inputs (attribute sliders / text fields), the custom slider track,
    // or any bounded click-to-trigger widget inside a body (bang circle,
    // toggle rocker, message content). Those match the cursor-system design
    // where grab = move and pointer = click: hovering a pointer-cursor region
    // must never start a move.
    const target = e.target as Element;
    if (target.tagName === "INPUT") return;
    if (target.closest(".pn-subpatch-lock")) return;
    if (target.closest(".pn-odo-col")) return;   // digit column — OIC handles drag
    if (target.closest(".patch-port")) return;
    if (target.closest(".pn-resize-handle")) return;
    if (target.closest(".pn-cable-svg")) return;
    if (target.closest(".patch-object-codebox-host")) return;
    if (target.closest(".cm-editor")) return;
    if (target.closest(".patch-object-slider-track")) return;
    if (target.closest(".patch-object-face-button")) return;
    if (target.closest(".patch-object-toggle-rocker")) return;
    if (target.closest(".patch-object-message-content")) return;
    // Sequencer cells: only block drag when the cell is editable (unlocked).
    // Locked cells fall through to drag so the object can be moved from the grid.
    const seqCell = target.closest<HTMLElement>(".pn-seq-cell");
    if (seqCell?.isContentEditable) return;

    const objectEl = target.closest<HTMLElement>(".patch-object");
    if (!objectEl?.dataset.nodeId) return;
    // Don't drag objects rendered inside a subPatch presentation panel
    if (objectEl.closest(".pn-subpatch-panel")) return;

    e.preventDefault();

    const canvasRect  = this.canvasEl.getBoundingClientRect();
    const z = getZoom();
    const mouseStartX = (e.clientX - canvasRect.left) / z;
    const mouseStartY = (e.clientY - canvasRect.top)  / z;
    const primaryId   = objectEl.dataset.nodeId;

    // ── Cmd+drag: duplicate then drag the clones ──────────────────────
    if (e.metaKey) {
      // Collect the full set to duplicate (primary + any co-selected nodes)
      const selected = this.getSelection?.() ?? new Set<string>();
      const toDuplicate = new Set<string>([primaryId]);
      if (selected.has(primaryId)) {
        for (const id of selected) toDuplicate.add(id);
      }

      // Clone at the same position. graph.emit("change") fires synchronously
      // inside duplicateNodes, so render() runs and new DOM elements exist
      // by the time duplicateNodes() returns.
      const idMap   = this.graph.duplicateNodes([...toDuplicate]);
      const newPrimId = idMap.get(primaryId);
      if (!newPrimId) return;

      // Notify CanvasController to update selection to the new clones
      this.onDuplicated?.(new Set(idMap.values()));

      // Redirect drag to the clone of the primary node
      const newEl = this.canvasEl.querySelector<HTMLElement>(`[data-node-id="${newPrimId}"]`);
      if (!newEl) return;

      const newRect = newEl.getBoundingClientRect();
      this.drag = {
        nodeId: newPrimId,
        el: newEl,
        offsetX: (e.clientX - newRect.left) / z,
        offsetY: (e.clientY - newRect.top)  / z,
        startX: mouseStartX - parseFloat(newEl.style.left || "0"),
        startY: mouseStartY - parseFloat(newEl.style.top || "0"),
        mouseStartX,
        mouseStartY,
        moved: false,
      };
      newEl.classList.add("patch-object--dragging");

      // Build co-movers from the other clones
      this.coMovers = [];
      for (const [oldId, newId] of idMap) {
        if (newId === newPrimId) continue;
        if (!toDuplicate.has(oldId)) continue;
        const coEl = this.canvasEl.querySelector<HTMLElement>(`[data-node-id="${newId}"]`);
        if (!coEl) continue;
        this.coMovers.push({
          nodeId: newId,
          el: coEl,
          startX: parseFloat(coEl.style.left || "0"),
          startY: parseFloat(coEl.style.top || "0"),
        });
        coEl.classList.add("patch-object--dragging");
      }

      document.addEventListener("mousemove", this.onMouseMove);
      document.addEventListener("mouseup", this.onMouseUp);
      return;
    }

    // ── Normal drag ────────────────────────────────────────────────────
    const rect = objectEl.getBoundingClientRect();

    this.drag = {
      nodeId: primaryId,
      el: objectEl,
      offsetX: (e.clientX - rect.left) / z,
      offsetY: (e.clientY - rect.top)  / z,
      startX: (e.clientX - canvasRect.left) / z - parseFloat(objectEl.style.left || "0"),
      startY: (e.clientY - canvasRect.top)  / z - parseFloat(objectEl.style.top  || "0"),
      mouseStartX,
      mouseStartY,
      moved: false,
    };

    objectEl.classList.add("patch-object--dragging");

    // Collect co-movers: selected peers + group siblings
    this.coMovers = [];
    const coveredIds = new Set<string>([primaryId]);

    // 1. Selection-based co-movers
    const selected = this.getSelection?.() ?? new Set<string>();
    if (selected.has(primaryId)) {
      for (const selId of selected) {
        if (selId === primaryId) continue;
        const el = this.canvasEl.querySelector<HTMLElement>(`[data-node-id="${selId}"]`);
        if (!el) continue;
        this.coMovers.push({
          nodeId: selId,
          el,
          startX: parseFloat(el.style.left || "0"),
          startY: parseFloat(el.style.top || "0"),
        });
        el.classList.add("patch-object--dragging");
        coveredIds.add(selId);
      }
    }

    // 2. Group siblings — always move with the group regardless of selection
    const primaryNode = this.graph.nodes.get(primaryId);
    if (primaryNode?.groupId) {
      for (const node of this.graph.getNodes()) {
        if (node.groupId !== primaryNode.groupId || coveredIds.has(node.id)) continue;
        const el = this.canvasEl.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
        if (!el) continue;
        this.coMovers.push({
          nodeId: node.id,
          el,
          startX: parseFloat(el.style.left || "0"),
          startY: parseFloat(el.style.top || "0"),
        });
        el.classList.add("patch-object--dragging");
        coveredIds.add(node.id);
      }
    }

    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.drag) return;

    const canvasRect = this.canvasEl.getBoundingClientRect();
    const z = getZoom();
    const x = (e.clientX - canvasRect.left) / z - this.drag.offsetX;
    const y = (e.clientY - canvasRect.top)  / z - this.drag.offsetY;

    // No clamp: the pan-group sits inside a left/top gutter, and negative
    // intrinsic coords render inside that gutter. The caller grows the
    // pan-group live during drag via updatePanGroupSize() so the scrollable
    // area expands as the object moves outward.
    const el = this.drag.el;
    const nx = Math.round(x);
    const ny = Math.round(y);

    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
    this.drag.moved = true;

    this.onMove?.(this.drag.nodeId, nx, ny);

    // Move co-selected nodes by the same delta (intrinsic)
    const mouseX = (e.clientX - canvasRect.left) / z;
    const mouseY = (e.clientY - canvasRect.top)  / z;
    const dx = mouseX - this.drag.mouseStartX;
    const dy = mouseY - this.drag.mouseStartY;

    for (const cm of this.coMovers) {
      const nx = Math.round(cm.startX + dx);
      const ny = Math.round(cm.startY + dy);
      cm.el.style.left = `${nx}px`;
      cm.el.style.top = `${ny}px`;
      this.onMove?.(cm.nodeId, nx, ny);
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (!this.drag) return;
    if (e.button !== 0) return;

    const { nodeId, el, moved } = this.drag;

    if (moved) {
      const x = parseFloat(el.style.left || "0");
      const y = parseFloat(el.style.top || "0");
      this.graph.setNodePosition(nodeId, x, y);

      for (const cm of this.coMovers) {
        const nx = parseFloat(cm.el.style.left || "0");
        const ny = parseFloat(cm.el.style.top || "0");
        this.graph.setNodePosition(cm.nodeId, nx, ny);
      }
    }

    this.endDrag();
    this.onDragEnd?.(nodeId);
  }

  /**
   * Tear down drag state. Always clears the `patch-object--dragging` class —
   * previously only cleared it when the object had actually moved, which
   * leaked the class onto any object the user clicked without dragging, and
   * locked that object's cursor into `grabbing` until the next real drag.
   */
  private endDrag(): void {
    if (this.drag) {
      this.drag.el.classList.remove("patch-object--dragging");
      this.drag = null;
    }
    for (const cm of this.coMovers) {
      cm.el.classList.remove("patch-object--dragging");
    }
    this.coMovers = [];
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
  }
}
