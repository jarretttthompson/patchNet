import type { PatchGraph } from "../graph/PatchGraph";
import type { AudioGraph } from "../runtime/AudioGraph";
import { YouTubePanel } from "./YouTubePanel";

/**
 * Lifecycle manager for inline YouTubePanel instances — one panel per
 * youtube~ node. Mirrors BrowserPanelController exactly: panels persist
 * across graph re-renders and re-attach into the fresh DOM slot emitted by
 * ObjectRenderer (`[data-youtube-panel-host]`) so the iframe playback state
 * survives cable edits elsewhere in the patch.
 */
export class YouTubePanelController {
  private readonly panels = new Map<string, YouTubePanel>();
  private audioGraph: AudioGraph | null = null;

  constructor(private readonly graph: PatchGraph) {}

  setAudioGraph(audioGraph: AudioGraph | null): void {
    this.audioGraph = audioGraph;
    for (const panel of this.panels.values()) panel.setAudioGraph(audioGraph);
  }

  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "youtube~*") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-youtube-panel-host="${node.id}"]`,
      );
      if (!host) continue;

      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new YouTubePanel(node, this.graph, this.audioGraph);
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
