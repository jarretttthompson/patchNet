import { PatchEdge, type PatchEdgeData } from "./PatchEdge";
import { audioPortDefaultWidth, canonicalizeType, deriveAdcPorts, deriveBufferPorts, deriveDacPorts, deriveFftPorts, deriveJsEffectPorts, deriveMixerPorts, derivePackPorts, deriveReaperVideoPorts, deriveSequencerPorts, deriveTriggerPorts, deriveUnpackPorts, ensureBufferArgs, ensureSequencerArgs, fillCreationDefaults, getObjectDef } from "./objectDefs";
import { PatchNode, type PatchNodeData } from "./PatchNode";
import { parsePatch } from "../serializer/parse";
import { getBlobSchema, isBlobPlaceholder, serializePatch, serializePatchForDisplay } from "../serializer/serialize";
import { findFreePlacement, objectIgnoresOverlap } from "../canvas/OverlapGuard";
import { assignMissingNodeNames, isValidNodeName, nextNodeName, usedNodeNames, validateNodeName } from "./nodeNames";

type PatchGraphEvent = "change" | "display";
type ChangeHandler = () => void;

export class PatchGraph {
  nodes = new Map<string, PatchNode>();
  edges = new Map<string, PatchEdge>();

  private readonly listeners = new Set<ChangeHandler>();
  private readonly displayListeners = new Set<ChangeHandler>();

  addNode(type: string, x: number, y: number, args: string[] = [], name?: string | null): PatchNode {
    type = canonicalizeType(type);
    const objectDef = getObjectDef(type);
    args = fillCreationDefaults(objectDef, args);
    let inlets  = objectDef.inlets;
    let outlets = objectDef.outlets;
    if (type === "t") {
      ({ inlets, outlets } = deriveTriggerPorts(args));
    }
    if (type === "pack") {
      ({ inlets, outlets } = derivePackPorts(args));
    }
    if (type === "unpack") {
      ({ inlets, outlets } = deriveUnpackPorts(args));
    }
    if (type === "sequencer") {
      ensureSequencerArgs(args);
      ({ inlets, outlets } = deriveSequencerPorts(args));
    }
    if (type === "fft~") {
      ({ inlets, outlets } = deriveFftPorts(args));
    }
    if (type === "mixer~") {
      ({ inlets, outlets } = deriveMixerPorts(args));
    }
    if (type === "adc~") {
      ({ inlets, outlets } = deriveAdcPorts(args));
    }
    if (type === "dac~") {
      ({ inlets, outlets } = deriveDacPorts(args));
    }
    if (type === "js~") {
      ({ inlets, outlets } = deriveJsEffectPorts(args));
    }
    if (type === "buffer~") {
      ensureBufferArgs(args);
      ({ inlets, outlets } = deriveBufferPorts(args));
    }
    if (type === "reaperVideo*") {
      ({ inlets, outlets } = deriveReaperVideoPorts(args));
    }

    // Auto-shift placement when the requested spot is occupied. Skips
    // exempt types (frame~, comment) so they can intentionally overlap.
    const def = getObjectDef(type);
    let placeX = x;
    let placeY = y;
    if (!objectIgnoresOverlap(type)) {
      const w = def.defaultWidth;
      const h = def.defaultHeight;
      ({ x: placeX, y: placeY } = findFreePlacement(this, x, y, w, h));
    }

    const adcDacWidth =
      (type === "adc~" || type === "dac~") && (inlets.length > 2 || outlets.length > 2)
        ? audioPortDefaultWidth(Math.max(inlets.length, outlets.length))
        : undefined;

    const nodeName = this.reserveNodeName(type, name);
    const node = new PatchNode({
      id: crypto.randomUUID(),
      name: nodeName,
      type,
      x: placeX,
      y: placeY,
      args,
      inlets,
      outlets,
      width: adcDacWidth,
    });

    this.nodes.set(node.id, node);
    this.emit("change");
    return node;
  }

  removeNode(id: string): void {
    if (!this.nodes.has(id)) {
      return;
    }

    this.nodes.delete(id);

    for (const [edgeId, edge] of this.edges.entries()) {
      if (edge.fromNodeId === id || edge.toNodeId === id) {
        this.edges.delete(edgeId);
      }
    }

    this.emit("change");
  }

