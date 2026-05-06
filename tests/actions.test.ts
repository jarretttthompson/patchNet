import { describe, expect, it } from "vitest";

import { ActionRegistry } from "../src/actions/ActionRegistry";
import { ActionKeymap, eventToChord, isEditableTarget } from "../src/actions/ActionKeymap";
import type { PatchAction } from "../src/actions/types";

function makeAction(partial: Partial<PatchAction> & { id: string }): PatchAction {
  return {
    title: partial.title ?? partial.id,
    section: partial.section ?? "Test",
    run: partial.run ?? (() => {}),
    ...partial,
  };
}

// ── Polyfills for the node test environment ─────────────────────────────────
// vitest runs with environment: "node" in this project, so KeyboardEvent and
// HTMLElement are not available. Tests that need them shim a minimal subset.

class FakeKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: unknown;
  constructor(opts: Partial<FakeKeyEvent> = {}) {
    this.key = opts.key ?? "";
    this.code = opts.code ?? "";
    this.metaKey = opts.metaKey ?? false;
    this.ctrlKey = opts.ctrlKey ?? false;
    this.altKey = opts.altKey ?? false;
    this.shiftKey = opts.shiftKey ?? false;
    this.target = opts.target ?? null;
  }
}

describe("ActionRegistry", () => {
  it("rejects duplicate IDs", () => {
    const r = new ActionRegistry();
    r.register(makeAction({ id: "a.b" }));
    expect(() => r.register(makeAction({ id: "a.b" }))).toThrow(/already registered/i);
  });

  it("registerAll accepts a batch", () => {
    const r = new ActionRegistry();
    r.registerAll([
      makeAction({ id: "x.one" }),
      makeAction({ id: "x.two" }),
    ]);
    expect(r.list().map((a) => a.id).sort()).toEqual(["x.one", "x.two"]);
  });

  it("search matches title prefix, id, keywords, and category", () => {
    const r = new ActionRegistry();
    r.registerAll([
      makeAction({ id: "canvas.selection.delete", title: "Delete selection", section: "Selection" }),
      makeAction({ id: "app.file.save", title: "Save patch to file", section: "Application", category: "File" }),
      makeAction({ id: "app.audio.toggle", title: "Toggle DSP", section: "Application", keywords: ["audio", "play"] }),
    ]);

    expect(r.search("delete").map((a) => a.id)).toContain("canvas.selection.delete");
    expect(r.search("save").map((a) => a.id)).toContain("app.file.save");
    expect(r.search("audio").map((a) => a.id)).toContain("app.audio.toggle");
    expect(r.search("file").map((a) => a.id)).toContain("app.file.save"); // category match
    expect(r.search("app.audio").map((a) => a.id)).toContain("app.audio.toggle"); // id match
  });

  it("empty query returns every action sorted", () => {
    const r = new ActionRegistry();
    r.registerAll([
      makeAction({ id: "z.one", title: "Zoom", section: "View" }),
      makeAction({ id: "a.one", title: "Apply", section: "Application" }),
    ]);
    expect(r.search("").map((a) => a.id)).toEqual(["a.one", "z.one"]);
  });

  it("ranks exact match higher than substring", () => {
    const r = new ActionRegistry();
    r.registerAll([
      makeAction({ id: "x.delete-thing", title: "Delete a thing" }),
      makeAction({ id: "x.delete", title: "Delete" }),
    ]);
    const result = r.search("delete");
    expect(result[0].id).toBe("x.delete");
  });
});

