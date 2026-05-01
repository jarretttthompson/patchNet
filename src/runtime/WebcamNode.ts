import type { MediaVideoSource } from "./MediaVideoNode";

/**
 * WebcamNode — runtime for a `cam*` patch object. Wraps a single videoinput
 * device (camera, USB capture card, virtual cam, etc.) as a MediaVideoSource
 * so every existing video sink (layer*, vfxCRT*, vfxBlur*, reaperVideo*,
 * vbuf*, shaderToy*) consumes it through the same `.video / .isReady /
 * .hasError` shape that mediaVideo* / browser~* / youtube~* / frame* expose.
 *
 * Audio is intentionally never requested. Webcams often expose a microphone
 * track — we drop it on the floor here. If the user wants the cam's mic, they
 * should use adc~ (which has its own device picker).
 *
 * Lifecycle:
 *   - Constructed by VisualizerGraph.sync() when a cam* node appears.
 *   - start(deviceId, w, h): getUserMedia({video:{...}}) and feeds the
 *     resulting stream into a hidden <video>. `getUserMedia` requires an
 *     active document but no per-call user gesture once permission is granted
 *     for the origin.
 *   - stop(): track.stop() on each video track (releases the device — the OS
 *     camera indicator goes off) and clears srcObject.
 *   - destroy(): stop + remove the <video>.
 */
export class WebcamNode implements MediaVideoSource {
  readonly video: HTMLVideoElement;

  private stream: MediaStream | null = null;
  private _started = false;
  private _starting = false;
  private _hasError = false;
  private _errorMessage = "";

  /** Last-requested args, kept so device-list refreshes / panel re-mounts can
   *  re-issue start() without the caller having to remember them. */
  private currentDeviceId = "";
  private currentWidth    = 0;
  private currentHeight   = 0;

  private onStateChange?: () => void;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted        = true;
    this.video.playsInline  = true;
    this.video.autoplay     = true;
    this.video.style.display = "none";
    document.body.appendChild(this.video);
  }

  setOnStateChange(fn: (() => void) | undefined): void {
    this.onStateChange = fn;
  }

  /** Browsers only return device labels after at least one getUserMedia call
   *  has been resolved for that kind of device. Static helper so panels can
   *  refresh their dropdowns without owning a node. */
  static async enumerate(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  }

  async start(deviceId = "", width = 0, height = 0): Promise<void> {
    if (this._started || this._starting) return;
    this._starting = true;
    this._hasError = false;
    this._errorMessage = "";
    this.onStateChange?.();

    try {
      const videoConstraints: MediaTrackConstraints = {};
      if (deviceId) videoConstraints.deviceId = { exact: deviceId };
      if (width  > 0) videoConstraints.width  = { ideal: width  };
      if (height > 0) videoConstraints.height = { ideal: height };

      const stream = await navigator.mediaDevices.getUserMedia({
        video: Object.keys(videoConstraints).length ? videoConstraints : true,
        audio: false,
      });

      // Defensive: if a track was returned with audio anyway (some virtual
      // cams do this even when audio:false is set), stop it so we don't hold
      // the mic open.
      for (const t of stream.getAudioTracks()) { try { t.stop(); } catch { /* ok */ } }

      this.stream = stream;
      this.video.srcObject = stream;
      try { await this.video.play(); } catch { /* autoplay policy — resumes on next gesture */ }

      // Browser/OS-initiated end (device unplugged, permission revoked).
      const track = stream.getVideoTracks()[0];
      track?.addEventListener("ended", () => this.stop());

      this.currentDeviceId = deviceId;
      this.currentWidth    = width;
      this.currentHeight   = height;
      this._started        = true;
    } catch (err) {
      this._hasError = true;
      this._errorMessage = describeCamError(err);
    } finally {
      this._starting = false;
      this.onStateChange?.();
    }
  }

  stop(): void {
    if (!this._started && !this.stream) return;
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch { /* ok */ }
    this.stream = null;
    this.video.srcObject = null;
    this._started = false;
    this.onStateChange?.();
  }

  /** Switch device. If currently running, restart with the new id; otherwise
   *  just remember it for the next start(). */
  async setDevice(deviceId: string): Promise<void> {
    if (deviceId === this.currentDeviceId && this._started) return;
    const wasRunning = this._started;
    if (wasRunning) this.stop();
    this.currentDeviceId = deviceId;
    if (wasRunning) await this.start(deviceId, this.currentWidth, this.currentHeight);
    else this.onStateChange?.();
  }

  destroy(): void {
    this.stop();
    this.video.remove();
  }

  // MediaVideoSource shape ------------------------------------------------
  get isReady(): boolean { return this._started && this.video.readyState >= 2; }
  get hasError(): boolean { return this._hasError; }
  get isStarted(): boolean { return this._started; }
  get isStarting(): boolean { return this._starting; }
  get errorMessage(): string { return this._errorMessage; }
  get deviceId(): string { return this.currentDeviceId; }
  get videoStream(): MediaStream | null { return this.stream; }
}

function describeCamError(err: unknown): string {
  if (!(err instanceof Error)) return "camera capture failed";
  const name = (err as DOMException).name;
  switch (name) {
    case "NotAllowedError":   return "permission denied — grant Camera access to this browser";
    case "NotFoundError":     return "no matching camera found";
    case "OverconstrainedError": return "device doesn't support requested resolution";
    case "NotReadableError":  return "device is in use by another app";
    case "AbortError":        return "capture aborted";
    case "SecurityError":     return "camera blocked by browser policy";
    case "TypeError":         return "browser doesn't support getUserMedia in this context (HTTPS / localhost only)";
    default: return err.message || "camera capture failed";
  }
}
