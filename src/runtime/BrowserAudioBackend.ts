import type { PatchGraph } from "../graph/PatchGraph";
import type { SubPatchManager } from "../canvas/SubPatchManager";
import type { AudioBackend } from "../platform/audio";
import { AudioGraph } from "./AudioGraph";
import { AudioRuntime } from "./AudioRuntime";

/**
 * Web Audio implementation of `AudioBackend`. Wraps the existing
 * `AudioRuntime` (singleton AudioContext + master gain) and `AudioGraph`
 * (per-object node sync) without changing either's behavior.
 *
 * Lifecycle (matches `docs/audio-backend.md §4`):
 *   - construct          → no audio engine yet, no AudioGraph
 *   - start()            → runtime.start() unlocks the AudioContext, then
 *                          AudioGraph is constructed on top
 *   - sync(graph)        → delegated to the AudioGraph's own sync()
 *                          (event-driven from PatchGraph "change" already)
 *   - stop()             → tear down AudioGraph, close AudioContext
 *   - destroy()          → synchronous teardown of the AudioGraph; the
 *                          singleton runtime is left alone (a future
 *                          backend instance can reuse it)
 *
 * The `audioGraph` accessor is the escape hatch documented in
 * `docs/audio-backend.md §6`: controllers that need Web-Audio-specific
 * access (mixer meters, FFT bands, per-node worklet handles) reach into
 * it directly. New code that *isn't* Web-Audio-specific should use the
 * `AudioBackend` interface instead.
 */
export class BrowserAudioBackend implements AudioBackend {
  private readonly runtime: AudioRuntime;
  private readonly graph: PatchGraph;
  private readonly subPatchManager: SubPatchManager | undefined;
  private _audioGraph: AudioGraph | null = null;

  constructor(graph: PatchGraph, subPatchManager?: SubPatchManager) {
    this.runtime = AudioRuntime.getInstance();
    this.graph = graph;
    this.subPatchManager = subPatchManager;
  }

  async start(): Promise<void> {
    if (this._audioGraph) return; // already started, idempotent
    await this.runtime.start();
    this._audioGraph = new AudioGraph(this.runtime, this.graph, this.subPatchManager);
  }

  async stop(): Promise<void> {
    this._audioGraph?.destroy();
    this._audioGraph = null;
    await this.runtime.stop();
  }

  get isStarted(): boolean {
    return this.runtime.isStarted;
  }

  get sampleRate(): number {
    // Spec contract: returns 0 before start() so UI can render "—"
    // without try/catch. (`runtime.context` would throw otherwise.)
    return this.runtime.isStarted ? this.runtime.sampleRate : 0;
  }

  get latencyMs(): number {
    if (!this.runtime.isStarted) return 0;
    const ctx = this.runtime.context;
    // baseLatency: processing latency (~256/sampleRate, always reported)
    // outputLatency: hardware buffer latency (Chrome 102+; some browsers
    //   report 0 if the API isn't implemented yet)
    const base = ctx.baseLatency ?? 0;
    const output = ctx.outputLatency ?? 0;
    const seconds = base + output;
    // Fallback estimate when neither value is reported (very rare —
    // Firefox without performance.timeOrigin permission, etc.). 15ms is a
    // reasonable default for typical Web Audio setups.
    return seconds > 0 ? seconds * 1000 : 15;
  }

  sync(_graph: PatchGraph): void {
    // AudioGraph subscribes to its own PatchGraph "change" events at
    // construction (`AudioGraph.ts:76`). Calling sync() externally is an
    // idempotent forced reconciliation — useful in tests or after manual
    // graph mutations that won't have fired "change".
    this._audioGraph?.sync();
  }

  destroy(): void {
    this._audioGraph?.destroy();
    this._audioGraph = null;
    // Don't touch the AudioRuntime singleton — it can be reused by a
    // future backend instance in the same tab. Use `stop()` if hardware
    // release is required.
  }

  /**
   * Escape hatch: the underlying `AudioGraph`. Returns `null` before
   * `start()` resolves. Web-Audio-specific consumers cast their
   * `AudioBackend` to `BrowserAudioBackend` and read this; see
   * `docs/audio-backend.md §6`.
   */
  get audioGraph(): AudioGraph | null {
    return this._audioGraph;
  }

  /**
   * Escape hatch: the underlying `AudioRuntime` (singleton AudioContext +
   * master gain). Used by code that needs to enumerate audio devices,
   * route to a specific output, or read the AudioContext directly.
   */
  get audioRuntime(): AudioRuntime {
    return this.runtime;
  }
}
