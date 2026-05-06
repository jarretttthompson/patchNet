import { describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { parsePatch } from "../src/serializer/parse";
import { serializePatch } from "../src/serializer/serialize";

describe("persistent object names", () => {
  it("assigns type-based names in creation order", () => {
    const graph = new PatchGraph();

    const button = graph.addNode("button", 0, 0);
    const metro = graph.addNode("metro", 0, 80);
    const secondMetro = graph.addNode("metro", 0, 160);
    const click = graph.addNode("click~", 0, 240);

    expect(button.name).toBe("button1");
    expect(metro.name).toBe("metro1");
    expect(secondMetro.name).toBe("metro2");
    expect(click.name).toBe("click1");
  });

  it("persists object names through patch text", () => {
    const graph = new PatchGraph();
    graph.addNode("metro", 10, 20, ["1000"], "clock");

    const text = serializePatch(graph);
    expect(text).toContain("#X name 0 clock;");

    const parsed = parsePatch(text);
    expect(parsed.nodes[0].name).toBe("clock");

    const loaded = new PatchGraph();
    loaded.deserialize(text);
    expect(loaded.getNodes()[0].name).toBe("clock");
  });

  it("assigns names to legacy patch text without name lines", () => {
    const graph = new PatchGraph();

    graph.deserialize([
      "#N canvas;",
      "#X obj 0 0 toggle;",
      "#X obj 0 80 metro 1000;",
      "#X connect 0 0 1 0;",
    ].join("\n"));

    expect(graph.getNodes().map((node) => node.name)).toEqual(["toggle1", "metro1"]);
    expect(serializePatch(graph)).toContain("#X name 1 metro1;");
  });

  it("renames duplicate or invalid loaded names to unique generated names", () => {
    const graph = new PatchGraph();

    graph.deserialize([
      "#N canvas;",
      "#X obj 0 0 metro 1000;",
      "#X name 0 clock;",
      "#X obj 0 80 metro 250;",
      "#X name 1 clock;",
    ].join("\n"));

    expect(graph.getNodes().map((node) => node.name)).toEqual(["clock", "metro1"]);
  });
});
