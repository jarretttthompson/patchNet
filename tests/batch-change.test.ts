import { describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { UndoManager } from "../src/graph/UndoManager";

describe("PatchGraph.batchChange", () => {
  it("defers change emits until the batch closes", () => {
    const graph = new PatchGraph();
    let changes = 0;
    graph.on("change", () => { changes += 1; });

    graph.batchChange(() => {
      graph.addNode("button", 0, 0);
      graph.addNode("toggle", 0, 0);
      graph.addNode("slider", 0, 0);
    });

    expect(changes).toBe(1);
    expect(graph.getNodes().length).toBe(3);
  });

  it("emits nothing when the batch made no mutations", () => {
    const graph = new PatchGraph();
    let changes = 0;
    graph.on("change", () => { changes += 1; });

    graph.batchChange(() => {
      // no-op
    });

    expect(changes).toBe(0);
  });

  it("nested batches collapse into a single emit", () => {
    const graph = new PatchGraph();
    let changes = 0;
    graph.on("change", () => { changes += 1; });

    graph.batchChange(() => {
      graph.addNode("button", 0, 0);
      graph.batchChange(() => {
        graph.addNode("toggle", 0, 0);
        graph.batchChange(() => {
          graph.addNode("slider", 0, 0);
        });
      });
    });

    expect(changes).toBe(1);
  });

  it("UndoManager treats a batch as a single undo step", () => {
    const graph = new PatchGraph();
    const a = graph.addNode("button", 0, 0);
    const b = graph.addNode("toggle", 100, 0);
    const c = graph.addNode("slider", 200, 0);
    expect(graph.getNodes().length).toBe(3);

    const undo = new UndoManager(graph);

    graph.batchChange(() => {
      graph.removeNode(a.id);
      graph.removeNode(b.id);
      graph.removeNode(c.id);
    });
    expect(graph.getNodes().length).toBe(0);

    undo.undo();
    expect(graph.getNodes().length).toBe(3);
  });

  it("returns the inner function's value", () => {
    const graph = new PatchGraph();
    const result = graph.batchChange(() => {
      const node = graph.addNode("button", 0, 0);
      return node.id;
    });
    expect(typeof result).toBe("string");
  });
});
