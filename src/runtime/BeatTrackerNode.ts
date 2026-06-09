import { AudioRuntime } from "./AudioRuntime";

// Onset-strength envelope (OSS) is sampled on a fixed time grid, decoupled from
// the variable control-tick rate, so autocorrelation lags map cleanly to tempo.
const H_MS = 1000 / 60;          // OSS hop ≈ 16.67 ms (60 Hz)
const WINDOW = 300;              // ~5 s of OSS history
const MIN_BPM = 60;
const MAX_BPM = 180;
const LAG_MIN = Math.floor((60 / MAX_BPM) * 1000 / H_MS); // ≈ 20 samples
const LAG_MAX = Math.ceil((60 / MIN_BPM) * 1000 / H_MS);  // ≈ 60 samples
const ESTIMATE_EVERY = 12;       // re-estimate tempo every ~200 ms

// SuperFlux-style onset function: log-magnitude over log-spaced bands, with a
// frame lag and a frequency max-filter to suppress vibrato/false onsets.
const FFT_SIZE = 2048;
const NBANDS = 40;
const BAND_FMIN = 30;
const BAND_FMAX = 16000;
const SF_LAG = 2;                // compare to the frame this many hops back
const SF_RING = SF_LAG + 1;      // band-frame history depth
const DB_FLOOR = -90;            // dB floor for silent bins
const PRIOR_BPM = 120;           // tempo prior centre (log domain)
const PRIOR_SIGMA = 0.6;         // prior width in octaves — discourages octave errors
const PEAK_CONF = 0.12;          // min normalized autocorr peak to accumulate an estimate
const TEMPO_DECAY = 0.90;        // tempo-histogram forgetting per estimate (~1.7s half-life)
const PERIOD_TRACK = 0.3;        // how fast the locked period follows the histogram peak
const PLL_GAIN = 0.10;           // beat-phase correction strength toward onsets
const ONSET_FACTOR = 1.4;        // OSS must exceed this × running mean to count as an onset
const SLOW_BIAS = 0.55;          // step to the slower octave if its comb ≥ this × the faster one

/**
 * BeatTrackerNode — runtime for `beat~`. Tempo + beat tracking robust enough
 * for real music captured through a mic/line (e.g. Spotify over speakers):
 *
 *  1. SuperFlux onset envelope: per frame, take the log-magnitude over ~40
 *     log-spaced bands, difference against the frame SF_LAG hops back with a
 *     frequency max-filter (rejects vibrato / spectral wobble), half-wave
 *     rectify, sum — sampled onto a fixed 60 Hz grid (the OSS envelope).
 *  2. Every ~200 ms, autocorrelate the OSS window, weight by a log-Gaussian
 *     tempo prior (≈120 BPM), and *accumulate the curve into a decaying tempo
 *     histogram*. The histogram peak is the tempo — integrating evidence over
 *     several seconds locks it hard while still adapting to real changes.
 *  3. A beat-phase clock runs at the locked period; its phase is nudged toward
 *     the best comb alignment of the OSS so bangs land on real onsets.
 *
 * Outlets: 0 = BPM (held), 1 = phase 0..1 (resets on beat), 2 = beat (bang).
 */
export class BeatTrackerNode {
  private readonly merger: ChannelMergerNode;
  private readonly analyser: AnalyserNode;
  private readonly floatData: Float32Array<ArrayBuffer>;

  // Log-spaced band ranges + the current frame's per-band log magnitude, and a
  // short ring of recent band frames for the SuperFlux lag difference.
  private readonly bandStart: Int32Array;
  private readonly bandEnd: Int32Array;
  private readonly curBands = new Float64Array(NBANDS);
  private readonly bandRing: Float64Array[] = [];
  private bandRingHead = 0;
  private bandFrames = 0;

  // OSS ring buffer + chronological scratch for autocorrelation.
  private readonly oss = new Float64Array(WINDOW);
  private readonly scratch = new Float64Array(WINDOW);
  private ossHead = 0;
  private ossCount = 0;

  private hopAccum = 0;
  private lastTick = performance.now();
  private estimateCounter = 0;

