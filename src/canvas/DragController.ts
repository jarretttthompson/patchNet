import type { PatchGraph } from "../graph/PatchGraph";
import { checkOverlap, getNodeBox, type Box } from "./OverlapGuard";
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
  /** Last (x,y) at which the no-overlap guard accepted the move. Used to
   *  snap back when a frame would cause a collision. Updated only on
   *  successful frames; stays stuck when blocked. */
  lastValidX: number;
  lastValidY: number;
  /** True once the user has triggered a blocked-flash during this drag.
   *  Subsequent blocked frames are silent so the pulse plays once per
   *  drag rather than re-triggering on every contact event. Reset on
   *  the next drag start. */
  flashed: boolean;
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
    /** Called when a drag frame is blocked by no-overlap. Receives the
     *  obstacle node id and the primary moving node id so the host can
     *  flash visual feedback on both objects. */
    private readonly onBlocked?: (obstacleId: string, movingId: string) => void,
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
    if (target.tagName === "SELECT") return;
    if (target.tagName === "TEXTAREA") return;
    if (target.tagName === "BUTTON") return;
    if (target.closest(".pn-subpatch-lock")) return;
    if (target.closest(".pn-odo-col")) return;   // digit column — OIC handles drag
    if (target.closest(".patch-port")) return;
    if (target.closest(".pn-resize-handle")) return;
    if (target.closest(".pn-cable-svg")) return;
    if (target.closest(".patch-object-codebox-host")) return;
    if (target.closest(".cm-editor")) return;
    // Inline dmx panel: its tabs, forms, and scroll regions should never
    // initiate an object drag. The object can still be dragged by grabbing
    // its border or any area outside the panel host.
    if (target.closest(".pn-dmx-panel-host")) return;
    if (target.closest(".pn-mixer-panel-host")) return;
    // Local (gitignored) plugin bodies opt in by tagging their host with
    // [data-localplugin-host]. Inline INPUT/SELECT/BUTTON are already excluded
    // above; this catches clicks on the plugin's own interactive surface.
    if (target.closest("[data-localplugin-host]")) return;
    // youtube~ panel — interior is URL input + iframe + buttons. Buttons/
    // inputs are already excluded above; this catches clicks on the iframe
    // body (which we never want to convert into an object drag).
    if (target.closest(".pn-youtube-panel-host")) return;
    // Same treatment for the js~ inline code-pane + slider panel — BUT
    // only when the js~ is unlocked. Locked js~ objects drag from anywhere
    // on the body, with an explicit exception for sliders (which stay
    // interactive in both states).
    const jsEffectHost = target.closest<HTMLElement>(".pn-jseffect-panel-host");
    if (jsEffectHost) {
      // Sliders always stay interactive — never initiate drag over them.
      if (target.closest(".pn-jseffect-slider-range")) return;
      // Lock button itself always clicks, never drags.
      if (target.closest(".pn-jseffect-lock")) return;
      const lockedBody = jsEffectHost.closest<HTMLElement>('.patch-object-jseffect-body[data-locked="1"]');
      if (!lockedBody) return;  // unlocked → panel interactive (no drag)
      // locked → fall through to drag
    }
    const rvideoHost = target.closest<HTMLElement>(".pn-rvideo-panel-host");
    if (rvideoHost) {
      // Knobs always stay interactive.
      if (target.closest(".pn-rvideo-knob-range")) return;
      // Lock button always clicks, never drags.
      if (target.closest(".pn-rvideo-lock")) return;
      const lockedBody = rvideoHost.closest<HTMLElement>('.patch-object-rvideo-body[data-locked="1"]');
      if (!lockedBody) return;
      // locked → fall through to drag
    }
    // buffer~ transport buttons + waveform canvas: never start drag.
    if (target.closest(".pn-buf-btn")) return;
    if (target.closest(".pn-buf-wave")) return;
    // vbuf* transport buttons + timeline strip + preview video: same.
    if (target.closest(".pn-vbuf-btn")) return;
    if (target.closest(".pn-vbuf-strip")) return;
    if (target.closest(".pn-vbuf-preview")) return;
    if (target.closest(".patch-object-slider-track")) return;
    if (target.closest(".pn-ezscale__range")) return;
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
        flashed: false,
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

      document.addEventListener("mousemove", this.onMouseMove);
      document.addEventListener("mouseup", this.onMouseUp);
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
      flashed: false,
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
    const nx = Math.round(x);
    const ny = Math.round(y);

    // Move co-selected nodes by the same delta (intrinsic)
    const mouseX = (e.clientX - canvasRect.left) / z;
    const mouseY = (e.clientY - canvasRect.top)  / z;
    const dx = mouseX - this.drag.mouseStartX;
    const dy = mouseY - this.drag.mouseStartY;

    // No-overlap check: build the proposed boxes for primary + every co-mover
    // and run a single guard. If ANY member of the rigid group would collide
    // with a non-moving object, the entire group stays at its last valid spot.
    const movingIds = new Set<string>([this.drag.nodeId, ...this.coMovers.map(cm => cm.nodeId)]);
    const proposed = new Map<string, Box>();
    const primNode = this.graph.nodes.get(this.drag.nodeId);
    if (primNode) {
      const box = getNodeBox(primNode);
      proposed.set(this.drag.nodeId, { x: nx, y: ny, w: box.w, h: box.h });
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

    const el = this.drag.el;
    if (result.ok) {
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
      this.drag.lastValidX = nx;
      this.drag.lastValidY = ny;
      this.drag.moved = true;
      this.onMove?.(this.drag.nodeId, nx, ny);

      for (const cm of this.coMovers) {
        const cnx = Math.round(cm.startX + dx);
        const cny = Math.round(cm.startY + dy);
        cm.el.style.left = `${cnx}px`;
        cm.el.style.top = `${cny}px`;
        cm.lastValidX = cnx;
        cm.lastValidY = cny;
        this.onMove?.(cm.nodeId, cnx, cny);
      }
    } else {
      // Snap back to the last valid spot. Don't update lastValid; don't fire
      // onMove (graph state already reflects last valid via the prior frame).
      el.style.left = `${this.drag.lastValidX}px`;
      el.style.top = `${this.drag.lastValidY}px`;
      for (const cm of this.coMovers) {
        cm.el.style.left = `${cm.lastValidX}px`;
        cm.el.style.top = `${cm.lastValidY}px`;
      }
      if (result.obstacleId && !this.drag.flashed) {
        this.drag.flashed = true;
        this.onBlocked?.(result.obstacleId, this.drag.nodeId);
      }
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
