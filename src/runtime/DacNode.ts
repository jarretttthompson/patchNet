import { AudioRuntime } from "./AudioRuntime";

/**
 * DacNode — stereo audio output sink.
 *
 * Uses a ChannelMergerNode(2) so that inlet 0 drives the left channel
 * and inlet 1 drives the right channel independently. The merger feeds
 * into the master gain → audioContext.destination.
 */
export class DacNode {
  private readonly merger: ChannelMergerNode;

  constructor(runtime: AudioRuntime) {
    const ctx = runtime.context;
    this.merger = ctx.createChannelMerger(2);
    this.merger.connect(runtime.masterInput);
  }

  /**
   * The ChannelMergerNode that audio sources connect into.
   * Callers must specify which input (0=L, 1=R) via connect(merger, 0, inlet).
   */
  get inputNode(): AudioNode {
    return this.merger;
  }

  destroy(): void {
    this.merger.disconnect();
  }
}
