import { AudioRuntime } from "./AudioRuntime";
import { fitScopeCanvas } from "./scopeCanvasFit";

const SMOOTH_TC = 0.01;          // gain ramp time constant — click-free
const MORPH_FFT = 256;           // analyser fftSize for morph CV sampling
const OUTPUT_FFT = 1024;         // analyser fftSize for live-output oscilloscope
const SCOPE_MIN_CYCLES = 0.5;    // never show less than half a cycle (very low freq → fat curve)
const SCOPE_MAX_CYCLES = 24;     // beyond this the trace turns into a solid green blur
const SCOPE_FREQ_ANCHOR = 27.5;  // Hz that would render exactly 0 cycles (A0). Each octave above adds one cycle.
const SHAPES = ["sine", "triangle", "sawtooth", "square"] as const;

interface Connection {
  dest: AudioNode;
  inputIndex: number;
}

/**
 * WaveNode — morphing oscillator with a gate and a still shape preview.
 *
 * Internal graph:
 *
 *   freqInput ──► osc.frequency   (AudioParam, summed onto base freq)
 *   ┌────────► sine    ─► g0 ─┐
 *   ├────────► tri     ─► g1 ─┤
 *   ├────────► saw     ─► g2 ─┼─► sumGain ─► levelGain ─► output
 *   └────────► square  ─► g3 ─┘
 *                                  (levelGain = userLevel × gateOn ? 1 : 0)
 *
 *   morphInput ─► morphAnalyser   (sampled per-rAF; drives crossfade weights
 *                                  AND the visual shape preview)
 *
 * The on-tile scope is a *still analytic preview* of the morph-weighted ideal
 * wave, not a live time-domain trace — so it doesn't jitter as audio plays.
 *
 * Gate: starts off. Send `1` (or `gate 1`) to inlet 2 to enable, `0` to mute.
 */
export class WaveNode {
  private readonly ctx: AudioContext;
  private readonly oscillators: OscillatorNode[] = [];
  private readonly shapeGains: GainNode[] = [];
  private readonly sumGain: GainNode;
  private readonly levelGain: GainNode;
  private readonly morphAnalyser: AnalyserNode;
  private readonly morphData: Float32Array<ArrayBuffer>;
  private readonly outputAnalyser: AnalyserNode;
  private readonly outputData: Float32Array<ArrayBuffer>;

  readonly freqInput: GainNode;     // inlet 0: freq CV (Hz, sums onto base)
  readonly morphInput: GainNode;    // inlet 1: morph CV (added to base morph, clamped 0..1)

  private connections: Connection[] = [];
  private baseFreq = 220;
  private baseMorph = 0;
  /** Most recent morph value applied (baseMorph + morph-CV). Used by the analytic scope renderer
   *  so the still preview reflects the actual shape being produced. */
  private currentMorph = 0;
  private level = 0.5;
  private gateOn = false;
  private started = false;

  /** Effective morph after CV (0..1). */
  get effectiveMorph(): number { return this.currentMorph; }
  get isGated(): boolean { return this.gateOn; }

  constructor(runtime: AudioRuntime) {
    this.ctx = runtime.context;

    this.freqInput  = this.ctx.createGain();
    this.morphInput = this.ctx.createGain();

    this.sumGain   = this.ctx.createGain();
    this.sumGain.gain.value = 1;
    this.levelGain = this.ctx.createGain();
    this.levelGain.gain.value = 0;          // gated off by default

    this.morphAnalyser = this.ctx.createAnalyser();
    this.morphAnalyser.fftSize = MORPH_FFT;
    this.morphAnalyser.smoothingTimeConstant = 0.6;
    this.morphData = new Float32Array(this.morphAnalyser.fftSize) as Float32Array<ArrayBuffer>;
    this.morphInput.connect(this.morphAnalyser);

    this.outputAnalyser = this.ctx.createAnalyser();
    this.outputAnalyser.fftSize = OUTPUT_FFT;
    this.outputAnalyser.smoothingTimeConstant = 0;
    this.outputData = new Float32Array(this.outputAnalyser.fftSize) as Float32Array<ArrayBuffer>;

    for (let i = 0; i < SHAPES.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = SHAPES[i];
      osc.frequency.value = this.baseFreq;
      const g = this.ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0;       // start fully on sine
      osc.connect(g);
      g.connect(this.sumGain);
      this.freqInput.connect(osc.frequency);
      this.oscillators.push(osc);
      this.shapeGains.push(g);
    }

    this.sumGain.connect(this.levelGain);
    // Tap the analyser BEFORE the gate/level so the live scope keeps showing
    // the morph-weighted oscillator output even when the gate is closed. The
    // gate only mutes audio, not the visualization.
    this.sumGain.connect(this.outputAnalyser);
  }

  /** Start oscillators with the given base frequency. Idempotent. */
  start(freqHz: number): void {
    if (this.started) {
      this.setFreq(freqHz);
      return;
    }
    this.baseFreq = clampFreq(freqHz);
    for (const osc of this.oscillators) {
      osc.frequency.value = this.baseFreq;
      osc.start();
    }
    this.started = true;
  }