  private periodSamples = 0;  // locked tempo period in OSS samples (0 = unknown)
  // Decaying tempo histogram indexed by autocorrelation lag — accumulates
  // prior-weighted periodicity votes over time so the tempo locks hard.
  private readonly tempoHist = new Float64Array(LAG_MAX + 2);
  private readonly lagScores = new Float64Array(LAG_MAX + 2);
  private lagMaxCache = LAG_MAX; // current valid upper lag (set each estimate)
  private beatPhase = 0;      // 0..1 beat-phase clock (PLL)
  private ossMean = 0;        // running mean of OSS, for the onset gate
  private prevOss = 0;
  private _confidence = 0;    // 0..1 strength of the dominant tempo
  private tightness = 1;      // higher = rigidly follow tempo; lower = chase onsets
  private divisionBeats = 1;  // beats per output bang (4,2,1,0.5,0.25)
  private beatCount = 0;      // beat counter for super-beat (half/whole) grouping
  private _bpm = 0;
  private _phase = 0;
  private beatPending = false;

  constructor(runtime: AudioRuntime) {
    const actx = runtime.context;
    const sampleRate = actx.sampleRate;
    this.merger = actx.createChannelMerger(2);
    this.analyser = actx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = DB_FLOOR;
    this.analyser.maxDecibels = -10;
    const bins = this.analyser.frequencyBinCount;
    this.floatData = new Float32Array(bins) as Float32Array<ArrayBuffer>;
    this.merger.connect(this.analyser);

    // Precompute log-spaced band → FFT-bin ranges (≥1 bin each).
    const binHz = (sampleRate / 2) / bins;
    const fmax = Math.min(BAND_FMAX, sampleRate / 2);
    const logMin = Math.log2(BAND_FMIN);
    const logMax = Math.log2(fmax);
    this.bandStart = new Int32Array(NBANDS);
    this.bandEnd = new Int32Array(NBANDS);
    for (let b = 0; b < NBANDS; b++) {
      const fLo = Math.pow(2, logMin + (b / NBANDS) * (logMax - logMin));
      const fHi = Math.pow(2, logMin + ((b + 1) / NBANDS) * (logMax - logMin));
      let s = Math.floor(fLo / binHz);
      let e = Math.ceil(fHi / binHz);
      s = Math.max(0, Math.min(bins - 1, s));
      e = Math.max(s + 1, Math.min(bins, e));
      this.bandStart[b] = s;
      this.bandEnd[b] = e;
    }
    for (let i = 0; i < SF_RING; i++) this.bandRing.push(new Float64Array(NBANDS));
  }

  get inputNode(): AudioNode { return this.merger; }
  get bpm(): number { return this._bpm; }
  get phase(): number { return this._phase; }
  get confidence(): number { return this._confidence; }

  /** Tempo rigidity: higher locks more strictly to the estimated period;
   *  lower lets the phase chase onsets more. Clamped to a sane range. */
  setTightness(t: number): void {
    if (Number.isFinite(t)) this.tightness = Math.max(0.1, Math.min(8, t));
  }

  /** Output note value by index: 0=whole, 1=half, 2=quarter(beat), 3=eighth,
   *  4=sixteenth. Controls how often the beat outlet bangs relative to the
   *  detected beat. */
  setDivision(index: number): void {
    const map = [4, 2, 1, 0.5, 0.25];
    const i = Math.max(0, Math.min(map.length - 1, index | 0));
    if (this.divisionBeats !== map[i]) {
      this.divisionBeats = map[i];
      this.beatCount = 0; // realign grouping when the division changes
    }
  }

  // Index 2 is NaN — that's the bang outlet, fired separately; the outlet push
  // skips non-finite values so nothing spurious lands on it.
  values(): readonly number[] { return [this._bpm, this._phase, NaN, this._confidence]; }

  consumeBeat(): boolean {
    if (!this.beatPending) return false;
    this.beatPending = false;
    return true;
  }

