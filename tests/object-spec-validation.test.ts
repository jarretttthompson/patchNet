import { describe, expect, it } from "vitest";

import { OBJECT_DEFS, validateObjectDef } from "../src/graph/objectDefs";

/**
 * M1 (Object API Contract) — task 1d: runtime validation.
 *
 * Every registered ObjectSpec must satisfy validateObjectDef(). objectDefs.ts
 * already runs this at module init, but only as console.warn (easy to miss).
 * This test makes the contract *enforced*: a non-conforming object fails CI
 * instead of silently warning into a scrolled-away dev console.
 *
 * The assertion message below is the canonical "conformance failure" report.
 */
describe("ObjectSpec contract (M1/1d)", () => {
  const failures: Record<string, string[]> = {};
  for (const [type, spec] of Object.entries(OBJECT_DEFS)) {
    const errs = validateObjectDef(type, spec);
    if (errs.length > 0) failures[type] = errs;
  }

  it("every registered object conforms to validateObjectDef()", () => {
    const offenders = Object.keys(failures);
    const report =
      offenders.length === 0
        ? ""
        : `\n${offenders.length}/${Object.keys(OBJECT_DEFS).length} objects fail the spec:\n` +
          offenders
            .map((t) => `  ${t}:\n${failures[t].map((e) => `    - ${e}`).join("\n")}`)
            .join("\n");
    expect(report, report).toBe("");
  });

  it("registers a non-empty object catalog", () => {
    expect(Object.keys(OBJECT_DEFS).length).toBeGreaterThan(0);
  });
});
