import { describe, expect, it } from "vitest";

import { KNOWN_VERSIONS, parsePatch, PatchParseError } from "../src/serializer/parse";

const CANVAS = "#N canvas;\n";

describe("patchnet format version header (M2/b)", () => {
  it("headerless patch parses as v1", () => {
    expect(parsePatch(CANVAS).version).toBe(1);
  });

  it("empty input parses as v1 (still the default)", () => {
    expect(parsePatch("").version).toBe(1);
  });

  it("explicit `#N patchnet v1;` parses as v1", () => {
    expect(parsePatch(`#N patchnet v1;\n${CANVAS}`).version).toBe(1);
  });

  it("explicit `#N patchnet v2;` parses as v2", () => {
    expect(parsePatch(`#N patchnet v2;\n${CANVAS}`).version).toBe(2);
  });

  it("rejects unknown version v0", () => {
    expect(() => parsePatch(`#N patchnet v0;\n${CANVAS}`))
      .toThrow(/Unknown patchnet format version v0/);
  });

  it("rejects unknown future version v99", () => {
    expect(() => parsePatch(`#N patchnet v99;\n${CANVAS}`))
      .toThrow(/Unknown patchnet format version v99/);
  });

  it("rejects malformed version token", () => {
    expect(() => parsePatch(`#N patchnet vfoo;\n${CANVAS}`))
      .toThrow(/Malformed version token "vfoo"/);
  });

  it("rejects header with missing version token", () => {
    expect(() => parsePatch(`#N patchnet;\n${CANVAS}`))
      .toThrow(/missing version token/);
  });

  it("rejects version header after `#N canvas;`", () => {
    expect(() => parsePatch(`${CANVAS}#N patchnet v2;`))
      .toThrow(/must be the first statement/);
  });

  it("rejects version header after an object line", () => {
    expect(() => parsePatch(`${CANVAS}#X obj 0 0 button;\n#N patchnet v2;`))
      .toThrow(/must be the first statement/);
  });

  it("allows comments and blank lines before the version header", () => {
    const text = `// saved 2026-05-20\n\n#N patchnet v2;\n${CANVAS}`;
    expect(parsePatch(text).version).toBe(2);
  });

  it("v2 patch parses to the same nodes/edges as the equivalent v1", () => {
    const body = "#X obj 100 100 button;\n#X obj 200 100 toggle;\n#X connect 0 0 1 0;\n";
    const v1 = parsePatch(`${CANVAS}${body}`);
    const v2 = parsePatch(`#N patchnet v2;\n${CANVAS}${body}`);
    expect(v2.version).toBe(2);
    expect(v1.version).toBe(1);
    expect(v2.nodes.length).toBe(v1.nodes.length);
    expect(v2.edges.length).toBe(v1.edges.length);
    expect(v2.nodes.map((n) => n.type)).toEqual(v1.nodes.map((n) => n.type));
  });

  it("a version header without `#N canvas;` still fails (canvas remains required)", () => {
    expect(() => parsePatch(`#N patchnet v2;\n#X obj 0 0 button;\n`))
      .toThrow(/Patch must start with #N canvas/);
  });

  it("error type is PatchParseError (not generic Error)", () => {
    let caught: unknown = null;
    try { parsePatch(`#N patchnet v0;\n${CANVAS}`); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PatchParseError);
  });

  it("KNOWN_VERSIONS exposes the supported set", () => {
    expect(KNOWN_VERSIONS.has(1)).toBe(true);
    expect(KNOWN_VERSIONS.has(2)).toBe(true);
    expect(KNOWN_VERSIONS.has(0)).toBe(false);
    expect(KNOWN_VERSIONS.has(3)).toBe(false);
  });
});
