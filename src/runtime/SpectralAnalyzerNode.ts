import { AudioRuntime } from "./AudioRuntime";

const SCREEN_W = 128;
const SCREEN_H = 48;

const BG        = "#000000";   // --pn-bg-deep
const LINE_DIM  = "#063b06";
const LINE_LIT  = "#00ff00";
const GRID_LINE = "rgba(0,0,0,0.5)";

/**
 * SpectralAnalyzerNode — audio feature-extraction analyzer for `spectral~`.
 *
 * Mirrors FftAnalyzerNode's lifecycle (own AnalyserNode, drawn + polled once
 * per control tick) but instead of band levels it emits spectral *descriptors*
 * computed from the same magnitude spectrum. Built incrementally:
 *
 *   outlet 0 = level   (overall energy)            ← this step (B0)
 *   outlet 1 = centroid                            ← B1
 *   outlet 2 = flux                                ← B2
 *   outlet 3 = flatness                            ← B3
 *   outlet 4 = rolloff                             ← B4
 *   outlet 5 = crest                               ← B5
 *   outlet 6 = loudness (A-weighted)               ← B6
 *
 * `values()` returns the descriptor array indexed by outlet, which main.ts's
 * control tick pushes downstream the same way it does fft~ band levels.
 */
export class SpectralAnalyzerNode {
  private readonly merger: ChannelMergerNode;
  private readonly analyser: AnalyserNode;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly freqData: Uint8Array<ArrayBuffer>;
  /** Previous frame's magnitudes, for spectral flux (frame-to-frame change). */
  private readonly prevFreq: Float64Array;
  /** Per-bin A-weighting factors (precomputed; depend only on bin frequency). */
  private readonly aWeights: Float64Array;
  /** Σ of aWeights, for normalizing the A-weighted loudness to 0..1. */
  private readonly aWeightSum: number;
  private readonly sampleRate: number;

  /** Descriptor values indexed by outlet. Grows as later steps add features. */
  private _values: number[] = [0];

  constructor(runtime: AudioRuntime) {
    const actx = runtime.context;
    this.sampleRate = actx.sampleRate;

    this.merger = actx.createChannelMerger(2);

    this.analyser = actx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.prevFreq = new Float64Array(this.analyser.frequencyBinCount);
    this.merger.connect(this.analyser);

    // Precompute the A-weighting curve per bin. A-weighting approximates how
    // loud each frequency *sounds* — it boosts the 1–5 kHz region the ear is
    // most sensitive to and rolls off lows and very highs. Bin frequency is
    // fixed, so we compute the weights once.
    const bins = this.analyser.frequencyBinCount;
    const binHz0 = (this.sampleRate / 2) / bins;
    this.aWeights = new Float64Array(bins);
    let wsum = 0;
    for (let i = 0; i < bins; i++) {
      const w = aWeightLinear(i * binHz0);
      this.aWeights[i] = w;
      wsum += w;
    }
    this.aWeightSum = wsum;

    this.canvas = document.createElement("canvas");
    this.canvas.width  = SCREEN_W;
    this.canvas.height = SCREEN_H;
    const c = this.canvas.getContext("2d");
    if (!c) throw new Error("[SpectralAnalyzerNode] canvas context unavailable");
    this.ctx2d = c;
  }

  get inputNode(): AudioNode { return this.merger; }

  /** Descriptor values indexed by outlet (read by main.ts's outlet push). */
  values(): readonly number[] { return this._values; }

