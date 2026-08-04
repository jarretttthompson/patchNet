import { describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { parsePatch } from "../src/serializer/parse";
import { serializePatch } from "../src/serializer/serialize";
import { FORMAT_VERSION, detectFormatVersion } from "../src/serializer/version";

const V0_PATCH = [
  "#N canvas;",
  "#X obj 100 100 metro 500;",
  "#X obj 100 200 button;",
  "#X connect 0 0 1 0;",
].join("\n");

function loadGraph(text: string): PatchGraph {
  const graph = new PatchGraph();
  graph.deserialize(text);
  return graph;
}

describe("format version header", () => {
  it("serialize stamps the current version as the first line", () => {
    const text = serializePatch(loadGraph(V0_PATCH));
    expect(text.split("\n")[0]).toBe(`#N patchnet ${FORMAT_VERSION};`);
  });

  it("detectFormatVersion reads the header, defaulting to 0", () => {
    expect(detectFormatVersion(V0_PATCH)).toBe(0);
    expect(detectFormatVersion(serializePatch(loadGraph(V0_PATCH)))).toBe(FORMAT_VERSION);
    expect(detectFormatVersion("")).toBe(0);
    expect(detectFormatVersion("#N patchnet 7;\n#N canvas;")).toBe(7);
    // Blank lines and comments before the header don't hide it.
    expect(detectFormatVersion("\n// comment\n#N patchnet 2;\n#N canvas;")).toBe(2);
  });

  it("parses v0 (headerless) and current-version text identically", () => {
    const v0 = parsePatch(V0_PATCH);
    const v1 = parsePatch(serializePatch(loadGraph(V0_PATCH)));
    expect(v0.nodes.length).toBe(v1.nodes.length);
    expect(v0.edges.length).toBe(v1.edges.length);
  });

  it("rejects a future format version with an actionable error", () => {
    const future = `#N patchnet ${FORMAT_VERSION + 1};\n${V0_PATCH}`;
    expect(() => parsePatch(future)).toThrow(/update patchNet/i);
  });

  it("rejects malformed header versions", () => {
    expect(() => parsePatch("#N patchnet nope;\n#N canvas;")).toThrow();
    expect(() => parsePatch("#N patchnet;\n#N canvas;")).toThrow();
  });

  it("round-trip stays byte-idempotent with the header present", () => {
    const first = serializePatch(loadGraph(V0_PATCH));
    const second = serializePatch(loadGraph(first));
    expect(second).toBe(first);
  });
});
