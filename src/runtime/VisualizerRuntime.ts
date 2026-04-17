import type { VisualizerNode } from "./VisualizerNode";

/**
 * VisualizerRuntime — singleton registry of active VisualizerNode popup windows.
 *
 * Any object that needs to find a named render context calls
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

  private nodes = new Map<string, VisualizerNode>();

  register(name: string, node: VisualizerNode): void {
    this.nodes.set(name, node);
  }

  unregister(name: string): void {
    this.nodes.delete(name);
  }

  get(name: string): VisualizerNode | undefined {
    return this.nodes.get(name);
  }

  /** Returns the first registered node, or undefined. Used as the default target. */
  getFirst(): VisualizerNode | undefined {
    return this.nodes.values().next().value;
  }

  destroy(): void {
    for (const node of this.nodes.values()) {
      node.destroy();
    }
    this.nodes.clear();
  }
}
