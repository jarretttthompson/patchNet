import { AudioRuntime } from "./AudioRuntime";

/**
 * DacNode — multichannel audio output sink.
 *
 * Signal path: sources → merger(N) → masterInput
 *                                  → splitter(N) → analyser per channel
 *
 * Channel N (1-indexed in the UI; 0-indexed inlets) maps to physical output N
 * via discrete channel routing on the AudioContext destination. Browsers
 * differ on multichannel output support — the AudioConfigPanel surfaces
 * `destination.maxChannelCount` so users know the ceiling.
 */
export class DacNode {
  private readonly _channels: number;
  private readonly merger: ChannelMergerNode;
  private readonly splitter: ChannelSplitterNode;
  private readonly analysers: AnalyserNode[];
  private readonly analyserData: Float32Array<ArrayBuffer>;

  constructor(runtime: AudioRuntime, channels: number = 2) {
    this._channels = Math.max(1, Math.min(32, channels | 0));
    const ctx = runtime.context;

    this.merger = ctx.createChannelMerger(this._channels);
    this.merger.connect(runtime.masterInput);

    this.splitter = ctx.createChannelSplitter(this._channels);
    this.merger.connect(this.splitter);

    this.analysers = [];
    this.analyserData = new Float32Array(256) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < this._channels; i++) {
      const a = ctx.createAnalyser();
      a.fftSize = 256;
      a.smoothingTimeConstant = 0.8;
      this.splitter.connect(a, i);
      this.analysers.push(a);
    }
  }

  get inputNode(): AudioNode { return this.merger; }
  get channelCount(): number { return this._channels; }

  getChannelLevel(ch: number): number {
    const a = this.analysers[ch];
    if (!a) return 0;
    a.getFloatTimeDomainData(this.analyserData);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) sum += this.analyserData[i] * this.analyserData[i];
    return Math.sqrt(sum / this.analyserData.length);
  }

  get levelL(): number { return this.getChannelLevel(0); }
  get levelR(): number { return this.getChannelLevel(this._channels > 1 ? 1 : 0); }
  get level():  number { return (this.levelL + this.levelR) / 2; }

  destroy(): void {
    try { this.merger.disconnect(); } catch { /* ok */ }
    try { this.splitter.disconnect(); } catch { /* ok */ }
    for (const a of this.analysers) { try { a.disconnect(); } catch { /* ok */ } }
  }
}
