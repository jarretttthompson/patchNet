import type { PatchGraph } from "../graph/PatchGraph";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import { ReaperVideoPanel } from "./ReaperVideoPanel";

/**
 * Lifecycle manager for inline ReaperVideoPanel instances — one per
 * reaperVideo node. Mirrors JsEffectPanelController: panels persist across
 * graph re-renders and re-parent into the fresh DOM slot emitted by
 * ObjectRenderer (`[data-rvideo-panel-host]`).
 */
export class ReaperVideoPanelController {
  private readonly panels = new Map<string, ReaperVideoPanel>();

  constructor(
    private readonly graph: PatchGraph,
    private readonly vizGraph: VisualizerGraph,
  ) {}

  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "reaperVideo*") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-rvideo-panel-host="${node.id}"]`,
      );
      if (!host) continue;

      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new ReaperVideoPanel(node, this.graph, this.vizGraph);
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
    for (const panel of this.panels.values()) panel.destroy();
    this.panels.clear();
  }

  /** Returns the mounted panel for a reaperVideo node, or undefined. */
  getPanel(nodeId: string): ReaperVideoPanel | undefined {
    return this.panels.get(nodeId);
  }
}
