import { PatchGraph } from "../graph/PatchGraph";
import { CableRenderer } from "./CableRenderer";
import { ObjectInteractionController } from "./ObjectInteractionController";
import { CanvasController } from "./CanvasController";
import { DragController } from "./DragController";
import { CableDrawController } from "./CableDrawController";
import { ResizeController } from "./ResizeController";
import { UndoManager } from "../graph/UndoManager";
import { renderObject } from "./ObjectRenderer";
import { getObjectDef } from "../graph/objectDefs";
import { VisualizerGraph } from "../runtime/VisualizerGraph";
import { CANVAS_LEFT_GUTTER_PX, CANVAS_TOP_GUTTER_PX } from "./canvasSpace";

const PANEL_GUI_TYPES = new Set(["button", "toggle", "slider", "message", "integer", "float", "attribute"]);

export class SubPatchSession {
  readonly nodeId: string;
  readonly graph: PatchGraph;
  readonly panGroup: HTMLElement;
  readonly canvasController: CanvasController;
  readonly interaction: ObjectInteractionController;
  readonly vizGraph: VisualizerGraph;
  /** Live GUI panel — mounted into the subPatch box body on the main canvas. */
  readonly presentationEl: HTMLDivElement;
  /** true = interact mode (GUI works, drag blocked); false = edit mode (drag works, GUI blocked). */
  private locked = true;
  private readonly cables: CableRenderer;

  onPortsChanged?: (inlets: number, outlets: number, content: string, panelW: number, panelH: number) => void;
  onOutletFire?: (outletIndex: number, value: string | null) => void;

  constructor(nodeId: string, canvasArea: HTMLElement, initialContent: string) {
    this.nodeId = nodeId;
    this.graph = new PatchGraph();

    this.presentationEl = document.createElement("div");
    this.presentationEl.className = "pn-subpatch-panel";

    this.panGroup = document.createElement("div");
    this.panGroup.className = "pn-pan-group pn-subpatch-pan";
    this.panGroup.style.cssText = `left:${CANVAS_LEFT_GUTTER_PX}px;top:${CANVAS_TOP_GUTTER_PX}px;display:none;`;
    canvasArea.appendChild(this.panGroup);

    this.cables = new CableRenderer(this.panGroup, this.graph);
    this.interaction = new ObjectInteractionController(this.panGroup, this.graph);

    this.canvasController = new CanvasController(canvasArea, this.graph);
    this.canvasController.setPanGroup(this.panGroup);
    this.canvasController.setCableRenderer(this.cables);
    this.canvasController.setActive(false);

    const cableDraw = new CableDrawController(this.panGroup, this.graph, this.cables);
    this.canvasController.setCableDrawController(cableDraw);

    new DragController(
      this.panGroup, this.graph, undefined,
      (nid, x, y) => {
        const n = this.graph.nodes.get(nid);
        if (n) { n.x = x; n.y = y; }
        this.cables.render();
      },
      () => this.canvasController.getSelectedNodeIds(),
      (newIds) => this.canvasController.selectNodes(newIds),
    );

    new ResizeController(this.panGroup, this.graph, (nid, w, h) => {
      const n = this.graph.nodes.get(nid);
      if (n) { n.width = w; n.height = h; }
      this.cables.render();
    });

    const undo = new UndoManager(this.graph);
    this.canvasController.setUndoManager(undo);

    this.interaction.setOutletCallback((idx, value) => {
      this.onOutletFire?.(idx, value);
    });

    this.setupPanelDrag();
    // Route clicks/mousedown on the presentation panel through the session OIC
    // so GUI objects (toggle, button, slider, etc.) respond in interact mode.
    // setupPanelDrag's stopImmediatePropagation blocks these in edit mode.
    this.interaction.addInteractionPanel(this.presentationEl);

    // Deserialize after all controllers are ready
    if (initialContent) {
      try { this.graph.deserialize(initialContent); } catch {}
    }

    // Per-session VisualizerGraph so a visualizer/layer/media* placed inside
    // the subpatch gets real runtime nodes and routes messages back through
    // this session's OIC. VisualizerRuntime is a singleton, so named contexts
    // remain visible across parent and nested sessions.
    this.vizGraph = new VisualizerGraph(this.graph);
    this.interaction.setVisualizerGraph(this.vizGraph);
    this.vizGraph.setObjectInteraction(this.interaction);

    this.graph.on("change", () => {
      this.render();
      this.syncPorts();
    });

    this.render();
  }