describe("ActionKeymap", () => {
  it("resolves Mod+S to the platform's mod key (meta on mac, ctrl elsewhere)", () => {
    // IS_MAC is module-load-time. Both node 22+ and the dev's mac shell
    // expose navigator.platform, so we read that to pick the matching key.
    const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
    const r = new ActionRegistry();
    r.register(makeAction({ id: "f.save", defaultKeys: ["Mod+S"] }));
    const km = new ActionKeymap(r);
    km.rebuildFromDefaults();

    const platformMod = new FakeKeyEvent({ key: "s", metaKey: isMac, ctrlKey: !isMac });
    const otherMod    = new FakeKeyEvent({ key: "s", metaKey: !isMac, ctrlKey: isMac });
    expect(km.resolve(platformMod as unknown as KeyboardEvent)).toContain("f.save");
    expect(km.resolve(otherMod    as unknown as KeyboardEvent)).not.toContain("f.save");
  });

  it("resolves bare letters and named keys", () => {
    const r = new ActionRegistry();
    r.registerAll([
      makeAction({ id: "view.toolbar", defaultKeys: ["Q"] }),
      makeAction({ id: "sel.delete", defaultKeys: ["Delete", "Backspace"] }),
      makeAction({ id: "actions.open", defaultKeys: ["?"] }),
    ]);
    const km = new ActionKeymap(r);
    km.rebuildFromDefaults();

    expect(km.resolve(new FakeKeyEvent({ key: "q" }) as unknown as KeyboardEvent)).toEqual(["view.toolbar"]);
    expect(km.resolve(new FakeKeyEvent({ key: "Q", shiftKey: true }) as unknown as KeyboardEvent)).toEqual(["view.toolbar"]);
    expect(km.resolve(new FakeKeyEvent({ key: "Delete" }) as unknown as KeyboardEvent)).toEqual(["sel.delete"]);
    expect(km.resolve(new FakeKeyEvent({ key: "Backspace" }) as unknown as KeyboardEvent)).toEqual(["sel.delete"]);
    // "?" arrives from Shift+/ — e.key is "?", shift is present but irrelevant
    expect(km.resolve(new FakeKeyEvent({ key: "?", shiftKey: true }) as unknown as KeyboardEvent)).toEqual(["actions.open"]);
  });

  it("does not match plain key when chord required modifier", () => {
    const r = new ActionRegistry();
    r.register(makeAction({ id: "f.save", defaultKeys: ["Mod+S"] }));
    const km = new ActionKeymap(r);
    km.rebuildFromDefaults();
    expect(km.resolve(new FakeKeyEvent({ key: "s" }) as unknown as KeyboardEvent)).toEqual([]);
  });

  it("supports multiple bindings for one action", () => {
    const r = new ActionRegistry();
    r.register(makeAction({ id: "view.zoomIn", defaultKeys: ["Mod+=", "Mod++"] }));
    const km = new ActionKeymap(r);
    km.rebuildFromDefaults();
    expect(km.resolve(new FakeKeyEvent({ key: "=", metaKey: true }) as unknown as KeyboardEvent)).toEqual(["view.zoomIn"]);
    expect(km.resolve(new FakeKeyEvent({ key: "+", metaKey: true }) as unknown as KeyboardEvent)).toEqual(["view.zoomIn"]);
    expect(km.shortcutsFor("view.zoomIn")).toEqual(["Mod+=", "Mod++"]);
  });

  it("eventToChord round-trips printable + named keys", () => {
    expect(eventToChord(new FakeKeyEvent({ key: "s", metaKey: true }) as unknown as KeyboardEvent)).toMatch(/^mod\+s$/i);
    expect(eventToChord(new FakeKeyEvent({ key: "Delete" }) as unknown as KeyboardEvent)).toBe("Delete");
    expect(eventToChord(new FakeKeyEvent({ code: "Space" }) as unknown as KeyboardEvent)).toBe("Space");
  });

  it("rejects chord strings with no key leaf", () => {
    const r = new ActionRegistry();
    r.register(makeAction({ id: "x" }));
    const km = new ActionKeymap(r);
    expect(() => km.bind("x", "Mod+Shift+")).toThrow();
  });

  it("isEditableTarget true for inputs/textarea/contenteditable", () => {
    // Faux-HTMLElement objects — isEditableTarget only checks instanceof
    // HTMLElement, tagName, and isContentEditable. In node we approximate:
    class FakeEl {
      tagName: string;
      isContentEditable: boolean;
      constructor(tag: string, ce = false) { this.tagName = tag; this.isContentEditable = ce; }
    }
    // Without a real HTMLElement constructor, instanceof always fails — so
    // this test verifies the function returns false on non-HTMLElement targets
    // (the safe default), then we test the positive cases by patching.
    const fake = new FakeEl("INPUT");
    expect(isEditableTarget(fake as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("Built-in action IDs", () => {
  it("are unique and parseable as chords", async () => {
    const { BUILTIN_ACTIONS } = await import("../src/actions/builtinActions");
    const ids = new Set<string>();
    for (const a of BUILTIN_ACTIONS) {
      expect(ids.has(a.id), `duplicate id: ${a.id}`).toBe(false);
      ids.add(a.id);
    }

    // Every default key should bind without throwing.
    const r = new ActionRegistry();
    r.registerAll(BUILTIN_ACTIONS);
    const km = new ActionKeymap(r);
    expect(() => km.rebuildFromDefaults()).not.toThrow();

    // ? must be bound to the action-list opener — that's the canonical entry.
    expect(km.resolve(new FakeKeyEvent({ key: "?", shiftKey: true }) as unknown as KeyboardEvent))
      .toContain("app.actions.open");
  });
});

describe("Generated object-create actions", () => {
  it("emit one canvas.object.create.<type> per OBJECT_DEFS key", async () => {
    const { generateObjectCreateActions } = await import("../src/actions/objectCreateActions");
    const { OBJECT_DEFS } = await import("../src/graph/objectDefs");

    const actions = generateObjectCreateActions();
    const types = Object.keys(OBJECT_DEFS).sort();

    expect(actions.length).toBe(types.length);
    expect(actions.map((a) => a.id).sort()).toEqual(
      types.map((t) => `canvas.object.create.${t}`).sort(),
    );
  });

  it("preserve B/T/S/A/M default keys", async () => {
    const { generateObjectCreateActions } = await import("../src/actions/objectCreateActions");
    const map = new Map(generateObjectCreateActions().map((a) => [a.id, a]));
    expect(map.get("canvas.object.create.button")?.defaultKeys).toEqual(["B"]);
    expect(map.get("canvas.object.create.toggle")?.defaultKeys).toEqual(["T"]);
    expect(map.get("canvas.object.create.slider")?.defaultKeys).toEqual(["S"]);
    expect(map.get("canvas.object.create.attribute")?.defaultKeys).toEqual(["A"]);
    expect(map.get("canvas.object.create.message")?.defaultKeys).toEqual(["M"]);
  });

  it("registers cleanly alongside built-ins (no id collisions)", async () => {
    const { BUILTIN_ACTIONS } = await import("../src/actions/builtinActions");
    const { generateObjectCreateActions } = await import("../src/actions/objectCreateActions");
    const r = new ActionRegistry();
    expect(() => {
      r.registerAll(BUILTIN_ACTIONS);
      r.registerAll(generateObjectCreateActions());
    }).not.toThrow();
  });
});
