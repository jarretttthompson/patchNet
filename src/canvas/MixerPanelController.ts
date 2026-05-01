import type { PatchGraph } from "../graph/PatchGraph";
import type { AudioGraph } from "../runtime/AudioGraph";
import { MixerPanel } from "./MixerPanel";

export class MixerPanelController {
  private readonly panels = new Map<string, MixerPanel>();
  private audioGraph: AudioGraph | null = null;

  constructor(private readonly graph: PatchGraph) {}

  setAudioGraph(audioGraph: AudioGraph | null): void {
    this.audioGraph = audioGraph;
    for (const panel of this.panels.values()) {
      panel.setAudioGraph(audioGraph);
    }
  }

  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "mixer~") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-mixer-panel-host="${node.id}"]`,
      );
      if (!host) continue;

      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new MixerPanel(node, this.graph, this.audioGraph);
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
