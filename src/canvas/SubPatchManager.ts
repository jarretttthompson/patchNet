import type { PatchGraph } from "../graph/PatchGraph";
import type { ObjectInteractionController } from "./ObjectInteractionController";
import type { PortType } from "../graph/PatchNode";
import { SubPatchSession } from "./SubPatchSession";

export class SubPatchManager {
  private sessions = new Map<string, SubPatchSession>();

  constructor(
    private readonly parentGraph: PatchGraph,
    private readonly parentInteraction: ObjectInteractionController,
    private readonly canvasArea: HTMLElement,
    private readonly onTabOpen: (nodeId: string, label: string, session: SubPatchSession) => void,
  ) {
    // Clean up sessions for removed nodes
    this.parentGraph.on("change", () => {
      const activeIds = new Set(
        this.parentGraph.getNodes().filter(n => n.type === "subPatch").map(n => n.id)
      );
      for (const id of [...this.sessions.keys()]) {
        if (!activeIds.has(id)) {
          this.sessions.get(id)!.destroy();
          this.sessions.delete(id);
        }
      }
    });
  }

  open(nodeId: string): void {
    const session = this.getOrCreate(nodeId);
    const pn = this.parentGraph.nodes.get(nodeId);
    const label = `p ${pn?.args[0] || nodeId.slice(0, 6)}`;
    this.onTabOpen(nodeId, label, session);
  }

  deliver(nodeId: string, inletIndex: number, value: string | null): void {
    this.getOrCreate(nodeId).deliverToInlet(inletIndex, value);
  }

  /**
   * After every main canvas render, re-mount each session's presentationEl into
   * the freshly-created panel mount div inside the subPatch box DOM element.
   * Also eagerly creates sessions for subPatch nodes that haven't been opened yet
   * so their panels are visible immediately.
   */
  mountPresentationPanels(panGroup: HTMLElement): void {
    for (const node of this.parentGraph.getNodes()) {
      if (node.type !== "subPatch") continue;
      const session = this.getOrCreate(node.id);
      const mount = panGroup.querySelector<HTMLElement>(`[data-panel-for="${node.id}"]`);
      if (!mount) continue;
      mount.appendChild(session.presentationEl);
      session.setLocked((node.args[3] ?? "1") !== "0");
      session.renderPresentation();
    }
  }

  private getOrCreate(nodeId: string): SubPatchSession {
    const existing = this.sessions.get(nodeId);
    if (existing) return existing;

    const pn = this.parentGraph.nodes.get(nodeId);
    const encoded = pn?.args[2] ?? "";
    let initialContent = "";
    if (encoded) {
      try { initialContent = decodeURIComponent(escape(atob(encoded))); } catch {}
    }

    const session = new SubPatchSession(nodeId, this.canvasArea, initialContent);

    session.onPortsChanged = (inlets, outlets, content, panelW, panelH) => {
      const node = this.parentGraph.nodes.get(nodeId);
      if (!node) return;
      node.args[0] = String(inlets);
      node.args[1] = String(outlets);
      node.args[2] = content;
      node.inlets  = Array.from({length: inlets},  (_, i) => ({ index: i, type: "any" as PortType, label: `inlet ${i}` }));
      node.outlets = Array.from({length: outlets}, (_, i) => ({ index: i, type: "any" as PortType, label: `outlet ${i}` }));

      // Auto-grow the subPatch box to fit panel content (only expands, never shrinks).
      if (panelW > 0 || panelH > 0) {
        const pad = 12;
        node.width  = Math.max(node.width  ?? 120, panelW + pad);
        node.height = Math.max(node.height ?? 40,  panelH + pad);
      }

      this.parentGraph.emit("change");
    };

    session.onOutletFire = (outletIndex, value) => {
      for (const edge of this.parentGraph.getEdges()) {
        if (edge.fromNodeId !== nodeId || edge.fromOutlet !== outletIndex) continue;
        const target = this.parentGraph.nodes.get(edge.toNodeId);
        if (!target) continue;
        if (value === null) this.parentInteraction.deliverBang(target, edge.toInlet);
        else this.parentInteraction.deliverMessageValue(target, edge.toInlet, value);
      }
    };

    // Wire the session's interaction controller to also handle events from the
    // presentation panel mounted on the main canvas.
    session.interaction.addInteractionPanel(session.presentationEl);

    this.sessions.set(nodeId, session);
    return session;
  }

  destroy(): void {
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
  }
}
