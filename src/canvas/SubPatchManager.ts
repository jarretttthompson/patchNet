import type { PatchGraph } from "../graph/PatchGraph";
import type { ObjectInteractionController } from "./ObjectInteractionController";
import type { AudioGraph } from "../runtime/AudioGraph";
import type { PortType } from "../graph/PatchNode";
import { SubPatchSession } from "./SubPatchSession";

export class SubPatchManager {
  private sessions = new Map<string, SubPatchSession>();
  private currentAudioGraph: AudioGraph | undefined;

  /** Called to add/sync a tab without switching to it (patch load, graph change). */
  onTabRegister?: (nodeId: string, label: string, session: SubPatchSession) => void;
  /** Called when user double-clicks a subPatch object to open and switch to its tab. */
  onTabOpen?: (nodeId: string, label: string, session: SubPatchSession) => void;
  /** Called when a subPatch node is removed so its tab can be closed. */
  onTabClose?: (nodeId: string) => void;

  constructor(
    private readonly parentGraph: PatchGraph,
    private readonly parentInteraction: ObjectInteractionController,
    private readonly canvasArea: HTMLElement,
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
          this.onTabClose?.(id);
        }
      }
    });
  }

  /** Ensure a tab exists for every subPatch node in the graph (no tab switching). */
  syncTabs(): void {
    for (const node of this.parentGraph.getNodes()) {
      if (node.type !== "subPatch") continue;
      const session = this.getOrCreate(node.id);
      const label = this.getTabLabel(node.id);
      this.onTabRegister?.(node.id, label, session);
    }
  }

  /** Open and switch to a subPatch tab (double-click from canvas). */
  open(nodeId: string): void {
    const session = this.getOrCreate(nodeId);
    const label = this.getTabLabel(nodeId);
    this.onTabOpen?.(nodeId, label, session);
  }

  /** Persist a user-assigned label in args[4] and save the patch. */
  setLabel(nodeId: string, label: string): void {
    const node = this.parentGraph.nodes.get(nodeId);
    if (!node) return;
    node.args[4] = label;
    this.parentGraph.emit("change");
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

  private getTabLabel(nodeId: string): string {
    const pn = this.parentGraph.nodes.get(nodeId);
    return pn?.args[4] || "sub";
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
    if (this.currentAudioGraph !== undefined) {
      session.interaction.setAudioGraph(this.currentAudioGraph);
    }

    this.sessions.set(nodeId, session);
    return session;
  }

  /** Return the PatchGraph for every live subpatch session. */
  getSubPatchGraphs(): PatchGraph[] {
    return [...this.sessions.values()].map(s => s.graph);
  }

  /** Propagate the audio graph (or undefined on stop) to all session OICs. */
  setAudioGraph(ag: AudioGraph | undefined): void {
    this.currentAudioGraph = ag;
    for (const session of this.sessions.values()) {
      session.interaction.setAudioGraph(ag);
    }
  }

  destroy(): void {
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
  }
}
