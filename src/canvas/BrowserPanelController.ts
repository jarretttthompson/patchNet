import type { PatchGraph } from "../graph/PatchGraph";
import type { AudioGraph } from "../runtime/AudioGraph";
import { BrowserPanel } from "./BrowserPanel";

/**
 * Lifecycle manager for inline BrowserPanel instances — one panel per
 * browser~ node. Follows the JsEffectPanelController pattern: panels persist
 * across graph re-renders and re-attach into the fresh DOM slot emitted by
 * ObjectRenderer (`[data-browser-panel-host]`) so the iframe preview and
 * capture state survive cable edits elsewhere in the patch.
 */
export class BrowserPanelController {
  private readonly panels = new Map<string, BrowserPanel>();
  private audioGraph: AudioGraph | null = null;

  constructor(private readonly graph: PatchGraph) {}

  setAudioGraph(audioGraph: AudioGraph | null): void {
    this.audioGraph = audioGraph;
    for (const panel of this.panels.values()) panel.setAudioGraph(audioGraph);
  }

  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "browser~") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-browser-panel-host="${node.id}"]`,
      );
      if (!host) continue;

      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new BrowserPanel(node, this.graph, this.audioGraph);
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
}