  addEdge(fromNodeId: string, fromOutlet: number, toNodeId: string, toInlet: number): PatchEdge {
    const sourceNode = this.requireNode(fromNodeId);
    const targetNode = this.requireNode(toNodeId);

    if (fromOutlet < 0 || fromOutlet >= sourceNode.outlets.length) {
      throw new Error(`Invalid outlet ${fromOutlet} for node ${sourceNode.type}`);
    }

    if (toInlet < 0 || toInlet >= targetNode.inlets.length) {
      throw new Error(`Invalid inlet ${toInlet} for node ${targetNode.type}`);
    }

    // Silently reject duplicate connections
    for (const existing of this.edges.values()) {
      if (
        existing.fromNodeId === fromNodeId &&
        existing.fromOutlet === fromOutlet &&
        existing.toNodeId === toNodeId &&
        existing.toInlet === toInlet
      ) {
        return existing;
      }
    }

    const edge = new PatchEdge({
      id: crypto.randomUUID(),
      fromNodeId,
      fromOutlet,
      toNodeId,
      toInlet,
    });

    this.edges.set(edge.id, edge);
    this.emit("change");
    return edge;
  }

  removeEdge(id: string): void {
    if (!this.edges.delete(id)) {
      return;
    }

    this.emit("change");
  }

