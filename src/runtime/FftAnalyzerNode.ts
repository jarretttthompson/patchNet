import { AudioRuntime } from "./AudioRuntime";
import { fftBandRanges, type FftBandCount } from "../graph/objectDefs";

const SCREEN_W = 128;
const SCREEN_H = 64;

// App palette — matches --pn-* tokens as closely as canvas allows
const BG        = "#000000";   // --pn-bg-deep
const BAR_DIM   = "#060a06";   // --pn-surface (unlit column)
const GRID_LINE = "rgba(0,0,0,0.5)";

// Low → hi: deep infernal green ramping to pure lime — all in app palette.
// 4 stops; intermediate band counts interpolate by position.
const BAND_COLOR_STOPS: string[] = ["#006400", "#00b300", "#00ff00", "#a8ffa8"];

function bandColor(bandIndex: number, bandCount: number): string {
  if (bandCount <= 1) return BAND_COLOR_STOPS[BAND_COLOR_STOPS.length - 1];
  const t = bandIndex / (bandCount - 1);
  const slot = Math.min(
    BAND_COLOR_STOPS.length - 1,
    Math.floor(t * (BAND_COLOR_STOPS.length - 1) + 0.0001),
  );
  return BAND_COLOR_STOPS[slot];
}

export class FftAnalyzerNode {
  private readonly merger: ChannelMergerNode;
  private readonly analyser: AnalyserNode;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly freqData: Uint8Array<ArrayBuffer>;
  private readonly sampleRate: number;

  private _bandCount: FftBandCount;
  private _bandRanges: Array<[number, number]>;
  private _bandLevels: number[];

  constructor(runtime: AudioRuntime, bandCount: FftBandCount = 4) {
    const actx = runtime.context;
    this.sampleRate = actx.sampleRate;

    this.merger = actx.createChannelMerger(2);

    this.analyser = actx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.merger.connect(this.analyser);

    this.canvas = document.createElement("canvas");
    this.canvas.width  = SCREEN_W;
    this.canvas.height = SCREEN_H;
    const c = this.canvas.getContext("2d");
    if (!c) throw new Error("[FftAnalyzerNode] canvas context unavailable");
    this.ctx2d = c;

    this._bandCount  = bandCount;
    this._bandRanges = fftBandRanges(bandCount);
    this._bandLevels = new Array(bandCount).fill(0);
  }

  get inputNode(): AudioNode { return this.merger; }

  get bandCount(): FftBandCount { return this._bandCount; }

  get bandLevels(): readonly number[] { return this._bandLevels; }

  setBandCount(bandCount: FftBandCount): void {
    if (this._bandCount === bandCount) return;
    this._bandCount  = bandCount;
    this._bandRanges = fftBandRanges(bandCount);
    this._bandLevels = new Array(bandCount).fill(0);
  }

  draw(): void {
    this.analyser.getByteFrequencyData(this.freqData);
    this._bandLevels = this.computeBands();

    const ctx = this.ctx2d;
    const w = SCREEN_W;
    const h = SCREEN_H;
    const nyquist = this.sampleRate / 2;
    const binHz = nyquist / this.freqData.length;

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // Log-scale spectrum bars
    const logMin = Math.log10(20);
    const logMax = Math.log10(nyquist);
    const numBars = w;

    for (let i = 0; i < numBars; i++) {
      const logFreq = logMin + (i / numBars) * (logMax - logMin);
      const freq = Math.pow(10, logFreq);
      const binIdx = Math.min(Math.round(freq / binHz), this.freqData.length - 1);
      const value = this.freqData[binIdx] / 255;

      // Pick color by band whose range contains this freq
      let bandIdx = this._bandRanges.findIndex(([lo, hi]) => freq >= lo && freq < hi);
      if (bandIdx < 0) bandIdx = this._bandRanges.length - 1;
      const color = bandColor(bandIdx, this._bandCount);

      const barH = Math.ceil(value * h);

      // Dim "unlit" column
      ctx.fillStyle = BAR_DIM;
      ctx.fillRect(i, 0, 1, h - barH);

      // Lit bar
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15 + value * 0.85;
      ctx.fillRect(i, h - barH, 1, barH);
      ctx.globalAlpha = 1;
    }

    // Scanline overlay — LCD pixel row effect
    ctx.fillStyle = GRID_LINE;
    for (let y = 0; y < h; y += 2) {
      ctx.fillRect(0, y, w, 1);
    }
  }

  private computeBands(): number[] {
    const nyquist = this.sampleRate / 2;
    const binHz = nyquist / this.freqData.length;
    return this._bandRanges.map(([lo, hi]) => {
      const s = Math.max(0, Math.floor(lo / binHz));
      const e = Math.min(Math.ceil(hi / binHz), this.freqData.length - 1);
      let sum = 0;
      for (let i = s; i <= e; i++) sum += this.freqData[i];
      return sum / ((e - s + 1) * 255);
    });
  }

  destroy(): void {
    this.merger.disconnect();
    this.analyser.disconnect();
  }
}
