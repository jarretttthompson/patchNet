import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { parsePatch } from "../src/serializer/parse";
import { serializePatch } from "../src/serializer/serialize";

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf8");
}

function loadGraph(text: string): PatchGraph {
  const graph = new PatchGraph();
  graph.deserialize(text);
  return graph;
}

describe("patch text round-trip", () => {
  it("rich autosave (js~/mixer~/fft~/dac~/browser~/patchViz/layer): parse → serialize → parse is stable", () => {
    const text = loadFixture("round-trip-rich.patchnet");

    const firstParse = parsePatch(text);
    expect(firstParse.nodes.length).toBeGreaterThan(0);

    const graph = loadGraph(text);
    const reSerialized = serializePatch(graph);
    const secondParse = parsePatch(reSerialized);

    // Structural identity: serialize → parse must yield the same node/edge
    // shape as parsing the original. Position/size/args/types all preserved.
    expect(secondParse.nodes.length).toBe(firstParse.nodes.length);
    expect(secondParse.edges.length).toBe(firstParse.edges.length);

    for (let i = 0; i < firstParse.nodes.length; i++) {
      const a = firstParse.nodes[i];
      const b = secondParse.nodes[i];
      expect(b.type).toBe(a.type);
      expect(b.args).toEqual(a.args);
      expect(b.x).toBe(a.x);
      expect(b.y).toBe(a.y);
      expect(b.inlets.length).toBe(a.inlets.length);
      expect(b.outlets.length).toBe(a.outlets.length);
    }
  });

  it("text → graph → serialize → graph is idempotent (second pass equals first)", () => {
    const text = loadFixture("round-trip-rich.patchnet");

    const firstSerialize = serializePatch(loadGraph(text));
    const secondSerialize = serializePatch(loadGraph(firstSerialize));

    // Once the text has gone through one full round, subsequent rounds must
    // be byte-identical. This catches any nondeterminism (id reordering,
    // float formatting drift, blob re-encoding) in the serialize path.
    expect(secondSerialize).toBe(firstSerialize);
  });

  it("empty patch round-trips to empty", () => {
    const graph = loadGraph("");
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);

    // Empty graph still emits the canonical canvas header; what we care about
    // is that re-parsing yields zero nodes/edges and a second round is stable.
    const round = serializePatch(graph);
    const reparsed = parsePatch(round);
    expect(reparsed.nodes.length).toBe(0);
    expect(reparsed.edges.length).toBe(0);
    expect(serializePatch(loadGraph(round))).toBe(round);
  });
});
