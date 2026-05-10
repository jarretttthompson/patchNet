import { describe, expect, it } from "vitest";

import { ActionKeymap } from "../src/actions/ActionKeymap";
import { ActionRegistry } from "../src/actions/ActionRegistry";
import type { ActionContext, AppActionsAPI, PatchAction } from "../src/actions/types";
import { getPortPos } from "../src/canvas/CableRenderer";
import { getObjectDef } from "../src/graph/objectDefs";
import { PatchGraph } from "../src/graph/PatchGraph";
import { UndoManager } from "../src/graph/UndoManager";
import { PatchTerminalEngine, tokenizeTerminalCommand } from "../src/terminal/PatchTerminalEngine";

function makeAction(partial: Partial<PatchAction> & { id: string }): PatchAction {
  return {
    title: partial.title ?? partial.id,
    section: partial.section ?? "Test",
    run: partial.run ?? (() => {}),
    ...partial,
  };
}

function makeHarness(graph = new PatchGraph(), registry = new ActionRegistry()) {
  let selected = new Set<string>();

  const canvas = {
    getSelectedNodeIds: () => selected,
    selectNode: (id: string | null) => {
      selected = id ? new Set([id]) : new Set();
    },
    selectNodes: (ids: Set<string>) => {
      selected = new Set(ids);
    },
    deleteSelection: () => {
      const ids = [...selected];
      selected = new Set();
      graph.batchChange(() => {
        for (const id of ids) graph.removeNode(id);
      });
    },
    viewportCenter: () => [200, 100] as [number, number],
  };

  const app: AppActionsAPI = {
    saveToFile: () => {},
    openLoadPicker: () => {},
    share: () => {},
    toggleDsp: () => {},
    isDspOn: () => false,
    togglePatchMode: () => {},
    isPatchMode: () => true,
    toggleToolbar: () => {},
    toggleConsole: () => {},
    togglePatchTerminal: () => {},
    newScratchTab: () => {},
  };

  const ctx: ActionContext = {
    graph,
    canvas: canvas as unknown as ActionContext["canvas"],
    interaction: {} as ActionContext["interaction"],
    undo: null,
    app,
    openActionList: () => {},
    flashStatus: () => {},
    registry,
    keymap: new ActionKeymap(registry),
  };

  return {
    ctx,
    get selected() { return selected; },
  };
}

describe("patch terminal tokenizer", () => {
  it("splits shell-like tokens, quoted strings, and arrows", () => {
    expect(tokenizeTerminalCommand("add message \"hello world\" as msg")).toEqual([
      "add", "message", "hello world", "as", "msg",
    ]);
    expect(tokenizeTerminalCommand("connect osc.0->out.1")).toEqual([
      "connect", "osc.0", "->", "out.1",
    ]);
    // Standalone `-` (whitespace-bounded) is the new preferred arrow syntax.
    expect(tokenizeTerminalCommand("connect osc.0 - out.1")).toEqual([
      "connect", "osc.0", "->", "out.1",
    ]);
    // Negative numbers must stay attached — the `-` only becomes an arrow when
    // followed by whitespace/end.
    expect(tokenizeTerminalCommand("move metro1 -1 200")).toEqual([
      "move", "metro1", "-1", "200",
    ]);
  });
});

