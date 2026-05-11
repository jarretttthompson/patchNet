import type { ActionContext } from "../actions/types";
import { getPortPos } from "../canvas/CableRenderer";
import { GRID_CELL_PX } from "../canvas/canvasSpace";
import { validateNodeName } from "../graph/nodeNames";
import { canonicalizeType, getObjectDef, getAvailableObjectDefs, OBJECT_DEFS } from "../graph/objectDefs";
import { PLATFORM } from "../platform/index";

// Objects available on the current platform. Used for type validation in
// user-facing commands (add, phrase parser). The full OBJECT_DEFS is still
// used for name-conflict checks so native-only type names stay reserved.
const AVAILABLE_DEFS = getAvailableObjectDefs(PLATFORM);
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
  // Explicit grid-cell placement from a `(gx, gy)` block after the alias.
  // null means "auto-place" (chained below previous, or above existing target).
  position: { gx: number; gy: number } | null;
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
  // "connect" wires the listed inlets to fromOutlet; "disconnect" severs
  // those edges if they exist (no-op if they don't).
  kind: "connect" | "disconnect";
}

type PhraseToken =
  | { kind: "word"; value: string }
  | { kind: "arg"; value: string[] }
  | { kind: "alias"; value: string }
  | { kind: "arrow"; value: "->" }
  | { kind: "sever"; value: "x" }
  | { kind: "coords"; value: { gx: number; gy: number } };

const RESERVED_REFS = new Set(["last", "selected", "selection", "out", "in"]);
const COMMANDS = new Set(["add", "connect", "select", "delete", "move", "run", "set"]);
// Object types whose port count/shape is computed from their args. `set`
// refuses to touch these because changing args without re-deriving ports
// would leave dangling edges; the patch-phrase rebuild path handles them.
const ARGS_DERIVE_PORTS = new Set([
  "t", "trigger",
  "pack", "unpack",
  "route",
  "sequencer",
  "fft~",
  "mixer~",
  "js~",
  "buffer~",
  "reaperVideo*",
]);
const HELP_TEXT = [
  "commands:",
  "  add <type> [args...] [as <name>]   create an object",
  "  connect <a>.<n> - <b>.<n>          wire two existing nodes",
  "  select <ref...>                    select nodes",
  "  delete <ref|selection>             remove nodes",
  "  move <ref> <x> <y>                 move (raw pixels)",
  "  set <ref> <args...>                replace an object's args",
  "  run <action title>                 fire an action by name",
  "",
  "patch phrases (braces optional):",
  "  toggle (tog1) out_1 - in_1 metro [500] (metro1)",
  "  metro1 (5, 2)                      move to grid cell",
  "  message (msg1)(20, 7)              create + place at grid cell",
  "  int1 out_1 x in_1 metro1           sever an existing cable",
  "",
  "slash commands:",
  "  /dspOn  /dspOff  /save  /clear  /list  /help",
  "  /run <action title>                fire any action shown in the menu",
  "  /define <name> [(<shortcut>)] = <body>  register a custom action; shortcut optional",
  "  /undefine <name>                   remove a custom action",
  "  /macros                            list all custom actions",
  "  /bind <name> <shortcut>            bind a keyboard shortcut to an existing macro",
  "  /unbind <name>                     remove all keyboard shortcuts from a macro",
].join("\n");
const MACRO_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_MACRO_DEPTH = 8;
const MACRO_STORAGE_KEY = "patchnet-macros";
const NODE_GAP_X = 56;
const PHRASE_GAP_Y = 6;

// Decides whether a brace-less input should be parsed as a patch phrase. The
// disambiguation rule: phrases never start with a reserved command keyword,
// so anything else is a phrase. Returns false for empty input so the empty
// short-circuit in `execute` still kicks in.
function isBarePhrase(input: string): boolean {
  const match = /^\S+/.exec(input);
  if (!match) return false;
  return !COMMANDS.has(match[0].toLowerCase());
}

function nodeBox(node: PatchNode): { left: number; right: number; top: number; bottom: number } {
  const def = getObjectDef(node.type);
  return {
    left: node.x,
    right: node.x + (node.width ?? def.defaultWidth),
    top: node.y,
    bottom: node.y + (node.height ?? def.defaultHeight),
  };
}

