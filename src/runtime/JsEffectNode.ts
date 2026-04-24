import type { AudioRuntime } from "./AudioRuntime";

export type JsEffectStatusKind = "idle" | "compiled" | "compile-error" | "runtime-error";

export interface JsEffectStatus {
  kind: JsEffectStatusKind;
  /** Non-empty when kind is compile-error / runtime-error. */
  message: string;
  /** For runtime-error: which section threw. */
  where?: "init" | "slider" | "block" | "sample";
}

export type JsEffectStatusListener = (status: JsEffectStatus) => void;

/** Translated JSFX body set the Panel hands to JsEffectNode. All three
 *  section bodies are compiled on the worklet side, sharing a state object
 *  so user vars set in @init / @slider are visible to @sample. */
export interface JsEffectCompileInput {
  init: string;
  slider: string;
  block: string;
  sample: string;
  /** Union of user vars across all sections. Worklet zero-initialises
   *  each slot on `state` before running @init. */
  userVars: string[];
}

/**
 * Per-object wrapper around the JSFX AudioWorkletNode.
 *
 * Signal topology:
 *   ┌──── inputMerger (2-in, 1 stereo-out) ────┐
 *   │ upstream nodes connect(merger, ch, idx)  │
 *   └──────────┬───────────────────────────────┘
 *              ↓
 *         worklet (stereo in/out)
 *              ↓
 *   ┌──── outputSplitter (1-in, 2-out) ────────┐
 *   │ connectOutlet(dest, outlet, inputIdx)    │
 *   └───────────────────────────────────────────┘
 *
 * Mirrors the adc~/dac~ pattern: the `inputMerger` is what upstream sources
 * connect into with (channel, inputIndex), and `connectOutlet` exposes each
 * output channel as its own outlet for downstream consumers.
 */
export class JsEffectNode {
  private readonly worklet: AudioWorkletNode;
  private readonly inputMerger: ChannelMergerNode;
  private readonly outputSplitter: ChannelSplitterNode;
  private readonly listeners = new Set<JsEffectStatusListener>();
  private _status: JsEffectStatus = { kind: "idle", message: "" };

  constructor(runtime: AudioRuntime) {
    const ctx = runtime.context;

    this.inputMerger    = ctx.createChannelMerger(2);
    this.outputSplitter = ctx.createChannelSplitter(2);

    this.worklet = new AudioWorkletNode(ctx, "jsfx-processor", {
      numberOfInputs:  1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });

    this.inputMerger.connect(this.worklet);
    this.worklet.connect(this.outputSplitter);

    this.worklet.port.onmessage = (ev) => this.onMessage(ev);
  }

  /** Where upstream nodes connect IN — stereo merger expecting channel-mapped
   *  connects: `source.connect(this.input, fromChannel, toInputIndex)`. */
  get input(): AudioNode { return this.inputMerger; }

  /** Connect one of the two output channels (0 = L, 1 = R) to a destination
   *  input index. Mirrors AdcNode.connectChannel. */
  connectOutlet(dest: AudioNode, outputChannel: number, inputIndex: number): void {
    this.outputSplitter.connect(dest, outputChannel, inputIndex);
  }

  disconnect(): void {
    try { this.outputSplitter.disconnect(); } catch { /* ok */ }
  }

  get status(): JsEffectStatus { return this._status; }

  setCode(compiled: JsEffectCompileInput): void {
    this.worklet.port.postMessage({
      type: "code",
      init:   compiled.init,
      slider: compiled.slider,
      block:  compiled.block,
      sample: compiled.sample,
      userVars: compiled.userVars,
    });
  }

  setSlider(index: number, value: number): void {
    this.worklet.port.postMessage({ type: "slider", index, value });
  }

  /** Subscribe to status changes; returns unsubscribe. Fires current state
   *  immediately so late subscribers aren't stuck on idle. */
  onStatus(listener: JsEffectStatusListener): () => void {
    this.listeners.add(listener);
    listener(this._status);
    return () => { this.listeners.delete(listener); };
  }

  destroy(): void {
    try { this.worklet.port.onmessage = null; } catch { /* noop */ }
    try { this.worklet.disconnect();        } catch { /* noop */ }
    try { this.inputMerger.disconnect();    } catch { /* noop */ }
    try { this.outputSplitter.disconnect(); } catch { /* noop */ }
    this.listeners.clear();
  }

  private onMessage(ev: MessageEvent): void {
    const data = ev.data as { type?: string; message?: string; where?: "init" | "slider" | "block" | "sample" };
    if (data.type === "compiled") {
      this.setStatus({ kind: "compiled", message: "" });
    } else if (data.type === "compile-error") {
      this.setStatus({ kind: "compile-error", message: data.message ?? "compile error" });
    } else if (data.type === "runtime-error") {
      this.setStatus({
        kind: "runtime-error",
        message: data.message ?? "runtime error",
        where: data.where,
      });
    }
  }

  private setStatus(status: JsEffectStatus): void {
    this._status = status;
    for (const l of this.listeners) l(status);
  }
}
