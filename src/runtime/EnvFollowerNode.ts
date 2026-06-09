import { AudioRuntime } from "./AudioRuntime";

/**
 * EnvFollowerNode — runtime for `env~`, an amplitude envelope follower.
 *
 * Computes the RMS of the time-domain signal each control tick, then smooths
 * it with asymmetric one-pole ballistics: a fast `attack` coefficient while
 * the level is rising, a slower `release` while it falls. The result is a
 * clean VU-style 0..1 control signal — much smoother than raw FFT level — for
 * driving continuous video params.
 *
 * Polled by AudioGraph.updateEnvDisplay once per control tick (same cadence as
 * fft~/spectral~); `value` is then pushed downstream by main.ts.
 */
export class EnvFollowerNode {
  private readonly merger: ChannelMergerNode;
  private readonly analyser: AnalyserNode;
  private readonly timeData: Uint8Array<ArrayBuffer>;

  private env = 0;
  private attackMs = 10;
  private releaseMs = 200;
  private lastTime = performance.now();

  constructor(runtime: AudioRuntime) {
    const actx = runtime.context;
    this.merger = actx.createChannelMerger(2);
    this.analyser = actx.createAnalyser();
    // Small window is plenty for an RMS amplitude read and keeps it responsive.
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0; // we do our own smoothing
    this.timeData = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.merger.connect(this.analyser);
  }

  get inputNode(): AudioNode { return this.merger; }

  /** Current smoothed envelope, 0..1. */
  get value(): number { return this.env; }

  setAttack(ms: number): void {
    if (Number.isFinite(ms)) this.attackMs = Math.max(0, ms);
  }
  setRelease(ms: number): void {
    if (Number.isFinite(ms)) this.releaseMs = Math.max(0, ms);
  }

  /** Recompute RMS and advance the smoothed envelope. */
  update(): void {
    this.analyser.getByteTimeDomainData(this.timeData);
    const n = this.timeData.length;

    // RMS of the centered waveform (byte 128 = silence midpoint → ±1.0).
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / n); // 0..1

    // Asymmetric one-pole: pick attack vs release time constant by direction,
    // and derive the coefficient from the actual elapsed time so the ballistics
    // are frame-rate independent.
    const now = performance.now();
    const dt = Math.max(0, now - this.lastTime);
    this.lastTime = now;
    const tau = rms > this.env ? this.attackMs : this.releaseMs;
    const coeff = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    this.env += coeff * (rms - this.env);
    if (this.env < 0) this.env = 0;
    else if (this.env > 1) this.env = 1;
  }

  destroy(): void {
    this.merger.disconnect();
    this.analyser.disconnect();
  }
}
