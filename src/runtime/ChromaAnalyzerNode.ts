import { AudioRuntime } from "./AudioRuntime";

const SCREEN_W = 132;
const SCREEN_H = 56;
const BG = "#000000";
const BAR_DIM = "#0a3d0a";
const BAR_LIT = "#00ff00";
const GRID_LINE = "rgba(0,0,0,0.5)";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Pitch-class folding range. Below ~C2 the FFT bins are too coarse to assign a
// class cleanly; above ~B6 harmonics muddy the estimate.
const MIN_FREQ = 65;    // ~C2
const MAX_FREQ = 2000;  // ~B6

/**
 * ChromaAnalyzerNode — runtime for `chroma~`. Folds the magnitude spectrum
 * into the 12 pitch classes (C, C#, … B), octave-wrapped, producing a chroma
 * vector for harmonic / chord-aware visuals.
 *
 *   outlets 0..11 = pitch-class energy (C..B), each 0..1 (normalized per frame
 *                   against the strongest class; silence → 0)
 *   outlet 12     = dominant pitch class index 0..11 (-1 when silent)
 *
 * Polled by AudioGraph.updateChromaDisplay each control tick.
 */
export class ChromaAnalyzerNode {
  private readonly merger: ChannelMergerNode;
  private readonly analyser: AnalyserNode;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly freqData: Uint8Array<ArrayBuffer>;
  /** Precomputed pitch class per bin (0..11), or -1 for out-of-range bins. */
  private readonly binClass: Int8Array;

  private readonly chroma = new Array<number>(12).fill(0);
  private dominant = -1;

  constructor(runtime: AudioRuntime) {
    const actx = runtime.context;
    const sampleRate = actx.sampleRate;
    this.merger = actx.createChannelMerger(2);
    this.analyser = actx.createAnalyser();
    this.analyser.fftSize = 4096; // finer bins → cleaner low-note classification
    this.analyser.smoothingTimeConstant = 0.6;
    const bins = this.analyser.frequencyBinCount;
    this.freqData = new Uint8Array(bins) as Uint8Array<ArrayBuffer>;
    this.merger.connect(this.analyser);

    // Precompute each bin's pitch class (fixed — bin frequency never changes).
    const binHz = (sampleRate / 2) / bins;
    this.binClass = new Int8Array(bins);
    for (let i = 0; i < bins; i++) {
      const freq = i * binHz;
      if (freq < MIN_FREQ || freq > MAX_FREQ) { this.binClass[i] = -1; continue; }
      const midi = Math.round(69 + 12 * Math.log2(freq / 440));
      this.binClass[i] = (((midi % 12) + 12) % 12) as number;
    }

    this.canvas = document.createElement("canvas");
    this.canvas.width = SCREEN_W;
    this.canvas.height = SCREEN_H;
    const c = this.canvas.getContext("2d");
    if (!c) throw new Error("[ChromaAnalyzerNode] canvas context unavailable");
    this.ctx2d = c;
  }

  get inputNode(): AudioNode { return this.merger; }

  /** [c, c#, d, … b, dominantIndex] indexed by outlet. */
  values(): readonly number[] { return [...this.chroma, this.dominant]; }

  update(): void {
    this.analyser.getByteFrequencyData(this.freqData);
    const n = this.freqData.length;

    for (let p = 0; p < 12; p++) this.chroma[p] = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const pc = this.binClass[i];
      if (pc < 0) continue;
      const m = this.freqData[i];
      this.chroma[pc] += m;
      total += m;
    }

    // Normalize per frame against the strongest pitch class so the dominant
    // note reads ~1.0 and others scale relative to it. Gate on total energy so
    // silence / faint noise floor doesn't produce phantom chroma.
    let max = 0;
    let domIdx = -1;
    for (let p = 0; p < 12; p++) {
      if (this.chroma[p] > max) { max = this.chroma[p]; domIdx = p; }
    }
    if (total < 200 || max <= 0) {
      for (let p = 0; p < 12; p++) this.chroma[p] = 0;
      this.dominant = -1;
    } else {
      for (let p = 0; p < 12; p++) this.chroma[p] = this.chroma[p] / max;
      this.dominant = domIdx;
    }

    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx2d;
    const w = SCREEN_W;
    const h = SCREEN_H;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    const slot = w / 12;
    const barW = slot - 1;
    for (let p = 0; p < 12; p++) {
      const v = this.chroma[p];
      const barH = Math.max(1, v * (h - 1));
      const x = p * slot;
      ctx.fillStyle = p === this.dominant ? BAR_LIT : BAR_DIM;
      ctx.fillRect(x, h - barH, barW, barH);
    }

    ctx.fillStyle = GRID_LINE;
    for (let y = 0; y < h; y += 2) ctx.fillRect(0, y, w, 1);
  }

  destroy(): void {
    this.merger.disconnect();
    this.analyser.disconnect();
  }
}

export { NOTE_NAMES as CHROMA_NOTE_NAMES };
