import { AudioRuntime } from "./AudioRuntime";

/**
 * AdcNode — multichannel audio input capture node.
 *
 * Signal path: getUserMedia(channelCount: N) → source → splitter(N)
 *                                                       → outlet 0..N-1
 *                                                       → analyser per channel (dead-end taps)
 *
 * The browser may grant fewer channels than requested. `detectedChannelCount`
 * reflects what the MediaStreamTrack actually delivered.
 */
export class AdcNode {
  private readonly runtime: AudioRuntime;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private readonly _channels: number;
  private readonly _splitter: ChannelSplitterNode;
  private readonly analysers: AnalyserNode[];
  private readonly analyserData: Float32Array<ArrayBuffer>;

  private _started = false;
  private _detectedChannelCount = 0;

  constructor(runtime: AudioRuntime, channels: number = 2) {
    this.runtime = runtime;
    this._channels = Math.max(1, Math.min(32, channels | 0));
    const ctx = runtime.context;

    this._splitter = ctx.createChannelSplitter(this._channels);

    this.analysers = [];
    this.analyserData = new Float32Array(256) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < this._channels; i++) {
      const a = ctx.createAnalyser();
      a.fftSize = 256;
      a.smoothingTimeConstant = 0.8;
      this._splitter.connect(a, i);
      this.analysers.push(a);
    }
  }

  async start(deviceId?: string): Promise<void> {
    if (this._started) return;
    try {
      // Disable processing — we want raw multichannel input from interfaces
      // like the X32. echoCancellation / autoGainControl / noiseSuppression
      // each force the browser to downmix to mono on Chrome.
      const audio: MediaTrackConstraints = {
        channelCount: { ideal: this._channels },
        echoCancellation: false,
        autoGainControl:  false,
        noiseSuppression: false,
      };
      if (deviceId) audio.deviceId = { exact: deviceId };

      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      this.source = this.runtime.context.createMediaStreamSource(this.stream);
      this.source.connect(this._splitter);

      const track = this.stream.getAudioTracks()[0];
      const settings = track?.getSettings() as { channelCount?: number } | undefined;
      this._detectedChannelCount = settings?.channelCount ?? this._channels;

      this._started = true;
    } catch (err) {
      console.warn("[AdcNode] getUserMedia failed:", err);
    }
  }

  /** Connect outlet (0..N-1) to a destination input. */
  connectChannel(dest: AudioNode, outputChannel: number, inputIndex: number): void {
    if (outputChannel < 0 || outputChannel >= this._channels) return;
    this._splitter.connect(dest, outputChannel, inputIndex);
  }

  disconnect(): void {
    try { this._splitter.disconnect(); } catch { /* ok */ }
    for (let i = 0; i < this.analysers.length; i++) {
      try { this._splitter.connect(this.analysers[i], i); } catch { /* ok */ }
    }
  }

  get channelCount(): number { return this._channels; }
  get detectedChannelCount(): number { return this._detectedChannelCount; }

  getChannelLevel(ch: number): number {
    const a = this.analysers[ch];
    if (!a || !this._started) return 0;
    a.getFloatTimeDomainData(this.analyserData);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) sum += this.analyserData[i] * this.analyserData[i];
    return Math.sqrt(sum / this.analyserData.length);
  }

  /** Backwards-compat L/R level taps used by the toolbar meter. */
  get levelL(): number { return this.getChannelLevel(0); }
  get levelR(): number { return this.getChannelLevel(this._channels > 1 ? 1 : 0); }
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
