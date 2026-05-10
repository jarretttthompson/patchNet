import type { PatchGraph } from "../graph/PatchGraph";
import { CANVAS_HEIGHT_PX, CANVAS_WIDTH_PX, GRID_SUB_PX } from "./canvasSpace";
import { checkOverlap, getNodeBox, type Box } from "./OverlapGuard";
import { getSnap } from "./snapState";
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
  /** Last (x,y) at which the no-overlap guard accepted the position. The
   *  object follows the cursor freely during drag, but on mouseup it snaps
   *  back here if the release point would collide. Updated only on
   *  overlap-free frames. */
  lastValidX: number;
  lastValidY: number;
  /** Whether the most recent frame was overlap-free. Drives the
   *  drop-blocked visual state and the mouseup commit decision. */
  lastFrameValid: boolean;
  /** True once the user has triggered a blocked-flash during this drag.
   *  Subsequent blocked frames are silent so the pulse plays once per
   *  drag rather than re-triggering on every contact event. Reset on
   *  the next drag start. */
  flashed: boolean;
  /** Primary's intrinsic position at drag start. Used as the anchor for
   *  clamping the move delta against canvas bounds — independent of
   *  startX/startY (which mix mouse coords) and of lastValidX/Y (which
   *  evolve during the drag). */
  primStartX: number;
  primStartY: number;
}

