import { describe, expect, it } from "vitest";
import { frame, parse } from "../../src/runtime/peer/topicRouter";

describe("topicRouter", () => {
  it("round-trips a bang", () => {
    const wire = frame("ctl", null);
    expect(parse(wire)).toEqual({ topic: "ctl", payload: null });
  });

  it("round-trips a float", () => {
    const wire = frame("rate", 0.42);
    expect(parse(wire)).toEqual({ topic: "rate", payload: 0.42 });
  });

  it("round-trips a symbol", () => {
    const wire = frame("name", "hello");
    expect(parse(wire)).toEqual({ topic: "name", payload: "hello" });
  });

  it("round-trips a list", () => {
    const wire = frame("vec", [1, 2, "x", null]);
    expect(parse(wire)).toEqual({ topic: "vec", payload: [1, 2, "x", null] });
  });

  it("rejects malformed JSON", () => {
    expect(parse("not json")).toBeNull();
  });

  it("rejects messages without a topic string", () => {
    expect(parse(JSON.stringify({ p: 1 }))).toBeNull();
    expect(parse(JSON.stringify({ t: "", p: 1 }))).toBeNull();
    expect(parse(JSON.stringify({ t: 42, p: 1 }))).toBeNull();
  });

  it("treats missing payload as null (bang)", () => {
    expect(parse(JSON.stringify({ t: "ctl" }))).toEqual({ topic: "ctl", payload: null });
  });

  it("escapes topic strings safely", () => {
    const tricky = 'has "quotes" and \\ backslashes';
    const wire = frame(tricky, "ok");
    expect(parse(wire)).toEqual({ topic: tricky, payload: "ok" });
  });
});
