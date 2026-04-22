import type { PatchGraph } from "../graph/PatchGraph";
import type { DmxGraph } from "../runtime/DmxGraph";
import { DmxPanel } from "./DmxPanel";

/**
 * Lifecycle manager for inline DmxPanel instances. One panel per dmx node.
 * Mirrors CodeboxController: panels survive graph re-renders by re-parenting
 * into the fresh DOM slot emitted by ObjectRenderer, so mid-edit state
 * (selected tab, profile editor working copy, log scroll) isn't lost when a
 * cable is added somewhere else in the patch.
 */
export class DmxPanelController {
  private readonly panels = new Map<string, DmxPanel>();

  constructor(
    private readonly graph: PatchGraph,
    private readonly dmxGraph: DmxGraph,
  ) {}

  /**
   * Ensure every dmx node in the panGroup has an attached panel. Called
   * after each render() pass.
   */
  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "dmx") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-dmx-panel-host="${node.id}"]`,
      );
      if (!host) continue;
      const dmxNode = this.dmxGraph.getNode(node.id);
      if (!dmxNode) continue;

      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new DmxPanel(node, dmxNode, this.graph);
        this.panels.set(node.id, panel);
      }
      panel.attach(host);
    }
  }

  /** Destroy panels whose nodes no longer exist in the graph. */
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
}