  update(): void {
    // Current per-band log magnitude (dB), used for SuperFlux differencing.
    this.computeCurBands();

    const now = performance.now();
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;

    // Resample onto the fixed OSS grid. Each hop pushes the current band frame
    // and computes the SuperFlux onset sample against the lagged frame.
    this.hopAccum += dt;
    let guard = 0;
    while (this.hopAccum >= H_MS && guard++ < WINDOW) {
      this.hopAccum -= H_MS;
      this.pushBandFrame();
      const ossVal = this.computeSuperfluxOss();
      this.pushOss(ossVal);

      this.advanceBeatPLL(ossVal);

      if (++this.estimateCounter >= ESTIMATE_EVERY && this.ossCount >= LAG_MAX * 2) {
        this.estimateCounter = 0;
        this.estimateTempo();
      }
    }
  }

  /** Causal beat agent: a phase-locked loop frequency-locked to the histogram
   *  tempo, with its phase continuously pulled toward detected onsets. The
   *  clock free-runs at the locked period (so it coasts through gaps), but
   *  whenever a real onset arrives its phase is nudged so beats land on hits —
   *  this is what keeps the bangs on the beat rather than drifting. Bangs fire
   *  when the phase wraps past a beat. */
  private advanceBeatPLL(ossVal: number): void {
    // Adaptive onset gate: slow running mean of the OSS; an onset is a local
    // rise meaningfully above it.
    this.ossMean = this.ossMean * 0.98 + ossVal * 0.02;
    const isOnset = ossVal > this.ossMean * ONSET_FACTOR && ossVal > this.prevOss;
    this.prevOss = ossVal;

    if (this.periodSamples <= 0) return;

    const prevPhase = this.beatPhase;
    this.beatPhase += 1 / this.periodSamples;

    if (isOnset) {
      // Pull the phase so this onset sits on the nearest beat (integer phase).
      // err > 0 → onset is just after a beat (beat too early) → slow down;
      // err < 0 → onset is just before the next beat → speed up.
      const err = this.beatPhase - Math.round(this.beatPhase);
      this.beatPhase -= (PLL_GAIN / this.tightness) * err;
    }

    let beatWrapped = false;
    if (this.beatPhase >= 1) {
      this.beatPhase -= 1;
      beatWrapped = true;
    } else if (this.beatPhase < 0) {
      this.beatPhase += 1;
    }
    this._phase = this.beatPhase;

    // Emit the beat bang at the selected note value. divBeats = beats per
    // output bang: 4=whole, 2=half, 1=quarter(beat), 0.5=eighth, 0.25=16th.
    const div = this.divisionBeats;
    if (div >= 1) {
      // Beat or slower: bang every `div` beats (4/4 grouping assumption).
      if (beatWrapped) {
        this.beatCount = (this.beatCount + 1) % div;
        if (this.beatCount === 0) this.beatPending = true;
      }
    } else {
      // Faster than the beat: bang at each 1/subs phase crossing within a beat.
      const subs = Math.round(1 / div); // 2 (eighth) or 4 (sixteenth)
      const prevSub = Math.floor(prevPhase * subs);
      const curSub = Math.floor(this.beatPhase * subs);
      if (beatWrapped || curSub !== prevSub) this.beatPending = true;
    }
  }

  private pushOss(v: number): void {
    this.oss[this.ossHead] = v;
    this.ossHead = (this.ossHead + 1) % WINDOW;
    if (this.ossCount < WINDOW) this.ossCount++;
  }

  /** Current frame's per-band log magnitude (dB averaged within each band). */
  private computeCurBands(): void {
    this.analyser.getFloatFrequencyData(this.floatData);
    for (let b = 0; b < NBANDS; b++) {
      const s = this.bandStart[b];
      const e = this.bandEnd[b];
      let sum = 0;
      for (let i = s; i < e; i++) {
        const v = this.floatData[i];
        sum += v < DB_FLOOR || !Number.isFinite(v) ? DB_FLOOR : v;
      }
      this.curBands[b] = sum / (e - s);
    }
  }

  private pushBandFrame(): void {
    this.bandRing[this.bandRingHead].set(this.curBands);
    this.bandRingHead = (this.bandRingHead + 1) % SF_RING;
    if (this.bandFrames < SF_RING) this.bandFrames++;
  }

