import { BrowserNode } from "./BrowserNode";

/**
 * YouTubeNode — BrowserNode plus YouTube-specific metadata.
 *
 * The audio + video capture path is inherited unchanged from BrowserNode:
 * the user picks a tab via getDisplayMedia(), L/R audio splits to outlets
 * 0/1, the captured `<video>` element drives outlet 2.
 *
 * What this class adds is purely the "which YouTube video is loaded" state
 * (videoId + startSeconds) so the panel iframe + the "Open in tab" button
 * can read/write a single source of truth. The BrowserNode capture flow is
 * orthogonal — the iframe is for viewing, capture is for routing into the
 * patch graph; they intentionally do not synchronise.
 */
export type CaptureMode = "none" | "tab" | "auto";

export class YouTubeNode extends BrowserNode {
  private _videoId = "";
  private _startSeconds = 0;
  private _captureMode: CaptureMode = "none";
  private metaListener?: () => void;

  setVideo(videoId: string, startSeconds: number): void {
    if (this._videoId === videoId && this._startSeconds === startSeconds) return;
    this._videoId = videoId;
    this._startSeconds = startSeconds;
    this.metaListener?.();
  }

  /** Independent listener from BrowserNode's onStateChange — that one is
   *  reserved for AudioGraph's rewire trigger on capture/release. The panel
   *  uses this one to react to videoId changes (which AudioGraph doesn't care
   *  about). */
  setOnVideoChange(fn: (() => void) | undefined): void {
    this.metaListener = fn;
  }

  get videoId(): string { return this._videoId; }
  get startSeconds(): number { return this._startSeconds; }
  get captureMode(): CaptureMode { return this._captureMode; }

  // Override release() to reset the capture-mode tracker.
  release(): void {
    super.release();
    this._captureMode = "none";
  }

  async capture(): Promise<void> {
    await super.capture();
    // super.capture() already fired onStateChange with _captureMode still
    // "none" — re-fire after we set the mode so the panel pill switches from
    // the "preview only" copy to the "● mirroring tab: …" state.
    if (this._capturing) {
      this._captureMode = "tab";
      this.onStateChange?.();
    }
  }

  /**
   * Auto-mirror the in-panel YouTube embed by capturing the patchNet tab
   * itself and cropping the resulting stream to the iframe's bounding box
   * via the Region Capture API (`CropTarget.fromElement` + `track.cropTo`).
   *
   * Pros vs. the standard manual capture flow:
   *  - One user gesture instead of two (no separate tab to open + pick).
   *  - The captured stream is bit-identical to the iframe pixels — `vFX.crt`
   *    et al. see exactly the YouTube video, no surrounding chrome.
   *
   * Cons (intentional):
   *  - **Video only.** Capturing tab audio would re-capture `dac~`'s output,
   *    creating an instant feedback loop. Audio routing through outlets 0/1
   *    stays exclusive to the manual `capture()` flow against a separate
   *    tab.
   *  - Chrome / Edge only — Firefox + Safari don't yet implement Region
   *    Capture (as of 2026-04). We feature-detect; no support → throw a
   *    helpful error so the panel can fall back to manual mirror.
   *  - One Chrome share-prompt is unavoidable. `getDisplayMedia` is
   *    user-gesture-gated by the platform; no API bypasses it.
   */
  async autoMirror(iframe: HTMLIFrameElement): Promise<void> {
    if (this._capturing) return;
    this._hasError = false;
    this._errorMessage = "";

    const w = window as unknown as {
      CropTarget?: { fromElement(el: Element): Promise<unknown> };
    };
    if (!w.CropTarget?.fromElement) {
      this._hasError = true;
      this._errorMessage = "Region Capture not supported in this browser — use 'mirror tab' instead";
      this.onStateChange?.();
      throw new Error("CropTarget API unavailable");
    }

    try {
      // Wait one frame so any in-flight layout (panel just attached, iframe
      // just toggled to display:block, etc.) has settled before we snapshot
      // the element for Region Capture. Without this, fromElement/cropTo can
      // resolve cleanly but reference a stale/empty bounding box, and the
      // captured stream silently falls back to the whole tab.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));

      const stream = await (navigator.mediaDevices as MediaDevices).getDisplayMedia({
        video: true,
        audio: false,
        // Bias the picker toward the current tab. Chrome will still show a
        // confirmation, but the tab is already pre-selected.
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions & { preferCurrentTab?: boolean });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error("no video track in captured stream");
      }

      const trackWithCrop = videoTrack as MediaStreamTrack & {
        cropTo(target: unknown): Promise<void>;
      };
      if (typeof trackWithCrop.cropTo !== "function") {
        stream.getTracks().forEach(t => t.stop());
        throw new Error("MediaStreamTrack.cropTo not supported");
      }

      // Build the CropTarget *after* getDisplayMedia resolves — in our
      // testing the inverse order (build CropTarget → prompt user → cropTo)
      // would silently fall back to whole-tab capture, presumably because
      // the cropTarget token went stale during the user-gesture interval.
      const cropTarget = await w.CropTarget.fromElement(iframe);
      await trackWithCrop.cropTo(cropTarget);

      // Hand the cropped stream off to the inherited stream-adoption path
      // — same wiring as capture() uses, just with no audio side.
      this.adoptStream(stream, this._videoId ? `youtube embed (${this._videoId})` : "youtube embed");

      // Defensive: re-apply cropTo after adoptStream wraps the track in a
      // fresh MediaStream. cropTo state is supposed to live on the track and
      // survive that wrapping, but re-applying is a cheap no-op when it does
      // and the safety net when it doesn't.
      await trackWithCrop.cropTo(cropTarget);

      this._captureMode = "auto";
      this.onStateChange?.();
    } catch (err) {
      console.warn("[YouTubeNode] autoMirror failed:", err);
      this._hasError = true;
      this._errorMessage = describeAutoMirrorError(err);
      this.onStateChange?.();
    }
  }
}

function describeAutoMirrorError(err: unknown): string {
  if (!(err instanceof Error)) return "auto-mirror failed";
  const name = (err as DOMException).name;
  switch (name) {
    case "NotAllowedError": return "permission denied (user dismissed share prompt)";
    case "NotFoundError":   return "no capturable source available";
    case "AbortError":      return "auto-mirror aborted";
    case "NotSupportedError": return "auto-mirror not supported in this browser";
    case "InvalidStateError": return "patchNet tab wasn't focused — keep this tab in front and try again";
    default: return err.message || "auto-mirror failed";
  }
}
