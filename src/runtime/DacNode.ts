import { AudioRuntime } from "./AudioRuntime";

/**
 * DacNode — stereo audio output sink.
 *
 * Signal path: sources → merger(2) → masterInput
 *                                   → splitter(2) → analyserL (dead-end tap)
 *                                                  → analyserR (dead-end tap)
 */
export class DacNode {
  private readonly merger: ChannelMergerNode;
  private readonly splitter: ChannelSplitterNode;
  private readonly analyserL: AnalyserNode;
  private readonly analyserR: AnalyserNode;
  private readonly dataL: Float32Array<ArrayBuffer>;
  private readonly dataR: Float32Array<ArrayBuffer>;

  constructor(runtime: AudioRuntime) {
    const ctx = runtime.context;

    this.merger = ctx.createChannelMerger(2);
    this.merger.connect(runtime.masterInput);

    this.splitter = ctx.createChannelSplitter(2);
    this.merger.connect(this.splitter);

    this.analyserL = ctx.createAnalyser();
    this.analyserL.fftSize = 256;
    this.analyserL.smoothingTimeConstant = 0.8;
    this.dataL = new Float32Array(this.analyserL.fftSize) as Float32Array<ArrayBuffer>;
    this.splitter.connect(this.analyserL, 0);

    this.analyserR = ctx.createAnalyser();
    this.analyserR.fftSize = 256;
    this.analyserR.smoothingTimeConstant = 0.8;
    this.dataR = new Float32Array(this.analyserR.fftSize) as Float32Array<ArrayBuffer>;
    this.splitter.connect(this.analyserR, 1);
  }

  get inputNode(): AudioNode { return this.merger; }

  get levelL(): number { return rms(this.analyserL, this.dataL); }
  get levelR(): number { return rms(this.analyserR, this.dataR); }
  get level():  number { return (this.levelL + this.levelR) / 2; }

  destroy(): void {
    this.merger.disconnect();
    this.splitter.disconnect();
    this.analyserL.disconnect();
    this.analyserR.disconnect();
  }
}

function rms(analyser: AnalyserNode, data: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}