  /** SuperFlux onset sample: positive log-magnitude rise vs the frame SF_LAG
   *  hops back, with a frequency max-filter (±1 band) on the reference frame to
   *  reject vibrato / spectral wobble. Summed over bands. */
  private computeSuperfluxOss(): number {
    if (this.bandFrames <= SF_LAG) return 0;
    const cur = this.bandRing[(this.bandRingHead - 1 + SF_RING) % SF_RING];
    const ref = this.bandRing[(this.bandRingHead - 1 - SF_LAG + SF_RING * 2) % SF_RING];
    let sum = 0;
    for (let b = 0; b < NBANDS; b++) {
      const lo = b > 0 ? ref[b - 1] : ref[b];
      const hi = b < NBANDS - 1 ? ref[b + 1] : ref[b];
      let refMax = ref[b];
      if (lo > refMax) refMax = lo;
      if (hi > refMax) refMax = hi;
      const diff = cur[b] - refMax;
      if (diff > 0) sum += diff;
    }
    return sum / NBANDS;
  }

  /** Autocorrelate the OSS window → tempo (period), with a tempo prior, peak
   *  confidence gate, smoothing, and phase alignment. */
  private estimateTempo(): void {
    const N = this.ossCount;
    // Copy ring → chronological scratch (oldest..newest) and remove the mean
    // so sustained energy doesn't bias the autocorrelation.
    let mean = 0;
    for (let i = 0; i < N; i++) {
      const v = this.oss[(this.ossHead - N + i + WINDOW * 2) % WINDOW];
      this.scratch[i] = v;
      mean += v;
    }
    mean /= N;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      this.scratch[i] -= mean;
      energy += this.scratch[i] * this.scratch[i];
    }
    if (energy <= 0) return;

    // Prior-weighted autocorrelation over the tempo-range lags. Keep the whole
    // per-lag curve so we can accumulate it into the tempo histogram.
    let bestRaw = 0;
    let maxScore = 0;
    const lagMax = Math.min(LAG_MAX, N - 1);
    for (let lag = LAG_MIN; lag <= lagMax; lag++) {
      let r = 0;
      for (let i = 0; i < N - lag; i++) r += this.scratch[i] * this.scratch[i + lag];
      if (r > bestRaw) bestRaw = r;                 // biased — for the energy gate
      // Bias-corrected (unbiased) autocorrelation: dividing by the overlap
      // length removes the triangular taper that otherwise inflates short
      // lags (fast tempi), sharpening the true periodicity peak.
      const rUnbiased = r / (N - lag);
      const bpm = 60000 / (lag * H_MS);
      const lp = Math.log2(bpm / PRIOR_BPM) / PRIOR_SIGMA;
      const weight = Math.exp(-0.5 * lp * lp);
      const score = (rUnbiased > 0 ? rUnbiased : 0) * weight;
      this.lagScores[lag] = score;
      if (score > maxScore) maxScore = score;
    }

    // Confidence gate: during weak / non-rhythmic passages don't pollute the
    // histogram — freeze it (no decay either) so the locked tempo persists.
    if (maxScore <= 0 || bestRaw / energy < PEAK_CONF) return;

    // Accumulate this estimate's normalized periodicity curve into the decaying
    // tempo histogram. Integrating votes over several seconds is what makes the
    // tempo lock rock-steady while still adapting to genuine tempo changes —
    // single-estimate metrical-level hops get averaged out instead of jumping.
    for (let lag = LAG_MIN; lag <= lagMax; lag++) {
      this.tempoHist[lag] = this.tempoHist[lag] * TEMPO_DECAY + this.lagScores[lag] / maxScore;
    }

    // Histogram peak — used only for the confidence readout (how dominant any
    // single periodicity is, regardless of which metrical level we pick).
    let peakVal = 0;
    let sumHist = 0;
    for (let lag = LAG_MIN; lag <= lagMax; lag++) {
      const h = this.tempoHist[lag];
      sumHist += h;
      if (h > peakVal) peakVal = h;
    }
    this._confidence = sumHist > 0 ? Math.min(1, peakVal / sumHist) : 0;

    // ── Octave-robust tempo via harmonic-comb scoring ──────────────────────
    // Instead of picking the single tallest histogram peak (which jumps to a
    // subdivision when a busy section makes the half-beat pulse momentarily
    // stronger), score each candidate base period by its whole metrical comb:
    // the beat plus its subdivisions and groupings. A busy subdivision then
    // *reinforces* the base beat rather than replacing it. (Klapuri-style
    // multi-level metrical analysis.)
    this.lagMaxCache = lagMax;
    let bestL = -1;
    let bestComb = -1;
    for (let L = LAG_MIN; L <= lagMax; L++) {
      const c = this.combScore(L);
      if (c > bestComb) { bestComb = c; bestL = L; }
    }
    if (bestL < 0) return;

