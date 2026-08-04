import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { parsePatch } from "../src/serializer/parse";
import { serializePatch } from "../src/serializer/serialize";

// Every real patch ever saved from production (bar-show autosaves included)
// lives in fixtures/corpus/. These files are the compatibility contract:
// a serializer/parser change that breaks any of them would brick a live rig
// on the next deploy. Add new real-world patches here as they accumulate;
// never regenerate existing ones from current code.
//
// Two behaviors are deliberately allowed:
//  - empty patches (autosaves of a blank canvas) round-trip to empty
//  - args APPENDED on reload: objects that grew new settings after a patch
//    was saved get defaults backfilled at the end (e.g. ezScale). Mutating
//    or dropping the original args is still a failure.
const corpusDir = resolve(__dirname, "fixtures", "corpus");
const corpusFiles = readdirSync(corpusDir)
  .filter((name) => name.endsWith(".patchnet"))
  .sort();

// Pre-blob-era files the current parser cannot read (raw multi-line source
// inside #X obj instead of base64 blob args). The format-versioning milestone
// owns fixing these; until then they must stay listed here — if a parser
// change makes one readable, the guard test below fails so it gets promoted
// into the main corpus.
const KNOWN_INCOMPATIBLE = new Set(["patch-2026-04-24-1437.patchnet"]);

function loadGraph(text: string): PatchGraph {
  const graph = new PatchGraph();
  graph.deserialize(text);
  return graph;
}

describe("production patch corpus", () => {
  it("corpus is present", () => {
    expect(corpusFiles.length).toBeGreaterThan(30);
  });

  it("known-incompatible list matches reality", () => {
    for (const name of KNOWN_INCOMPATIBLE) {
      expect(corpusFiles, `${name} listed but missing from corpus`).toContain(name);
      const text = readFileSync(resolve(corpusDir, name), "utf8");
      // Still throws today. If this assertion fails, the parser learned to
      // read this file — remove it from KNOWN_INCOMPATIBLE so it gets the
      // full round-trip treatment.
      expect(() => parsePatch(text)).toThrow();
    }
  });

  describe.each(corpusFiles.filter((f) => !KNOWN_INCOMPATIBLE.has(f)))(
    "%s",
    (name) => {
      const text = readFileSync(resolve(corpusDir, name), "utf8");

      it("parses without throwing", () => {
        expect(() => parsePatch(text)).not.toThrow();
      });

      it("survives parse → serialize → parse with structure intact", () => {
        const firstParse = parsePatch(text);
        const reSerialized = serializePatch(loadGraph(text));
        const secondParse = parsePatch(reSerialized);

        expect(secondParse.nodes.length).toBe(firstParse.nodes.length);
        expect(secondParse.edges.length).toBe(firstParse.edges.length);

        for (let i = 0; i < firstParse.nodes.length; i++) {
          const a = firstParse.nodes[i];
          const b = secondParse.nodes[i];
          expect(b.type, `node ${i} type in ${name}`).toBe(a.type);
          // Original args must survive verbatim as a prefix; anything beyond
          // is default backfill for settings added since the file was saved.
          expect(
            b.args.slice(0, a.args.length),
            `node ${i} (${a.type}) original args in ${name}`,
          ).toEqual(a.args);
          expect(b.inlets.length).toBe(a.inlets.length);
          expect(b.outlets.length).toBe(a.outlets.length);
        }
      });

      it("second serialize pass is byte-identical", () => {
        const first = serializePatch(loadGraph(text));
        const second = serializePatch(loadGraph(first));
        expect(second).toBe(first);
      });
    },
  );
});