  /** Add a downstream connection. Mirrors ClickNode.connect(). */
  connect(dest: AudioNode, inputIndex = 0): void {
    this.connections.push({ dest, inputIndex });
    try { this.levelGain.connect(dest, 0, inputIndex); } catch { /* already connected */ }
  }

  /** Drop all tracked downstream connections. Called by AudioGraph.rewireConnections()
   *  before rewire. Only severs the destinations recorded in `connections` so the
   *  internal analyser tap on `levelGain` (used by drawLiveScope) survives. */
  disconnect(): void {
    for (const c of this.connections) {
      try { this.levelGain.disconnect(c.dest, 0, c.inputIndex); } catch { /* ok */ }
    }
    this.connections = [];
  }

  setFreq(hz: number): void {
    this.baseFreq = clampFreq(hz);
    const now = this.ctx.currentTime;
    for (const osc of this.oscillators) {
      osc.frequency.setTargetAtTime(this.baseFreq, now, SMOOTH_TC);
    }
  }

  setMorph(p: number): void {
    this.baseMorph = clamp01(p);
    this.currentMorph = this.baseMorph;
    this.applyMorphWeights(this.baseMorph);
  }

  setLevel(g: number): void {
    this.level = clamp01(g);
    this.applyOutputGain();
  }

  /** Open or close the audio gate. When closed, the output gain ramps to 0
   *  (oscillators keep running internally). When opened, gain ramps to the
   *  user-set `level` value. Click-free in both directions via the standard
   *  setTargetAtTime ramp. */
  setGate(on: boolean): void {
    this.gateOn = on;
    this.applyOutputGain();
  }

  /** Sample the morph CV analyser, average to a 0..1 morph value, and apply the
   *  resulting crossfade weights to the four shape gains. Call once per rAF.
   *  Morph CV affects audio (and the analytic preview that reads `currentMorph`),
   *  but does NOT animate the morph knob — the knob always shows the user-set
   *  base value. */
  tickMorph(): void {
    this.morphAnalyser.getFloatTimeDomainData(this.morphData);
    let morphSum = 0;
    for (let i = 0; i < this.morphData.length; i++) morphSum += this.morphData[i];
    const morphCvAvg = morphSum / this.morphData.length;
    const next = Math.abs(morphCvAvg) < 1e-6
      ? this.baseMorph
      : clamp01(this.baseMorph + morphCvAvg);
    this.currentMorph = next;
    this.applyMorphWeights(next);
  }

  /** Render a *still analytic preview* of the morph-weighted wave shape into
   *  the canvas. Pure math — no analyser tap, no jitter. The trace only
   *  changes when the morph value (knob or CV) changes. */
  drawScope(canvas: HTMLCanvasElement): void {
    const c2d = canvas.getContext("2d");
    if (!c2d) return;

    const dims = fitScopeCanvas(canvas);
    if (!dims) return;
    const { w, h } = dims;

    c2d.clearRect(0, 0, w, h);

    // Background — same bezel-inside look as before
    c2d.fillStyle = "rgba(0, 0, 0, 0.55)";
    c2d.fillRect(0, 0, w, h);

    // Center line
    c2d.strokeStyle = "rgba(0, 255, 0, 0.12)";
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(0, h / 2);
    c2d.lineTo(w, h / 2);
    c2d.stroke();

    // Trace — analytic morph-weighted shape. The number of cycles rendered
    // scales with frequency so the user gets visible feedback when tuning:
    // each octave above the anchor (A0 ≈ 27.5 Hz) adds one cycle. At the
    // 220 Hz default this lands at ~3 cycles. Fractional cycles are fine —
    // they just mean a partial cycle hangs at the right edge.
    const cyclesShown = Math.max(
      SCOPE_MIN_CYCLES,
      Math.min(SCOPE_MAX_CYCLES, Math.log2(Math.max(this.baseFreq, 1) / SCOPE_FREQ_ANCHOR)),
    );
    const weights = morphWeights(this.currentMorph);
    const amp = h / 2 - 1;

    c2d.strokeStyle = this.gateOn ? "#00ff00" : "rgba(0, 255, 0, 0.55)";
    c2d.lineWidth = 1.25;
    c2d.shadowColor = "rgba(0, 255, 0, 0.75)";
    c2d.shadowBlur = 4;
    c2d.beginPath();
    for (let x = 0; x < w; x++) {
      const t = (x / (w - 1)) * cyclesShown;        // cycles elapsed at this column
      const v = waveSample(t, weights);
      const y = h / 2 - v * amp;
      if (x === 0) c2d.moveTo(x, y); else c2d.lineTo(x, y);
    }
    c2d.stroke();
    c2d.shadowBlur = 0;
  }

