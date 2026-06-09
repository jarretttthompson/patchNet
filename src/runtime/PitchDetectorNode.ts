import { AudioRuntime } from "./AudioRuntime";

const MIN_FREQ = 55;    // ~A1 — low enough for bass voice / bass guitar
const MAX_FREQ = 2000;  // covers sung/whistled range without wasting lags

/**
 * PitchDetectorNode — runtime for `pitch~`. Estimates the fundamental
 * frequency of the input via normalized autocorrelation on the time-domain
 * signal, with parabolic interpolation for sub-sample lag precision.
 *
 *   outlet 0 = frequency (Hz) — held at the last good value when unvoiced
 *   outlet 1 = confidence (0..1) — autocorrelation peak strength
 *
 * Heavier than the other analyzers (bounded O(lags × window) per tick), so
 * keep instances modest. Polled by AudioGraph.updatePitchDisplay each tick.
 */
export class PitchDetectorNode {
  private readonly merger: ChannelMergerNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private readonly sampleRate: number;

  private _freq = 0;
  private _conf = 0;

  constructor(runtime: AudioRuntime) {
    const actx = runtime.context;
    this.sampleRate = actx.sampleRate;
    this.merger = actx.createChannelMerger(2);
    this.analyser = actx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.buf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    this.merger.connect(this.analyser);
  }

  get inputNode(): AudioNode { return this.merger; }
  get frequency(): number { return this._freq; }
  get confidence(): number { return this._conf; }

  /** [frequencyHz, confidence] indexed by outlet. */
  values(): readonly number[] { return [this._freq, this._conf]; }

  /** Lagged autocorrelation r(lag) = Σ buf[i]·buf[i+lag]. */
  private corr(L: number, lag: number): number {
    let s = 0;
    for (let i = 0; i < L - lag; i++) s += this.buf[i] * this.buf[i + lag];
    return s;
  }

  update(): void {
    this.analyser.getFloatTimeDomainData(this.buf);
    const L = this.buf.length;

    // Energy / RMS gate — below this the signal is silence or noise; hold the
    // last frequency (so mappings don't snap to 0) but report zero confidence.
    let energy = 0;
    for (let i = 0; i < L; i++) energy += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(energy / L);
    if (rms < 0.01 || energy <= 0) {
      this._conf = 0;
      return;
    }

    const minLag = Math.max(2, Math.floor(this.sampleRate / MAX_FREQ));
    const maxLag = Math.min(L - 2, Math.ceil(this.sampleRate / MIN_FREQ));

    // Find the lag with the strongest normalized autocorrelation.
    let bestLag = -1;
    let bestNorm = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const norm = this.corr(L, lag) / energy;
      if (norm > bestNorm) { bestNorm = norm; bestLag = lag; }
    }
    if (bestLag < 0) { this._conf = 0; return; }

    // Parabolic interpolation around the peak for sub-sample lag precision.
    const y1 = this.corr(L, bestLag - 1);
    const y2 = this.corr(L, bestLag);
    const y3 = this.corr(L, bestLag + 1);
    const denom = y1 - 2 * y2 + y3;
    const offset = denom !== 0 ? 0.5 * (y1 - y3) / denom : 0;
    const lag = bestLag + offset;

    const freq = this.sampleRate / lag;
    if (freq >= MIN_FREQ && freq <= MAX_FREQ) {
      this._freq = freq;
      this._conf = bestNorm < 0 ? 0 : bestNorm > 1 ? 1 : bestNorm;
    } else {
      this._conf = 0;
    }
  }

  destroy(): void {
    this.merger.disconnect();
    this.analyser.disconnect();
  }
}

/** Nearest note name (e.g. "A4") for a frequency, or "—" when out of range. */
export function freqToNoteName(freq: number): string {
  if (!Number.isFinite(freq) || freq <= 0) return "—";
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const name = NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}