  render(): void {
    this.panGroup.querySelectorAll<HTMLElement>(":scope > .patch-object").forEach(el => el.remove());
    for (const node of this.graph.getNodes()) {
      this.panGroup.appendChild(renderObject(node));
    }
    this.cables.render();
    this.canvasController.updatePanGroupSize();
    this.renderPresentation();
  }

  renderPresentation(): void {
    this.presentationEl.innerHTML = "";
    const guiNodes = this.graph.getNodes().filter(n => PANEL_GUI_TYPES.has(n.type));

    let autoY = 8;
    for (const node of guiNodes) {
      const def = getObjectDef(node.type);
      // Panel position is independent from editor position.
      // Use stored panelX/Y if available; otherwise stack vertically from top-left.
      const px = node.panelX ?? 8;
      const py = node.panelY !== undefined ? node.panelY : autoY;
      const pw = node.panelW ?? (node.width ?? def.defaultWidth);
      const ph = node.panelH ?? (node.height ?? def.defaultHeight);

      if (node.panelY === undefined) autoY += ph + 8;

      const el = renderObject(node);
      // Override position/size to use panel coords, not editor coords
      el.style.left   = `${px}px`;
      el.style.top    = `${py}px`;
      el.style.width  = `${pw}px`;
      el.style.height = `${ph}px`;
      // Always strip ports — not patchable from the panel.
      // Resize handle is kept only in edit (unlocked) mode.
      // Covers top/bottom port containers AND side nubs, which live as direct
      // children of .patch-object outside any port container.
      el.querySelectorAll(".patch-object-ports, .patch-port-side-left, .patch-port-side-right").forEach(e => e.remove());
      if (this.locked) el.querySelector(".pn-resize-handle")?.remove();
      this.presentationEl.appendChild(el);
    }

    if (guiNodes.length === 0) {
      const nodes = this.graph.getNodes();
      const ic = nodes.filter(n => n.type === "inlet").length;
      const oc = nodes.filter(n => n.type === "outlet").length;
      const hint = document.createElement("div");
      hint.className = "pn-subpatch-panel-hint";
      const name = document.createElement("span");
      name.className = "pn-subpatch-hint-name";
      name.textContent = "subPatch";
      const sub = document.createElement("span");
      sub.className = "pn-subpatch-hint-sub";
      sub.textContent = `${ic} in · ${oc} out · dbl-click to edit`;
      hint.appendChild(name);
      hint.appendChild(sub);
      this.presentationEl.appendChild(hint);
    }
  }

