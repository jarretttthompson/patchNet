import { describe, expect, it } from "vitest";

import { OBJECT_DEFS } from "../src/graph/objectDefs";
import { PatchGraph } from "../src/graph/PatchGraph";
import { serializePatch } from "../src/serializer/serialize";

/**
 * M2/c — every entry in `OBJECT_DEFS` must round-trip byte-identically through
 * the serialize → parse → serialize cycle. Pinning every object means a future
 * change that breaks one object's positional encoding (an inserted arg, a
 * dropped `ensureArgs` default, a regex slip in a per-type decoder) fails CI
 * loudly at the offending object, not at a vague fixture.
 *
 * The test seed is the minimal declaration `#X obj 0 0 <type>;` plus a stable
 * `#X id`. The parser's per-type decoders + `ensureArgs` + `derivePorts` fill
 * in the rest — that filled-in state IS the canonical "fresh node" snapshot,
 * and the assertion is that re-serializing it after another parse yields the
 * same bytes. Two serializations are required because the first serialize is
 * what normalizes a freshly-created node into stable disk form.
 */

function loadGraph(text: string): PatchGraph {
  const graph = new PatchGraph();
  graph.deserialize(text);
  return graph;
}

describe("per-object round-trip (M2/c)", () => {
  it("the catalog is non-empty (sanity)", () => {
    expect(Object.keys(OBJECT_DEFS).length).toBeGreaterThan(0);
  });

  for (const type of Object.keys(OBJECT_DEFS)) {
    it(`${type}: serialize → parse → serialize is byte-identical`, () => {
      // Fixed id so the round-trip is deterministic (otherwise the second
      // serialize would emit a different `#X id` UUID than the first).
      const seed = `#N canvas;\n#X obj 0 0 ${type};\n#X id 0 ${type}-fixed-id;\n`;

      const firstSerialize = serializePatch(loadGraph(seed));
      const secondSerialize = serializePatch(loadGraph(firstSerialize));

      expect(secondSerialize).toBe(firstSerialize);
    });
  }
});