  setNodeSize(id: string, width: number, height: number): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Unknown node id: ${id}`);
    }
    node.width = width;
    node.height = height;
    this.emit("change");
  }

  setNodePosition(id: string, x: number, y: number): void {
    const node = this.requireNode(id);
    node.x = x;
    node.y = y;
    // No equality guard: DragController pre-writes node.x/y during mousemove so
    // cables can track the drag, which would make this look like a no-op at
    // commit time. Skipping the emit leaves subPatch panels stale because
    // main.ts's mountPresentationPanels hook only re-mounts on "change".
    this.emit("change");
  }

  getNodes(): PatchNode[] {
    return Array.from(this.nodes.values());
  }

  getEdges(): PatchEdge[] {
    return Array.from(this.edges.values());
  }

  serialize(): string {
    return serializePatch(this);
  }

  /**
   * Console-facing serialization. Blob args (codebox/js~/reaperVideo
   * sources, libraries, slider/param values) are emitted as compact
   * `~b64:label:hash:summary~` placeholders instead of full base64.
   *
   * Round-trip safe: deserialize() rehydrates placeholders from the matched
   * in-memory node, so the textarea can edit structure without losing
   * payload bytes. Disk save/load and undo/redo continue to use serialize().
   */
  serializeForDisplay(): string {
    return serializePatchForDisplay(this);
  }

  /**
   * Diff-based deserialize. Incoming nodes that match an existing node
   * (by id when present, else by type + args or type + position) are mutated
   * in place — this preserves node.id so runtime state keyed by id
   * (IndexedDB video blobs, imageFX bg-removal PNGs, runtime node instances)
   * survives a round-trip through the text panel.
   *
   * Nodes only in the old graph are destroyed; nodes only in the new graph
   * are inserted with fresh ids. Edges are always rebuilt from the parsed set.
   */
  deserialize(text: string): void {
    const parsed = parsePatch(text);

    const oldNodes = new Map(this.nodes);
    const claimedOldIds = new Set<string>();

    // ── Pass 1: match by id when the incoming node preserved one ────
    for (const parsedNode of parsed.nodes) {
      const candidate = oldNodes.get(parsedNode.id);
      if (candidate && candidate.type === parsedNode.type && !claimedOldIds.has(candidate.id)) {
        claimedOldIds.add(candidate.id);
      }
    }

    // ── Pass 2: for unmatched parsed nodes, try structural matching ──
    const resolvedNodes: PatchNode[] = [];
    for (const parsedNode of parsed.nodes) {
      // Already matched in pass 1?
      const idMatch = oldNodes.get(parsedNode.id);
      if (idMatch && idMatch.type === parsedNode.type && claimedOldIds.has(idMatch.id)) {
        this.applyParsedToOld(idMatch, parsedNode);
        resolvedNodes.push(idMatch);
        continue;
      }

      // Structural fallback — find a compatible unclaimed old node
      const structural = this.findStructuralMatch(parsedNode, oldNodes, claimedOldIds);
      if (structural) {
        claimedOldIds.add(structural.id);
        this.applyParsedToOld(structural, parsedNode);
        resolvedNodes.push(structural);
        continue;
      }

      // No old match — strip any unresolved blob placeholders so they don't
      // leak into runtime as literal `~b64:…~` strings. Without an old node,
      // we have no payload to restore from.
      this.clearOrphanBlobPlaceholders(parsedNode);
      resolvedNodes.push(parsedNode);
    }

    assignMissingNodeNames(resolvedNodes);

    // ── Build a map from parsed.id → resolved.id for edge rewriting ──
    const parsedIdToResolvedId = new Map<string, string>();
    parsed.nodes.forEach((parsedNode, index) => {
      parsedIdToResolvedId.set(parsedNode.id, resolvedNodes[index].id);
    });

    // ── Commit nodes: resolved set replaces the graph ────────────────
    this.nodes.clear();
    for (const node of resolvedNodes) this.nodes.set(node.id, node);

    // ── Commit edges: rewrite parsed edge endpoints through the id map ──
    this.edges.clear();
    for (const parsedEdge of parsed.edges) {
      const fromId = parsedIdToResolvedId.get(parsedEdge.fromNodeId);
      const toId   = parsedIdToResolvedId.get(parsedEdge.toNodeId);
      if (!fromId || !toId) continue;
      const edge = new PatchEdge({
        id: crypto.randomUUID(),
        fromNodeId: fromId,
        fromOutlet: parsedEdge.fromOutlet,
        toNodeId:   toId,
        toInlet:    parsedEdge.toInlet,
      });
      this.edges.set(edge.id, edge);
    }

    this.emit("change");
  }

  /**
   * Copy parsed state onto the matched old node in place (preserves node.id
   * and runtime bindings). Rehydrates any abbreviated blob args from old —
   * the textarea uses `~b64:…~` placeholders for source/library/values, so
   * the parser leaves placeholders verbatim and we substitute the original
   * payload here.
   */
  private applyParsedToOld(target: PatchNode, parsed: PatchNode): void {
    const args = [...parsed.args];
    const schema = getBlobSchema(target.type);
    let portsAbbreviated = false;

    if (schema) {
      for (const slot of schema) {
        if (isBlobPlaceholder(args[slot.index])) {
          args[slot.index] = target.args[slot.index] ?? "";
          if (slot.drivesPorts) portsAbbreviated = true;
        }
      }
    }

    target.x       = parsed.x;
    target.y       = parsed.y;
    target.name    = parsed.name;
    target.args    = args;
    target.groupId = parsed.groupId;

    // When the source slot was abbreviated, the parser couldn't derive ports
    // from the placeholder — keep the old node's ports/dimensions intact.
    if (!portsAbbreviated) {
      target.inlets  = parsed.inlets.map((p) => ({ ...p }));
      target.outlets = parsed.outlets.map((p) => ({ ...p }));
      target.width   = parsed.width;
      target.height  = parsed.height;
    }
  }

  /**
   * Replace orphan blob placeholders with empty strings. Hit when an
   * abbreviated patch is pasted into a fresh session: there's no old node
   * to rehydrate from, so the placeholder represents missing data.
   */
  private clearOrphanBlobPlaceholders(node: PatchNode): void {
    const schema = getBlobSchema(node.type);
    if (!schema) return;
    for (const slot of schema) {
      if (isBlobPlaceholder(node.args[slot.index])) {
        node.args[slot.index] = "";
      }
    }
  }

  /**
   * Structural match for a parsed node against the set of unclaimed old
   * nodes. We prefer same-type + same-position matches (user didn't move
   * the node), then fall back to same-type + matching args[0] for media
   * objects whose args[0] is a stable IDB/localStorage reference.
   */
  private findStructuralMatch(
    parsedNode: PatchNode,
    oldNodes: Map<string, PatchNode>,
    claimedOldIds: Set<string>,
  ): PatchNode | null {
    // Media types: match on args[0] when it's a stable ref (idb:/bg:/data:)
    if (parsedNode.type === "mediaVideo*" || parsedNode.type === "mediaImage*") {
      const ref = parsedNode.args[0] ?? "";
      if (ref) {
        for (const old of oldNodes.values()) {
          if (claimedOldIds.has(old.id)) continue;
          if (old.type !== parsedNode.type) continue;
          if ((old.args[0] ?? "") === ref) return old;
        }
      }
    }

    // Position match — round because text stores integer coordinates
    const px = Math.round(parsedNode.x);
    const py = Math.round(parsedNode.y);
    for (const old of oldNodes.values()) {
      if (claimedOldIds.has(old.id)) continue;
      if (old.type !== parsedNode.type) continue;
      if (Math.round(old.x) === px && Math.round(old.y) === py) return old;
    }

    return null;
  }

  on(event: PatchGraphEvent, handler: ChangeHandler): () => void {
    if (event === "display") {
      this.displayListeners.add(handler);
      return () => { this.displayListeners.delete(handler); };
    }
    if (event === "change") {
      this.listeners.add(handler);
      return () => { this.listeners.delete(handler); };
    }
    return () => undefined;
  }

  emit(event: PatchGraphEvent): void {
    if (event === "display") {
      for (const handler of this.displayListeners) handler();
      return;
    }
    if (event === "change") {
      if (this.batchDepth > 0) {
        this.batchHadChange = true;
        return;
      }
      for (const handler of this.listeners) handler();
    }
  }

  private batchDepth = 0;
  private batchHadChange = false;

  /**
   * Run `fn` with all "change" events deferred until completion. Nested calls
   * are coalesced — only the outermost batch flushes. Used for compound
   * mutations (multi-node delete, group/ungroup, future macros) so the
   * UndoManager treats them as one history step instead of N.
   *
   * Display events are not batched — text-panel updates still tick during a
   * batch, but the visible canvas re-render and undo snapshot wait for flush.
   */
  batchChange<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchHadChange) {
        this.batchHadChange = false;
        for (const handler of this.listeners) handler();
      }
    }
  }

  load(data: { nodes: PatchNodeData[]; edges: PatchEdgeData[] }): void {
    this.nodes.clear();
    this.edges.clear();

    data.nodes.forEach((nodeData) => {
      this.nodes.set(nodeData.id, new PatchNode(nodeData));
    });
    assignMissingNodeNames(this.nodes.values());

    data.edges.forEach((edgeData) => {
      this.edges.set(edgeData.id, new PatchEdge(edgeData));
    });

    this.emit("change");
  }

  /**
   * Duplicates a set of nodes. Clones land at a uniform (+20, +20) offset
   * from their sources so the no-overlap rule holds without losing the
   * group's internal spatial layout. Exempt types (frame~, comment) clone
   * in place since they're allowed to overlap.
   *
   * Edges whose both endpoints are inside the set are also duplicated.
   * Edges that cross the boundary (one end outside) are not copied.
   *
   * Returns a Map<originalId, newId> for every cloned node.
   * Emits "change" once after all nodes and edges are created.
   */
  duplicateNodes(nodeIds: string[]): Map<string, string> {
    const idMap = new Map<string, string>();
    const CASCADE_OFFSET = 20;

    for (const oldId of nodeIds) {
      const src = this.nodes.get(oldId);
      if (!src) continue;

      const exempt = objectIgnoresOverlap(src.type);
      const dx = exempt ? 0 : CASCADE_OFFSET;
      const dy = exempt ? 0 : CASCADE_OFFSET;

      const cloned = new PatchNode({
        id: crypto.randomUUID(),
        name: this.reserveNodeName(src.type),
        type: src.type,
        x: src.x + dx,
        y: src.y + dy,
        args: [...src.args],
        inlets:  src.inlets.map(p => ({ ...p })),
        outlets: src.outlets.map(p => ({ ...p })),
        width:  src.width,
        height: src.height,
        groupId: src.groupId, // remapped below
      });

      this.nodes.set(cloned.id, cloned);
      idMap.set(oldId, cloned.id);
    }

    // Re-create edges whose both endpoints were cloned
    for (const edge of this.edges.values()) {
      const newFrom = idMap.get(edge.fromNodeId);
      const newTo   = idMap.get(edge.toNodeId);
      if (!newFrom || !newTo) continue;

      const clonedEdge = new PatchEdge({
        id: crypto.randomUUID(),
        fromNodeId: newFrom,
        fromOutlet: edge.fromOutlet,
        toNodeId:   newTo,
        toInlet:    edge.toInlet,
      });
      this.edges.set(clonedEdge.id, clonedEdge);
    }

    // Remap group IDs: cloned nodes that shared a group get a new shared group
    const groupRemap = new Map<string, string>();
    for (const newId of idMap.values()) {
      const node = this.nodes.get(newId);
      if (!node?.groupId) continue;
      if (!groupRemap.has(node.groupId)) groupRemap.set(node.groupId, crypto.randomUUID());
      node.groupId = groupRemap.get(node.groupId);
    }

    this.emit("change");
    return idMap;
  }

  private requireNode(id: string): PatchNode {
    const node = this.nodes.get(id);

    if (!node) {
      throw new Error(`Unknown node id: ${id}`);
    }

    return node;
  }

  private reserveNodeName(type: string, requested?: string | null): string {
    const used = usedNodeNames(this.nodes.values());
    if (requested) {
      validateNodeName(requested);
      if (used.has(requested)) {
        throw new Error(`object name already exists: ${requested}`);
      }
      return requested;
    }

    const name = nextNodeName(type, used);
    if (!isValidNodeName(name)) {
      throw new Error(`could not generate object name for ${type}`);
    }
    return name;
  }
}
