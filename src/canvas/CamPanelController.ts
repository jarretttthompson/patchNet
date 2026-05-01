import type { PatchGraph } from "../graph/PatchGraph";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import { CamPanel } from "./CamPanel";

/**
 * Lifecycle manager for inline CamPanel instances — one panel per cam*
 * node. Panels persist across graph re-renders and re-attach into the
 * fresh DOM slot (`[data-cam-panel-host]`) emitted by ObjectRenderer.
 */
export class CamPanelController {
  private readonly panels = new Map<string, CamPanel>();
  private vizGraph: VisualizerGraph | null = null;

  constructor(private readonly graph: PatchGraph) {}

  setVisualizerGraph(vg: VisualizerGraph | null): void {
    this.vizGraph = vg;
    for (const p of this.panels.values()) p.setVisualizerGraph(vg);
  }

  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "cam*") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-cam-panel-host="${node.id}"]`,
      );
      if (!host) continue;

      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new CamPanel(node, this.graph, this.vizGraph);
        this.panels.set(node.id, panel);
      } else {
        panel.syncFromArgs();
      }
      panel.attach(host);
    }
  }

  prune(activeNodeIds: Set<string>): void {
    for (const id of Array.from(this.panels.keys())) {
      if (!activeNodeIds.has(id)) {
        this.panels.get(id)?.destroy();
        this.panels.delete(id);
      }
    }
  }

  destroy(): void {
    for (const p of this.panels.values()) p.destroy();
    this.panels.clear();
  }
}
