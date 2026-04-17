/**
 * MediaImageNode — wraps an HTMLImageElement.
 *
 * Loaded images are stored as object URLs and drawn each frame by
 * LayerNode.draw() via ctx.drawImage().
 */
export class MediaImageNode {
  readonly image: HTMLImageElement;
  private objectUrl: string | null = null;

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
        this.image.onload = () => resolve();
        this.image.onerror = () => reject(new Error("Image failed to load"));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  loadUrl(url: string): void {
    this.revokeUrl();
    this.image.src = url;
  }

  loadBlob(data: ArrayBuffer, mimeType: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.revokeUrl();
      const blob = new Blob([data], { type: mimeType });
      this.objectUrl = URL.createObjectURL(blob);
      this.image.src = this.objectUrl;
      this.image.onload  = () => resolve();
      this.image.onerror = () => reject(new Error("Image blob failed to load"));
    });
  }

  get isReady(): boolean {
    return this.image.complete && this.image.naturalWidth > 0;
  }

  get url(): string | null { return this.objectUrl; }

  destroy(): void {
    this.revokeUrl();
    this.image.remove();
  }

  private revokeUrl(): void {
    if (this.objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = null;
  }
}