describe("PatchTerminalEngine Phase 1 commands", () => {
  it("adds objects with session aliases and selects the new node", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute("add button as trig", harness.ctx);

    expect(result.ok).toBe(true);
    const node = harness.ctx.graph.getNodes()[0];
    expect(node.type).toBe("button");
    expect(engine.aliasesFor(harness.ctx.graph).get("trig")).toBe(node.id);
    expect([...harness.selected]).toEqual([node.id]);
    expect(node.x).toBe(180);
    expect(node.y).toBe(80);
  });

  it("places the next added object to the right of the current selection", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("add button as trig", harness.ctx);
    await engine.execute("add metro 250 as clock", harness.ctx);

    const [button, metro] = harness.ctx.graph.getNodes();
    expect(button.x).toBe(180);
    expect(metro.x).toBe(276);
    expect(metro.args[0]).toBe("250");
  });

  it("connects alias endpoints", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("add button as trig", harness.ctx);
    await engine.execute("add metro 250 as clock", harness.ctx);
    const result = await engine.execute("connect trig.0 -> clock.0", harness.ctx);

    expect(result.ok).toBe(true);
    const edge = harness.ctx.graph.getEdges()[0];
    expect(edge.fromNodeId).toBe(engine.aliasesFor(harness.ctx.graph).get("trig"));
    expect(edge.toNodeId).toBe(engine.aliasesFor(harness.ctx.graph).get("clock"));
  });

  it("selects, moves, and deletes referenced nodes", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("add button as trig", harness.ctx);
    await engine.execute("add toggle as gate", harness.ctx);

    let result = await engine.execute("select trig gate", harness.ctx);
    expect(result.ok).toBe(true);
    expect(harness.selected.size).toBe(2);

    result = await engine.execute("move trig 10 20", harness.ctx);
    expect(result.ok).toBe(true);
    expect(harness.ctx.graph.nodes.get(engine.aliasesFor(harness.ctx.graph).get("trig")!)?.x).toBe(10);

    await engine.execute("select trig gate", harness.ctx);
    result = await engine.execute("delete selection", harness.ctx);
    expect(result.ok).toBe(true);
    expect(harness.ctx.graph.getNodes()).toHaveLength(0);
  });

  it("moves a node via the `<ref> (gx, gy)` grid shorthand", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("add toggle as tog1", harness.ctx);
    const result = await engine.execute("tog1 (5, 10)", harness.ctx);

    // Grid units, not pixels — coords are multiplied by GRID_CELL_PX (50).
    expect(result.ok).toBe(true);
    expect(result.message).toBe("moved tog1 to (5, 10)");
    const tog = harness.ctx.graph.getNodes()[0];
    expect(tog.x).toBe(250);
    expect(tog.y).toBe(500);
  });

  it("accepts negative coords and float coords in the move shorthand", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("add toggle as tog1", harness.ctx);
    await engine.execute("tog1 (-3, 12.5)", harness.ctx);

    const tog = harness.ctx.graph.getNodes()[0];
    expect(tog.x).toBe(-150);
    expect(tog.y).toBe(625);
  });

  it("move shorthand resolves a phrase-created persistent name", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    // Persistent-name path: phrase aliases set both a session alias AND
    // node.name. After a hard reload the session alias is gone but the name
    // remains, so the move shorthand has to find the node by name.
    await engine.execute("{ metro [500] (metro1) }", harness.ctx);
    const result = await engine.execute("metro1 (5, 2)", harness.ctx);

    expect(result.ok).toBe(true);
    const metro = harness.ctx.graph.getNodes().find((n) => n.type === "metro")!;
    expect(metro.x).toBe(250);
    expect(metro.y).toBe(100);
  });

  it("/dspOn toggles DSP on via the app api", async () => {
    let dspState = false;
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    harness.ctx.app.toggleDsp = () => { dspState = !dspState; };
    harness.ctx.app.isDspOn = () => dspState;

    let result = await engine.execute("/dspOn", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("DSP on");
    expect(dspState).toBe(true);

    // Second call is a no-op since DSP is already on.
    result = await engine.execute("/dspOn", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("DSP already on");
    expect(dspState).toBe(true);
  });

  it("/dspOff turns DSP off and is a no-op when already off", async () => {
    let dspState = true;
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    harness.ctx.app.toggleDsp = () => { dspState = !dspState; };
    harness.ctx.app.isDspOn = () => dspState;

    let result = await engine.execute("/dspOff", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("DSP off");
    expect(dspState).toBe(false);

    result = await engine.execute("/dspOff", harness.ctx);
    expect(result.message).toBe("DSP already off");
    expect(dspState).toBe(false);
  });

  it("/save calls saveToFile on the app", async () => {
    let saveCalls = 0;
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    harness.ctx.app.saveToFile = () => { saveCalls += 1; };

    const result = await engine.execute("/save", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("saved");
    expect(saveCalls).toBe(1);
  });

  it("/clear removes every node in the graph as one undo step", async () => {
    const engine = new PatchTerminalEngine();
    const graph = new PatchGraph();
    const undo = new UndoManager(graph);
    const harness = makeHarness(graph);
    await engine.execute("add toggle as tog1", harness.ctx);
    await engine.execute("add metro as metro1", harness.ctx);
    expect(graph.getNodes()).toHaveLength(2);

    const result = await engine.execute("/clear", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("cleared 2 nodes");
    expect(graph.getNodes()).toHaveLength(0);

    undo.undo();
    expect(graph.getNodes()).toHaveLength(2);
    undo.destroy();
  });

  it("/clear on an empty graph reports nothing to clear", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute("/clear", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("nothing to clear");
  });

  it("/list prints every node sorted top-to-bottom in grid coords", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("toggle (tog1)(2, 1)", harness.ctx);
    await engine.execute("metro [500](metro1)(2, 4)", harness.ctx);

    const result = await engine.execute("/list", harness.ctx);
    expect(result.ok).toBe(true);
    const lines = result.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tog1");
    expect(lines[0]).toContain("toggle");
    expect(lines[0]).toContain("(2, 1)");
    expect(lines[1]).toContain("metro1");
    expect(lines[1]).toContain("metro");
    expect(lines[1]).toContain("500");
    expect(lines[1]).toContain("(2, 4)");
  });

  it("/list reports `(no nodes)` on an empty graph", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute("/list", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("(no nodes)");
  });

  it("/help prints the command reference", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute("/help", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/commands:/);
    expect(result.message).toMatch(/patch phrases/);
    expect(result.message).toMatch(/slash commands/);
    expect(result.message).toMatch(/\/dspOn/);
  });

  it("set replaces an object's args in place", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("metro [500](metro1)(2, 2)", harness.ctx);
    const before = harness.ctx.graph.getNodes()[0];
    expect(before.args).toEqual(["500"]);

    const result = await engine.execute("set metro1 250", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/set .* to 250/);
    expect(before.args).toEqual(["250"]);
  });

  it("set refuses types whose ports are derived from args", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("add t bang float as t1", harness.ctx);
    const result = await engine.execute("set t1 bang bang bang", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/set on 't' isn't supported/);
  });

  it("/run fires an action by title", async () => {
    let ran = false;
    const registry = new ActionRegistry();
    registry.register(makeAction({
      id: "app.test.ping",
      title: "Ping Patch",
      run: () => { ran = true; },
    }));
    const engine = new PatchTerminalEngine();
    const harness = makeHarness(new PatchGraph(), registry);

    const result = await engine.execute("/run Ping Patch", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("ran Ping Patch");
    expect(ran).toBe(true);
  });

  it("/run errors on missing argument", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute("/run", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/usage: \/run/);
  });

  it("/define registers a macro that runs via /run", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    let result = await engine.execute(
      "/define synth = toggle (tog1)(2, 1) ; metro [500](metro1)(2, 4)",
      harness.ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe("defined synth");

    // Registered in the action registry under user.* with section "Custom".
    const action = harness.ctx.registry.get("user.synth");
    expect(action?.section).toBe("Custom");
    expect(action?.title).toBe("synth");

    // Body executes: both objects exist after running it.
    result = await engine.execute("/run synth", harness.ctx);
    expect(result.ok).toBe(true);
    const types = harness.ctx.graph.getNodes().map((n) => n.type).sort();
    expect(types).toEqual(["metro", "toggle"]);
  });

  it("/define refuses names that collide with built-ins", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    let result = await engine.execute("/define add = toggle", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/conflicts with a built-in command/);

    result = await engine.execute("/define metro = toggle", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/conflicts with an object type/);
  });

  it("/define replaces an existing macro of the same name", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("/define foo = toggle (a)", harness.ctx);
    const result = await engine.execute("/define foo = metro (a)", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("redefined foo");
    expect(engine.macrosFor().get("foo")?.body).toBe("metro (a)");
  });

  it("/undefine removes a macro from registry and engine", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("/define foo = toggle", harness.ctx);
    expect(harness.ctx.registry.get("user.foo")).toBeTruthy();

    const result = await engine.execute("/undefine foo", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("undefined foo");
    expect(harness.ctx.registry.get("user.foo")).toBeUndefined();
    expect(engine.macrosFor().has("foo")).toBe(false);
  });

  it("/undefine errors when the macro doesn't exist", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute("/undefine nope", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no macro named nope/);
  });

  it("/macros lists every defined macro alphabetically", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    expect((await engine.execute("/macros", harness.ctx)).message).toBe("(no macros)");

    await engine.execute("/define beta = toggle", harness.ctx);
    await engine.execute("/define alpha = metro", harness.ctx);

    const result = await engine.execute("/macros", harness.ctx);
    const lines = result.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^alpha\s+= metro$/);
    expect(lines[1]).toMatch(/^beta\s+= toggle$/);
  });

  it("macros persist across engine restarts via localStorage", async () => {
    // Install a fake localStorage so the engine's persistence layer is
    // exercised in node test env. Restored after the test so other tests
    // that assume `typeof localStorage === "undefined"` aren't affected.
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: () => null,
      length: 0,
    } as Storage;
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = fake;
    try {
      const engineA = new PatchTerminalEngine();
      const harnessA = makeHarness();
      await engineA.execute("/define synth = toggle (a)", harnessA.ctx);
      expect(store.has("patchnet-macros")).toBe(true);

      // Fresh engine + fresh registry — simulates a page reload.
      const engineB = new PatchTerminalEngine();
      const harnessB = makeHarness();
      expect(engineB.macrosFor().size).toBe(0);
      engineB.loadMacros(harnessB.ctx);
      expect(engineB.macrosFor().get("synth")?.body).toBe("toggle (a)");
      expect(harnessB.ctx.registry.get("user.synth")).toBeTruthy();

      // And it's still runnable end-to-end.
      const result = await engineB.execute("/run synth", harnessB.ctx);
      expect(result.ok).toBe(true);
      expect(harnessB.ctx.graph.getNodes().map((n) => n.type)).toEqual(["toggle"]);
    } finally {
      if (original) (globalThis as { localStorage?: Storage }).localStorage = original;
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("/undefine clears the persisted entry too", async () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: () => null,
      length: 0,
    } as Storage;
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = fake;
    try {
      const engine = new PatchTerminalEngine();
      const harness = makeHarness();
      await engine.execute("/define foo = toggle", harness.ctx);
      await engine.execute("/undefine foo", harness.ctx);

      const persisted = JSON.parse(store.get("patchnet-macros") ?? "[]");
      expect(persisted).toEqual([]);
    } finally {
      if (original) (globalThis as { localStorage?: Storage }).localStorage = original;
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("/define with (chord) binds the chord to the new macro", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute(
      "/define synth (Cmd+Shift+S) = toggle (a)",
      harness.ctx,
    );
    expect(result.ok).toBe(true);
    expect(harness.ctx.keymap.shortcutsFor("user.synth")).toContain("Cmd+Shift+S");
    expect(engine.macrosFor().get("synth")?.chords).toEqual(["Cmd+Shift+S"]);
  });

  it("/define with an invalid chord still defines the macro and reports the chord error", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    // `Cmd+` parses as "modifier with no key" — chord-validator rejects it.
    const result = await engine.execute("/define synth (Cmd+) = toggle", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/keyboard shortcut rejected/);
    // Macro is still defined — the chord was the optional bonus.
    expect(engine.macrosFor().has("synth")).toBe(true);
  });

  it("/bind adds a chord to an existing macro", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    await engine.execute("/define foo = toggle", harness.ctx);

    const result = await engine.execute("/bind foo Cmd+K", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("bound Cmd+K to foo");
    expect(harness.ctx.keymap.shortcutsFor("user.foo")).toContain("Cmd+K");
    expect(engine.macrosFor().get("foo")?.chords).toEqual(["Cmd+K"]);
  });

  it("/bind errors when macro doesn't exist", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute("/bind ghost Cmd+G", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no macro named ghost/);
  });

  it("/unbind removes every chord on a macro", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    await engine.execute("/define foo = toggle", harness.ctx);
    await engine.execute("/bind foo Cmd+K", harness.ctx);
    await engine.execute("/bind foo Cmd+L", harness.ctx);
    expect(harness.ctx.keymap.shortcutsFor("user.foo")).toEqual(
      expect.arrayContaining(["Cmd+K", "Cmd+L"]),
    );

    const result = await engine.execute("/unbind foo", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/unbound .* from foo/);
    expect(harness.ctx.keymap.shortcutsFor("user.foo")).toEqual([]);
    expect(engine.macrosFor().get("foo")?.chords).toEqual([]);
  });

  it("/undefine also strips the macro's chord bindings", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    await engine.execute("/define foo (Cmd+K) = toggle", harness.ctx);
    expect(harness.ctx.keymap.shortcutsFor("user.foo")).toContain("Cmd+K");

    await engine.execute("/undefine foo", harness.ctx);
    expect(harness.ctx.keymap.shortcutsFor("user.foo")).toEqual([]);
  });

  it("loadMacros re-applies persisted chords", async () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: () => null,
      length: 0,
    } as Storage;
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = fake;
    try {
      const engineA = new PatchTerminalEngine();
      const harnessA = makeHarness();
      await engineA.execute("/define synth (Cmd+Shift+S) = toggle", harnessA.ctx);

      const engineB = new PatchTerminalEngine();
      const harnessB = makeHarness();
      engineB.loadMacros(harnessB.ctx);
      expect(engineB.macrosFor().get("synth")?.chords).toEqual(["Cmd+Shift+S"]);
      expect(harnessB.ctx.keymap.shortcutsFor("user.synth")).toContain("Cmd+Shift+S");
    } finally {
      if (original) (globalThis as { localStorage?: Storage }).localStorage = original;
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it("createMacro registers a macro from a programmatic spec", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = engine.createMacro(
      { name: "synth", body: "toggle (a)" },
      harness.ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe("defined synth");
    expect(engine.macrosFor().get("synth")?.body).toBe("toggle (a)");
    expect(harness.ctx.registry.get("user.synth")?.section).toBe("Custom");
  });

  it("createMacro accepts a multi-line body verbatim (no regex parse)", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    // Newlines are normal in a multi-line textarea; `/define` regex would
    // reject this because `.` is single-line. createMacro must not.
    const body = "toggle (a)\n; metro (b)";
    const result = engine.createMacro({ name: "multi", body }, harness.ctx);
    expect(result.ok).toBe(true);
    expect(engine.macrosFor().get("multi")?.body).toBe(body);
  });

  it("createMacro applies an optional chord", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = engine.createMacro(
      { name: "synth", body: "toggle", chord: "Cmd+J" },
      harness.ctx,
    );
    expect(result.ok).toBe(true);
    expect(harness.ctx.keymap.shortcutsFor("user.synth")).toContain("Cmd+J");
  });

  it("createMacro on an invalid chord still defines the macro", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = engine.createMacro(
      { name: "synth", body: "toggle", chord: "Cmd+" },
      harness.ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/keyboard shortcut rejected/);
    expect(engine.macrosFor().has("synth")).toBe(true);
  });

  it("createMacro rejects names that collide with built-ins", () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    expect(() =>
      engine.createMacro({ name: "metro", body: "toggle" }, harness.ctx),
    ).toThrow(/conflicts with an object type/);
  });

  it("macro recursion past depth 8 is aborted", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    // A macro that calls itself — would loop forever without the guard.
    await engine.execute("/define loop = /run loop", harness.ctx);
    const result = await engine.execute("/run loop", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/macro recursion depth/);
  });

  it("rejects unknown slash commands", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute("/nope", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unknown slash command/);
  });

  it("runs an action by unique title search", async () => {
    let ran = false;
    const registry = new ActionRegistry();
    registry.register(makeAction({
      id: "app.test.ping",
      title: "Ping Patch",
      run: () => { ran = true; },
    }));
    const engine = new PatchTerminalEngine();
    const harness = makeHarness(new PatchGraph(), registry);

    const result = await engine.execute("run ping patch", harness.ctx);

    expect(result.ok).toBe(true);
    expect(ran).toBe(true);
  });

  it("keeps aliases isolated by graph", async () => {
    const engine = new PatchTerminalEngine();
    const a = makeHarness();
    const b = makeHarness();

    await engine.execute("add button as trig", a.ctx);
    await engine.execute("add toggle as trig", b.ctx);

    const aNode = a.ctx.graph.getNodes()[0];
    const bNode = b.ctx.graph.getNodes()[0];
    expect(engine.aliasesFor(a.ctx.graph).get("trig")).toBe(aNode.id);
    expect(engine.aliasesFor(b.ctx.graph).get("trig")).toBe(bNode.id);
    expect(aNode.type).toBe("button");
    expect(bNode.type).toBe("toggle");
  });

  it("lets UndoManager restore a multi-node terminal delete in one undo", async () => {
    const engine = new PatchTerminalEngine();
    const graph = new PatchGraph();
    const undo = new UndoManager(graph);
    const harness = makeHarness(graph);

    await engine.execute("add button as trig", harness.ctx);
    await engine.execute("add toggle as gate", harness.ctx);
    await engine.execute("select trig gate", harness.ctx);
    await engine.execute("delete selection", harness.ctx);

    expect(graph.getNodes()).toHaveLength(0);
    undo.undo();
    expect(graph.getNodes()).toHaveLength(2);
    undo.destroy();
  });
});

