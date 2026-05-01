import type { PatchGraph } from "../graph/PatchGraph";
import type { PeerRegistry } from "../runtime/peer/PeerRegistry";
import { PeerPanel } from "./PeerPanel";

/**
 * Lifecycle manager for inline PeerPanel instances — one panel per `peer`
 * node. Mirrors CamPanelController. Mounted from main.ts after every render
 * so panels re-attach into the freshly-rendered DOM slot
 * (`[data-peer-panel-host]`) emitted by ObjectRenderer.
 */
export class PeerPanelController {
  private readonly panels = new Map<string, PeerPanel>();

  constructor(
    private readonly graph: PatchGraph,
    private registry: PeerRegistry,
  ) {}

  setRegistry(registry: PeerRegistry): void {
    this.registry = registry;
    for (const p of this.panels.values()) p.setRegistry(registry);
  }

  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "peer") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-peer-panel-host="${node.id}"]`,
      );
      if (!host) continue;
      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new PeerPanel(node, this.graph, this.registry);
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
