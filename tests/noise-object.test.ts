import { describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { parsePatch } from "../src/serializer/parse";
import { serializePatch } from "../src/serializer/serialize";

describe("noise~ object", () => {
  it("creates with default color/level args and one signal outlet", () => {
    const graph = new PatchGraph();
    const node = graph.addNode("noise~", 10, 20);

    expect(node.type).toBe("noise~");
    expect(node.args).toEqual(["white", "0.25"]);
    expect(node.inlets).toHaveLength(1);
    expect(node.inlets[0].type).toBe("any");
    expect(node.outlets).toEqual([
      { index: 0, type: "signal", label: "noise signal out" },
    ]);
  });

  it("round-trips through patch text with explicit color and level", () => {
    const graph = new PatchGraph();
    const noise = graph.addNode("noise~", 10, 20, ["pink", "0.4"]);
    const dac = graph.addNode("dac~", 180, 20);
    graph.addEdge(noise.id, 0, dac.id, 0);

    const text = serializePatch(graph);
    const parsed = parsePatch(text);
    const parsedNoise = parsed.nodes.find((node) => node.type === "noise~");

    expect(parsedNoise?.args).toEqual(["pink", "0.4"]);
    expect(parsed.edges).toHaveLength(1);
    expect(serializePatch(loadGraph(text))).toBe(text);
  });
});

function loadGraph(text: string): PatchGraph {
  const graph = new PatchGraph();
  graph.deserialize(text);
  return graph;
}
