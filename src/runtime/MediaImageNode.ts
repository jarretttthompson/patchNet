/**
 * MediaImageNode — wraps an HTMLImageElement.
 *
 * Loaded images are stored as object URLs and drawn each frame by
 * LayerNode.draw() via ctx.drawImage().
 *
 * For large images, a pre-scaled display canvas is maintained so the render
 * loop doesn't have to downscale a 4000×3000 bitmap to a small canvas every
 * frame. ImageFXNode still receives the full-resolution HTMLImageElement for
 * pixel-accurate filter and bg-removal work.
 */
export class MediaImageNode {
  readonly image: HTMLImageElement;
  private objectUrl: string | null = null;
  private _displayCanvas: HTMLCanvasElement | null = null;

  // Fired after every successful load (file, URL, or IDB blob).
  onReady?: () => void;

  // Images larger than this in either dimension get a pre-scaled display copy.
  private static readonly MAX_DISPLAY_DIM = 1920;

  constructor() {
    this.image             = document.createElement("img");
    this.image.crossOrigin = "anonymous";
    this.image.style.display = "none";
    document.body.appendChild(this.image);
  }

  loadFile(file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      this.revokeUrl();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        this.objectUrl = dataUrl;
        this.image.src = dataUrl;
        this.image.onload = () => { this.buildDisplayCanvas(); resolve(); };
        this.image.onerror = () => reject(new Error("Image failed to load"));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  loadUrl(url: string): void {
    this.revokeUrl();
    this.image.src = url;
    this.image.addEventListener("load", () => { this.buildDisplayCanvas(); }, { once: true });
  }

  loadBlob(data: ArrayBuffer, mimeType: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.revokeUrl();
      const blob = new Blob([data], { type: mimeType });
      this.objectUrl = URL.createObjectURL(blob);
      this.image.src = this.objectUrl;
      this.image.onload  = () => { this.buildDisplayCanvas(); resolve(); };
      this.image.onerror = () => reject(new Error("Image blob failed to load"));
    });
  }

  get isReady(): boolean {
    return this.image.complete && this.image.naturalWidth > 0;
  }

  get url(): string | null { return this.objectUrl; }

  /**
   * The source to use for display rendering (LayerNode).
   * Returns a pre-scaled canvas for large images, otherwise the raw image.
   * ImageFXNode should use `.image` directly for full-resolution processing.
   */
  get displaySource(): HTMLCanvasElement | HTMLImageElement {
    return this._displayCanvas ?? this.image;
  }

  destroy(): void {
    this.revokeUrl();
    this.image.remove();
  }

  private revokeUrl(): void {
    if (this.objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = null;
    this._displayCanvas = null;
  }

  private buildDisplayCanvas(): void {
    const w = this.image.naturalWidth;
    const h = this.image.naturalHeight;
    const max = MediaImageNode.MAX_DISPLAY_DIM;
    if (w <= max && h <= max) {
      this._displayCanvas = null;
    } else {
      const scale = Math.min(max / w, max / h);
      const dw = Math.round(w * scale);
      const dh = Math.round(h * scale);
      const c  = document.createElement("canvas");
      c.width  = dw;
      c.height = dh;
      c.getContext("2d")!.drawImage(this.image, 0, 0, dw, dh);
      this._displayCanvas = c;
    }
    this.onReady?.();
  }
}