  /** Pull the latest spectrum, recompute descriptors, repaint the scope.
   *  Called once per control tick by AudioGraph.updateSpectralDisplay. */
  update(): void {
    this.analyser.getByteFrequencyData(this.freqData);
    const n = this.freqData.length;
    const nyquist = this.sampleRate / 2;
    const binHz = nyquist / n;

    // Single pass: accumulate total magnitude (for level), the magnitude-
    // weighted bin index (for centroid), and the summed positive frame-to-
    // frame rise (for flux).
    // Flatness uses a tiny floor so silent bins contribute a large negative
    // log (pulling the geometric mean toward 0 for tonal/peaky spectra)
    // rather than blowing up at ln(0).
    const FLOOR = 1e-6;
    let sum = 0;
    let weighted = 0;
    let fluxSum = 0;
    let logSum = 0;
    let maxMag = 0;
    let loudSum = 0;
    for (let i = 0; i < n; i++) {
      const m = this.freqData[i];
      sum += m;
      weighted += i * m;
      if (m > maxMag) maxMag = m;
      const rise = m - this.prevFreq[i];
      if (rise > 0) fluxSum += rise;
      this.prevFreq[i] = m;
      logSum += Math.log(m / 255 + FLOOR);
      loudSum += m * this.aWeights[i];
    }

    // outlet 0 — overall level: mean magnitude normalized to 0..1.
    const level = sum / (n * 255);

    // outlet 1 — spectral centroid ("brightness"): the magnitude-weighted
    // mean frequency, then LOG-normalized between 20 Hz and Nyquist so the
    // value spreads usefully across 0..1 (a linear normalize would pin
    // everyday material near 0 since most energy is low-frequency).
    // Silence (no magnitude) → 0 rather than NaN.
    let centroid = 0;
    if (sum > 0) {
      const centroidHz = (weighted / sum) * binHz;
      if (centroidHz > 20) {
        const logMin = Math.log10(20);
        const logMax = Math.log10(nyquist);
        centroid = (Math.log10(centroidHz) - logMin) / (logMax - logMin);
        centroid = centroid < 0 ? 0 : centroid > 1 ? 1 : centroid;
      }
    }

    // outlet 2 — spectral flux: mean positive frame-to-frame magnitude rise,
    // normalized 0..1. ~0 for sustained/steady sound; spikes on onsets,
    // attacks, and spectral sweeps. (The analyser's own smoothing damps this
    // somewhat, so practical values stay modest — calibrate with ezScale.)
    const flux = fluxSum / (n * 255);

    // outlet 3 — spectral flatness: geometric mean / arithmetic mean of the
    // (floored) normalized magnitudes. ~0 for tonal/peaky spectra (a sung
    // note, a whistle), rising toward 1 for noisy/broadband spectra (hiss,
    // cymbals, breath). Silence → 0 (guarded; not "flat").
    const FLOOR2 = 1e-6;
    let flatness = 0;
    if (level > 1e-5) {
      const geoMean = Math.exp(logSum / n);
      flatness = geoMean / (level + FLOOR2);
      flatness = flatness < 0 ? 0 : flatness > 1 ? 1 : flatness;
    }

    // outlet 4 — spectral rolloff: the frequency below which 85% of the total
    // magnitude sits, log-normalized 20 Hz..Nyquist (same scale as centroid).
    // Another "dark↔bright" axis, but more robust than centroid on percussive
    // material since it's a cumulative threshold rather than a weighted mean.
    let rolloff = 0;
    if (sum > 0) {
      const threshold = 0.85 * sum;
      let acc = 0;
      let rolloffBin = 0;
      for (let i = 0; i < n; i++) {
        acc += this.freqData[i];
        if (acc >= threshold) { rolloffBin = i; break; }
      }
      const rolloffHz = rolloffBin * binHz;
      if (rolloffHz > 20) {
        const logMin = Math.log10(20);
        const logMax = Math.log10(nyquist);
        rolloff = (Math.log10(rolloffHz) - logMin) / (logMax - logMin);
        rolloff = rolloff < 0 ? 0 : rolloff > 1 ? 1 : rolloff;
      }
    }

    // outlet 5 — spectral crest: peak magnitude ÷ mean magnitude, log-
    // normalized by log(n) so 0..1. High when one bin dominates (a pure
    // tone / strong fundamental → "peaky"), low for broadband/noisy spectra
    // where energy is spread evenly. Complements flatness: flatness looks at
    // the whole distribution's evenness, crest at the single tallest peak.
    let crest = 0;
    if (sum > 0) {
      const mean = sum / n;
      const crestRaw = maxMag / mean;           // ≥ 1
      crest = Math.log(crestRaw) / Math.log(n); // ≈1 single-bin, →0 flat
      crest = crest < 0 ? 0 : crest > 1 ? 1 : crest;
    }

    // outlet 6 — A-weighted loudness: magnitude weighted by the A-curve, then
    // normalized by the weight sum → 0..1. Tracks how loud the sound *feels*
    // (mid-frequency emphasis) rather than raw broadband energy like level.
    const loudness = this.aWeightSum > 0
      ? Math.min(1, loudSum / (this.aWeightSum * 255))
      : 0;

    this._values = [
      level,
      centroid,
      flux < 0 ? 0 : flux > 1 ? 1 : flux,
      flatness,
      rolloff,
      crest,
      loudness,
    ];

    this.drawScope();
  }

  private drawScope(): void {
    const ctx = this.ctx2d;
    const w = SCREEN_W;
    const h = SCREEN_H;
    const n = this.freqData.length;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // Log-frequency spectrum line — same mapping fft~ uses, gives a familiar
    // "is audio flowing" readout.
    const nyquist = this.sampleRate / 2;
    const binHz = nyquist / n;
    const logMin = Math.log10(20);
    const logMax = Math.log10(nyquist);

    ctx.strokeStyle = LINE_DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x < w; x++) {
      const logFreq = logMin + (x / w) * (logMax - logMin);
      const freq = Math.pow(10, logFreq);
      const binIdx = Math.min(Math.round(freq / binHz), n - 1);
      const v = this.freqData[binIdx] / 255;
      const y = h - v * h;
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Lit overlay at higher alpha for the bright peak silhouette.
    ctx.strokeStyle = LINE_LIT;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Scanlines for the LCD look, matching fft~.
    ctx.fillStyle = GRID_LINE;
    for (let y = 0; y < h; y += 2) ctx.fillRect(0, y, w, 1);
  }

  destroy(): void {
    this.merger.disconnect();
    this.analyser.disconnect();
  }
}

/**
 * Linear A-weighting factor for a frequency (Hz) — the standard IEC 61672
 * R_A(f) transfer function. Peaks near ~1 around 2.5 kHz, attenuates lows and
 * very highs. We use the raw linear response (the conventional +2 dB
 * normalization is a constant that cancels when we normalize by the weight
 * sum). f = 0 → 0.
 */
function aWeightLinear(f: number): number {
  if (f <= 0) return 0;
  const f2 = f * f;
  const num = 12194 * 12194 * f2 * f2;
  const den =
    (f2 + 20.6 * 20.6) *
    Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
    (f2 + 12194 * 12194);
  return num / den;
}
