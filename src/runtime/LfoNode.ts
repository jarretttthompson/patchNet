import { AudioRuntime } from "./AudioRuntime";
import { fitScopeCanvas } from "./scopeCanvasFit";

const SMOOTH_TC = 0.01;
const LFO_RATE_MIN = 0.01;
const LFO_RATE_MAX = 20;
const LFO_DEPTH_MAX = 1000;
const OUTPUT_FFT = 2048;
const SHAPES = ["sine", "triangle", "sawtooth", "square"] as const;

interface Connection {
  dest: AudioNode;
  inputIndex: number;
}

/**
 * LfoNode — sub-audio morphing oscillator for modulation.
 *
 * Internal graph:
 *
 *   rateInput ──► osc[i].frequency   (AudioParam summed onto base rate)
 *   ┌────────► sine    ─► g0 ─┐
 *   ├────────► tri     ─► g1 ─┤
 *   ├────────► saw     ─► g2 ─┼─► sumGain ─► depthGain ─► output
 *   └────────► square  ─► g3 ─┘
 *                (depthGain.gain = depth; output peak ≈ ±depth)
 *
 * No gate — LFO always runs. Connect outlet 0 to another object's signal
 * inlet (e.g. wave~ inlet 0 for FM, wave~ inlet 1 for morph CV, adsr~ inlet
 * 0 for tremolo).
 */
export class LfoNode {
  private readonly ctx: AudioContext;
  private readonly oscillators: OscillatorNode[] = [];
  private readonly shapeGains: GainNode[] = [];
  private readonly sumGain: GainNode;
  private readonly depthGain: GainNode;
  private readonly outputAnalyser: AnalyserNode;
  private readonly outputData: Float32Array<ArrayBuffer>;

  readonly rateInput: GainNode;  // inlet 1: rate CV (Hz, summed onto base rate)

  private connections: Connection[] = [];
  private baseRate = 1;
  private currentShape = 0;
  private started = false;

  constructor(runtime: AudioRuntime) {
    this.ctx = runtime.context;

    this.rateInput = this.ctx.createGain();

    this.sumGain = this.ctx.createGain();
    this.sumGain.gain.value = 1;
    this.depthGain = this.ctx.createGain();
    this.depthGain.gain.value = 100;

    for (let i = 0; i < SHAPES.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = SHAPES[i];
      osc.frequency.value = this.baseRate;
      const g = this.ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0;
      osc.connect(g);
      g.connect(this.sumGain);
      this.rateInput.connect(osc.frequency);
      this.oscillators.push(osc);
      this.shapeGains.push(g);
    }

    this.sumGain.connect(this.depthGain);

    this.outputAnalyser = this.ctx.createAnalyser();
    this.outputAnalyser.fftSize = OUTPUT_FFT;
    this.outputAnalyser.smoothingTimeConstant = 0;
    this.outputData = new Float32Array(this.outputAnalyser.fftSize) as Float32Array<ArrayBuffer>;
    this.depthGain.connect(this.outputAnalyser);
  }

  start(rateHz: number): void {
    if (this.started) {
      this.setRate(rateHz);
      return;
    }
    this.baseRate = clampRate(rateHz);
    for (const osc of this.oscillators) {
      osc.frequency.value = this.baseRate;
      osc.start();
    }
    this.started = true;
  }

  connect(dest: AudioNode, inputIndex = 0): void {
    this.connections.push({ dest, inputIndex });
    try { this.depthGain.connect(dest, 0, inputIndex); } catch { /* already connected */ }
  }

  disconnect(): void {
    for (const c of this.connections) {
      try { this.depthGain.disconnect(c.dest, 0, c.inputIndex); } catch { /* ok */ }
    }
    this.connections = [];
  }

  setRate(hz: number): void {
    this.baseRate = clampRate(hz);
    const now = this.ctx.currentTime;
    for (const osc of this.oscillators) {
      osc.frequency.setTargetAtTime(this.baseRate, now, SMOOTH_TC);
    }
  }

  setDepth(v: number): void {
    const d = clampDepth(v);
    const now = this.ctx.currentTime;
    this.depthGain.gain.setTargetAtTime(d, now, SMOOTH_TC);
  }

  setShape(p: number): void {
    this.currentShape = clamp01(p);
    this.applyShapeWeights(this.currentShape);
  }

  /** Draw a still analytic preview of the current wave shape. Fixed 3 cycles —
   *  rate is sub-audio so a fixed count is more useful than frequency-scaled. */
  drawScope(canvas: HTMLCanvasElement): void {
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

    const weights = morphWeights(this.currentShape);
    const amp = h / 2 - 1;

    c2d.strokeStyle = "#00ff00";
    c2d.lineWidth = 1.25;
    c2d.shadowColor = "rgba(0, 255, 0, 0.75)";
    c2d.shadowBlur = 4;
    c2d.beginPath();
    for (let x = 0; x < w; x++) {
      const t = (x / (w - 1)) * 3;
      const v = waveSample(t, weights);
      const y = h / 2 - v * amp;
      if (x === 0) c2d.moveTo(x, y); else c2d.lineTo(x, y);
    }
    c2d.stroke();
    c2d.shadowBlur = 0;
  }

  /** Render a live oscilloscope trace of the post-depth output. The analyser
   *  window is ~46ms at 44.1kHz; LFO rates below ~22Hz render as a partial
   *  cycle (correct — this view is a true oscilloscope, not a rate-scaled preview). */
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

    // Auto-scale so the LFO trace fills the box regardless of depth. The 0.001
    // floor prevents a near-zero output from amplifying numerical noise into a
    // jagged hash — at very low depth we'd rather show a flat line.
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(this.outputData[i]);
      if (v > peak) peak = v;
    }
    const scale = peak < 0.001 ? 1 : 1 / peak;

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
    try { this.depthGain.disconnect(); } catch { /* ok */ }
    try { this.rateInput.disconnect(); } catch { /* ok */ }
    try { this.outputAnalyser.disconnect(); } catch { /* ok */ }
    this.started = false;
  }

  private applyShapeWeights(p: number): void {
    const weights = morphWeights(p);
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.shapeGains.length; i++) {
      this.shapeGains[i].gain.setTargetAtTime(weights[i], now, SMOOTH_TC);
    }
  }
}

function morphWeights(p: number): [number, number, number, number] {
  const x = clamp01(p);
  if (x <= 1 / 3) { const t = x * 3;           return [1 - t, t, 0, 0]; }
  if (x <= 2 / 3) { const t = (x - 1 / 3) * 3; return [0, 1 - t, t, 0]; }
  const t = (x - 2 / 3) * 3;
  return [0, 0, 1 - t, t];
}

function waveSample(t: number, weights: readonly [number, number, number, number]): number {
  const phase = t - Math.floor(t);
  const angle = 2 * Math.PI * phase;
  const sine = Math.sin(angle);
  const tri  = (2 / Math.PI) * Math.asin(Math.sin(angle));
  const saw  = 2 * (phase - Math.floor(phase + 0.5));
  const sqr  = phase < 0.5 ? 1 : -1;
  return weights[0] * sine + weights[1] * tri + weights[2] * saw + weights[3] * sqr;
}

function clampRate(hz: number): number {
  if (!Number.isFinite(hz)) return LFO_RATE_MIN;
  return hz < LFO_RATE_MIN ? LFO_RATE_MIN : hz > LFO_RATE_MAX ? LFO_RATE_MAX : hz;
}

function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > LFO_DEPTH_MAX ? LFO_DEPTH_MAX : v;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
