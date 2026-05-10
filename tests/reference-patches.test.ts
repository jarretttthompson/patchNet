import { describe, expect, it } from "vitest";

import { REFERENCE_PATCHES } from "../src/canvas/referencePatches";
import { PatchGraph } from "../src/graph/PatchGraph";

describe("REFERENCE_PATCHES round-trip", () => {
  // Iterate the record so newly added entries are covered automatically.
  for (const [key, entry] of Object.entries(REFERENCE_PATCHES)) {
    describe(`${key} (${entry.label})`, () => {
      it("deserialize does not throw and produces at least one node", () => {
        const graph = new PatchGraph();
        expect(() => graph.deserialize(entry.text)).not.toThrow();
        expect(graph.getNodes().length).toBeGreaterThan(0);
      });

      it("survives parse → serialize → parse → serialize without drift", () => {
        // Strict equality vs. entry.text fails on the cold start because
        // serialize() emits `#X id <idx> <uuid>;` lines containing freshly
        // minted UUIDs that aren't present in the source. Running the round
        // trip twice and comparing the second emission to the first sidesteps
        // that — once the ids are baked in, every subsequent pass must be
        // byte-identical, so any nondeterminism (arg-slot reorder, port
        // derivation drift, blob re-encoding, group/name reordering) shows
        // up immediately.
        const graphA = new PatchGraph();
        graphA.deserialize(entry.text);
        const firstSerialize = graphA.serialize();

        const graphB = new PatchGraph();
        graphB.deserialize(firstSerialize);
        const secondSerialize = graphB.serialize();

        expect(secondSerialize).toBe(firstSerialize);
      });

      it("structural shape is preserved across the round trip", () => {
        // Belt-and-suspenders check: even if the byte-stable test above
        // passed due to symmetric corruption (e.g. an arg slot dropped on
        // parse AND not re-emitted on serialize), this verifies node count,
        // edge count, and per-node type/args/position/name all survive.
        const graphA = new PatchGraph();
        graphA.deserialize(entry.text);

        const graphB = new PatchGraph();
        graphB.deserialize(graphA.serialize());

        const a = graphA.getNodes();
        const b = graphB.getNodes();
        expect(b.length).toBe(a.length);
        expect(graphB.getEdges().length).toBe(graphA.getEdges().length);

        for (let i = 0; i < a.length; i += 1) {
          expect(b[i].type).toBe(a[i].type);
          expect(b[i].args).toEqual(a[i].args);
          expect(b[i].x).toBe(a[i].x);
          expect(b[i].y).toBe(a[i].y);
          expect(b[i].name).toBe(a[i].name);
          expect(b[i].inlets.length).toBe(a[i].inlets.length);
          expect(b[i].outlets.length).toBe(a[i].outlets.length);
        }
      });
    });
  }
});
