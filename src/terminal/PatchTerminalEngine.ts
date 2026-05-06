import type { ActionContext } from "../actions/types";
import { getPortPos } from "../canvas/CableRenderer";
import { validateNodeName } from "../graph/nodeNames";
import { canonicalizeType, getObjectDef, OBJECT_DEFS } from "../graph/objectDefs";
import { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";

export interface TerminalResult {
  ok: boolean;
  message: string;
  touchedNodeIds?: string[];
  completionCandidates?: string[];
}

interface TerminalSessionState {
  aliases: Map<string, string>;
  lastNodeId: string | null;
}

interface AddSpec {
  type: string;
  args: string[];
  alias: string | null;
}

interface EndpointRef {
  nodeId: string;
  port: number;
}

type PhraseElement =
  | { kind: "new"; spec: AddSpec }
  | { kind: "existing"; ref: string; nodeId: string };

interface PatchPhrasePlan {
  elements: PhraseElement[];
  connections: PhraseConnection[];
}

interface PhraseConnection {
  fromElementIndex: number;
  fromOutlet: number;
  toElementIndex: number;
  toInlets: number[];
}

type PhraseToken =
  | { kind: "word"; value: string }
  | { kind: "arg"; value: string[] }
  | { kind: "alias"; value: string }
  | { kind: "arrow"; value: "->" };

const RESERVED_REFS = new Set(["last", "selected", "selection", "out", "in"]);
const COMMANDS = new Set(["add", "connect", "select", "delete", "move", "run"]);
const NODE_GAP_X = 56;
const PHRASE_GAP_X = 24;
const PHRASE_GAP_Y = 32;

export class TerminalCommandError extends Error {}

export class PatchTerminalEngine {
  private readonly sessions = new WeakMap<PatchGraph, TerminalSessionState>();

  async execute(input: string, ctx: ActionContext): Promise<TerminalResult> {
    const trimmed = input.trim();
    if (!trimmed) return { ok: true, message: "" };

    try {
      if (trimmed.startsWith("{") || trimmed.endsWith("}")) {
        return this.buildPatchPhrase(trimmed, ctx);
      }

      const tokens = tokenizeTerminalCommand(trimmed);
      if (tokens.length === 0) return { ok: true, message: "" };

      const command = tokens[0].toLowerCase();
      const args = tokens.slice(1);

      switch (command) {
        case "add": return this.add(args, ctx);
        case "connect": return this.connect(args, ctx);
        case "select": return this.select(args, ctx);
        case "delete": return this.delete(args, ctx);
        case "move": return this.move(args, ctx);
        case "run": return this.runAction(args, ctx);
        default:
          throw new TerminalCommandError(`unknown command: ${tokens[0]}`);
      }
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "command failed",
      };
    }
  }

  aliasesFor(graph: PatchGraph): ReadonlyMap<string, string> {
    return this.nameMapFor(graph);
  }

  private add(tokens: string[], ctx: ActionContext): TerminalResult {
    const spec = this.parseAddSpec(tokens);
    const def = getObjectDef(spec.type);
    const state = this.stateFor(ctx.graph);
    if (spec.alias) this.ensureAliasAvailable(ctx.graph, state, spec.alias);

    const node = ctx.graph.batchChange(() => {
      const { x, y } = this.nextPlacement(ctx, def.defaultWidth, def.defaultHeight);
      return ctx.graph.addNode(spec.type, x, y, spec.args, spec.alias);
    });

    state.lastNodeId = node.id;
    if (spec.alias) state.aliases.set(spec.alias, node.id);
    ctx.canvas.selectNode(node.id);

    return {
      ok: true,
      message: spec.alias
        ? `added ${node.type} as ${spec.alias}`
        : `added ${node.type} ${shortId(node.id)}`,
      touchedNodeIds: [node.id],
    };
  }

  private connect(tokens: string[], ctx: ActionContext): TerminalResult {
    if (tokens.length !== 3 || tokens[1] !== "->") {
      throw new TerminalCommandError("usage: connect <source>.<outlet> -> <target>.<inlet>");
    }

    const from = this.resolveEndpoint(tokens[0], ctx, "outlet");
    const to = this.resolveEndpoint(tokens[2], ctx, "inlet");
    const before = ctx.graph.getEdges().length;

    ctx.graph.batchChange(() => {
      ctx.graph.addEdge(from.nodeId, from.port, to.nodeId, to.port);
    });

    const changed = ctx.graph.getEdges().length > before;
    return {
      ok: true,
      message: changed ? "connected" : "connection already exists",
      touchedNodeIds: [from.nodeId, to.nodeId],
    };
  }

  private select(tokens: string[], ctx: ActionContext): TerminalResult {
    if (tokens.length === 0) throw new TerminalCommandError("usage: select <node...>");

    const ids = tokens.map((token) => this.resolveSingleNode(token, ctx));
    ctx.canvas.selectNodes(new Set(ids));
    const state = this.stateFor(ctx.graph);
    state.lastNodeId = ids[ids.length - 1] ?? state.lastNodeId;

    return {
      ok: true,
      message: `selected ${ids.length} node${ids.length === 1 ? "" : "s"}`,
      touchedNodeIds: ids,
    };
  }

  private delete(tokens: string[], ctx: ActionContext): TerminalResult {
    if (tokens.length === 0) throw new TerminalCommandError("usage: delete <node|selection>");

    const state = this.stateFor(ctx.graph);
    let ids: string[];

    if (tokens.length === 1 && tokens[0].toLowerCase() === "selection") {
      ids = [...ctx.canvas.getSelectedNodeIds()].filter((id) => ctx.graph.nodes.has(id));
      if (ids.length === 0) return { ok: true, message: "no selected nodes to delete" };
      ctx.canvas.deleteSelection();
    } else {
      ids = tokens.map((token) => this.resolveSingleNode(token, ctx));
      ctx.canvas.selectNode(null);
      ctx.graph.batchChange(() => {
        for (const id of ids) ctx.graph.removeNode(id);
      });
    }

    this.pruneAliases(state, ctx.graph);
    if (state.lastNodeId && !ctx.graph.nodes.has(state.lastNodeId)) state.lastNodeId = null;

    return {
      ok: true,
      message: `deleted ${ids.length} node${ids.length === 1 ? "" : "s"}`,
      touchedNodeIds: ids,
    };
  }

  private move(tokens: string[], ctx: ActionContext): TerminalResult {
    if (tokens.length !== 3) throw new TerminalCommandError("usage: move <node> <x> <y>");

    const id = this.resolveSingleNode(tokens[0], ctx);
    const x = parseFiniteNumber(tokens[1], "x");
    const y = parseFiniteNumber(tokens[2], "y");
    const node = ctx.graph.nodes.get(id);
    if (!node) throw new TerminalCommandError(`unknown node: ${tokens[0]}`);
    if (node.x === x && node.y === y) {
      return { ok: true, message: "node already at that position", touchedNodeIds: [id] };
    }

    ctx.graph.batchChange(() => ctx.graph.setNodePosition(id, x, y));
    ctx.canvas.selectNode(id);
    this.stateFor(ctx.graph).lastNodeId = id;

    return {
      ok: true,
      message: `moved ${this.describeNode(id, ctx.graph)} to ${x}, ${y}`,
      touchedNodeIds: [id],
    };
  }

  private async runAction(tokens: string[], ctx: ActionContext): Promise<TerminalResult> {
    if (tokens.length === 0) throw new TerminalCommandError("usage: run <action id|search>");
    const query = tokens.join(" ").trim();
    const action = this.resolveAction(query, ctx);
    if (action.enabled && !action.enabled(ctx)) {
      throw new TerminalCommandError(`action disabled: ${action.title}`);
    }
    await action.run(ctx);
    return { ok: true, message: `ran ${action.title}` };
  }

  private buildPatchPhrase(input: string, ctx: ActionContext): TerminalResult {
    const plan = this.parsePatchPhrase(input, ctx);
    const state = this.stateFor(ctx.graph);
    for (const element of plan.elements) {
      if (element.kind === "new" && element.spec.alias) {
        this.ensureAliasAvailable(ctx.graph, state, element.spec.alias);
      }
    }
    this.validatePatchPhrase(plan, ctx);

    const created: PatchNode[] = [];
    const touchedNodeIds = new Set<string>();
    const nodeByElementIndex = new Map<number, PatchNode>();
    ctx.graph.batchChange(() => {
      const firstSpec = plan.elements.find((element): element is { kind: "new"; spec: AddSpec } =>
        element.kind === "new",
      )?.spec;
      const firstDef = firstSpec ? getObjectDef(firstSpec.type) : null;
      const start = firstDef
        ? this.nextPlacement(ctx, firstDef.defaultWidth, firstDef.defaultHeight)
        : { x: 0, y: 0 };

      for (let i = 0; i < plan.elements.length; i++) {
        const element = plan.elements[i];
        if (element.kind === "existing") {
          const node = ctx.graph.nodes.get(element.nodeId);
          if (!node) throw new TerminalCommandError(`unknown node: ${element.ref}`);
          nodeByElementIndex.set(i, node);
          touchedNodeIds.add(node.id);
          continue;
        }

        const spec = element.spec;
        const placement = this.nextPhraseElementPlacement(i, spec, plan, nodeByElementIndex, ctx, start);
        const node = ctx.graph.addNode(spec.type, placement.x, placement.y, spec.args, spec.alias);
        created.push(node);
        touchedNodeIds.add(node.id);
        nodeByElementIndex.set(i, node);
      }

      for (const connection of plan.connections) {
        const from = nodeByElementIndex.get(connection.fromElementIndex);
        const to = nodeByElementIndex.get(connection.toElementIndex);
        if (!from || !to) throw new TerminalCommandError("invalid patch phrase connection");
        touchedNodeIds.add(from.id);
        touchedNodeIds.add(to.id);
        for (const inlet of connection.toInlets) {
          ctx.graph.addEdge(from.id, connection.fromOutlet, to.id, inlet);
        }
      }
    });

    let createdIndex = 0;
    for (const element of plan.elements) {
      if (element.kind !== "new") continue;
      const alias = element.spec.alias;
      const node = created[createdIndex];
      if (alias && node) state.aliases.set(alias, node.id);
      createdIndex += 1;
    }
    const lastElementNode = nodeByElementIndex.get(plan.elements.length - 1);
    state.lastNodeId = lastElementNode?.id ?? state.lastNodeId;

    if (created.length > 0) {
      ctx.canvas.selectNodes(new Set(created.map((node) => node.id)));
    } else {
      ctx.canvas.selectNodes(touchedNodeIds);
    }

    const cableCount = plan.connections.reduce((count, c) => count + c.toInlets.length, 0);
    const objectLabel = created.length === 1 ? "object" : "objects";
    return {
      ok: true,
      message: `built patch phrase: ${created.length} ${objectLabel}, ${cableCount} cable${cableCount === 1 ? "" : "s"}`,
      touchedNodeIds: [...touchedNodeIds],
    };
  }

  private parsePatchPhrase(input: string, ctx: ActionContext): PatchPhrasePlan {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      throw new TerminalCommandError("patch phrases must be wrapped in { ... }");
    }

    const inner = trimmed.slice(1, -1).trim();
    if (!inner) throw new TerminalCommandError("empty patch phrase");

    const tokens = tokenizePatchPhrase(inner);
    let index = 0;
    const aliases = new Set<string>();

    const read = (): PhraseToken | undefined => tokens[index];
    const readWord = (): string | null => {
      const token = read();
      return token?.kind === "word" ? token.value : null;
    };

    const parseElement = (): PhraseElement => {
      const typeToken = read();
      if (typeToken?.kind !== "word") {
        throw new TerminalCommandError("expected object type or node reference in patch phrase");
      }
      if (typeToken.value === "out" || typeToken.value === "in") {
        throw new TerminalCommandError(`expected object type or node reference, got ${typeToken.value}`);
      }

      const type = canonicalizeType(typeToken.value);
      if (!OBJECT_DEFS[type]) {
        const nodeId = this.resolveSingleNode(typeToken.value, ctx);
        index += 1;
        const next = read();
        if (next?.kind === "arg" || next?.kind === "alias") {
          throw new TerminalCommandError(`existing node reference cannot have args or alias: ${typeToken.value}`);
        }
        return { kind: "existing", ref: typeToken.value, nodeId };
      }

      index += 1;
      const args: string[] = [];
      let alias: string | null = null;
      while (index < tokens.length) {
        const token = read()!;
        if (token.kind === "arg") {
          args.push(...token.value);
          index += 1;
          continue;
        }
        if (token.kind === "alias") {
          if (alias) throw new TerminalCommandError(`object ${type} has more than one alias`);
          validateAlias(token.value);
          if (aliases.has(token.value)) throw new TerminalCommandError(`duplicate alias in patch phrase: ${token.value}`);
          aliases.add(token.value);
          alias = token.value;
          index += 1;
          continue;
        }
        break;
      }

      return { kind: "new", spec: { type, args, alias } };
    };

    const elements: PhraseElement[] = [parseElement()];
    const connections: PhraseConnection[] = [];

    while (index < tokens.length) {
      if (readWord() !== "out") throw new TerminalCommandError("expected out <n> -> in <n> ...");
      index += 1;
      const fromOutlet = parsePortToken(tokens[index], "outlet");
      index += 1;

      if (read()?.kind !== "arrow") throw new TerminalCommandError("expected -> after out <n>");
      index += 1;

      const toInlets: number[] = [];
      while (readWord() === "in") {
        index += 1;
        toInlets.push(parsePortToken(tokens[index], "inlet"));
        index += 1;
      }
      if (toInlets.length === 0) throw new TerminalCommandError("expected at least one in <n> after ->");

      const fromElementIndex = elements.length - 1;
      const target = parseElement();
      elements.push(target);
      connections.push({
        fromElementIndex,
        fromOutlet,
        toElementIndex: elements.length - 1,
        toInlets,
      });
    }

    return { elements, connections };
  }

  private validatePatchPhrase(plan: PatchPhrasePlan, ctx: ActionContext): void {
    const temp = new PatchGraph();
    const nodes = new Map<number, PatchNode>();
    try {
      plan.elements.forEach((element, index) => {
        if (element.kind === "new") {
          nodes.set(index, temp.addNode(element.spec.type, 0, index * 100, element.spec.args));
          return;
        }
        const node = ctx.graph.nodes.get(element.nodeId);
        if (!node) throw new Error(`Unknown node: ${element.ref}`);
        nodes.set(index, node);
      });

      for (const connection of plan.connections) {
        const from = nodes.get(connection.fromElementIndex);
        const to = nodes.get(connection.toElementIndex);
        if (!from || !to) throw new Error("invalid patch phrase connection");
        if (connection.fromOutlet < 0 || connection.fromOutlet >= from.outlets.length) {
          throw new Error(`Invalid outlet ${connection.fromOutlet} for node ${from.type}`);
        }
        for (const inlet of connection.toInlets) {
          if (inlet < 0 || inlet >= to.inlets.length) {
            throw new Error(`Invalid inlet ${inlet} for node ${to.type}`);
          }
        }
      }
    } catch (err) {
      throw new TerminalCommandError(
        err instanceof Error ? err.message : "invalid patch phrase connection",
      );
    }
  }

  private parseAddSpec(tokens: string[]): AddSpec {
    if (tokens.length === 0) throw new TerminalCommandError("usage: add <type> [args...] [as <alias>]");

    const type = canonicalizeType(tokens[0]);
    if (!OBJECT_DEFS[type]) throw new TerminalCommandError(`unknown object type: ${tokens[0]}`);

    const args = tokens.slice(1);
    let alias: string | null = null;
    const asIndex = args.lastIndexOf("as");
    if (asIndex >= 0) {
      if (asIndex !== args.length - 2) {
        throw new TerminalCommandError("usage: add <type> [args...] [as <alias>]");
      }
      alias = args[asIndex + 1];
      validateAlias(alias);
      args.splice(asIndex, 2);
    }

    return { type, args, alias };
  }

  private nextPlacement(
    ctx: ActionContext,
    width: number,
    height: number,
  ): { x: number; y: number } {
    const selected = [...ctx.canvas.getSelectedNodeIds()]
      .map((id) => ctx.graph.nodes.get(id))
      .filter((node): node is PatchNode => !!node);

    if (selected.length > 0) {
      let right = -Infinity;
      let top = Infinity;
      for (const node of selected) {
        const def = getObjectDef(node.type);
        right = Math.max(right, node.x + (node.width ?? def.defaultWidth));
        top = Math.min(top, node.y);
      }
      return { x: Math.round(right + NODE_GAP_X), y: Math.round(top) };
    }

    const [cx, cy] = ctx.canvas.viewportCenter();
    return {
      x: Math.max(0, Math.round(cx - width / 2)),
      y: Math.max(0, Math.round(cy - height / 2)),
    };
  }

  private nextPhraseElementPlacement(
    index: number,
    spec: AddSpec,
    plan: PatchPhrasePlan,
    nodeByElementIndex: ReadonlyMap<number, PatchNode>,
    ctx: ActionContext,
    fallbackStart: { x: number; y: number },
  ): { x: number; y: number } {
    const existingTarget = index === 0 ? this.existingTargetForNewSource(index, plan, ctx) : null;
    if (existingTarget) {
      const targetDef = getObjectDef(existingTarget.node.type);
      const targetWidth = existingTarget.node.width ?? targetDef.defaultWidth;
      const firstInlet = Math.min(...existingTarget.toInlets);
      const targetPort = getPortPos(existingTarget.node, "inlet", firstInlet);
      const previewSource = this.previewNode(spec);
      const sourcePort = getPortPos(previewSource, "outlet", existingTarget.fromOutlet);
      const sourcePortOffset = {
        x: sourcePort.x - previewSource.x,
        y: sourcePort.y - previewSource.y,
      };

      if (firstInlet > 0) {
        return {
          x: Math.round(existingTarget.node.x + targetWidth + PHRASE_GAP_X),
          y: Math.max(0, Math.round(targetPort.y - sourcePortOffset.y)),
        };
      }

      return {
        x: Math.max(0, Math.round(targetPort.x - sourcePortOffset.x)),
        y: Math.max(0, Math.round(targetPort.y - sourcePortOffset.y - PHRASE_GAP_Y)),
      };
    }

    const previous = this.previousPhraseNode(index, nodeByElementIndex);
    if (previous) {
      const previousDef = getObjectDef(previous.type);
      return {
        x: Math.round(previous.x),
        y: Math.round(previous.y + (previous.height ?? previousDef.defaultHeight) + PHRASE_GAP_Y),
      };
    }

    return fallbackStart;
  }

  private existingTargetForNewSource(
    index: number,
    plan: PatchPhrasePlan,
    ctx: ActionContext,
  ): { node: PatchNode; fromOutlet: number; toInlets: number[] } | null {
    const connection = plan.connections.find((candidate) => candidate.fromElementIndex === index);
    if (!connection) return null;
    const target = plan.elements[connection.toElementIndex];
    if (target?.kind !== "existing") return null;
    const node = ctx.graph.nodes.get(target.nodeId);
    return node ? { node, fromOutlet: connection.fromOutlet, toInlets: connection.toInlets } : null;
  }

  private previewNode(spec: AddSpec): PatchNode {
    return new PatchGraph().addNode(spec.type, 0, 0, spec.args, null);
  }

  private previousPhraseNode(
    index: number,
    nodeByElementIndex: ReadonlyMap<number, PatchNode>,
  ): PatchNode | null {
    for (let i = index - 1; i >= 0; i--) {
      const node = nodeByElementIndex.get(i);
      if (node) return node;
    }
    return null;
  }

  private resolveEndpoint(token: string, ctx: ActionContext, label: "inlet" | "outlet"): EndpointRef {
    const dot = token.lastIndexOf(".");
    if (dot <= 0 || dot === token.length - 1) {
      throw new TerminalCommandError(`usage: ${label} endpoint must look like <node>.<port>`);
    }
    const nodeRef = token.slice(0, dot);
    const portRaw = token.slice(dot + 1);
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 0) {
      throw new TerminalCommandError(`invalid ${label} index: ${portRaw}`);
    }
    const nodeId = this.resolveSingleNode(nodeRef, ctx);
    return { nodeId, port };
  }

  private resolveSingleNode(ref: string, ctx: ActionContext): string {
    const state = this.stateFor(ctx.graph);
    const key = ref.trim();
    if (!key) throw new TerminalCommandError("missing node reference");

    const alias = state.aliases.get(key);
    if (alias && ctx.graph.nodes.has(alias)) return alias;
    if (alias) {
      state.aliases.delete(key);
    }

    const namedMatches = ctx.graph.getNodes().filter((node) => node.name === key);
    if (namedMatches.length === 1) return namedMatches[0].id;
    if (namedMatches.length > 1) throw new TerminalCommandError(`ambiguous object name: ${key}`);

    if (key === "last") {
      if (state.lastNodeId && ctx.graph.nodes.has(state.lastNodeId)) return state.lastNodeId;
      throw new TerminalCommandError("last node is not set");
    }

    if (key === "selected") {
      const ids = [...ctx.canvas.getSelectedNodeIds()].filter((id) => ctx.graph.nodes.has(id));
      if (ids.length === 1) return ids[0];
      if (ids.length === 0) throw new TerminalCommandError("no selected node");
      throw new TerminalCommandError("selected refers to multiple nodes; use an alias or node id");
    }

    const matches = [...ctx.graph.nodes.keys()].filter((id) => id.startsWith(key));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new TerminalCommandError(`ambiguous node id prefix: ${key}`);
    throw new TerminalCommandError(`unknown node: ${key}`);
  }

  private resolveAction(query: string, ctx: ActionContext) {
    const exact = ctx.registry.get(query);
    if (exact) return exact;

    const q = query.toLowerCase();
    const matches = ctx.registry.search(query);
    const exactTitleMatches = matches.filter((action) => action.title.toLowerCase() === q);
    if (exactTitleMatches.length === 1) return exactTitleMatches[0];
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new TerminalCommandError(`unknown action: ${query}`);

    const preview = matches.slice(0, 5).map((action) => action.title).join(", ");
    throw new TerminalCommandError(`ambiguous action: ${query} (${preview})`);
  }

  private ensureAliasAvailable(graph: PatchGraph, state: TerminalSessionState, alias: string): void {
    const existing = state.aliases.get(alias);
    if (existing && graph.nodes.has(existing)) throw new TerminalCommandError(`object name already exists: ${alias}`);
    if (graph.getNodes().some((node) => node.name === alias)) {
      throw new TerminalCommandError(`object name already exists: ${alias}`);
    }
  }

  private pruneAliases(state: TerminalSessionState, graph: PatchGraph): void {
    for (const [alias, nodeId] of state.aliases.entries()) {
      if (!graph.nodes.has(nodeId)) state.aliases.delete(alias);
    }
  }

  private describeNode(id: string, graph: PatchGraph): string {
    const node = graph.nodes.get(id);
    if (node?.name) return node.name;
    const state = this.stateFor(graph);
    for (const [alias, nodeId] of state.aliases.entries()) {
      if (nodeId === id) return alias;
    }
    return node ? `${node.type} ${shortId(id)}` : shortId(id);
  }

  private nameMapFor(graph: PatchGraph): ReadonlyMap<string, string> {
    const state = this.stateFor(graph);
    const names = new Map<string, string>();
    for (const node of graph.getNodes()) {
      if (node.name) names.set(node.name, node.id);
    }
    for (const [alias, nodeId] of state.aliases.entries()) {
      if (graph.nodes.has(nodeId)) names.set(alias, nodeId);
    }
    return names;
  }

  private stateFor(graph: PatchGraph): TerminalSessionState {
    let state = this.sessions.get(graph);
    if (!state) {
      state = { aliases: new Map(), lastNodeId: null };
      this.sessions.set(graph, state);
    }
    return state;
  }
}