interface CoMover {
  nodeId: string;
  el: HTMLElement;
  startX: number;
  startY: number;
  lastValidX: number;
  lastValidY: number;
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
  /** Set to true once we've warned about a re-entrant mousedown. The
   *  guard's job is rare-event recovery; if it fires repeatedly that
   *  signals a real bug elsewhere and we want it visible exactly once. */
  private reentrancyWarned = false;

  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;
  private readonly onWindowBlur: () => void;
  private readonly onEscapeKey: (e: KeyboardEvent) => void;

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
    /** Called when a drag frame is blocked by no-overlap. Receives the
     *  obstacle node id and the primary moving node id so the host can
     *  flash visual feedback on both objects. */
    private readonly onBlocked?: (obstacleId: string, movingId: string) => void,
  ) {
    this.onMouseDown = this.handleMouseDown.bind(this);
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseUp = this.handleMouseUp.bind(this);
    // If the window loses focus (e.g., user alt-tabs mid-drag, or releases
    // the mouse outside the browser window so the OS swallows mouseup),
    // commit-and-clean rather than leaving the object stuck to the cursor.
    this.onWindowBlur = () => {
      if (this.drag) this.commitAndEnd();
    };
    // Escape mid-drag: commit-and-end at the current position. Matches
    // window.blur semantics — both are recovery paths for "the user can't
    // release the mouse normally". We commit rather than revert because
    // the user's pressing Escape to break a stuck-cursor state, not to
    // undo a move they made on purpose.
    this.onEscapeKey = (e) => {
      if (e.key !== "Escape") return;
      if (this.drag) this.commitAndEnd();
    };

    this.canvasEl.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("keydown", this.onEscapeKey);
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  destroy(): void {
    this.canvasEl.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("keydown", this.onEscapeKey);
    this.endDrag();
  }

  // ── Handlers ──────────────────────────────────────────────────────

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;

    // Drag is initiated only from a perimeter move-handle. ObjectRenderer
    // appends seven invisible .pn-move-handle elements to every object
    // (top/bottom/left/right edges + TL/TR/BL corners — BR is reserved for
    // resize). Mousedown anywhere else on the object — body interior,
    // ports, panel hosts, interactive widgets — won't have .pn-move-handle
    // as an ancestor and is dropped here.
    const target = e.target as Element;
    const moveHandle = target.closest(".pn-move-handle");
    if (!moveHandle) return;

    // Defense-in-depth: ports (z-index 6) and the resize handle (z-index 5)
    // sit above move-handles (z-index 4) and should already win event.target
    // where they overlap. Keep these short-circuits so a future stacking
    // change can't silently turn a port click into a drag.
    if (target.closest(".patch-port")) return;
    if (target.closest(".pn-resize-handle")) return;

    const objectEl = target.closest<HTMLElement>(".patch-object");
    if (!objectEl?.dataset.nodeId) return;

    // Re-entrancy guard: if a prior drag's mouseup was missed (focus race,
    // synchronous DOM rebuild on emit("change"), browser quirk), this.drag
    // is still populated and the prior dragging-class is still on the prior
    // element. Commit-and-end the stale drag before allocating new state so
    // we don't stack drags or leak the visual stuck-to-cursor state. Warn
    // exactly once — if this fires routinely it's a real bug elsewhere.
    if (this.drag) {
      if (!this.reentrancyWarned) {
        console.warn("[DragController] re-entrant mousedown caught a stale drag; force-committing prior drag. If you see this, a mouseup was missed somewhere upstream.");
        this.reentrancyWarned = true;
      }
      this.commitAndEnd();
    }
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

      // Capture the cursor's offset within the SOURCE element BEFORE
      // duplicateNodes runs — the clones land cascaded by (+20, +20) so
      // the no-overlap rule holds, and we want the cursor to stay
      // anchored to the same logical pixel of the dragged clone.
      const sourceRect = objectEl.getBoundingClientRect();
      const cursorOffsetX = (e.clientX - sourceRect.left) / z;
      const cursorOffsetY = (e.clientY - sourceRect.top)  / z;

      // Clone — graph.emit("change") fires synchronously inside
      // duplicateNodes, so render() runs and new DOM elements exist
      // by the time duplicateNodes() returns.
      const idMap   = this.graph.duplicateNodes([...toDuplicate]);
      const newPrimId = idMap.get(primaryId);
      if (!newPrimId) return;

      // Notify CanvasController to update selection to the new clones
      this.onDuplicated?.(new Set(idMap.values()));

      // Redirect drag to the clone of the primary node
      const newEl = this.canvasEl.querySelector<HTMLElement>(`[data-node-id="${newPrimId}"]`);
      if (!newEl) return;

      const newPrimX = parseFloat(newEl.style.left || "0");
      const newPrimY = parseFloat(newEl.style.top || "0");
      this.drag = {
        nodeId: newPrimId,
        el: newEl,
        offsetX: cursorOffsetX,
        offsetY: cursorOffsetY,
        startX: mouseStartX - newPrimX,
        startY: mouseStartY - newPrimY,
        mouseStartX,
        mouseStartY,
        moved: false,
        lastValidX: newPrimX,
        lastValidY: newPrimY,
        lastFrameValid: true,
        flashed: false,
        primStartX: newPrimX,
        primStartY: newPrimY,
      };
      newEl.classList.add("patch-object--dragging");

      // Build co-movers from the other clones
      this.coMovers = [];
      for (const [oldId, newId] of idMap) {
        if (newId === newPrimId) continue;
        if (!toDuplicate.has(oldId)) continue;
        const coEl = this.canvasEl.querySelector<HTMLElement>(`[data-node-id="${newId}"]`);
        if (!coEl) continue;
        const cx = parseFloat(coEl.style.left || "0");
        const cy = parseFloat(coEl.style.top || "0");
        this.coMovers.push({
          nodeId: newId,
          el: coEl,
          startX: cx,
          startY: cy,
          lastValidX: cx,
          lastValidY: cy,
        });
        coEl.classList.add("patch-object--dragging");
      }

      window.addEventListener("mousemove", this.onMouseMove);
      window.addEventListener("mouseup", this.onMouseUp);
      return;
    }

    // ── Normal drag ────────────────────────────────────────────────────
    const rect = objectEl.getBoundingClientRect();
    const primX = parseFloat(objectEl.style.left || "0");
    const primY = parseFloat(objectEl.style.top  || "0");

    this.drag = {
      nodeId: primaryId,
      el: objectEl,
      offsetX: (e.clientX - rect.left) / z,
      offsetY: (e.clientY - rect.top)  / z,
      startX: (e.clientX - canvasRect.left) / z - primX,
      startY: (e.clientY - canvasRect.top)  / z - primY,
      mouseStartX,
      mouseStartY,
      moved: false,
      lastValidX: primX,
      lastValidY: primY,
      lastFrameValid: true,
      flashed: false,
      primStartX: primX,
      primStartY: primY,
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
        const cx = parseFloat(el.style.left || "0");
        const cy = parseFloat(el.style.top || "0");
        this.coMovers.push({
          nodeId: selId,
          el,
          startX: cx,
          startY: cy,
          lastValidX: cx,
          lastValidY: cy,
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
        const cx = parseFloat(el.style.left || "0");
        const cy = parseFloat(el.style.top || "0");
        this.coMovers.push({
          nodeId: node.id,
          el,
          startX: cx,
          startY: cy,
          lastValidX: cx,
          lastValidY: cy,
        });
        el.classList.add("patch-object--dragging");
        coveredIds.add(node.id);
      }
    }

    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.drag) return;

    const canvasRect = this.canvasEl.getBoundingClientRect();
    const z = getZoom();

    // Mouse delta in world coords from drag start.
    const mouseX = (e.clientX - canvasRect.left) / z;
    const mouseY = (e.clientY - canvasRect.top)  / z;
    const rawDx = mouseX - this.drag.mouseStartX;
    const rawDy = mouseY - this.drag.mouseStartY;

    // Clamp the delta so every moving node — primary plus co-movers — stays
    // fully inside the bounded canvas. Treats the drag as a rigid group:
    // the whole group stops at whichever member would cross an edge first.
    const primNode = this.graph.nodes.get(this.drag.nodeId);
    const primBox = primNode ? getNodeBox(primNode) : { x: 0, y: 0, w: 0, h: 0 };
    let minDx = -this.drag.primStartX;
    let maxDx = CANVAS_WIDTH_PX  - primBox.w - this.drag.primStartX;
    let minDy = -this.drag.primStartY;
    let maxDy = CANVAS_HEIGHT_PX - primBox.h - this.drag.primStartY;
    for (const cm of this.coMovers) {
      const cmNode = this.graph.nodes.get(cm.nodeId);
      if (!cmNode) continue;
      const box = getNodeBox(cmNode);
      minDx = Math.max(minDx, -cm.startX);
      maxDx = Math.min(maxDx, CANVAS_WIDTH_PX  - box.w - cm.startX);
      minDy = Math.max(minDy, -cm.startY);
      maxDy = Math.min(maxDy, CANVAS_HEIGHT_PX - box.h - cm.startY);
    }
    let dx = Math.max(minDx, Math.min(maxDx, rawDx));
    let dy = Math.max(minDy, Math.min(maxDy, rawDy));

    let nx = Math.round(this.drag.primStartX + dx);
    let ny = Math.round(this.drag.primStartY + dy);

    // Snap to grid: align the primary's top-left to the nearest grid cell,
    // then re-clamp to canvas bounds (the snap can push slightly past). The
    // co-mover delta is recomputed below from the snapped primary, so the
    // group stays rigid relative to the dragged anchor.
    if (getSnap()) {
      nx = Math.round(nx / GRID_SUB_PX) * GRID_SUB_PX;
      ny = Math.round(ny / GRID_SUB_PX) * GRID_SUB_PX;
      nx = Math.max(0, Math.min(CANVAS_WIDTH_PX  - primBox.w, nx));
      ny = Math.max(0, Math.min(CANVAS_HEIGHT_PX - primBox.h, ny));
      dx = nx - this.drag.primStartX;
      dy = ny - this.drag.primStartY;
    }

    // No-overlap check: build the proposed boxes for primary + every co-mover
    // and run a single guard. If ANY member of the rigid group would collide
    // with a non-moving object, the entire group stays at its last valid spot.
    const movingIds = new Set<string>([this.drag.nodeId, ...this.coMovers.map(cm => cm.nodeId)]);
    const proposed = new Map<string, Box>();
    if (primNode) {
      proposed.set(this.drag.nodeId, { x: nx, y: ny, w: primBox.w, h: primBox.h });
    }
    for (const cm of this.coMovers) {
      const cmNode = this.graph.nodes.get(cm.nodeId);
      if (!cmNode) continue;
      const box = getNodeBox(cmNode);
      proposed.set(cm.nodeId, {
        x: Math.round(cm.startX + dx),
        y: Math.round(cm.startY + dy),
        w: box.w,
        h: box.h,
      });
    }
    const result = checkOverlap(this.graph, movingIds, proposed);

    // Follow the cursor freely — even when the proposed position would
    // overlap another object. The no-overlap rule is enforced on drop, not
    // mid-drag, so the user can route an object across a busy patch without
    // getting stuck against intermediate obstacles.
    const el = this.drag.el;
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
    this.drag.moved = true;
    this.onMove?.(this.drag.nodeId, nx, ny);

    for (const cm of this.coMovers) {
      const cnx = Math.round(cm.startX + dx);
      const cny = Math.round(cm.startY + dy);
      cm.el.style.left = `${cnx}px`;
      cm.el.style.top = `${cny}px`;
      this.onMove?.(cm.nodeId, cnx, cny);
    }

    if (result.ok) {
      this.drag.lastValidX = nx;
      this.drag.lastValidY = ny;
      this.drag.lastFrameValid = true;
      el.classList.remove("patch-object--drop-blocked");
      for (const cm of this.coMovers) {
        cm.lastValidX = Math.round(cm.startX + dx);
        cm.lastValidY = Math.round(cm.startY + dy);
        cm.el.classList.remove("patch-object--drop-blocked");
      }
    } else {
      this.drag.lastFrameValid = false;
      el.classList.add("patch-object--drop-blocked");
      for (const cm of this.coMovers) {
        cm.el.classList.add("patch-object--drop-blocked");
      }
      if (result.obstacleId && !this.drag.flashed) {
        this.drag.flashed = true;
        this.onBlocked?.(result.obstacleId, this.drag.nodeId);
      }
    }
  }

  private handleMouseUp(_e: MouseEvent): void {
    if (!this.drag) return;
    // Don't gate on `e.button !== 0`: a stuck drag is much worse than ending
    // one early on a stray middle/right release. The drag-start path is still
    // gated on button 0, so the only events reaching here mid-drag are real
    // releases. Always commit-and-end.
    this.commitAndEnd();
  }

  /**
   * Commit the in-flight drag's final position to the graph and tear down
   * drag state. Used by `handleMouseUp` (normal release) and `onWindowBlur`
   * (recovery when the window loses focus mid-drag, so the OS may have
   * swallowed mouseup). Safe to call when `this.drag` is null (no-op).
   *
   * Order matters: classes are cleared on the live DOM elements BEFORE
   * `setNodePosition` runs, because `setNodePosition` may synchronously
   * `emit("change")` and rebuild the DOM, which would orphan the
   * dragged element and leave its `--dragging`/`--drop-blocked` classes
   * stuck on a detached node.
   */
  private commitAndEnd(): void {
    if (!this.drag) return;
    const { nodeId, el, moved, lastFrameValid, lastValidX, lastValidY } = this.drag;

    if (moved) {
      // If the release point would collide, snap back to the last overlap-free
      // position observed during this drag. Free movement mid-drag lets the
      // user route across busy patches; the no-overlap rule is enforced here.
      if (!lastFrameValid) {
        el.style.left = `${lastValidX}px`;
        el.style.top = `${lastValidY}px`;
        this.onMove?.(nodeId, lastValidX, lastValidY);
        for (const cm of this.coMovers) {
          cm.el.style.left = `${cm.lastValidX}px`;
          cm.el.style.top = `${cm.lastValidY}px`;
          this.onMove?.(cm.nodeId, cm.lastValidX, cm.lastValidY);
        }
      }

      // Clear classes on the live DOM before the commit can rebuild it.
      this.clearDragClasses();

      const x = parseFloat(el.style.left || "0");
      const y = parseFloat(el.style.top || "0");
      this.graph.setNodePosition(nodeId, x, y);

      for (const cm of this.coMovers) {
        const nx = parseFloat(cm.el.style.left || "0");
        const ny = parseFloat(cm.el.style.top || "0");
        this.graph.setNodePosition(cm.nodeId, nx, ny);
      }
    } else {
      // No commit needed (no movement), but classes still need clearing.
      this.clearDragClasses();
    }

    this.clearDragState();
    this.onDragEnd?.(nodeId);
  }

  /**
   * Remove `patch-object--dragging` and `patch-object--drop-blocked` from
   * the primary dragged element and any co-movers. Idempotent — safe to
   * call when `this.drag` is null. Does not touch `this.drag`/`coMovers`
   * arrays or window listeners (see `clearDragState` for that).
   */
  private clearDragClasses(): void {
    if (this.drag) {
      this.drag.el.classList.remove("patch-object--dragging");
      this.drag.el.classList.remove("patch-object--drop-blocked");
    }
    for (const cm of this.coMovers) {
      cm.el.classList.remove("patch-object--dragging");
      cm.el.classList.remove("patch-object--drop-blocked");
    }
  }

  /**
   * Null out drag state and detach window listeners. Idempotent.
   */
  private clearDragState(): void {
    this.drag = null;
    this.coMovers = [];
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  }

  /**
   * Tear down everything — used by `destroy()`. Always clears the
   * `patch-object--dragging` class even when no movement happened, so a
   * mousedown-without-drag-then-destroy doesn't leak the class onto an
   * unmoved object.
   */
  private endDrag(): void {
    this.clearDragClasses();
    this.clearDragState();
  }
}
