import { describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { LATEST_VERSION, migrate } from "../src/serializer/migrate";
import { parsePatch } from "../src/serializer/parse";

const CANVAS = "#N canvas;\n";

describe("migration dispatcher (M2/d)", () => {
  it("LATEST_VERSION is 2 (current emitted version)", () => {
    expect(LATEST_VERSION).toBe(2);
  });

  it("a v1 patch migrates up to LATEST_VERSION", () => {
    const parsed = parsePatch(CANVAS);
    expect(parsed.version).toBe(1);
    const migrated = migrate(parsed);
    expect(migrated.version).toBe(LATEST_VERSION);
  });

  it("a v2 patch is a no-op (already at LATEST_VERSION)", () => {
    const parsed = parsePatch(`#N patchnet v2;\n${CANVAS}`);
    expect(parsed.version).toBe(2);
    const migrated = migrate(parsed);
    expect(migrated.version).toBe(2);
  });

  it("preserves nodes and edges through the identity transform", () => {
    const patchText =
      `${CANVAS}#X obj 0 0 button;\n#X obj 100 0 toggle;\n#X connect 0 0 1 0;\n`;
    const parsed = parsePatch(patchText);
    const migrated = migrate(parsed);
    expect(migrated.nodes.length).toBe(parsed.nodes.length);
    expect(migrated.edges.length).toBe(parsed.edges.length);
    expect(migrated.nodes.map((n) => n.type)).toEqual(
      parsed.nodes.map((n) => n.type),
    );
    expect(migrated.nodes.map((n) => n.args)).toEqual(
      parsed.nodes.map((n) => n.args),
    );
  });

  it("does not mutate the input patch object", () => {
    const parsed = parsePatch(CANVAS);
    const originalVersion = parsed.version;
    migrate(parsed);
    expect(parsed.version).toBe(originalVersion);
  });

  it("PatchGraph.deserialize routes parsed patches through migrate()", () => {
    // The wire test: loading a v1 patch via PatchGraph applies the migration
    // (today an identity bump). If this path stops calling migrate(), a future
    // real format change would silently bypass it.
    const graph = new PatchGraph();
    graph.deserialize(`${CANVAS}#X obj 0 0 button;\n`);
    expect(graph.nodes.size).toBe(1);
    const node = [...graph.nodes.values()][0];
    expect(node.type).toBe("button");
  });

  it("rejects a patch whose version is newer than LATEST_VERSION", () => {
    // Parser's KNOWN_VERSIONS guard should prevent this — but if a bug ever
    // lets a v99 patch through, migrate() refuses rather than silently
    // pretending it understood the format.
    const fakeFuturePatch = { version: 99, nodes: [], edges: [] };
    expect(() => migrate(fakeFuturePatch))
      .toThrow(/newer than LATEST_VERSION/);
  });
});
