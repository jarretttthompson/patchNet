import type { PatchGraph } from "../graph/PatchGraph";
import { DmxNode } from "./DmxNode";
import type { FixtureProfile } from "./dmx/FixtureProfile";
import type { FixtureInstance } from "./dmx/Patch";

function decodeArgJson<T>(encoded: string | undefined): T[] {
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

/**
 * Lifecycle manager for dmx objects in the patch graph. Mirrors the
 * AudioGraph / VisualizerGraph shape: creates a DmxNode when a `dmx` node
 * appears, destroys it when the node disappears.
 *
 * Phase 3.5 removed the body-paint loop: the inline DmxPanel now owns its
 * own live-state rendering (status dot, frames-sent counter, log), so this
 * graph just manages node lifecycle + rehydration.
 */
export class DmxGraph {
  private readonly nodes = new Map<string, DmxNode>();
  private readonly unsubscribe: () => void;

  constructor(private readonly graph: PatchGraph) {
    this.unsubscribe = this.graph.on("change", () => this.sync());
    this.sync();
  }

  getNode(nodeId: string): DmxNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  destroy(): void {
    this.unsubscribe();
    for (const node of this.nodes.values()) node.destroy();
    this.nodes.clear();
  }

  private sync(): void {
    const activeIds = new Set<string>();
    for (const node of this.graph.getNodes()) {
      if (node.type !== "dmx") continue;
      activeIds.add(node.id);
      if (!this.nodes.has(node.id)) {
        const baudRate = parseInt(node.args[1] ?? "250000", 10) || 250000;
        const dmx = new DmxNode({ baudRate });
        // Rehydrate user profiles + fixture instances from persisted args.
        // Profiles first so instances that reference them can resolve.
        const profiles = decodeArgJson<FixtureProfile>(node.args[6]);
        if (profiles.length > 0) dmx.loadUserProfiles(profiles);
        const instances = decodeArgJson<FixtureInstance>(node.args[7]);
        if (instances.length > 0) dmx.loadInstances(instances);
        this.nodes.set(node.id, dmx);

        // If the patch was saved in a connected state, try silent reconnect
        // via getPorts(). This works without a user gesture because the user
        // already granted permission to this device earlier.
        if (node.args[2] === "1") {
          const vid = parseInt(node.args[3] ?? "0", 10) || 0;
          const pid = parseInt(node.args[4] ?? "0", 10) || 0;
          if (vid && pid) void dmx.autoReconnect(vid, pid);
        }
      }
    }
    for (const id of Array.from(this.nodes.keys())) {
      if (!activeIds.has(id)) {
        this.nodes.get(id)?.destroy();
        this.nodes.delete(id);
      }
    }
  }
}
