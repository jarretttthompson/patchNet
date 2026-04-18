import { AudioRuntime } from "./AudioRuntime";

/**
 * AdcNode — microphone / audio input capture node.
 *
 * Signal path: getUserMedia → source → splitter(2) → L/R outlets → downstream
 *                                                   → analyserL (dead-end tap)
 *                                                   → analyserR (dead-end tap)
 *
 * Outlet 0 = left channel, outlet 1 = right channel.
 */
export class AdcNode {
  private readonly runtime: AudioRuntime;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private readonly _splitter: ChannelSplitterNode;
  private readonly analyserL: AnalyserNode;
  private readonly analyserR: AnalyserNode;
  private readonly dataL: Float32Array<ArrayBuffer>;
  private readonly dataR: Float32Array<ArrayBuffer>;

  private _started = false;

  constructor(runtime: AudioRuntime) {
    this.runtime = runtime;
    const ctx = runtime.context;

    this._splitter = ctx.createChannelSplitter(2);

    this.analyserL = ctx.createAnalyser();
    this.analyserL.fftSize = 256;
    this.analyserL.smoothingTimeConstant = 0.8;
    this.dataL = new Float32Array(this.analyserL.fftSize) as Float32Array<ArrayBuffer>;
    this._splitter.connect(this.analyserL, 0);

    this.analyserR = ctx.createAnalyser();
    this.analyserR.fftSize = 256;
    this.analyserR.smoothingTimeConstant = 0.8;
    this.dataR = new Float32Array(this.analyserR.fftSize) as Float32Array<ArrayBuffer>;
    this._splitter.connect(this.analyserR, 1);
  }

  async start(deviceId?: string): Promise<void> {
    if (this._started) return;
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.source = this.runtime.context.createMediaStreamSource(this.stream);
      this.source.connect(this._splitter);
      this._started = true;
    } catch (err) {
      console.warn("[AdcNode] getUserMedia failed:", err);
    }
  }

  /** Connect outlet (0=L, 1=R) to a destination input.
   *  No _started guard — splitter is constructed before start() resolves
   *  and will carry audio once the source is attached. */
  connectChannel(dest: AudioNode, outputChannel: number, inputIndex: number): void {
    this._splitter.connect(dest, outputChannel, inputIndex);
  }

  disconnect(): void {
    try { this._splitter.disconnect(); } catch { /* ok */ }
    // Always re-attach metering taps — constructed before start() resolves,
    // so must not be conditional on _started.
    try { this._splitter.connect(this.analyserL, 0); } catch { /* ok */ }
    try { this._splitter.connect(this.analyserR, 1); } catch { /* ok */ }
  }

  get levelL(): number { return this._started ? rms(this.analyserL, this.dataL) : 0; }
  get levelR(): number { return this._started ? rms(this.analyserR, this.dataR) : 0; }
  get level():  number { return (this.levelL + this.levelR) / 2; }

  get isStarted(): boolean { return this._started; }

  destroy(): void {
    try { this._splitter.disconnect(); } catch { /* ok */ }
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.source = null;
    this.stream = null;
    this._started = false;
  }
}

function rms(analyser: AnalyserNode, data: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}