describe("PatchTerminalEngine braced patch phrases", () => {
  const phrase = "{ toggle (toggle1) out_1 -> in_1 metro [1000] (metro1) out_1 -> in_1 click~ (click1) out_1 -> in_1 in_2 dac~ (dac1) }";

  it("accepts a brace-less patch phrase", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    // Same phrase as the wrapped form, just without the curly braces.
    const result = await engine.execute(
      "toggle (tog1) out_1 - in_1 metro [500] (metro1)",
      harness.ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 2 objects, 1 cable");
  });

  it("still accepts brace-wrapped phrases for backward compat", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute(
      "{ toggle (tog1) out_1 - in_1 metro [500] (metro1) }",
      harness.ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 2 objects, 1 cable");
  });

  it("rejects an unbalanced brace", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute("{ toggle (tog1)", harness.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unmatched brace/);
  });

  it("places a new phrase element at an explicit grid cell via `(gx, gy)`", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute("message (msg1)(20, 7)", harness.ctx);
    expect(result.ok).toBe(true);
    const msg = harness.ctx.graph.getNodes()[0];
    expect(msg.type).toBe("message");
    expect(msg.name).toBe("msg1");
    expect(msg.x).toBe(1000);
    expect(msg.y).toBe(350);
  });

  it("explicit coords work without an alias and in either order", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute("toggle (3, 3)", harness.ctx);
    await engine.execute("metro [500](6, 3)(metro1)", harness.ctx);

    const nodes = harness.ctx.graph.getNodes();
    const tog = nodes.find((n) => n.type === "toggle")!;
    const metro = nodes.find((n) => n.type === "metro")!;
    expect(tog.x).toBe(150);
    expect(tog.y).toBe(150);
    expect(metro.x).toBe(300);
    expect(metro.y).toBe(150);
    expect(metro.name).toBe("metro1");
    expect(metro.args[0]).toBe("500");
  });

  it("disconnects an existing edge with the `x` sever operator", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    // Create integer feeding metro inlet 0.
    await engine.execute(
      "{ metro [500] (metro1) }",
      harness.ctx,
    );
    await engine.execute("{ integer (int1) out_1 - in_1 metro1 }", harness.ctx);
    expect(harness.ctx.graph.getEdges()).toHaveLength(1);

    const result = await engine.execute("{ int1 out_1 x in_1 metro1 }", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 0 objects, 0 cables, 1 removed");
    expect(harness.ctx.graph.getEdges()).toHaveLength(0);
  });

  it("disconnect of a non-existent edge is a silent no-op", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    await engine.execute("{ metro [500] (metro1) }", harness.ctx);
    await engine.execute("{ integer (int1) }", harness.ctx);

    const result = await engine.execute("{ int1 out_1 x in_1 metro1 }", harness.ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 0 objects, 0 cables");
  });

  it("accepts `-` as the cable arrow in patch phrases", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();
    const result = await engine.execute(
      "{ toggle (tog1) out_1 - in_1 metro [500] (metro1) }",
      harness.ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 2 objects, 1 cable");
  });

  it("builds an inline patch phrase with aliases, args, and 1-based ports", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute(phrase, harness.ctx);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 4 objects, 4 cables");

    const nodes = harness.ctx.graph.getNodes();
    expect(nodes.map((node) => node.type)).toEqual(["toggle", "metro", "click~", "dac~"]);
    expect(nodes[1].args[0]).toBe("1000");
    expect(nodes[0].y).toBeLessThan(nodes[1].y);
    expect(nodes[1].y).toBeLessThan(nodes[2].y);
    expect(nodes[2].y).toBeLessThan(nodes[3].y);

    expect(engine.aliasesFor(harness.ctx.graph).get("toggle1")).toBe(nodes[0].id);
    expect(engine.aliasesFor(harness.ctx.graph).get("metro1")).toBe(nodes[1].id);
    expect(engine.aliasesFor(harness.ctx.graph).get("click1")).toBe(nodes[2].id);
    expect(engine.aliasesFor(harness.ctx.graph).get("dac1")).toBe(nodes[3].id);

    const edges = harness.ctx.graph.getEdges();
    expect(edges).toHaveLength(4);
    expect(edges.map((edge) => ({
      from: edge.fromNodeId,
      outlet: edge.fromOutlet,
      to: edge.toNodeId,
      inlet: edge.toInlet,
    }))).toEqual([
      { from: nodes[0].id, outlet: 0, to: nodes[1].id, inlet: 0 },
      { from: nodes[1].id, outlet: 0, to: nodes[2].id, inlet: 0 },
      { from: nodes[2].id, outlet: 0, to: nodes[3].id, inlet: 0 },
      { from: nodes[2].id, outlet: 0, to: nodes[3].id, inlet: 1 },
    ]);
    expect([...harness.selected]).toEqual(nodes.map((node) => node.id));
  });

  it("requires patch phrase braces to be closed", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute("{ toggle (toggle1)", harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unmatched brace/);
    expect(harness.ctx.graph.getNodes()).toHaveLength(0);
  });

  it("validates patch phrase connections before mutating the graph", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute("{ click~ (click1) out_1 -> in_3 dac~ (dac1) }", harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid inlet/);
    expect(harness.ctx.graph.getNodes()).toHaveLength(0);
  });

  it("attaches a new object to an existing alias with 1-based inlet syntax", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute(phrase, harness.ctx);
    const metro = harness.ctx.graph.getNodes().find((node) => node.type === "metro")!;

    const result = await engine.execute("{ integer (int1) out_1 -> in_2 metro1 }", harness.ctx);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 1 object, 1 cable");
    const nodes = harness.ctx.graph.getNodes();
    expect(nodes).toHaveLength(5);

    const integer = nodes.find((node) => node.type === "integer")!;
    const integerHeight = integer.height ?? getObjectDef(integer.type).defaultHeight;
    expect(engine.aliasesFor(harness.ctx.graph).get("int1")).toBe(integer.id);
    // The new integer is placed above metro, with its outlet x aligned to metro's inlet 1
    // and a PHRASE_GAP_Y gap between integer.bottom and metro.y.
    const inletPort = getPortPos(metro, "inlet", 1);
    const outletPort = getPortPos(integer, "outlet", 0);
    expect(Math.abs(outletPort.x - inletPort.x)).toBeLessThanOrEqual(1);
    expect(integer.y + integerHeight + 6).toBe(metro.y);

    const edge = harness.ctx.graph.getEdges().find((candidate) =>
      candidate.fromNodeId === integer.id && candidate.toNodeId === metro.id,
    );
    expect(edge).toMatchObject({
      fromOutlet: 0,
      toInlet: 1,
    });
    expect([...harness.selected]).toEqual([integer.id]);
  });

  it("resolves persisted object names after loading a patch", async () => {
    const engine = new PatchTerminalEngine();
    const graph = new PatchGraph();
    graph.deserialize([
      "#N canvas;",
      "#X obj 200 120 metro 1000;",
    ].join("\n"));
    const harness = makeHarness(graph);
    const metro = graph.getNodes()[0];

    const result = await engine.execute("{ integer (int1) out_1 -> in_2 metro1 }", harness.ctx);

    expect(result.ok).toBe(true);
    const integer = graph.getNodes().find((node) => node.type === "integer")!;
    const integerHeight = integer.height ?? getObjectDef(integer.type).defaultHeight;
    expect(integer.name).toBe("int1");
    const inletPort = getPortPos(metro, "inlet", 1);
    const outletPort = getPortPos(integer, "outlet", 0);
    expect(Math.abs(outletPort.x - inletPort.x)).toBeLessThanOrEqual(1);
    expect(integer.y + integerHeight + 6).toBe(metro.y);
    expect(graph.getEdges()[0]).toMatchObject({
      fromNodeId: integer.id,
      fromOutlet: 0,
      toNodeId: metro.id,
      toInlet: 1,
    });
  });

  it("shifts the existing target down when there is no room above for the new source", async () => {
    const engine = new PatchTerminalEngine();
    const graph = new PatchGraph();
    // Metro near the top of the canvas — placing a new source above would clip
    // past y=0, so the engine must push metro down to make room.
    graph.deserialize([
      "#N canvas;",
      "#X obj 100 10 metro 500;",
    ].join("\n"));
    const harness = makeHarness(graph);
    const metro = graph.getNodes()[0];
    const metroOriginalY = metro.y;

    const result = await engine.execute("{ integer (int1) out_1 -> in_1 metro1 }", harness.ctx);

    expect(result.ok).toBe(true);
    const integer = graph.getNodes().find((node) => node.type === "integer")!;
    const integerHeight = integer.height ?? getObjectDef(integer.type).defaultHeight;
    expect(integer.y).toBeGreaterThanOrEqual(0);
    expect(metro.y).toBeGreaterThan(metroOriginalY);
    expect(integer.y + integerHeight + 6).toBe(metro.y);
  });

  it("cascades the make-room shift down a chain so descendants don't get overlapped", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    // Build a chain that places toggle directly above metro, sequencer below.
    // Adding an integer above metro must push BOTH metro and sequencer down,
    // not just metro alone (which would leave metro overlapping sequencer).
    await engine.execute(
      "{ toggle (tog1) out_1 -> in_1 metro [500] (metro1) out_1 -> in_1 sequencer (seq1) }",
      harness.ctx,
    );
    const before = new Map(harness.ctx.graph.getNodes().map((n) => [n.type, n.y]));
    const metroBeforeY = before.get("metro")!;
    const seqBeforeY = before.get("sequencer")!;

    const result = await engine.execute("{ integer (int1) out_1 -> in_1 metro1 }", harness.ctx);
    expect(result.ok).toBe(true);

    const nodes = harness.ctx.graph.getNodes();
    const metro = nodes.find((n) => n.type === "metro")!;
    const sequencer = nodes.find((n) => n.type === "sequencer")!;
    expect(metro.y).toBeGreaterThan(metroBeforeY);
    expect(sequencer.y).toBeGreaterThan(seqBeforeY);

    const metroH = metro.height ?? getObjectDef(metro.type).defaultHeight;
    expect(metro.y + metroH).toBeLessThanOrEqual(sequencer.y);
  });

  it("can use an existing alias as the source for a new phrase object", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute(phrase, harness.ctx);
    const metro = harness.ctx.graph.getNodes().find((node) => node.type === "metro")!;

    const result = await engine.execute("{ metro1 out_1 -> in_1 integer (int2) }", harness.ctx);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 1 object, 1 cable");
    const integer = harness.ctx.graph.getNodes().find((node) =>
      node.type === "integer" && engine.aliasesFor(harness.ctx.graph).get("int2") === node.id,
    )!;
    expect(integer.y).toBeGreaterThan(metro.y);

    const edge = harness.ctx.graph.getEdges().find((candidate) =>
      candidate.fromNodeId === metro.id && candidate.toNodeId === integer.id,
    );
    expect(edge).toMatchObject({
      fromOutlet: 0,
      toInlet: 0,
    });
  });

  it("validates existing-alias phrase connections before creating new objects", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute(phrase, harness.ctx);
    const beforeNodeCount = harness.ctx.graph.getNodes().length;
    const beforeEdgeCount = harness.ctx.graph.getEdges().length;

    const result = await engine.execute("{ integer (int1) out_1 -> in_3 metro1 }", harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid inlet/);
    expect(harness.ctx.graph.getNodes()).toHaveLength(beforeNodeCount);
    expect(harness.ctx.graph.getEdges()).toHaveLength(beforeEdgeCount);
    expect(engine.aliasesFor(harness.ctx.graph).get("int1")).toBeUndefined();
  });

  it("treats a patch phrase as one undo step", async () => {
    const engine = new PatchTerminalEngine();
    const graph = new PatchGraph();
    const undo = new UndoManager(graph);
    const harness = makeHarness(graph);

    await engine.execute(phrase, harness.ctx);

    expect(graph.getNodes()).toHaveLength(4);
    expect(graph.getEdges()).toHaveLength(4);
    undo.undo();
    expect(graph.getNodes()).toHaveLength(0);
    expect(graph.getEdges()).toHaveLength(0);
    undo.destroy();
  });
});