export function tokenizeTerminalCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let tokenStarted = false;

  const push = () => {
    if (!tokenStarted) return;
    tokens.push(current);
    current = "";
    tokenStarted = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === "\\") {
        i += 1;
        if (i >= input.length) current += "\\";
        else current += input[i];
        tokenStarted = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      current += ch;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      i += 1;
      current += input[i];
      tokenStarted = true;
      continue;
    }

    if (ch === "-" && input[i + 1] === ">") {
      push();
      tokens.push("->");
      i += 1;
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  if (quote) throw new TerminalCommandError("unterminated quote");
  push();
  return tokens;
}

function tokenizePatchPhrase(input: string): PhraseToken[] {
  const tokens: PhraseToken[] = [];
  let current = "";

  const pushWord = () => {
    if (!current) return;
    tokens.push({ kind: "word", value: current });
    current = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }

    if (ch === "-" && input[i + 1] === ">") {
      pushWord();
      tokens.push({ kind: "arrow", value: "->" });
      i += 1;
      continue;
    }

    if (ch === "[") {
      pushWord();
      const end = input.indexOf("]", i + 1);
      if (end < 0) throw new TerminalCommandError("unterminated argument block");
      const raw = input.slice(i + 1, end).trim();
      tokens.push({ kind: "arg", value: raw ? tokenizeTerminalCommand(raw) : [] });
      i = end;
      continue;
    }

    if (ch === "(") {
      pushWord();
      const end = input.indexOf(")", i + 1);
      if (end < 0) throw new TerminalCommandError("unterminated alias");
      const alias = input.slice(i + 1, end).trim();
      if (!alias) throw new TerminalCommandError("empty alias");
      tokens.push({ kind: "alias", value: alias });
      i = end;
      continue;
    }

    current += ch;
  }

  pushWord();
  return tokens;
}

function parsePortToken(token: PhraseToken | undefined, label: "inlet" | "outlet"): number {
  if (token?.kind !== "word") throw new TerminalCommandError(`expected ${label} number`);
  const n = Number(token.value);
  if (!Number.isInteger(n) || n < 1) {
    throw new TerminalCommandError(`${label} numbers are 1-based; got ${token.value}`);
  }
  return n - 1;
}

function validateAlias(alias: string): void {
  try {
    validateNodeName(alias);
  } catch {
    throw new TerminalCommandError(`invalid object name: ${alias}`);
  }
  if (RESERVED_REFS.has(alias) || COMMANDS.has(alias.toLowerCase())) {
    throw new TerminalCommandError(`reserved object name: ${alias}`);
  }
}

function parseFiniteNumber(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new TerminalCommandError(`invalid ${label}: ${raw}`);
  return n;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
