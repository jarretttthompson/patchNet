import type { ActionContext } from "../actions/types";
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

interface PatchPhrasePlan {
  objects: AddSpec[];
  connections: PhraseConnection[];
}

interface PhraseConnection {
  fromObjectIndex: number;
  fromOutlet: number;
  toObjectIndex: number;
  toInlets: number[];
}

type PhraseToken =
  | { kind: "word"; value: string }
  | { kind: "arg"; value: string[] }
  | { kind: "alias"; value: string }
  | { kind: "arrow"; value: "->" };

const RESERVED_REFS = new Set(["last", "selected", "selection", "out", "in"]);
const COMMANDS = new Set(["add", "connect", "select", "delete", "move", "run"]);
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const NODE_GAP_X = 56;
const PHRASE_GAP_Y = 56;

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
    return this.stateFor(graph).aliases;
  }

  private add(tokens: string[], ctx: ActionContext): TerminalResult {
    const spec = this.parseAddSpec(tokens);
    const def = getObjectDef(spec.type);
    const state = this.stateFor(ctx.graph);
    if (spec.alias) this.ensureAliasAvailable(state, spec.alias);

    const node = ctx.graph.batchChange(() => {
      const { x, y } = this.nextPlacement(ctx, def.defaultWidth, def.defaultHeight);
      return ctx.graph.addNode(spec.type, x, y, spec.args);
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
    const plan = this.parsePatchPhrase(input);
    const state = this.stateFor(ctx.graph);
    for (const spec of plan.objects) {
      if (spec.alias) this.ensureAliasAvailable(state, spec.alias);
    }
    this.validatePatchPhrase(plan);

    const created: PatchNode[] = [];
    ctx.graph.batchChange(() => {
      const firstDef = getObjectDef(plan.objects[0].type);
      const start = this.nextPlacement(ctx, firstDef.defaultWidth, firstDef.defaultHeight);
      let y = start.y;

      for (const spec of plan.objects) {
        const node = ctx.graph.addNode(spec.type, start.x, y, spec.args);
        created.push(node);
        const def = getObjectDef(node.type);
        y = node.y + (node.height ?? def.defaultHeight) + PHRASE_GAP_Y;
      }

      for (const connection of plan.connections) {
        const from = created[connection.fromObjectIndex];
        const to = created[connection.toObjectIndex];
        for (const inlet of connection.toInlets) {
          ctx.graph.addEdge(from.id, connection.fromOutlet, to.id, inlet);
        }
      }
    });

    for (let i = 0; i < plan.objects.length; i++) {
      const alias = plan.objects[i].alias;
      if (alias) state.aliases.set(alias, created[i].id);
    }
    state.lastNodeId = created[created.length - 1]?.id ?? state.lastNodeId;
    ctx.canvas.selectNodes(new Set(created.map((node) => node.id)));

    const cableCount = plan.connections.reduce((count, c) => count + c.toInlets.length, 0);
    return {
      ok: true,
      message: `built patch phrase: ${created.length} objects, ${cableCount} cable${cableCount === 1 ? "" : "s"}`,
      touchedNodeIds: created.map((node) => node.id),
    };
  }

  private parsePatchPhrase(input: string): PatchPhrasePlan {
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

    const parseObjectSpec = (): AddSpec => {
      const typeToken = read();
      if (typeToken?.kind !== "word") {
        throw new TerminalCommandError("expected object type in patch phrase");
      }
      if (typeToken.value === "out" || typeToken.value === "in") {
        throw new TerminalCommandError(`expected object type, got ${typeToken.value}`);
      }

      const type = canonicalizeType(typeToken.value);
      if (!OBJECT_DEFS[type]) throw new TerminalCommandError(`unknown object type: ${typeToken.value}`);
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

      return { type, args, alias };
    };

    const objects: AddSpec[] = [parseObjectSpec()];
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

      const fromObjectIndex = objects.length - 1;
      const target = parseObjectSpec();
      objects.push(target);
      connections.push({
        fromObjectIndex,
        fromOutlet,
        toObjectIndex: objects.length - 1,
        toInlets,
      });
    }

    return { objects, connections };
  }

  private validatePatchPhrase(plan: PatchPhrasePlan): void {
    const temp = new PatchGraph();
    const tempNodes = plan.objects.map((spec, index) =>
      temp.addNode(spec.type, 0, index * 100, spec.args),
    );
    try {
      for (const connection of plan.connections) {
        const from = tempNodes[connection.fromObjectIndex];
        const to = tempNodes[connection.toObjectIndex];
        for (const inlet of connection.toInlets) {
          temp.addEdge(from.id, connection.fromOutlet, to.id, inlet);
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
      throw new TerminalCommandError(`alias points to a missing node: ${key}`);
    }

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

  private ensureAliasAvailable(state: TerminalSessionState, alias: string): void {
    const existing = state.aliases.get(alias);
    if (existing) throw new TerminalCommandError(`alias already exists: ${alias}`);
  }

  private pruneAliases(state: TerminalSessionState, graph: PatchGraph): void {
    for (const [alias, nodeId] of state.aliases.entries()) {
      if (!graph.nodes.has(nodeId)) state.aliases.delete(alias);
    }
  }

  private describeNode(id: string, graph: PatchGraph): string {
    const state = this.stateFor(graph);
    for (const [alias, nodeId] of state.aliases.entries()) {
      if (nodeId === id) return alias;
    }
    const node = graph.nodes.get(id);
    return node ? `${node.type} ${shortId(id)}` : shortId(id);
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
  if (!ALIAS_RE.test(alias)) {
    throw new TerminalCommandError(`invalid alias: ${alias}`);
  }
  if (RESERVED_REFS.has(alias) || COMMANDS.has(alias.toLowerCase())) {
    throw new TerminalCommandError(`reserved alias: ${alias}`);
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
