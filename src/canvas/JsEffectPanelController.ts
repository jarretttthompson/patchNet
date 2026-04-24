import type { PatchGraph } from "../graph/PatchGraph";
import type { AudioGraph } from "../runtime/AudioGraph";
import { JsEffectPanel } from "./JsEffectPanel";

/**
 * Lifecycle manager for inline JsEffectPanel instances — one panel per js~
 * node. Mirrors DmxPanelController: panels persist across graph re-renders
 * and are re-parented into the fresh DOM slot emitted by ObjectRenderer
 * (`[data-jseffect-panel-host]`), so CodeMirror undo stack + slider values
 * survive cable tweaks elsewhere in the patch.
 *
 * The AudioGraph is optional at construction — panels can render their
 * editor UI + slider GUI without it (user can paste code before starting
 * DSP). When the AudioGraph becomes available, panels bind their
 * JsEffectNode and push cached code/slider state; when it's torn down, they
 * clear bindings but the editor continues to work.
 */
export class JsEffectPanelController {
  private readonly panels = new Map<string, JsEffectPanel>();
  private audioGraph: AudioGraph | null = null;

  constructor(private readonly graph: PatchGraph) {}

  setAudioGraph(audioGraph: AudioGraph | null): void {
    this.audioGraph = audioGraph;
    for (const panel of this.panels.values()) {
      panel.setAudioGraph(audioGraph);
    }
  }

  /** Ensure every js~ node has an attached panel. Called after each
   *  render() pass. */
  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "js~") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-jseffect-panel-host="${node.id}"]`,
      );
      if (!host) continue;

      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new JsEffectPanel(node, this.graph, this.audioGraph);
        this.panels.set(node.id, panel);
      } else {
        // Patch-file load may have rewritten args[0] — keep editor in sync.
        panel.syncFromArgs();
      }
      panel.attach(host);
    }
  }

  /** Destroy panels whose nodes are no longer in the graph. */
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
