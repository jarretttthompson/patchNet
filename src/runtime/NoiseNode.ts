import { AudioRuntime } from "./AudioRuntime";
import { fitScopeCanvas } from "./scopeCanvasFit";

const BUFFER_SECONDS = 3;
const OUTPUT_FFT = 2048;
const SMOOTH_TC = 0.01;
const COLORS = ["white", "pink", "brown"] as const;

type NoiseColor = (typeof COLORS)[number];

interface Connection {
  dest: AudioNode;
  inputIndex: number;
}

/**
 * NoiseNode — continuous procedural noise source.
 *
 * A looping AudioBufferSourceNode is the lightest Web Audio primitive for
 * broad-band noise here. Changing the noise color swaps the loop buffer and
 * restarts the source; changing level ramps a GainNode for click-free control.
 */
export class NoiseNode {
  private readonly ctx: AudioContext;
  private readonly levelGain: GainNode;
  private readonly outputAnalyser: AnalyserNode;
  private readonly outputData: Float32Array<ArrayBuffer>;

  private source: AudioBufferSourceNode | null = null;
  private connections: Connection[] = [];
  private color: NoiseColor = "white";

  constructor(runtime: AudioRuntime) {
    this.ctx = runtime.context;

    this.levelGain = this.ctx.createGain();
    this.levelGain.gain.value = 0.25;

    this.outputAnalyser = this.ctx.createAnalyser();
    this.outputAnalyser.fftSize = OUTPUT_FFT;
    this.outputAnalyser.smoothingTimeConstant = 0;
    this.outputData = new Float32Array(this.outputAnalyser.fftSize) as Float32Array<ArrayBuffer>;
    this.levelGain.connect(this.outputAnalyser);

    this.restartSource();
  }

  connect(dest: AudioNode, inputIndex = 0): void {
    this.connections.push({ dest, inputIndex });
    try { this.levelGain.connect(dest, 0, inputIndex); } catch { /* already connected */ }
  }

  disconnect(): void {
    for (const c of this.connections) {
      try { this.levelGain.disconnect(c.dest, 0, c.inputIndex); } catch { /* ok */ }
    }
    this.connections = [];
  }

  setLevel(level: number): void {
    const safe = clamp01(level);
    this.levelGain.gain.setTargetAtTime(safe, this.ctx.currentTime, SMOOTH_TC);
  }

  setColor(color: string): void {
    const next = normalizeColor(color);
    if (next === this.color) return;
    this.color = next;
    this.restartSource();
  }

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

    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(this.outputData[i]);
      if (v > peak) peak = v;
    }
    const scale = peak < 0.01 ? 1 : 1 / peak;

    c2d.strokeStyle = "#00ff00";
    c2d.lineWidth = 1.15;
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
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* ok */ }
      this.source = null;
    }
    try { this.levelGain.disconnect(); } catch { /* ok */ }
    try { this.outputAnalyser.disconnect(); } catch { /* ok */ }
  }

  private restartSource(): void {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* ok */ }
    }

    const source = this.ctx.createBufferSource();
    source.buffer = makeNoiseBuffer(this.ctx, this.color);
    source.loop = true;
    source.connect(this.levelGain);
    source.start();
    this.source = source;
  }
}

function makeNoiseBuffer(ctx: AudioContext, color: NoiseColor): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * BUFFER_SECONDS));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  if (color === "pink") {
    fillPink(data);
  } else if (color === "brown") {
    fillBrown(data);
  } else {
    fillWhite(data);
  }

  return buffer;
}

function fillWhite(data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
}

function fillPink(data: Float32Array): void {
  // Paul Kellet's economical pink-noise filter. The final scale keeps output
  // near unity without clipping, matching the white/brown buffers by ear.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    data[i] = Math.max(-1, Math.min(1, pink * 0.11));
  }
}

function fillBrown(data: Float32Array): void {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = Math.max(-1, Math.min(1, last * 3.5));
  }
}

function normalizeColor(raw: string): NoiseColor {
  const value = raw.trim().toLowerCase();
  return COLORS.includes(value as NoiseColor) ? (value as NoiseColor) : "white";
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
