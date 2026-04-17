import { AudioRuntime } from "./AudioRuntime";
import { ClickNode } from "./ClickNode";
import { DacNode } from "./DacNode";
import type { PatchGraph } from "../graph/PatchGraph";

/**
 * AudioGraph — maps patchNet graph nodes/edges to Web Audio nodes.
 *
 * Listens to graph "change" events and keeps the Web Audio topology
 * in sync: creates ClickNode/DacNode instances for click~/dac~ objects,
 * connects them when patch cables link them, and tears down removed nodes.
 */
export class AudioGraph {
  private readonly runtime: AudioRuntime;
  private readonly graph: PatchGraph;

  private clickNodes = new Map<string, ClickNode>();
  private dacNodes   = new Map<string, DacNode>();

  private unsubscribe: () => void;

  constructor(runtime: AudioRuntime, graph: PatchGraph) {
    this.runtime = runtime;
    this.graph   = graph;

    this.unsubscribe = this.graph.on("change", () => this.sync());
    this.sync();
  }

  /** Trigger a click~ node by patchNet nodeId. Called by ObjectInteractionController. */
  triggerClick(nodeId: string): void {
    this.clickNodes.get(nodeId)?.trigger();
  }

  destroy(): void {
    this.unsubscribe();
    this.clickNodes.clear();
    this.dacNodes.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private sync(): void {
    const activeNodeIds = new Set(this.graph.getNodes().map(n => n.id));

    // Remove audio nodes for deleted patchNet nodes
    for (const id of this.clickNodes.keys()) {
      if (!activeNodeIds.has(id)) this.clickNodes.delete(id);
    }
    for (const id of this.dacNodes.keys()) {
      if (!activeNodeIds.has(id)) {
        this.dacNodes.get(id)?.destroy();
        this.dacNodes.delete(id);
      }
    }

    if (!this.runtime.isStarted) return;

    // Create audio nodes for new patchNet nodes
    for (const node of this.graph.getNodes()) {
      if (node.type === "click~" && !this.clickNodes.has(node.id)) {
        this.clickNodes.set(node.id, new ClickNode(this.runtime));
      }
      if (node.type === "dac~" && !this.dacNodes.has(node.id)) {
        this.dacNodes.set(node.id, new DacNode(this.runtime));
      }
    }

    // Wire connections: click~ → dac~
    this.rewireConnections();
  }

  private rewireConnections(): void {
    // Disconnect all click nodes first, then reconnect per current edges
    for (const click of this.clickNodes.values()) {
      click.disconnect();
    }

    for (const edge of this.graph.getEdges()) {
      const fromNode = this.graph.nodes.get(edge.fromNodeId);
      const toNode   = this.graph.nodes.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;

      if (fromNode.type === "click~" && toNode.type === "dac~") {
        const click = this.clickNodes.get(edge.fromNodeId);
        const dac   = this.dacNodes.get(edge.toNodeId);
        if (click && dac) {
          // edge.toInlet: 0 = left channel, 1 = right channel
          click.connect(dac.inputNode, edge.toInlet);
        }
      }
    }
  }
}
