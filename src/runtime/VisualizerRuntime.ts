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

  private nodes = new Map<string, IRenderContext[]>();
  private registerListeners = new Set<(name: string, node: IRenderContext) => void>();

  /**
   * Subscribe to context-registration events. Lets a VisualizerGraph re-wire
   * its layers when a sibling VG (e.g. a subpatch session) registers a context
   * matching one of its layer targets. Returns an unsubscribe function.
   */
  onRegister(cb: (name: string, node: IRenderContext) => void): () => void {
    this.registerListeners.add(cb);
    return () => this.registerListeners.delete(cb);
  }

  register(name: string, node: IRenderContext): void {
    const list = this.nodes.get(name) ?? [];
    if (!list.includes(node)) list.push(node);
    this.nodes.set(name, list);
    for (const cb of this.registerListeners) cb(name, node);
  }

  /**
   * Remove a specific node from the named slot. If `node` is omitted every
   * context registered under `name` is removed (backwards-compat path).
   */
  unregister(name: string, node?: IRenderContext): void {
    if (!node) { this.nodes.delete(name); return; }
    const list = this.nodes.get(name);
    if (!list) return;
    const filtered = list.filter(n => n !== node);
    if (filtered.length === 0) this.nodes.delete(name);
    else this.nodes.set(name, filtered);
  }

  /** Returns the first context registered under `name`, or undefined. */
  get(name: string): IRenderContext | undefined {
    return this.nodes.get(name)?.[0];
  }

  /** Returns all contexts registered under `name`. */
  getAll(name: string): IRenderContext[] {
    return this.nodes.get(name) ?? [];
  }

  /** Returns the first registered context across all names. Used as a fallback target. */
  getFirst(): IRenderContext | undefined {
    return this.nodes.values().next().value?.[0];
  }

  destroy(): void {
    for (const list of this.nodes.values()) {
      for (const node of list) node.destroy();
    }
    this.nodes.clear();
  }
}
