import type { IRenderContext } from "./IRenderContext";

/**
 * VisualizerRuntime — singleton registry of named render contexts.
 *
 * Contexts may be popup VisualizerNodes or inline PatchVizNodes.
 * Any object that needs a render context calls
 * VisualizerRuntime.getInstance().get(name).
 */
export class VisualizerRuntime {
  private static _instance: VisualizerRuntime | null = null;

  static getInstance(): VisualizerRuntime {
    if (!VisualizerRuntime._instance) {
      VisualizerRuntime._instance = new VisualizerRuntime();
    }
    return VisualizerRuntime._instance;
  }

  private nodes = new Map<string, IRenderContext>();

  register(name: string, node: IRenderContext): void {
    this.nodes.set(name, node);
  }

  unregister(name: string): void {
    this.nodes.delete(name);
  }

  get(name: string): IRenderContext | undefined {
    return this.nodes.get(name);
  }

  /** Returns the first registered context, or undefined. Used as the default target. */
  getFirst(): IRenderContext | undefined {
    return this.nodes.values().next().value;
  }

  destroy(): void {
    for (const node of this.nodes.values()) {
      node.destroy();
    }
    this.nodes.clear();
  }
}
