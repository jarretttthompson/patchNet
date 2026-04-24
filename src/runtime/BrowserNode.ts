import { AudioRuntime } from "./AudioRuntime";

/**
 * BrowserNode — captures audio + video from a user-approved browser tab via
 * getDisplayMedia(). Shape mirrors AdcNode on the audio side and
 * MediaVideoNode on the video side.
 *
 * Audio path: getDisplayMedia → source → splitter(2) → L/R outlets
 *                                                   → analyserL / analyserR (meter taps)
 *
 * Video:      getDisplayMedia → hidden <video>.srcObject = stream.
 *             The `.video`, `.isReady`, `.hasError` trio satisfies the
 *             MediaVideoSource interface used by LayerNode / vFX nodes.
 */
export class BrowserNode {
  private readonly runtime: AudioRuntime;
  private stream: MediaStream | null = null;
  private videoOnlyStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private readonly _splitter: ChannelSplitterNode;
  private readonly analyserL: AnalyserNode;
  private readonly analyserR: AnalyserNode;
  private readonly dataL: Float32Array<ArrayBuffer>;
  private readonly dataR: Float32Array<ArrayBuffer>;

  // Video side — always present so LayerNode can read a valid element,
  // even before the user approves capture (falls back to a muted blank frame).
  readonly video: HTMLVideoElement;

  private _capturing = false;
  private _hasError = false;
  private _errorMessage = "";
  private _tabLabel = "";
  private onStateChange?: () => void;

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

    this.video = document.createElement("video");
    this.video.muted = true; // audio goes through Web Audio, not the element
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.style.display = "none";
    document.body.appendChild(this.video);
  }

  /** Prompts the user to pick a tab. Must be called from a user gesture. */
  async capture(): Promise<void> {
    if (this._capturing) return;
    this._hasError = false;
    this._errorMessage = "";
    try {
      // `suppressLocalAudioPlayback: true` tells Chromium to route the tab's
      // audio ONLY into the MediaStream — the source tab goes silent at the
      // OS/speaker level. Without this, Chrome's default is to still play
      // the tab through speakers alongside the captured copy, which breaks
      // the "no cable = no sound" contract. Cast: TS DOM lib doesn't
      // always include the getDisplayMedia audio constraint dictionary.
      const stream = await (navigator.mediaDevices as MediaDevices).getDisplayMedia({
        video: true,
        audio: {
          suppressLocalAudioPlayback: true,
        } as MediaTrackConstraints,
      });
      this.stream = stream;

      // Belt-and-suspenders: some Chrome builds honour the flag only via
      // applyConstraints after the track is live. Safe no-op elsewhere.
      for (const track of stream.getAudioTracks()) {
        try {
          await track.applyConstraints({ suppressLocalAudioPlayback: true } as MediaTrackConstraints);
        } catch { /* unsupported — nothing more we can do from here */ }
      }

      // Audio path: captured audio is wrapped in a MediaStreamAudioSourceNode
      // that dead-ends at meter analysers. It only reaches the speakers if
      // the user explicitly patches an outlet to dac~. This is the contract:
      // no cable to dac~ = no sound from the tab through patchNet.
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.source = this.runtime.context.createMediaStreamSource(
          new MediaStream(audioTracks),
        );
        this.source.connect(this._splitter);
      }

      // Video path: feed the video element a VIDEO-ONLY clone of the stream
      // so the element has no audio tracks to play at all — defence in depth
      // against browsers that route `<video muted>` audio to default output.
      this.videoOnlyStream = new MediaStream(stream.getVideoTracks());
      this.video.srcObject = this.videoOnlyStream;
      this.video.play().catch(() => { /* ignored — autoplay policy */ });

      const videoTrack = stream.getVideoTracks()[0];
      this._tabLabel = videoTrack?.label ?? "";

      // Browser-initiated end (user clicked "Stop sharing").
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => this.release());
      }

      this._capturing = true;
      this._hasError = false;
      this.onStateChange?.();
    } catch (err) {
      console.warn("[BrowserNode] getDisplayMedia failed:", err);
      this._hasError = true;
      this._errorMessage = describeCaptureError(err);
      this.onStateChange?.();
    }
  }

  release(): void {
    if (!this._capturing && !this.stream) return;
    try { this.source?.disconnect(); } catch { /* ok */ }
    this.source = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.videoOnlyStream = null;
    this.video.srcObject = null;
    this._capturing = false;
    this._tabLabel = "";
    this.onStateChange?.();
  }

  /** Connect outlet (0=L, 1=R) to a destination input. See AdcNode docs. */
  connectChannel(dest: AudioNode, outputChannel: number, inputIndex: number): void {
    this._splitter.connect(dest, outputChannel, inputIndex);
  }

  disconnect(): void {
    try { this._splitter.disconnect(); } catch { /* ok */ }
    try { this._splitter.connect(this.analyserL, 0); } catch { /* ok */ }
    try { this._splitter.connect(this.analyserR, 1); } catch { /* ok */ }
  }

  setOnStateChange(fn: (() => void) | undefined): void {
    this.onStateChange = fn;
  }

  get levelL(): number { return this._capturing ? rms(this.analyserL, this.dataL) : 0; }
  get levelR(): number { return this._capturing ? rms(this.analyserR, this.dataR) : 0; }
  get level():  number { return (this.levelL + this.levelR) / 2; }

  get isCapturing():  boolean { return this._capturing; }
  get tabLabel():     string  { return this._tabLabel; }
  get errorMessage(): string  { return this._errorMessage; }
  /** Video-only clone of the captured stream. Use this — not the raw stream —
   *  for any `<video>` element, so audio cannot leak through an HTML element. */
  get videoStream(): MediaStream | null { return this.videoOnlyStream; }

  // MediaVideoSource shape ------------------------------------------------
  get isReady():  boolean { return this._capturing && this.video.readyState >= 2; }
  get hasError(): boolean { return this._hasError; }

  destroy(): void {
    this.release();
    try { this._splitter.disconnect(); } catch { /* ok */ }
    this.video.remove();
  }
}

function describeCaptureError(err: unknown): string {
  if (!(err instanceof Error)) return "capture failed";
  const name = (err as DOMException).name;
  switch (name) {
    case "NotAllowedError":
      // Two sub-cases: user dismissed, or the page/iframe lacks permission.
      return "permission denied (cancelled, or page needs display-capture permission)";
    case "NotFoundError":
      return "no capturable source available";
    case "AbortError":
      return "capture aborted";
    case "NotReadableError":
      return "the selected source is already in use";
    case "TypeError":
      return "browser refused the capture request (check permissions-policy)";
    case "InvalidStateError":
      return "the patchNet tab wasn't focused when the prompt opened — keep this tab in front and try again";
    default:
      return err.message || "capture failed";
  }
}

function rms(analyser: AnalyserNode, data: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}
