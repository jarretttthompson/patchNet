import { FrameCapture } from "./frame/CaptureSession";

/**
 * FrameNode — runtime for a `frame~` patch object. Captures the pixels of
 * a DOM element (the panel's transparent inner rectangle) into an
 * HTMLVideoElement via the Region Capture API, then exposes that element
 * to downstream video sinks (vfxCRT, vfxBlur, reaperVideo, layer) through
 * the same MediaVideoSource shape that mediaVideo / browser~ / youtube~
 * already use (`.video`, `.isReady`, `.hasError`).
 *
 * Why each FrameNode owns its own getDisplayMedia stream (no sharing):
 *   The natural "share one capture across all frames" design clones the
 *   source video track and crops each clone to a different element. Chrome
 *   refuses with "Can't change target while clones exist" — the Region
 *   Capture impl doesn't allow cropTo on clones (or on a track whose
 *   source has clones). So each frame~ takes its own getDisplayMedia.
 *   preferCurrentTab keeps the prompt to one click per instance.
 *
 * Lifecycle:
 *   - Constructed by VisualizerGraph.sync() when a frame~ node appears.
 *   - The FramePanel calls bindElement(rect) once mounted — the element
 *     whose pixels will be captured.
 *   - capture() prompts getDisplayMedia, applies cropTo(rect) to the
 *     resulting track, and feeds the stream to the hidden <video>. Must
 *     be called from a user gesture.
 *   - release() stops the underlying stream so the share indicator goes
 *     away; the next capture() re-prompts.
 *
 * Bound element vs. capture:
 *   bindElement() can be called repeatedly as the panel re-mounts across
 *   canvas re-renders. If we're already capturing, we re-issue cropTo
 *   against the new element so the stream tracks the live DOM rect.
 */
export class FrameNode {
  readonly video: HTMLVideoElement;

  private element: HTMLElement | null = null;
  private track: MediaStreamTrack | null = null;
  private stream: MediaStream | null = null;
  private _capturing = false;
  private _hasError = false;
  private _errorMessage = "";

  private onStateChange?: () => void;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.style.display = "none";
    document.body.appendChild(this.video);
  }

  setOnStateChange(fn: (() => void) | undefined): void {
    this.onStateChange = fn;
  }

  /** Bind (or rebind) the DOM element to capture. If a stream is already
   *  live, re-apply cropTo so it tracks the new element. */
  bindElement(el: HTMLElement | null): void {
    this.element = el;
    if (this._capturing && this.track && el) {
      void this.applyCropTo(el).catch(() => { /* swallow — onStateChange surfaces */ });
    }
  }

  isSupported(): boolean {
    return FrameCapture.isSupported();
  }

  /** Prompt and start capturing this frame's bound element. Must be called
   *  from within a user gesture. */
  async capture(): Promise<void> {
    if (this._capturing) return;
    if (!this.element) {
      this._hasError = true;
      this._errorMessage = "frame element not mounted yet";
      this.onStateChange?.();
      return;
    }
    if (!FrameCapture.isSupported()) {
      this._hasError = true;
      this._errorMessage = "Region Capture not supported in this browser";
      this.onStateChange?.();
      return;
    }
    this._hasError = false;
    this._errorMessage = "";

    let stream: MediaStream | null = null;
    try {
      // Wait one frame so the panel layout has settled before fromElement
      // snapshots the bounding box. Without this, an in-flight re-mount can
      // make Region Capture silently fall back to whole-tab.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));

      stream = await (navigator.mediaDevices as MediaDevices).getDisplayMedia({
        video: true,
        audio: false,
        // Bias picker toward the patchNet tab itself.
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions & { preferCurrentTab?: boolean });

      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("no video track in captured stream");
      this.track = track;
      this.stream = stream;

      // Build CropTarget *after* getDisplayMedia resolves — building before
      // can let the token go stale across the user-gesture interval and
      // silently fall back to whole-tab capture (same gotcha YouTubeNode hit).
      await this.applyCropTo(this.element);

      this.video.srcObject = this.stream;
      try { await this.video.play(); } catch { /* autoplay policy */ }

      // Browser-initiated end (user clicked "Stop sharing").
      track.addEventListener("ended", () => this.release());

      this._capturing = true;
      this.onStateChange?.();
    } catch (err) {
      if (stream) {
        try { stream.getTracks().forEach(t => t.stop()); } catch { /* ok */ }
      }
      this.track = null;
      this.stream = null;
      this.video.srcObject = null;
      this._capturing = false;
      this._hasError = true;
      this._errorMessage = describeCaptureError(err);
      this.onStateChange?.();
    }
  }

  release(): void {
    if (!this._capturing && !this.track) return;
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch { /* ok */ }
    this.track = null;
    this.stream = null;
    this.video.srcObject = null;
    this._capturing = false;
    this.onStateChange?.();
  }

  destroy(): void {
    this.release();
    this.video.remove();
  }

  // MediaVideoSource shape ------------------------------------------------
  get isCapturing(): boolean { return this._capturing; }
  get isReady(): boolean { return this._capturing && this.video.readyState >= 2; }
  get hasError(): boolean { return this._hasError; }
  get errorMessage(): string { return this._errorMessage; }

  // ── Private ───────────────────────────────────────────────────────────

  private async applyCropTo(el: HTMLElement): Promise<void> {
    const w = window as unknown as {
      CropTarget?: { fromElement(el: Element): Promise<unknown> };
    };
    if (!w.CropTarget?.fromElement || !this.track) return;
    const trackWithCrop = this.track as MediaStreamTrack & {
      cropTo(target: unknown): Promise<void>;
    };
    if (typeof trackWithCrop.cropTo !== "function") {
      throw new Error("MediaStreamTrack.cropTo not supported");
    }
    // One rAF settles in-flight layout before we snapshot.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const target = await w.CropTarget.fromElement(el);
    await trackWithCrop.cropTo(target);
  }
}

function describeCaptureError(err: unknown): string {
  if (!(err instanceof Error)) return "frame capture failed";
  const name = (err as DOMException).name;
  switch (name) {
    case "NotAllowedError": return "permission denied (cancelled share prompt)";
    case "NotFoundError":   return "no capturable source available";
    case "AbortError":      return "capture aborted";
    case "NotSupportedError": return "Region Capture not supported in this browser";
    case "InvalidStateError": return "patchNet tab wasn't focused — keep this tab in front and try again";
    case "NotReadableError": return "OS blocked screen capture — grant Screen Recording permission to this browser in System Settings, then relaunch it";
    default: return err.message || "frame capture failed";
  }
}
