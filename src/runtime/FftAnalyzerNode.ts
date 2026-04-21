import { AudioRuntime } from "./AudioRuntime";

const SCREEN_W = 128;
const SCREEN_H = 64;

// App palette — matches --pn-* tokens as closely as canvas allows
const BG        = "#000000";   // --pn-bg-deep
const BAR_DIM   = "#060a06";   // --pn-surface (unlit column)
const GRID_LINE = "rgba(0,0,0,0.5)";

// Low → hi: deep infernal green ramping to pure lime — all in app palette
const BAND_COLORS: string[] = ["#006400", "#00b300", "#00ff00", "#a8ffa8"];

// Frequency band definitions [lo, hi] in Hz
const BANDS: [number, number][] = [
  [20,   250],   // low
  [250,  2000],  // low-mid
  [2000, 6000],  // hi-mid
  [6000, 20000], // hi
];

export class FftAnalyzerNode {
  private readonly merger: ChannelMergerNode;
  private readonly analyser: AnalyserNode;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly freqData: Uint8Array<ArrayBuffer>;
  private readonly sampleRate: number;

  private _bandLevels: [number, number, number, number] = [0, 0, 0, 0];

  constructor(runtime: AudioRuntime) {
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
  }

  get inputNode(): AudioNode { return this.merger; }

  get bandLevels(): [number, number, number, number] { return this._bandLevels; }

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

      // Pick color by frequency band
      let color = BAND_COLORS[3];
      if (freq < 250)  color = BAND_COLORS[0];
      else if (freq < 2000) color = BAND_COLORS[1];
      else if (freq < 6000) color = BAND_COLORS[2];

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

  private computeBands(): [number, number, number, number] {
    const nyquist = this.sampleRate / 2;
    const binHz = nyquist / this.freqData.length;
    return BANDS.map(([lo, hi]) => {
      const s = Math.max(0, Math.floor(lo / binHz));
      const e = Math.min(Math.ceil(hi / binHz), this.freqData.length - 1);
      let sum = 0;
      for (let i = s; i <= e; i++) sum += this.freqData[i];
      return sum / ((e - s + 1) * 255);
    }) as [number, number, number, number];
  }

  destroy(): void {
    this.merger.disconnect();
    this.analyser.disconnect();
  }
}