    // Slower-level preference: step toward the slower octave while it still
    // carries a meaningful share of the comb strength — biases toward the
    // tactus (the foot-tap beat) over its subdivision.
    let m = 1;
    for (let k = 0; k < 2; k++) {
      const slowerL = bestL * m * 2;
      if (slowerL <= lagMax && this.combScore(slowerL) >= SLOW_BIAS * this.combScore(bestL * m)) {
        m *= 2;
      } else break;
    }

    // Sub-lag precision: parabolic interpolation around the comb winner, then
    // apply the chosen octave multiplier.
    const h1 = bestL > LAG_MIN ? this.tempoHist[bestL - 1] : this.tempoHist[bestL];
    const h2 = this.tempoHist[bestL];
    const h3 = bestL < lagMax ? this.tempoHist[bestL + 1] : this.tempoHist[bestL];
    const denom = h1 - 2 * h2 + h3;
    const off = denom !== 0 ? 0.5 * (h1 - h3) / denom : 0;
    let chosenPeriod = (bestL + off) * m;

    // Octave hysteresis: once locked, fold the new estimate to the locked
    // octave so the reported tempo never flips up/down a level mid-song.
    if (this.periodSamples > 0) {
      while (chosenPeriod / this.periodSamples > 1.4) chosenPeriod /= 2;
      while (this.periodSamples / chosenPeriod > 1.4) chosenPeriod *= 2;
    }

    // Keep the estimate inside the trackable tempo range. The octave fold
    // above can overshoot past LAG_MAX; without this the lock would ratchet
    // slower every estimate and run away to ~30 BPM over a few minutes (the
    // histogram has no data outside [LAG_MIN, LAG_MAX] to correct it back).
    while (chosenPeriod > LAG_MAX) chosenPeriod /= 2;
    while (chosenPeriod < LAG_MIN) chosenPeriod *= 2;

    this.periodSamples = this.periodSamples > 0
      ? this.periodSamples * (1 - PERIOD_TRACK) + chosenPeriod * PERIOD_TRACK
      : chosenPeriod;
    // Hard clamp the lock to the valid range as a final guard against drift.
    if (this.periodSamples > LAG_MAX) this.periodSamples = LAG_MAX;
    else if (this.periodSamples < LAG_MIN) this.periodSamples = LAG_MIN;
    this._bpm = 60000 / (this.periodSamples * H_MS);
    // Phase is handled continuously by the onset-driven PLL (advanceBeatPLL),
    // so no per-estimate phase realignment is needed here.
  }

  /** Linear-interpolated tempo-histogram lookup; 0 outside the tempo range. */
  private histAt(lag: number): number {
    if (lag < LAG_MIN || lag > this.lagMaxCache) return 0;
    const i = Math.floor(lag);
    const f = lag - i;
    const a = this.tempoHist[i];
    const b = i + 1 <= this.lagMaxCache ? this.tempoHist[i + 1] : a;
    return a * (1 - f) + b * f;
  }

  /** Harmonic-comb score for a candidate base period (lag): the beat itself
   *  plus its subdivisions (faster pulses) and groupings (slower pulses),
   *  weighted, times the log-Gaussian tempo prior. Picks the metrical level
   *  whose whole comb is strongest rather than any single peak. */
  private combScore(L: number): number {
    let s = this.histAt(L);
    s += 0.6 * this.histAt(L / 2) + 0.4 * this.histAt(L / 3) + 0.3 * this.histAt(L / 4);
    s += 0.5 * this.histAt(L * 2) + 0.3 * this.histAt(L * 3);
    const bpm = 60000 / (L * H_MS);
    const lp = Math.log2(bpm / PRIOR_BPM) / PRIOR_SIGMA;
    return s * Math.exp(-0.5 * lp * lp);
  }

  destroy(): void {
    this.merger.disconnect();
    this.analyser.disconnect();
  }
}
