import type { IRenderContext } from "./IRenderContext";
import { VisualizerNode } from "./VisualizerNode";

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
  private popupStateListeners = new Set<() => void>();

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

  /**
   * Subscribe to popup open/close transitions. Fires whenever a VisualizerNode
   * opens or closes its popup window — used by main.ts to re-host the meter
   * rAF loop on the visible popup (which the OS keeps un-throttled) instead of
   * the main window (which Chrome throttles to ~1 Hz when backgrounded by a
   * fullscreened popup). Returns an unsubscribe function.
   */
  onPopupStateChange(cb: () => void): () => void {
    this.popupStateListeners.add(cb);
    return () => this.popupStateListeners.delete(cb);
  }

  /** Called by VisualizerNode after open()/close()/beforeunload. */
  notifyPopupStateChanged(): void {
    for (const cb of this.popupStateListeners) cb();
  }

  /**
   * First open VisualizerNode popup in registration order, or null if none.
   * Registration order is stable (Map insertion order), so the same patch
   * deterministically picks the same host.
   */
  getFirstOpenPopupWindow(): Window | null {
    for (const list of this.nodes.values()) {
      for (const node of list) {
        if (node instanceof VisualizerNode && node.isOpen()) {
          const w = node.getPopupWindow();
          if (w) return w;
        }
      }
    }
    return null;
  }

  destroy(): void {
    for (const list of this.nodes.values()) {
      for (const node of list) node.destroy();
    }
    this.nodes.clear();
  }
}
