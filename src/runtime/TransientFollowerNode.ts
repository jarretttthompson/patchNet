import { AudioRuntime } from "./AudioRuntime";
import { fitScopeCanvas } from "./scopeCanvasFit";

interface Connection {
  dest: AudioNode;
  inputIndex: number;
  outletIndex: number;   // 0 = shaped audio, 1 = envelope signal
}

const HISTORY_FRAMES = 240;   // ~4 seconds of envelope history at 60 Hz rAF
const ANALYSER_FFT   = 256;   // small window — we only need the recent peak
const MIN_TIME_MS    = 0.05;
const MAX_TIME_MS    = 10000;

/**
 * TransientFollowerNode — envelope follower + VCA in one node.
 *
 * Inlets:
 *   0 (sourceInput)  — audio carrier to be shaped (e.g. wave~ output)
 *   1 (shapeInput)   — audio whose envelope drives the VCA (e.g. adc~)
 *
 * Outlets:
 *   0 (shapedOutput)   — sourceInput × envelope. Drop-in for adsr~ → *~
 *   1 (envelopeOutput) — detected envelope as an audio-rate signal
 *
 * Internal graph:
 *
 *   shapeInput ──► worklet ──┬─► vcaGain.gain   (audio-param modulation)
 *                            ├─► envelopeOutput (outlet 1)
 *                            └─► envAnalyser    (face draw)
 *
 *   sourceInput ──► vcaGain ──► shapedOutput (outlet 0)
 *
 * VCA trick: vcaGain.gain.value = 0; the worklet's audio output is connected
 * to the AudioParam, which sums with the default. Result: gain follows the
 * envelope at audio rate (same pattern wave~ uses for freq/morph CV).
 */
export class TransientFollowerNode {
  private readonly ctx: AudioContext;

  readonly sourceInput: GainNode;     // inlet 0
  readonly shapeInput: GainNode;      // inlet 1

  private readonly worklet: AudioWorkletNode;
  private readonly vcaGain: GainNode;
  readonly shapedOutput: GainNode;    // outlet 0
  readonly envelopeOutput: GainNode;  // outlet 1

  private readonly envAnalyser: AnalyserNode;
  private readonly envSampleBuf: Float32Array<ArrayBuffer>;
  /** Circular buffer of one envelope-peak sample per drawLiveScope() call. */
  private readonly history: Float32Array;
  private historyHead = 0;

  private connections: Connection[] = [];

