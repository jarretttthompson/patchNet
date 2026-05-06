import { describe, expect, it } from "vitest";

import { ActionKeymap } from "../src/actions/ActionKeymap";
import { ActionRegistry } from "../src/actions/ActionRegistry";
import type { ActionContext, AppActionsAPI, PatchAction } from "../src/actions/types";
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
  const phrase = "{ toggle (toggle1) out 1 -> in 1 metro [1000] (metro1) out 1 -> in 1 click~ (click1) out 1 -> in 1 in 2 dac~ (dac1) }";

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
    expect(result.message).toMatch(/wrapped in/);
    expect(harness.ctx.graph.getNodes()).toHaveLength(0);
  });

  it("validates patch phrase connections before mutating the graph", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    const result = await engine.execute("{ click~ (click1) out 1 -> in 3 dac~ (dac1) }", harness.ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid inlet/);
    expect(harness.ctx.graph.getNodes()).toHaveLength(0);
  });

  it("attaches a new object to an existing alias with 1-based inlet syntax", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute(phrase, harness.ctx);
    const metro = harness.ctx.graph.getNodes().find((node) => node.type === "metro")!;

    const result = await engine.execute("{ integer (int1) out 1 -> in 2 metro1 }", harness.ctx);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("built patch phrase: 1 object, 1 cable");
    const nodes = harness.ctx.graph.getNodes();
    expect(nodes).toHaveLength(5);

    const integer = nodes.find((node) => node.type === "integer")!;
    const integerHeight = integer.height ?? getObjectDef(integer.type).defaultHeight;
    expect(engine.aliasesFor(harness.ctx.graph).get("int1")).toBe(integer.id);
    expect(integer.x).toBe(metro.x + 124);
    expect(integer.y + integerHeight).toBe(metro.y);

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

    const result = await engine.execute("{ integer (int1) out 1 -> in 2 metro1 }", harness.ctx);

    expect(result.ok).toBe(true);
    const integer = graph.getNodes().find((node) => node.type === "integer")!;
    const integerHeight = integer.height ?? getObjectDef(integer.type).defaultHeight;
    expect(integer.name).toBe("int1");
    expect(integer.x).toBe(metro.x + 124);
    expect(integer.y + integerHeight).toBe(metro.y);
    expect(graph.getEdges()[0]).toMatchObject({
      fromNodeId: integer.id,
      fromOutlet: 0,
      toNodeId: metro.id,
      toInlet: 1,
    });
  });

  it("can use an existing alias as the source for a new phrase object", async () => {
    const engine = new PatchTerminalEngine();
    const harness = makeHarness();

    await engine.execute(phrase, harness.ctx);
    const metro = harness.ctx.graph.getNodes().find((node) => node.type === "metro")!;

    const result = await engine.execute("{ metro1 out 1 -> in 1 integer (int2) }", harness.ctx);

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

    const result = await engine.execute("{ integer (int1) out 1 -> in 3 metro1 }", harness.ctx);

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
