/**
 * AudioRuntime — singleton Web Audio context.
 *
 * Must be started by a user gesture (call start() from a click handler).
 * Provides the shared AudioContext and master destination node.
 */
export class AudioRuntime {
  private static instance: AudioRuntime | null = null;

  private _context: AudioContext | null = null;
  private _masterGain: GainNode | null = null;
  private _started = false;

  static getInstance(): AudioRuntime {
    if (!AudioRuntime.instance) {
      AudioRuntime.instance = new AudioRuntime();
    }
    return AudioRuntime.instance;
  }

  /** Call from a user gesture to unlock the AudioContext. */
  async start(): Promise<void> {
    if (this._started) return;
    this._context = new AudioContext();
    if (this._context.state === "suspended") {
      await this._context.resume();
    }
    this._masterGain = this._context.createGain();
    this._masterGain.gain.value = 0.75;
    this._masterGain.connect(this._context.destination);
    this._started = true;
  }

  async stop(): Promise<void> {
    if (!this._context) return;
    await this._context.close();
    this._context = null;
    this._masterGain = null;
    this._started = false;
  }

  /** Enumerate available audio output devices (requires HTTPS or localhost). */
  async getOutputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "audiooutput");
  }

  /** Route audio to a specific output device by deviceId. Chrome 110+ only. */
  async setOutputDevice(deviceId: string): Promise<void> {
    if (!this._context) return;
    // setSinkId is not yet in all TS lib types
    const ctx = this._context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId(deviceId);
    }
  }

  set masterVolume(value: number) {
    if (this._masterGain) {
      this._masterGain.gain.setTargetAtTime(
        Math.max(0, Math.min(1, value)),
        this._context!.currentTime,
        0.01,
      );
    }
  }

  get isStarted(): boolean {
    return this._started;
  }

  get context(): AudioContext {
    if (!this._context) throw new Error("AudioRuntime not started — call start() first");
    return this._context;
  }

  /** Audio sources should connect here (master gain → destination). */
  get masterInput(): AudioNode {
    if (!this._masterGain) throw new Error("AudioRuntime not started");
    return this._masterGain;
  }

  get destination(): AudioDestinationNode {
    return this.context.destination;
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }
}