  constructor(runtime: AudioRuntime) {
    this.ctx = runtime.context;

    this.sourceInput = this.ctx.createGain();
    this.shapeInput  = this.ctx.createGain();

    this.worklet = new AudioWorkletNode(this.ctx, "transient-follower", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.vcaGain = this.ctx.createGain();
    this.vcaGain.gain.value = 0;        // silent at rest — envelope drives gain via AudioParam

    this.shapedOutput   = this.ctx.createGain();
    this.envelopeOutput = this.ctx.createGain();

    this.shapeInput.connect(this.worklet);
    // worklet → vcaGain.gain (audio-param modulation, NOT a regular node connection)
    this.worklet.connect(this.vcaGain.gain);
    this.worklet.connect(this.envelopeOutput);

    this.sourceInput.connect(this.vcaGain);
    this.vcaGain.connect(this.shapedOutput);

    this.envAnalyser = this.ctx.createAnalyser();
    this.envAnalyser.fftSize = ANALYSER_FFT;
    this.envAnalyser.smoothingTimeConstant = 0;
    this.envSampleBuf = new Float32Array(this.envAnalyser.fftSize) as Float32Array<ArrayBuffer>;
    this.worklet.connect(this.envAnalyser);

    this.history = new Float32Array(HISTORY_FRAMES);
  }

  /** Add a downstream connection. outletIndex selects which outlet to wire:
   *  0 = shaped audio, 1 = envelope signal. */
  connect(dest: AudioNode, outletIndex: number, inputIndex = 0): void {
    const source = outletIndex === 1 ? this.envelopeOutput : this.shapedOutput;
    this.connections.push({ dest, inputIndex, outletIndex });
    try { source.connect(dest, 0, inputIndex); } catch { /* already connected */ }
  }

  /** Drop all tracked downstream connections. The internal worklet→analyser
   *  and worklet→vcaGain.gain links are NOT severed so the live scope and
   *  VCA keep working across rewires. */
  disconnect(): void {
    for (const c of this.connections) {
      const source = c.outletIndex === 1 ? this.envelopeOutput : this.shapedOutput;
      try { source.disconnect(c.dest, 0, c.inputIndex); } catch { /* ok */ }
    }
    this.connections = [];
  }

  /** Push args into the worklet's k-rate AudioParams. Args are positional:
   *  [attackMs, releaseMs, sensitivity, floor]. */
  setArgs(attackMs: number, releaseMs: number, sensitivity: number, floor: number): void {
    const now = this.ctx.currentTime;
    this.worklet.parameters.get("attackMs")?.setValueAtTime(clampTimeMs(attackMs), now);
    this.worklet.parameters.get("releaseMs")?.setValueAtTime(clampTimeMs(releaseMs), now);
    this.worklet.parameters.get("sensitivity")?.setValueAtTime(clampSensitivity(sensitivity), now);
    this.worklet.parameters.get("floor")?.setValueAtTime(clamp01(floor), now);
  }

  /** Render the scrolling envelope history into the canvas. Sample once per
   *  call — peak of the analyser window is appended to the circular buffer,
   *  then the full buffer is drawn as a filled area chart growing left→right
   *  (oldest left, newest right, like a strip-chart recorder). */
  drawLiveScope(canvas: HTMLCanvasElement): void {
    const c2d = canvas.getContext("2d");
    if (!c2d) return;

    this.envAnalyser.getFloatTimeDomainData(this.envSampleBuf);
    let peak = 0;
    for (let i = 0; i < this.envSampleBuf.length; i++) {
      const v = this.envSampleBuf[i];
      if (v > peak) peak = v;       // envelope is non-negative; no abs needed
    }
    const clampedPeak = peak > 1 ? 1 : peak < 0 ? 0 : peak;
    this.history[this.historyHead] = clampedPeak;
    this.historyHead = (this.historyHead + 1) % HISTORY_FRAMES;

    const dims = fitScopeCanvas(canvas);
    if (!dims) return;
    const { w, h } = dims;

    c2d.clearRect(0, 0, w, h);
    c2d.fillStyle = "rgba(0, 0, 0, 0.55)";
    c2d.fillRect(0, 0, w, h);

    // Baseline (x-axis at the bottom — envelope is unipolar).
    c2d.strokeStyle = "rgba(0, 255, 0, 0.12)";
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(0, h - 0.5);
    c2d.lineTo(w, h - 0.5);
    c2d.stroke();

    // Filled envelope area + bright top edge. Walk the circular buffer
    // oldest → newest so the curve scrolls right with time.
    const usableH = h - 2;
    c2d.fillStyle = "rgba(0, 255, 0, 0.18)";
    c2d.strokeStyle = "#00ff00";
    c2d.lineWidth = 1.25;
    c2d.shadowColor = "rgba(0, 255, 0, 0.75)";
    c2d.shadowBlur = 4;
    c2d.beginPath();
    c2d.moveTo(0, h - 1);
    for (let x = 0; x < w; x++) {
      const t = x / Math.max(1, w - 1);
      const idx = Math.floor(t * (HISTORY_FRAMES - 1));
      const slot = (this.historyHead + idx) % HISTORY_FRAMES;
      const v = this.history[slot];
      const y = (h - 1) - v * usableH;
      c2d.lineTo(x, y);
    }
    c2d.lineTo(w - 1, h - 1);
    c2d.closePath();
    c2d.fill();
    // Re-trace the top edge as a bright stroke (shadow gives the glow).
    c2d.beginPath();
    for (let x = 0; x < w; x++) {
      const t = x / Math.max(1, w - 1);
      const idx = Math.floor(t * (HISTORY_FRAMES - 1));
      const slot = (this.historyHead + idx) % HISTORY_FRAMES;
      const v = this.history[slot];
      const y = (h - 1) - v * usableH;
      if (x === 0) c2d.moveTo(x, y); else c2d.lineTo(x, y);
    }
    c2d.stroke();
    c2d.shadowBlur = 0;
  }

  destroy(): void {
    this.disconnect();
    try { this.worklet.disconnect(); } catch { /* ok */ }
    try { this.vcaGain.disconnect(); } catch { /* ok */ }
    try { this.sourceInput.disconnect(); } catch { /* ok */ }
    try { this.shapeInput.disconnect(); } catch { /* ok */ }
    try { this.shapedOutput.disconnect(); } catch { /* ok */ }
    try { this.envelopeOutput.disconnect(); } catch { /* ok */ }
    try { this.envAnalyser.disconnect(); } catch { /* ok */ }
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampTimeMs(v: number): number {
  if (!Number.isFinite(v)) return MIN_TIME_MS;
  return v < MIN_TIME_MS ? MIN_TIME_MS : v > MAX_TIME_MS ? MAX_TIME_MS : v;
}

function clampSensitivity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 64 ? 64 : v;
}
