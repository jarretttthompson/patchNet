import { AudioRuntime } from "./AudioRuntime";

/**
 * ClickNode — fires a single-sample impulse on bang.
 *
 * Creates a fresh AudioBufferSourceNode on each trigger (the correct
 * Web Audio pattern for one-shot sources). Connects to the shared
 * DacNode destination if one is registered, otherwise to the master
 * gain. The inputIndex determines which channel of the destination to
 * drive (0 = left, 1 = right).
 */
interface Connection {
  dest: AudioNode;
  inputIndex: number;
}

export class ClickNode {
  private readonly runtime: AudioRuntime;
  private connections: Connection[] = [];

  constructor(runtime: AudioRuntime) {
    this.runtime = runtime;
  }

  /**
   * Add a connection from this click source to a downstream audio node.
   * inputIndex: which input of the destination to connect to (0=L, 1=R).
   * Multiple calls accumulate connections — call disconnect() first to reset.
   */
  connect(dest: AudioNode, inputIndex = 0): void {
    this.connections.push({ dest, inputIndex });
  }

  disconnect(): void {
    this.connections = [];
  }

  /** Fire one impulse sample to all connected destinations. No-op if AudioRuntime is not started. */
  trigger(): void {
    if (!this.runtime.isStarted) return;

    const ctx = this.runtime.context;
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    buffer.getChannelData(0)[0] = 1.0;

    if (this.connections.length === 0) {
      // No patch cables — fire to master output directly
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.runtime.masterInput);
      source.start();
      return;
    }

    for (const { dest, inputIndex } of this.connections) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest, 0, inputIndex);
      source.start();
    }
  }
}
