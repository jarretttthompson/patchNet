import { afterEach, describe, expect, it } from "vitest";

import { PatchGraph } from "../src/graph/PatchGraph";
import { BrowserAudioBackend } from "../src/runtime/BrowserAudioBackend";
import { NativeAudioBackend } from "../src/runtime/NativeAudioBackend";
import type { AudioBackend } from "../src/platform/audio";
import { getAudioCapabilities } from "../src/platform/audio";
import {
  _resetAudioBackendForTests,
  getAudioBackend,
} from "../src/platform/registry";
import { isNative } from "../src/platform/index";

afterEach(() => {
  _resetAudioBackendForTests();
});

describe("AudioBackend — registry (M3/d)", () => {
  it("returns a singleton — second call returns the same instance", () => {
    const graph = new PatchGraph();
    const first = getAudioBackend(graph);
    const second = getAudioBackend(graph);
    expect(second).toBe(first);
  });

  it("returns BrowserAudioBackend in the Node test env (isBrowser)", () => {
    // The test runner has no window/__TAURI__, so isNative is false and
    // isBrowser is true. This test pins that selection rule.
    expect(isNative).toBe(false);
    const backend = getAudioBackend(new PatchGraph());
    expect(backend).toBeInstanceOf(BrowserAudioBackend);
  });

  it("first-call wins — second call ignores its arguments", () => {
    const graph1 = new PatchGraph();
    const graph2 = new PatchGraph();
    const first = getAudioBackend(graph1);
    const second = getAudioBackend(graph2);
    expect(second).toBe(first);
    // The bound graph is graph1 — we can verify via the BrowserAudioBackend
    // escape hatch (audioRuntime is the singleton, doesn't help, so we just
    // confirm the instance identity above).
  });

  it("_resetAudioBackendForTests() drops the singleton", () => {
    const a = getAudioBackend(new PatchGraph());
    _resetAudioBackendForTests();
    const b = getAudioBackend(new PatchGraph());
    expect(b).not.toBe(a);
  });
});

describe("BrowserAudioBackend (M3/b) — stub-state behavior", () => {
  // start()/stop() require a working AudioContext which doesn't exist in
  // the Node test env. Visual verification of those paths is via
  // `npm run dev`. Here we pin the no-start lifecycle.

  it("constructor is safe before any user gesture (no AudioContext touch)", () => {
    expect(() => new BrowserAudioBackend(new PatchGraph())).not.toThrow();
  });

  it("reports zero / null state before start()", () => {
    const backend = new BrowserAudioBackend(new PatchGraph());
    expect(backend.isStarted).toBe(false);
    expect(backend.sampleRate).toBe(0);
    expect(backend.latencyMs).toBe(0);
    expect(backend.audioGraph).toBeNull();
  });

  it("destroy() before start is a safe no-op", () => {
    const backend = new BrowserAudioBackend(new PatchGraph());
    expect(() => backend.destroy()).not.toThrow();
    expect(backend.isStarted).toBe(false);
  });

  it("sync() before start is a safe no-op", () => {
    const backend = new BrowserAudioBackend(new PatchGraph());
    expect(() => backend.sync(new PatchGraph())).not.toThrow();
  });

  it("conforms to the AudioBackend interface (structural)", () => {
    const backend: AudioBackend = new BrowserAudioBackend(new PatchGraph());
    // If this compiles, structural conformance is satisfied. The runtime
    // assertion below is belt-and-braces against accidental any-typing.
    expect(typeof backend.start).toBe("function");
    expect(typeof backend.stop).toBe("function");
    expect(typeof backend.sync).toBe("function");
    expect(typeof backend.destroy).toBe("function");
    expect(typeof backend.isStarted).toBe("boolean");
    expect(typeof backend.sampleRate).toBe("number");
    expect(typeof backend.latencyMs).toBe("number");
  });
});

describe("NativeAudioBackend (M3/c) — stub-state behavior", () => {
  // The stub is fully testable in Node — no AudioContext, no Tauri runtime
  // needed. M3/f will replace these stubs with real CPAL/IPC calls and
  // those will need integration tests against the running native binary.

  it("constructor doesn't throw", () => {
    expect(() => new NativeAudioBackend(new PatchGraph())).not.toThrow();
  });

  it("reports zero state before start()", () => {
    const backend = new NativeAudioBackend(new PatchGraph());
    expect(backend.isStarted).toBe(false);
    expect(backend.sampleRate).toBe(0);
    expect(backend.latencyMs).toBe(0);
  });

  it("start() flips isStarted and reports placeholder sample rate", async () => {
    const backend = new NativeAudioBackend(new PatchGraph());
    await backend.start();
    expect(backend.isStarted).toBe(true);
    expect(backend.sampleRate).toBe(48000);
    expect(backend.latencyMs).toBe(0); // M3/c stub: no real latency yet
  });

  it("start() is idempotent — second call is a no-op", async () => {
    const backend = new NativeAudioBackend(new PatchGraph());
    await backend.start();
    await backend.start();
    expect(backend.isStarted).toBe(true);
  });

  it("stop() flips isStarted back", async () => {
    const backend = new NativeAudioBackend(new PatchGraph());
    await backend.start();
    await backend.stop();
    expect(backend.isStarted).toBe(false);
    expect(backend.sampleRate).toBe(0);
  });

  it("sync() is a no-op (doesn't throw)", () => {
    const backend = new NativeAudioBackend(new PatchGraph());
    expect(() => backend.sync(new PatchGraph())).not.toThrow();
  });

  it("destroy() flips isStarted back", async () => {
    const backend = new NativeAudioBackend(new PatchGraph());
    await backend.start();
    backend.destroy();
    expect(backend.isStarted).toBe(false);
  });

  it("conforms to the AudioBackend interface (structural)", () => {
    const backend: AudioBackend = new NativeAudioBackend(new PatchGraph());
    expect(typeof backend.start).toBe("function");
    expect(typeof backend.sync).toBe("function");
    expect(typeof backend.destroy).toBe("function");
    expect(typeof backend.isStarted).toBe("boolean");
    expect(typeof backend.sampleRate).toBe("number");
    expect(typeof backend.latencyMs).toBe("number");
  });
});

describe("AudioCapabilities (M3/a) — platform matrix", () => {
  it("browser: every native-only capability is false", () => {
    const caps = getAudioCapabilities(false);
    expect(caps.lowLatencyIO).toBe(false);
    expect(caps.midiIO).toBe(false);
    expect(caps.multiChannelProIO).toBe(false);
    expect(caps.nativeSidecar).toBe(false);
  });

  it("native: every capability is true (palette / autocomplete filter gates)", () => {
    const caps = getAudioCapabilities(true);
    expect(caps.lowLatencyIO).toBe(true);
    expect(caps.midiIO).toBe(true);
    expect(caps.multiChannelProIO).toBe(true);
    expect(caps.nativeSidecar).toBe(true);
  });
});