export class TerminalCommandError extends Error {}

interface MacroDef {
  name: string;
  body: string;
  /** User-bound keyboard chords for this macro. Empty when unbound. */
  chords: string[];
}

export class PatchTerminalEngine {
  private readonly sessions = new WeakMap<PatchGraph, TerminalSessionState>();
  // User-defined macros. Each lives both here (so the engine can list/remove
  // them and inspect bodies on re-registration) and in the action registry
  // (so they show up in the action menu and respond to `/run <name>`).
  private readonly macros = new Map<string, MacroDef>();
  private macroDepth = 0;

  /** Read-only snapshot of currently registered macros — used by tests. */
  macrosFor(): ReadonlyMap<string, MacroDef> { return this.macros; }

  async execute(input: string, ctx: ActionContext): Promise<TerminalResult> {
    const trimmed = input.trim();
    if (!trimmed) return { ok: true, message: "" };

    try {
      if (trimmed.startsWith("/")) {
        return await this.runSlashCommand(trimmed.slice(1), ctx);
      }

      // Shorthand move: `<nodeRef> (<gx>, <gy>)` aligns the upper-left corner
      // of the node with grid cell (gx, gy). Skipped when the ref is actually
      // an object type — `toggle (3, 3)` creates a toggle at that cell via
      // the phrase parser instead.
      const movePattern = /^(\S+)\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/;
      const moveMatch = movePattern.exec(trimmed);
      if (
        moveMatch
        && !COMMANDS.has(moveMatch[1].toLowerCase())
        && !AVAILABLE_DEFS[canonicalizeType(moveMatch[1])]
      ) {
        const [, ref, gx, gy] = moveMatch;
        return this.moveByGrid(ref, gx, gy, ctx);
      }

      // Patch phrase: explicit braces OR any input whose leading word isn't
      // a reserved command keyword. Braces are still accepted for clarity /
      // backward compatibility with logs.
      if (trimmed.startsWith("{") || trimmed.endsWith("}") || isBarePhrase(trimmed)) {
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
        case "set": return this.setArgs(args, ctx);
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
      throw new TerminalCommandError("usage: connect <source>.<outlet> - <target>.<inlet>");
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

  // Grid-cell move used by the `<ref> (gx, gy)` shorthand. Converts grid
  // coordinates (matching the ruler) to world pixels before mutating the
  // node, and reports the result back in grid units so the user sees the
  // same numbers they typed.
  private moveByGrid(ref: string, gxRaw: string, gyRaw: string, ctx: ActionContext): TerminalResult {
    const gx = parseFiniteNumber(gxRaw, "x");
    const gy = parseFiniteNumber(gyRaw, "y");
    const id = this.resolveSingleNode(ref, ctx);
    const node = ctx.graph.nodes.get(id);
    if (!node) throw new TerminalCommandError(`unknown node: ${ref}`);
    const x = gx * GRID_CELL_PX;
    const y = gy * GRID_CELL_PX;
    if (node.x === x && node.y === y) {
      return { ok: true, message: "node already at that position", touchedNodeIds: [id] };
    }
    ctx.graph.batchChange(() => ctx.graph.setNodePosition(id, x, y));
    ctx.canvas.selectNode(id);
    this.stateFor(ctx.graph).lastNodeId = id;
    return {
      ok: true,
      message: `moved ${this.describeNode(id, ctx.graph)} to (${gx}, ${gy})`,
      touchedNodeIds: [id],
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

  // Slash commands are app-level toggles invoked with a leading `/` so they
  // never collide with object names or the phrase grammar.
  //   /dspOn        — start audio (no-op if already running)
  //   /dspOff       — stop audio  (no-op if already stopped)
  //   /save         — write the active patch to disk via the autosave handle
  //   /clear        — remove every node from the active graph (one undo step)
  //   /list         — print every node sorted top-to-bottom
  //   /help         — print available commands
  //   /run <title>  — fire any registered action by title (same surface as
  //                   the `run` command, just shorter to type and consistent
  //                   with the action menu's terminal column)
  private async runSlashCommand(rest: string, ctx: ActionContext): Promise<TerminalResult> {
    const trimmed = rest.trim();
    if (!trimmed) throw new TerminalCommandError("usage: /<command>");
    // Split into command word + argument tail. Keeps the tail's case so
    // action titles like "Toggle DSP" match exactly.
    const spaceIdx = trimmed.search(/\s/);
    const cmd = (spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const tail = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1).trim();
    switch (cmd) {
      case "dspon":
        if (ctx.app.isDspOn()) return { ok: true, message: "DSP already on" };
        ctx.app.toggleDsp();
        return { ok: true, message: "DSP on" };
      case "dspoff":
        if (!ctx.app.isDspOn()) return { ok: true, message: "DSP already off" };
        ctx.app.toggleDsp();
        return { ok: true, message: "DSP off" };
      case "save":
        await ctx.app.saveToFile();
        return { ok: true, message: "saved" };
      case "clear": {
        const ids = ctx.graph.getNodes().map((n) => n.id);
        if (ids.length === 0) return { ok: true, message: "nothing to clear" };
        ctx.graph.batchChange(() => {
          for (const id of ids) ctx.graph.removeNode(id);
        });
        ctx.canvas.selectNodes(new Set());
        return {
          ok: true,
          message: `cleared ${ids.length} node${ids.length === 1 ? "" : "s"}`,
          touchedNodeIds: ids,
        };
      }
      case "list":
        return this.listNodes(ctx);
      case "help":
        return { ok: true, message: HELP_TEXT };
      case "run":
        if (!tail) throw new TerminalCommandError("usage: /run <action title>");
        return this.runAction([tail], ctx);
      case "define":
        return this.defineMacro(tail, ctx);
      case "undefine":
        return this.undefineMacro(tail, ctx);
      case "macros":
        return this.listMacros();
      case "bind":
        return this.bindMacro(tail, ctx);
      case "unbind":
        return this.unbindMacro(tail, ctx);
      default:
        throw new TerminalCommandError(`unknown slash command: /${rest}`);
    }
  }

  private defineMacro(rest: string, ctx: ActionContext): TerminalResult {
    // Optional `(<chord>)` between the name and `=` binds a key to the
    // macro at definition time, e.g.  /define synth (Cmd+Shift+S) = ...
    const m = /^(\S+?)(?:\s*\(([^)]+)\))?\s*=\s*(.+)$/.exec(rest);
    if (!m) throw new TerminalCommandError("usage: /define <name> [(<shortcut>)] = <body>");
    return this.createMacro(
      { name: m[1], body: m[3].trim(), chord: m[2]?.trim() ?? null },
      ctx,
    );
  }

  /**
   * Public programmatic macro creator — mirrors `/define` but skips the line
   * parsing so callers (the action-list "New action…" form) can pass a
   * multi-line body verbatim. Same validation, same persistence, same return
   * shape.
   */
  createMacro(
    spec: { name: string; body: string; chord?: string | null },
    ctx: ActionContext,
  ): TerminalResult {
    const { name, body } = spec;
    const chord = spec.chord || null;
    if (!body.trim()) throw new TerminalCommandError("macro body is empty");
    if (!MACRO_NAME_RE.test(name)) {
      throw new TerminalCommandError(
        `invalid macro name: ${name} (letters, digits, _, - only; must start with a letter)`,
      );
    }
    const lower = name.toLowerCase();
    if (COMMANDS.has(lower)) {
      throw new TerminalCommandError(`macro name "${name}" conflicts with a built-in command`);
    }
    if (OBJECT_DEFS[canonicalizeType(name)]) {
      throw new TerminalCommandError(`macro name "${name}" conflicts with an object type`);
    }

    const id = `user.${name}`;
    const replacing = this.macros.has(name);
    if (replacing) ctx.registry.unregister(id);
    if (!replacing && ctx.registry.get(id)) {
      throw new TerminalCommandError(`action ${id} is already registered (not as a macro)`);
    }

    // Carry forward any existing chords if this is a redefine, so binding
    // is preserved when only the body changed.
    const prior = this.macros.get(name);
    const chords = prior ? [...prior.chords] : [];
    this.macros.set(name, { name, body, chords });
    this.registerMacroAction(name, body, ctx);
    if (chord) {
      try {
        this.applyChord(name, chord, ctx);
      } catch (err) {
        // Macro is already registered; chord was the bonus. Surface the
        // error but don't unwind the definition.
        const reason = err instanceof Error ? err.message : String(err);
        this.persistMacros();
        return { ok: false, message: `defined ${name}, but keyboard shortcut rejected: ${reason}` };
      }
    }
    this.persistMacros();

    return {
      ok: true,
      message: replacing ? `redefined ${name}` : `defined ${name}`,
    };
  }

  private bindMacro(rest: string, ctx: ActionContext): TerminalResult {
    const tokens = rest.trim().split(/\s+/);
    if (tokens.length < 2 || !tokens[0] || !tokens[1]) {
      throw new TerminalCommandError("usage: /bind <name> <shortcut>");
    }
    const name = tokens[0];
    const chord = tokens.slice(1).join(" ");
    if (!this.macros.has(name)) {
      throw new TerminalCommandError(`no macro named ${name}`);
    }
    this.applyChord(name, chord, ctx);
    this.persistMacros();
    return { ok: true, message: `bound ${chord} to ${name}` };
  }

  private unbindMacro(rest: string, ctx: ActionContext): TerminalResult {
    const name = rest.trim();
    if (!name) throw new TerminalCommandError("usage: /unbind <name>");
    const macro = this.macros.get(name);
    if (!macro) throw new TerminalCommandError(`no macro named ${name}`);
    if (macro.chords.length === 0) {
      return { ok: true, message: `${name} has no bindings` };
    }
    const removed = [...macro.chords];
    for (const c of removed) {
      ctx.keymap.removeUserBinding(`user.${name}`, c);
    }
    macro.chords = [];
    this.persistMacros();
    return { ok: true, message: `unbound ${removed.join(", ")} from ${name}` };
  }

  // Add a chord to a macro and remember it so we can re-apply on reload.
  private applyChord(name: string, chord: string, ctx: ActionContext): void {
    ctx.keymap.addUserBinding(`user.${name}`, chord);
    const macro = this.macros.get(name);
    if (macro && !macro.chords.includes(chord)) macro.chords.push(chord);
  }

  private undefineMacro(rest: string, ctx: ActionContext): TerminalResult {
    const name = rest.trim();
    if (!name) throw new TerminalCommandError("usage: /undefine <name>");
    const macro = this.macros.get(name);
    if (!macro) {
      throw new TerminalCommandError(`no macro named ${name}`);
    }
    // Drop any keymap bindings first so the keymap doesn't keep dangling
    // references to a now-unregistered action id.
    for (const chord of macro.chords) {
      ctx.keymap.removeUserBinding(`user.${name}`, chord);
    }
    this.macros.delete(name);
    ctx.registry.unregister(`user.${name}`);
    this.persistMacros();
    return { ok: true, message: `undefined ${name}` };
  }

  private registerMacroAction(name: string, body: string, ctx: ActionContext): void {
    ctx.registry.register({
      id: `user.${name}`,
      title: name,
      section: "Custom",
      run: async (innerCtx) => {
        await this.executeMacro(name, body, innerCtx);
      },
    });
  }

  /**
   * Restore persisted macros into the engine + the action registry. Called
   * on app boot once the registry is set up. Silently skips entries that
   * collide with current built-ins or object types — the storage is a
   * best-effort cache, not authoritative.
   */
  loadMacros(ctx: ActionContext): void {
    if (typeof localStorage === "undefined") return;
    let raw: string | null = null;
    try { raw = localStorage.getItem(MACRO_STORAGE_KEY); } catch { return; }
    if (!raw) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      const body = (entry as { body?: unknown }).body;
      if (typeof name !== "string" || typeof body !== "string") continue;
      if (!MACRO_NAME_RE.test(name)) continue;
      if (this.macros.has(name)) continue;
      const lower = name.toLowerCase();
      if (COMMANDS.has(lower)) continue;
      if (OBJECT_DEFS[canonicalizeType(name)]) continue;
      if (ctx.registry.get(`user.${name}`)) continue;
      const rawChords = (entry as { chords?: unknown }).chords;
      const chords = Array.isArray(rawChords)
        ? rawChords.filter((c): c is string => typeof c === "string")
        : [];
      this.macros.set(name, { name, body, chords: [] });
      this.registerMacroAction(name, body, ctx);
      // Re-apply chords through applyChord so the keymap is updated and the
      // chord list on the MacroDef stays the canonical source of truth.
      for (const chord of chords) {
        try {
          this.applyChord(name, chord, ctx);
        } catch {
          // Stale chord (key syntax changed across versions) — drop silently.
        }
      }
    }
  }

  private persistMacros(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const arr = [...this.macros.values()].map((m) => ({
        name: m.name,
        body: m.body,
        chords: m.chords,
      }));
      localStorage.setItem(MACRO_STORAGE_KEY, JSON.stringify(arr));
    } catch {
      // quota exceeded / private browsing — keep running, just don't persist.
    }
  }

  private listMacros(): TerminalResult {
    if (this.macros.size === 0) return { ok: true, message: "(no macros)" };
    const sorted = [...this.macros.values()].sort((a, b) => a.name.localeCompare(b.name));
    const labelWidth = sorted.reduce((w, m) => Math.max(w, m.name.length), 0);
    const lines = sorted.map((m) => `${m.name.padEnd(labelWidth)}  = ${m.body}`);
    return { ok: true, message: lines.join("\n") };
  }

  private async executeMacro(name: string, body: string, ctx: ActionContext): Promise<void> {
    if (this.macroDepth >= MAX_MACRO_DEPTH) {
      throw new TerminalCommandError(`macro recursion depth (${MAX_MACRO_DEPTH}) exceeded in ${name}`);
    }
    this.macroDepth += 1;
    try {
      // `;` separates steps. Empty steps (trailing `;`, double `;`) are
      // skipped so users can format multi-line macros loosely.
      const steps = body.split(";").map((s) => s.trim()).filter(Boolean);
      for (const step of steps) {
        const result = await this.execute(step, ctx);
        if (!result.ok) {
          throw new TerminalCommandError(`macro ${name} step failed: ${result.message}`);
        }
      }
    } finally {
      this.macroDepth -= 1;
    }
  }

  private listNodes(ctx: ActionContext): TerminalResult {
    const nodes = ctx.graph.getNodes();
    if (nodes.length === 0) return { ok: true, message: "(no nodes)" };
    // Sort by visual position so the printed order matches what the user
    // sees on the canvas — top-to-bottom, then left-to-right.
    const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    const labelWidth = sorted.reduce(
      (w, n) => Math.max(w, (n.name ?? shortId(n.id)).length),
      0,
    );
    const typeWidth = sorted.reduce((w, n) => Math.max(w, n.type.length), 0);
    const lines = sorted.map((n) => {
      const label = (n.name ?? shortId(n.id)).padEnd(labelWidth);
      const type = n.type.padEnd(typeWidth);
      const args = n.args.length > 0 ? ` ${n.args.join(" ")}` : "";
      const gx = n.x / GRID_CELL_PX;
      const gy = n.y / GRID_CELL_PX;
      return `${label}  ${type}${args}  @ (${formatGrid(gx)}, ${formatGrid(gy)})`;
    });
    return { ok: true, message: lines.join("\n") };
  }

  private setArgs(tokens: string[], ctx: ActionContext): TerminalResult {
    if (tokens.length < 2) {
      throw new TerminalCommandError("usage: set <node> <args...>");
    }
    const id = this.resolveSingleNode(tokens[0], ctx);
    const node = ctx.graph.nodes.get(id);
    if (!node) throw new TerminalCommandError(`unknown node: ${tokens[0]}`);
    if (ARGS_DERIVE_PORTS.has(node.type)) {
      throw new TerminalCommandError(
        `set on '${node.type}' isn't supported — its args determine its port shape; rebuild via patch phrase`,
      );
    }
    const newArgs = tokens.slice(1);
    node.args = newArgs;
    ctx.graph.batchChange(() => ctx.graph.emit("change"));
    ctx.canvas.selectNode(id);
    return {
      ok: true,
      message: `set ${this.describeNode(id, ctx.graph)} args to ${newArgs.join(" ") || "(empty)"}`,
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
    let removedCount = 0;
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
        // Explicit `(gx, gy)` block bypasses the auto-placement / make-room
        // logic — the user has asked for an exact grid cell.
        const placement = spec.position
          ? { x: spec.position.gx * GRID_CELL_PX, y: spec.position.gy * GRID_CELL_PX }
          : this.nextPhraseElementPlacement(i, spec, plan, nodeByElementIndex, ctx, start);
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
        if (connection.kind === "disconnect") {
          for (const inlet of connection.toInlets) {
            const edge = ctx.graph.getEdges().find((e) =>
              e.fromNodeId === from.id &&
              e.fromOutlet === connection.fromOutlet &&
              e.toNodeId === to.id &&
              e.toInlet === inlet,
            );
            if (edge) {
              ctx.graph.removeEdge(edge.id);
              removedCount += 1;
            }
          }
        } else {
          for (const inlet of connection.toInlets) {
            ctx.graph.addEdge(from.id, connection.fromOutlet, to.id, inlet);
          }
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

    const cableCount = plan.connections
      .filter((c) => c.kind === "connect")
      .reduce((count, c) => count + c.toInlets.length, 0);
    const objectLabel = created.length === 1 ? "object" : "objects";
    const parts = [`${created.length} ${objectLabel}`, `${cableCount} cable${cableCount === 1 ? "" : "s"}`];
    if (removedCount > 0) {
      parts.push(`${removedCount} removed`);
    }
    return {
      ok: true,
      message: `built patch phrase: ${parts.join(", ")}`,
      touchedNodeIds: [...touchedNodeIds],
    };
  }

  private parsePatchPhrase(input: string, ctx: ActionContext): PatchPhrasePlan {
    let trimmed = input.trim();
    // Curly braces are optional but must come as a pair when present —
    // they're still accepted for backward compatibility with phrases pasted
    // from logs or written before the braces became optional.
    const opens = trimmed.startsWith("{");
    const closes = trimmed.endsWith("}");
    if (opens !== closes) {
      throw new TerminalCommandError("unmatched brace in patch phrase");
    }
    if (opens && closes) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    if (!trimmed) throw new TerminalCommandError("empty patch phrase");
    const inner = trimmed;

    const tokens = tokenizePatchPhrase(inner);
    let index = 0;
    const aliases = new Set<string>();

    const read = (): PhraseToken | undefined => tokens[index];

    const parseElement = (): PhraseElement => {
      const typeToken = read();
      if (typeToken?.kind !== "word") {
        throw new TerminalCommandError("expected object type or node reference in patch phrase");
      }
      if (typeToken.value === "out" || typeToken.value === "in") {
        throw new TerminalCommandError(`expected object type or node reference, got ${typeToken.value}`);
      }

      const type = canonicalizeType(typeToken.value);
      if (!AVAILABLE_DEFS[type]) {
        const nodeId = this.resolveSingleNode(typeToken.value, ctx);
        index += 1;
        const next = read();
        if (next?.kind === "arg" || next?.kind === "alias" || next?.kind === "coords") {
          throw new TerminalCommandError(
            `existing node reference cannot have args, alias, or coords: ${typeToken.value}`,
          );
        }
        return { kind: "existing", ref: typeToken.value, nodeId };
      }

      index += 1;
      const args: string[] = [];
      let alias: string | null = null;
      let position: { gx: number; gy: number } | null = null;
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
        if (token.kind === "coords") {
          if (position) throw new TerminalCommandError(`object ${type} has more than one coord block`);
          position = token.value;
          index += 1;
          continue;
        }
        break;
      }

      return { kind: "new", spec: { type, args, alias, position } };
    };

    const elements: PhraseElement[] = [parseElement()];
    const connections: PhraseConnection[] = [];

    while (index < tokens.length) {
      const fromOutlet = parseDirectionalPort(tokens[index], "out");
      if (fromOutlet === null) {
        throw new TerminalCommandError("expected out_<n> - in_<n> ...");
      }
      index += 1;

      const op = read();
      let kind: "connect" | "disconnect";
      if (op?.kind === "arrow") kind = "connect";
      else if (op?.kind === "sever") kind = "disconnect";
      else throw new TerminalCommandError("expected - or x after out_<n>");
      index += 1;

      const toInlets: number[] = [];
      while (true) {
        const port = parseDirectionalPort(tokens[index], "in");
        if (port === null) break;
        toInlets.push(port);
        index += 1;
      }
      if (toInlets.length === 0) {
        const op = kind === "connect" ? "-" : "x";
        throw new TerminalCommandError(`expected at least one in_<n> after ${op}`);
      }

      const fromElementIndex = elements.length - 1;
      const target = parseElement();
      elements.push(target);
      connections.push({
        fromElementIndex,
        fromOutlet,
        toElementIndex: elements.length - 1,
        toInlets,
        kind,
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
    if (!AVAILABLE_DEFS[type]) throw new TerminalCommandError(
      OBJECT_DEFS[type]
        ? `${tokens[0]} is only available in the desktop version`
        : `unknown object type: ${tokens[0]}`,
    );

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

    return { type, args, alias, position: null };
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
      const previewSource = this.previewNode(spec);
      const previewDef = getObjectDef(spec.type);
      const previewWidth = previewSource.width ?? previewDef.defaultWidth;
      const previewHeight = previewSource.height ?? previewDef.defaultHeight;
      const firstInlet = Math.min(...existingTarget.toInlets);
      const targetPort = getPortPos(existingTarget.node, "inlet", firstInlet);
      const sourcePort = getPortPos(previewSource, "outlet", existingTarget.fromOutlet);
      const sourcePortOffset = {
        x: sourcePort.x - previewSource.x,
        y: sourcePort.y - previewSource.y,
      };

      // Always place the new source above the target, aligning the source's
      // outlet x with the target's inlet x.
      const desiredX = Math.round(targetPort.x - sourcePortOffset.x);
      const desiredY = Math.round(targetPort.y - sourcePortOffset.y - PHRASE_GAP_Y);

      const shifts = this.computeMakeRoomShifts(
        { x: desiredX, y: desiredY, width: previewWidth, height: previewHeight },
        existingTarget.node,
        ctx,
      );

      for (const [nodeId, dy] of shifts) {
        const node = ctx.graph.nodes.get(nodeId);
        if (node) ctx.graph.setNodePosition(nodeId, node.x, node.y + dy);
      }

      const targetShift = shifts.get(existingTarget.node.id) ?? 0;
      return {
        x: Math.max(0, desiredX),
        y: Math.max(0, desiredY + targetShift),
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
    // Only honor connect-kind here: a disconnect doesn't justify placing the
    // new node above a target it's about to be severed from.
    const connection = plan.connections.find(
      (candidate) => candidate.fromElementIndex === index && candidate.kind === "connect",
    );
    if (!connection) return null;
    const target = plan.elements[connection.toElementIndex];
    if (target?.kind !== "existing") return null;
    const node = ctx.graph.nodes.get(target.nodeId);
    return node ? { node, fromOutlet: connection.fromOutlet, toInlets: connection.toInlets } : null;
  }

  private previewNode(spec: AddSpec): PatchNode {
    return new PatchGraph().addNode(spec.type, 0, 0, spec.args, null);
  }

  // Computes downward shifts needed to make room above the target for a new
  // node at `newRect`. Always shifts the target itself (when y<0 or an
  // obstacle blocks the slot) and cascades the shift to anything the moved
  // target then collides with — so a chained metro→sequencer doesn't end up
  // overlapping when metro is pushed down. Returns nodeId → dy (positive =
  // move down). Empty map means no shift needed.
  private computeMakeRoomShifts(
    newRect: { x: number; y: number; width: number; height: number },
    target: PatchNode,
    ctx: ActionContext,
  ): Map<string, number> {
    const shifts = new Map<string, number>();
    let targetShift = newRect.y < 0 ? -newRect.y : 0;
    const newLeft = newRect.x;
    const newRight = newRect.x + newRect.width;
    const newTop = newRect.y;
    const newBottom = newRect.y + newRect.height;
    for (const node of ctx.graph.getNodes()) {
      if (node.id === target.id) continue;
      const r = nodeBox(node);
      if (newLeft >= r.right || newRight <= r.left) continue;
      if (newBottom <= r.top || newTop >= r.bottom) continue;
      const required = r.bottom + PHRASE_GAP_Y - newTop;
      if (required > targetShift) targetShift = required;
    }
    if (targetShift <= 0) return shifts;
    shifts.set(target.id, targetShift);

    // Cascade: a node that overlaps with a shifted node's new rect gets pushed
    // down enough to clear it. Skip nodes above the shifted node (otherwise we
    // would push them into it from above). Iterate to a fixed point so a long
    // downstream chain all moves together.
    let changed = true;
    while (changed) {
      changed = false;
      for (const mover of ctx.graph.getNodes()) {
        const moverShift = shifts.get(mover.id);
        if (moverShift === undefined) continue;
        const m = nodeBox(mover);
        const mTop = m.top + moverShift;
        const mBottom = m.bottom + moverShift;
        for (const other of ctx.graph.getNodes()) {
          if (other.id === mover.id) continue;
          const otherShift = shifts.get(other.id) ?? 0;
          const o = nodeBox(other);
          const oTop = o.top + otherShift;
          const oBottom = o.bottom + otherShift;
          if (m.left >= o.right || m.right <= o.left) continue;
          if (mBottom <= oTop || mTop >= oBottom) continue;
          if (oTop < mTop) continue; // never push a node upward
          const required = mBottom + PHRASE_GAP_Y - o.top;
          if (required > otherShift) {
            shifts.set(other.id, required);
            changed = true;
          }
        }
      }
    }
    return shifts;
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

    // `->` is always an arrow, even mid-token (e.g. `osc.0->out.1`).
    if (ch === "-" && input[i + 1] === ">") {
      push();
      tokens.push("->");
      i += 1;
      continue;
    }

    // Standalone `-` at a token boundary acts as an arrow too, but only when
    // the next char is whitespace/end so negatives like `-1` stay attached.
    if (ch === "-" && !tokenStarted) {
      const next = input[i + 1];
      if (next === undefined || /\s/.test(next)) {
        push();
        tokens.push("->");
        continue;
      }
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

    // `->` is always an arrow.
    if (ch === "-" && input[i + 1] === ">") {
      pushWord();
      tokens.push({ kind: "arrow", value: "->" });
      i += 1;
      continue;
    }

    // Standalone `-` at a word boundary is also an arrow, but only when the
    // next char is whitespace/end so a `-1` arg stays attached to the number.
    if (ch === "-" && !current) {
      const next = input[i + 1];
      if (next === undefined || /\s/.test(next)) {
        pushWord();
        tokens.push({ kind: "arrow", value: "->" });
        continue;
      }
    }

    // Standalone `x` between port specs is the sever operator — disconnects
    // matching inlets from the source outlet. Only treated as sever when both
    // sides are word boundaries; otherwise `x` is a normal letter.
    if (ch === "x" && !current) {
      const next = input[i + 1];
      if (next === undefined || /\s/.test(next)) {
        pushWord();
        tokens.push({ kind: "sever", value: "x" });
        continue;
      }
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
      if (end < 0) throw new TerminalCommandError("unterminated alias or coord block");
      const inside = input.slice(i + 1, end).trim();
      if (!inside) throw new TerminalCommandError("empty parens");
      // `(gx, gy)` — two numbers separated by a comma — is a placement block.
      // Anything else is treated as an alias.
      const coordsMatch = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(inside);
      if (coordsMatch) {
        tokens.push({
          kind: "coords",
          value: { gx: Number(coordsMatch[1]), gy: Number(coordsMatch[2]) },
        });
      } else {
        tokens.push({ kind: "alias", value: inside });
      }
      i = end;
      continue;
    }

    current += ch;
  }

  pushWord();
  return tokens;
}

// Patch-phrase port form: ports are written as `out_<n>` / `in_<n>` so the
// direction and 1-based index travel together as a single token. Returns the
// 0-based port index, or null if the token doesn't match the expected
// direction (so the caller can decide whether the chain is over).
function parseDirectionalPort(
  token: PhraseToken | undefined,
  expected: "in" | "out",
): number | null {
  if (token?.kind !== "word") return null;
  const m = /^(in|out)_(\d+)$/.exec(token.value);
  if (!m || m[1] !== expected) return null;
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 1) {
    const label = expected === "in" ? "inlet" : "outlet";
    throw new TerminalCommandError(`${label} numbers are 1-based; got ${m[2]}`);
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

// Render a grid coord without an unnecessary `.0` so `/list` lines up with
// the way the user typed coordinates: `(5, 2)` not `(5.0, 2.0)`.
function formatGrid(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}
