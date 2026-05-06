import type { PatchNode } from "./PatchNode";
import type { PatchGraph } from "./PatchGraph";
import type { ObjectSpec } from "./objectDefs";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import type { PatchAction, ActionContext } from "../actions/types";

/**
 * Local object plugin contract.
 *
 * Files in src/graph/localObjects/*.ts (gitignored) export a default
 * LocalPlugin and are loaded eagerly via Vite's import.meta.glob below.
 * Each plugin contributes one object type — its spec is merged into
 * OBJECT_DEFS at module init, its body is rendered through
 * renderLocalPluginBody, and its runtime is mounted/pruned every render
 * via mountLocalPlugins / pruneLocalPlugins.
 *
 * The folder is gitignored so private plugins never reach origin. A
 * tracked .gitkeep keeps the folder present so the glob always resolves.
 */
export interface LocalPluginContext {
  graph: PatchGraph;
  vizGraph: VisualizerGraph | null;
}

export interface LocalPlugin {
  type: string;
  spec: ObjectSpec;
  /** Build the patch-object-body element for one instance. */
  renderBody(node: PatchNode): HTMLDivElement;
  /** Called every render() — reconcile per-node runtime against the live DOM. */
  mount(panGroup: HTMLElement, ctx: LocalPluginContext): void;
  /** Called every render() with the set of node IDs still in the graph. */
  prune(activeNodeIds: Set<string>): void;
  /** Optional: contribute searchable actions to the action list / palette.
   *  Called once at app boot. Action ids must use the "plugin.<type>." prefix
   *  so they don't collide with built-ins. */
  actions?(ctx: { type: string }): PatchAction[];
}

const modules = import.meta.glob<{ default: LocalPlugin }>(
  "./localObjects/*.ts",
  { eager: true },
);

const registry = new Map<string, LocalPlugin>();
for (const path in modules) {
  const plugin = modules[path]?.default;
  if (!plugin || typeof plugin !== "object") continue;
  if (registry.has(plugin.type)) {
    console.warn(`[localPlugins] duplicate plugin type "${plugin.type}" from ${path}`);
    continue;
  }
  registry.set(plugin.type, plugin);
}

export function getLocalPluginSpecs(): ReadonlyMap<string, ObjectSpec> {
  const out = new Map<string, ObjectSpec>();
  for (const [type, plugin] of registry) out.set(type, plugin.spec);
  return out;
}

export function hasLocalPlugin(type: string): boolean {
  return registry.has(type);
}

export function renderLocalPluginBody(node: PatchNode): HTMLDivElement | null {
  const plugin = registry.get(node.type);
  return plugin ? plugin.renderBody(node) : null;
}

export function mountLocalPlugins(
  panGroup: HTMLElement,
  ctx: LocalPluginContext,
): void {
  for (const plugin of registry.values()) plugin.mount(panGroup, ctx);
}

export function pruneLocalPlugins(activeNodeIds: Set<string>): void {
  for (const plugin of registry.values()) plugin.prune(activeNodeIds);
}

/** Collect every plugin's contributed actions for registration with the
 *  ActionRegistry. Plugins without an `actions` hook contribute nothing. */
export function collectLocalPluginActions(): PatchAction[] {
  const out: PatchAction[] = [];
  for (const plugin of registry.values()) {
    if (!plugin.actions) continue;
    try {
      out.push(...plugin.actions({ type: plugin.type }));
    } catch (err) {
      console.warn(`[localPlugins] ${plugin.type}.actions() threw`, err);
    }
  }
  return out;
}

// Re-export so localObjects/*.ts plugin files can author actions without
// reaching into src/actions/ directly. ActionContext travels with the run()
// callback, never needs to be constructed by plugin code.
export type { PatchAction, ActionContext };