  /** Render a live oscilloscope trace of the post-gain output. Single trace,
   *  full canvas width, mirroring the analytic-scope visual style. Goes flat
   *  when the gate is closed (level = 0). */
  drawLiveScope(canvas: HTMLCanvasElement): void {
    const c2d = canvas.getContext("2d");
    if (!c2d) return;

    const dims = fitScopeCanvas(canvas);
    if (!dims) return;
    const { w, h } = dims;

    c2d.clearRect(0, 0, w, h);
    c2d.fillStyle = "rgba(0, 0, 0, 0.55)";
    c2d.fillRect(0, 0, w, h);

    c2d.strokeStyle = "rgba(0, 255, 0, 0.12)";
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(0, h / 2);
    c2d.lineTo(w, h / 2);
    c2d.stroke();

    this.outputAnalyser.getFloatTimeDomainData(this.outputData);
    const n = this.outputData.length;
    const amp = h / 2 - 1;

    // Auto-scale so the trace always fills the box vertically. We only boost
    // (cap scale at 1) — never *shrink* a healthy signal — so users still see
    // when output is clipping. The 0.02 floor keeps a near-silent signal from
    // exploding into an amplified noise hash.
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(this.outputData[i]);
      if (a > peak) peak = a;
    }
    const scale = peak < 0.02 ? 1 : 1 / peak;

    c2d.strokeStyle = "#00ff00";
    c2d.lineWidth = 1.25;
    c2d.shadowColor = "rgba(0, 255, 0, 0.75)";
    c2d.shadowBlur = 4;
    c2d.beginPath();
    for (let x = 0; x < w; x++) {
      const i = Math.min(n - 1, Math.floor((x / Math.max(1, w - 1)) * (n - 1)));
      const v = Math.max(-1, Math.min(1, this.outputData[i] * scale));
      const y = h / 2 - v * amp;
      if (x === 0) c2d.moveTo(x, y); else c2d.lineTo(x, y);
    }
    c2d.stroke();
    c2d.shadowBlur = 0;
  }

  destroy(): void {
    this.disconnect();
    for (const osc of this.oscillators) {
      try { osc.stop(); } catch { /* not started */ }
      try { osc.disconnect(); } catch { /* ok */ }
    }
    for (const g of this.shapeGains) { try { g.disconnect(); } catch { /* ok */ } }
    try { this.sumGain.disconnect(); } catch { /* ok */ }
    try { this.levelGain.disconnect(); } catch { /* ok */ }
    try { this.freqInput.disconnect(); } catch { /* ok */ }
    try { this.morphInput.disconnect(); } catch { /* ok */ }
    try { this.morphAnalyser.disconnect(); } catch { /* ok */ }
    try { this.outputAnalyser.disconnect(); } catch { /* ok */ }
    this.started = false;
  }

  /** Convert morph position p∈[0,1] to crossfade weights and ramp the four shape gains. */
  private applyMorphWeights(p: number): void {
    const weights = morphWeights(p);
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.shapeGains.length; i++) {
      this.shapeGains[i].gain.setTargetAtTime(weights[i], now, SMOOTH_TC);
    }
  }

  /** Effective output gain = level × gateOn. Single ramp covers both the
   *  level knob and the gate so they share click-free transitions. */
  private applyOutputGain(): void {
    const target = this.gateOn ? this.level : 0;
    const now = this.ctx.currentTime;
    this.levelGain.gain.setTargetAtTime(target, now, SMOOTH_TC);
  }
}

/** Map p∈[0,1] to four anchor weights at 0, 1/3, 2/3, 1. Adjacent pair lerp; others 0. */
function morphWeights(p: number): [number, number, number, number] {
  const x = clamp01(p);
  if (x <= 1 / 3) {
    const t = x * 3;
    return [1 - t, t, 0, 0];
  }
  if (x <= 2 / 3) {
    const t = (x - 1 / 3) * 3;
    return [0, 1 - t, t, 0];
  }
  const t = (x - 2 / 3) * 3;
  return [0, 0, 1 - t, t];
}

/** Sample value of one cycle of each ideal wave at phase `t` (in cycles).
 *  All four shapes are phase-aligned: each starts at 0 going positive at
 *  phase 0, matching Web Audio's `OscillatorNode` convention so the morph
 *  crossfade is visually coherent. Returns the weighted sum, normalized ±1. */
function waveSample(t: number, weights: readonly [number, number, number, number]): number {
  const phase = t - Math.floor(t);                                 // 0..1 within cycle
  const angle = 2 * Math.PI * phase;
  const sine  = Math.sin(angle);
  const tri   = (2 / Math.PI) * Math.asin(Math.sin(angle));        // 0 at p=0, +1 at p=0.25, -1 at p=0.75
  const saw   = 2 * (phase - Math.floor(phase + 0.5));             // 0 at p=0, +1 just before 0.5, -1 just after
  const sqr   = phase < 0.5 ? 1 : -1;
  return weights[0] * sine + weights[1] * tri + weights[2] * saw + weights[3] * sqr;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampFreq(hz: number): number {
  if (!Number.isFinite(hz)) return 0;
  return hz < 0 ? 0 : hz > 20000 ? 20000 : hz;
}
