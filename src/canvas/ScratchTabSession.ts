/**
 * Top-level scratch patch in its own tab. Independent graph, undo, and canvas.
 * Registered with patchSessionRegistry so global send/receive and AudioGraph
 * see its nodes alongside main and any subpatches.
 *
 * Distinct from SubPatchSession:
 *   - no parent-node ties (no presentation panel, no inlet/outlet routing)
 *   - lives at top level (panGroup is a sibling of main's panGroup)
 *   - has its own UndoManager
 */

import { PatchGraph } from "../graph/PatchGraph";
import { CableRenderer } from "./CableRenderer";
import { CableDrawController } from "./CableDrawController";
import { CanvasController } from "./CanvasController";
import { DragController } from "./DragController";
import { ResizeController } from "./ResizeController";
import { ObjectInteractionController } from "./ObjectInteractionController";
import { UndoManager } from "../graph/UndoManager";
import { VisualizerGraph } from "../runtime/VisualizerGraph";
import { renderObject, autoFitInlineArgsWidth } from "./ObjectRenderer";
import { CANVAS_LEFT_GUTTER_PX, CANVAS_TOP_GUTTER_PX } from "./canvasSpace";
import { registerSession, unregisterSession } from "./patchSessionRegistry";

export class ScratchTabSession {
  readonly id: string;
  readonly graph: PatchGraph;
  readonly panGroup: HTMLElement;
  readonly canvasController: CanvasController;
  readonly interaction: ObjectInteractionController;
  readonly vizGraph: VisualizerGraph;
  readonly undo: UndoManager;
  private readonly cables: CableRenderer;

  constructor(id: string, canvasArea: HTMLElement, initialContent: string = "") {
    this.id = id;
    this.graph = new PatchGraph();

    this.panGroup = document.createElement("div");
    this.panGroup.className = "pn-pan-group pn-scratch-pan";
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

    this.undo = new UndoManager(this.graph);
    this.canvasController.setUndoManager(this.undo);

    this.vizGraph = new VisualizerGraph(this.graph);
    this.interaction.setVisualizerGraph(this.vizGraph);
    this.vizGraph.setObjectInteraction(this.interaction);

    this.graph.on("change", () => this.render());

    if (initialContent) {
      try { this.graph.deserialize(initialContent); } catch {}
    }

    registerSession({ id, graph: this.graph, oic: this.interaction });

    this.render();
  }

  render(): void {
    this.panGroup.querySelectorAll<HTMLElement>(":scope > .patch-object").forEach(el => el.remove());
    for (const node of this.graph.getNodes()) {
      this.panGroup.appendChild(renderObject(node));
    }
    this.panGroup.querySelectorAll<HTMLElement>(":scope > .patch-object").forEach(autoFitInlineArgsWidth);
    this.cables.render();
    this.canvasController.updatePanGroupSize();
  }

  serialize(): string {
    return this.graph.serialize();
  }

  destroy(): void {
    unregisterSession(this.id);
    this.vizGraph.destroy();
    this.interaction.destroy();
    this.canvasController.destroy();
    this.panGroup.remove();
  }
}
