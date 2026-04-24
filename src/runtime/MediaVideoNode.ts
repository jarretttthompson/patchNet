/** Narrow shape consumed by LayerNode / vFX nodes. Satisfied by
 *  MediaVideoNode and also by BrowserNode (captured-tab video). */
export interface MediaVideoSource {
  readonly video: HTMLVideoElement;
  readonly isReady: boolean;
  readonly hasError: boolean;
}

/**
 * MediaVideoNode — wraps an HTMLVideoElement.
 *
 * The element lives in the main document (not the popup).
 * LayerNode.draw() reads it via ctx.drawImage() each rAF frame.
 * File data is stored in IndexedDB via VideoStore; only a tiny reference key
 * lives in patchNode.args so the graph serialization stays small and fast.
 */
export class MediaVideoNode implements MediaVideoSource {
  readonly video: HTMLVideoElement;
  private objectUrl: string | null = null;
  private loading = false;
  private loadError = false;

  onPlay?:  () => void;
  onPause?: () => void;
  onEnded?: () => void;

  constructor() {
    this.video             = document.createElement("video");
    this.video.loop        = true;
    this.video.muted       = true;   // muted allows autoplay without user-gesture restriction
    this.video.preload     = "auto";
    this.video.crossOrigin = "anonymous";
    this.video.style.display = "none";
    document.body.appendChild(this.video);

    this.video.addEventListener("play",  () => this.onPlay?.());
    this.video.addEventListener("pause", () => this.onPause?.());
    this.video.addEventListener("ended", () => this.onEnded?.());
    this.video.addEventListener("loadeddata", () => {
      this.loading = false;
      this.loadError = false;
    });
    this.video.addEventListener("canplay", () => {
      this.loading = false;
      this.loadError = false;
    });
    this.video.addEventListener("error", () => {
      this.loading = false;
      this.loadError = true;
    });
    this.video.addEventListener("emptied", () => {
      this.loading = false;
    });
  }

  loadFile(file: File): void {
    this.revokeUrl();
    this.loading = true;
    this.loadError = false;
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.video.load();
  }

  loadBlob(data: ArrayBuffer, mimeType = "video/mp4"): void {
    this.revokeUrl();
    this.loading = true;
    this.loadError = false;
    const blob = new Blob([data], { type: mimeType });
    this.objectUrl = URL.createObjectURL(blob);
    this.video.src = this.objectUrl;
    this.video.load();
  }

  loadUrl(url: string): void {
    this.revokeUrl();
    this.loading = true;
    this.loadError = false;
    this.video.src = url;
    this.video.load();
  }

  play():   void { this.video.play().catch(() => {}); }
  pause():  void { this.video.pause(); }
  mute():   void { this.video.muted = true; }
  unmute(): void { this.video.muted = false; }

  /** Pause and return to the start — matches patch `stop` message semantics. */
  stop(): void {
    this.video.pause();
    this.video.currentTime = 0;
  }

  togglePlay(): void {
    this.video.paused ? this.play() : this.pause();
  }

  seek(normalized: number): void {
    if (!isFinite(this.video.duration)) return;
    this.video.currentTime = Math.max(0, Math.min(1, normalized)) * this.video.duration;
  }

  setLoop(on: boolean): void { this.video.loop = on; }

  get position(): number {
    return this.video.duration ? this.video.currentTime / this.video.duration : 0;
  }

  get isReady(): boolean {
    return this.video.readyState >= 2; // HAVE_CURRENT_DATA
  }

  get isLoading(): boolean {
    return this.loading && !this.isReady;
  }

  get hasError(): boolean {
    return this.loadError;
  }

  get url(): string | null { return this.objectUrl; }

  destroy(): void {
    this.video.pause();
    this.revokeUrl();
    this.video.remove();
  }

  private revokeUrl(): void {
    if (this.objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = null;
  }
}