  deliverToInlet(inletIndex: number, value: string | null): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "inlet") continue;
      if (parseInt(node.args[0] ?? "0", 10) !== inletIndex) continue;
      for (const edge of this.graph.getEdges()) {
        if (edge.fromNodeId !== node.id || edge.fromOutlet !== 0) continue;
        const target = this.graph.nodes.get(edge.toNodeId);
        if (!target) continue;
        if (value === null) this.interaction.deliverBang(target, edge.toInlet);
        else this.interaction.deliverMessageValue(target, edge.toInlet, value);
      }
    }
  }

  syncPorts(): void {
    const nodes = this.graph.getNodes();
    const inletIdxs  = nodes.filter(n => n.type === "inlet").map(n => parseInt(n.args[0] ?? "0", 10)).filter(i => !isNaN(i));
    const outletIdxs = nodes.filter(n => n.type === "outlet").map(n => parseInt(n.args[0] ?? "0", 10)).filter(i => !isNaN(i));
    const ic = inletIdxs.length  > 0 ? Math.max(...inletIdxs)  + 1 : 0;
    const oc = outletIdxs.length > 0 ? Math.max(...outletIdxs) + 1 : 0;
    const content = btoa(unescape(encodeURIComponent(this.graph.serialize())));

    // Bounding box uses panel positions (independent of editor positions)
    let autoY = 8;
    let panelW = 0, panelH = 0;
    for (const node of nodes) {
      if (!PANEL_GUI_TYPES.has(node.type)) continue;
      const def = getObjectDef(node.type);
      const px = node.panelX ?? 8;
      const py = node.panelY !== undefined ? node.panelY : autoY;
      const pw = node.panelW ?? (node.width ?? def.defaultWidth);
      const ph = node.panelH ?? (node.height ?? def.defaultHeight);
      if (node.panelY === undefined) autoY += ph + 8;
      panelW = Math.max(panelW, px + pw);
      panelH = Math.max(panelH, py + ph);
    }

    this.onPortsChanged?.(ic, oc, content, panelW, panelH);
  }

  /**
   * Lock = interact mode: GUI events (click/drag on sliders, buttons, etc.) work normally.
   * Unlock = edit mode: plain drag repositions objects in the panel; GUI events are blocked.
   */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.presentationEl.dataset.locked = locked ? "1" : "0";
  }

  /**
   * In unlocked/edit mode: plain drag repositions, drag-from-resize-handle scales.
   * stopImmediatePropagation blocks the session OIC so GUI interactions don't fire.
   * In locked/interact mode every handler returns early, letting the OIC take over.
   */
  private setupPanelDrag(): void {
    const DRAG_THRESHOLD = 4;
    const MIN_SIZE = 24;

    type DragState = {
      mode: "move" | "resize";
      nodeId: string;
      el: HTMLElement;
      startMouseX: number;
      startMouseY: number;
      startPanelX: number;
      startPanelY: number;
      startW: number;
      startH: number;
      moved: boolean;
    };

    let state: DragState | null = null;

    const onMouseMove = (e: MouseEvent) => {
      if (!state) return;
      const dx = e.clientX - state.startMouseX;
      const dy = e.clientY - state.startMouseY;
      if (!state.moved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      state.moved = true;

      const node = this.graph.nodes.get(state.nodeId);
      if (!node) return;

      if (state.mode === "move") {
        const newX = Math.max(0, Math.round(state.startPanelX + dx));
        const newY = Math.max(0, Math.round(state.startPanelY + dy));
        state.el.style.left = `${newX}px`;
        state.el.style.top  = `${newY}px`;
        node.panelX = newX;
        node.panelY = newY;
      } else {
        const newW = Math.max(MIN_SIZE, Math.round(state.startW + dx));
        const newH = Math.max(MIN_SIZE, Math.round(state.startH + dy));
        state.el.style.width  = `${newW}px`;
        state.el.style.height = `${newH}px`;
        node.panelW = newW;
        node.panelH = newH;
      }
    };

    const onMouseUp = () => {
      if (state?.moved) this.syncPorts();
      state = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup",   onMouseUp);
    };

    this.presentationEl.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0 || this.locked) return;
      const target = e.target as Element;
      const objectEl = target.closest<HTMLElement>(".patch-object");
      if (!objectEl) return;
      const nodeId = objectEl.dataset.nodeId;
      if (!nodeId || !this.graph.nodes.has(nodeId)) return;
      const node = this.graph.nodes.get(nodeId)!;

      e.preventDefault();
      e.stopImmediatePropagation();

      const isResize = !!target.closest(".pn-resize-handle");
      const def = getObjectDef(node.type);
      state = {
        mode: isResize ? "resize" : "move",
        nodeId,
        el: objectEl,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startPanelX: node.panelX ?? 8,
        startPanelY: node.panelY ?? 8,
        startW: node.panelW ?? (node.width ?? def.defaultWidth),
        startH: node.panelH ?? (node.height ?? def.defaultHeight),
        moved: false,
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup",   onMouseUp);
    });

    this.presentationEl.addEventListener("click", (e: MouseEvent) => {
      if (!this.locked) e.stopImmediatePropagation();
    });

    this.presentationEl.addEventListener("dblclick", (e: MouseEvent) => {
      if (!this.locked) e.stopImmediatePropagation();
    });
  }

  destroy(): void {
    this.vizGraph.destroy();
    this.interaction.destroy();
    this.canvasController.destroy();
    this.panGroup.remove();
  }
}
