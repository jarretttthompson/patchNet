import type { MediaImageNode } from "./MediaImageNode";

/**
 * ImageFXNode — applies CSS filter effects and optional flood-fill background
 * removal to a MediaImageNode, writing the result to an offscreen canvas.
 *
 * Signal path:  mediaImage → imageFX → layer
 *
 * Parameters map 1-to-1 to CSS filter functions and are stored in
 * patchNode.args so they survive re-renders and serialisation.
 *
 * Background removal is a runtime-only operation (not serialised):
 * the ImageFXPanel computes a processed ImageData (filters + flood-fill BG
 * removal) and hands it to setBgImageData(). process() then uses putImageData
 * directly instead of redrawing from the source image.
 */
export class ImageFXNode {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private inputNode: MediaImageNode | null = null;

  // ── Effect parameters ─────────────────────────────────────────────
  hue        = 0;    // −180 to +180 degrees
  saturation = 1.0;  // 0 to 3
  brightness = 1.0;  // 0 to 3
  contrast   = 1.0;  // 0 to 3
  blur       = 0;    // 0 to 20 px (Gaussian)
  invert     = 0;    // 0 to 1

  // ── Background removal ────────────────────────────────────────────
  // _bgImageData:  serialisation-only PNG round-trip source
  // _bgMaskCanvas: offscreen canvas whose alpha encodes the BG mask.
  //                Used with destination-in composite in process() to avoid
  //                getImageData GPU readbacks in the slider hot path.
  private _bgImageData:  ImageData | null = null;
  private _bgMaskCanvas: HTMLCanvasElement | null = null;

  // rAF throttle — coalesces rapid process() requests to one per frame
  private _rafPending = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx   = this.canvas.getContext("2d");
    if (!ctx) throw new Error("[ImageFXNode] 2D canvas context unavailable");
    this.ctx = ctx;
  }

  setInput(node: MediaImageNode | null): void {
    this.inputNode = node;
  }

  get isReady(): boolean {
    return this.canvas.width > 0 && (this.inputNode?.isReady ?? false);
  }

  /** The raw source image (used by ImageFXPanel for its own preview canvas). */
  get inputImage(): HTMLImageElement | null {
    return this.inputNode?.isReady ? this.inputNode.image : null;
  }

  get hasBgRemoved(): boolean { return this._bgMaskCanvas !== null; }

  // ── Processing ────────────────────────────────────────────────────

  /**
   * Re-render the offscreen canvas from the current input + parameters.
   * Always draws with the current CSS filters, then composites the BG mask
   * via destination-in (no getImageData readback — stays on the GPU).
   */
  process(): void {
    if (!this.inputNode?.isReady) return;
    const img = this.inputNode.image;
    const w   = img.naturalWidth;
    const h   = img.naturalHeight;
    if (w === 0 || h === 0) return;

    // Only reallocate GPU memory when dimensions change.
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width  = w;
      this.canvas.height = h;
    }

    this.ctx.clearRect(0, 0, w, h);
    this.ctx.filter = buildFilter(this);
    this.ctx.drawImage(img, 0, 0);
    this.ctx.filter = "none";

    // Apply BG mask using destination-in: keeps destination pixels where the
    // mask is opaque, removes them where the mask is transparent — no GPU
    // readback needed, unlike the getImageData approach.
    if (this._bgMaskCanvas) {
      this.ctx.globalCompositeOperation = "destination-in";
      this.ctx.drawImage(this._bgMaskCanvas, 0, 0);
      this.ctx.globalCompositeOperation = "source-over";
    }
  }

  /**
   * Schedule a process() call for the next animation frame, coalescing
   * multiple rapid requests (e.g. attribute slider drags) into one per frame.
   */
  scheduleProcess(): void {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this.process();
    });
  }

  /**
   * Store a pre-processed ImageData (filters + flood-fill BG removal baked in
   * by ImageFXPanel). Pass null to clear BG removal.
   */
  setBgImageData(data: ImageData | null): void {
    this._bgImageData = data;
    this._bgMaskCanvas = data ? ImageFXNode.buildMaskCanvas(data) : null;
    this.process();
  }

  /** Clear background removal and reprocess with CSS filters only. */
  clearBg(): void {
    this._bgImageData  = null;
    this._bgMaskCanvas = null;
    this.process();
  }

  /** Synchronously serialize current bg ImageData to a PNG data URL. */
  getBgDataUrl(): string | null {
    if (!this._bgImageData) return null;
    const tmp = document.createElement("canvas");
    tmp.width  = this._bgImageData.width;
    tmp.height = this._bgImageData.height;
    tmp.getContext("2d")!.putImageData(this._bgImageData, 0, 0);
    return tmp.toDataURL("image/png");
  }

  /** Restore bg ImageData from a PNG data URL. */
  setBgFromDataUrl(dataUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const tmp = document.createElement("canvas");
        tmp.width = w; tmp.height = h;
        const tmpCtx = tmp.getContext("2d")!;
        tmpCtx.drawImage(img, 0, 0);
        this._bgImageData  = tmpCtx.getImageData(0, 0, w, h);
        this._bgMaskCanvas = ImageFXNode.buildMaskCanvas(this._bgImageData);
        this.process();
        resolve();
      };
      img.onerror = () => reject(new Error("Failed to decode bg data URL"));
      img.src = dataUrl;
    });
  }

  destroy(): void {
    this.inputNode     = null;
    this._bgImageData  = null;
    this._bgMaskCanvas = null;
  }

  private static buildMaskCanvas(data: ImageData): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = data.width;
    c.height = data.height;
    c.getContext("2d")!.putImageData(data, 0, 0);
    return c;
  }
}

// ── Shared utilities (also used by ImageFXPanel for live preview) ─────

export function buildFilter(p: {
  blur: number;
  brightness: number;
  contrast: number;
  hue: number;
  saturation: number;
  invert: number;
}): string {
  const parts: string[] = [];
  if (p.blur       > 0  ) parts.push(`blur(${p.blur}px)`);
  if (p.brightness !== 1) parts.push(`brightness(${p.brightness})`);
  if (p.contrast   !== 1) parts.push(`contrast(${p.contrast})`);
  if (p.saturation !== 1) parts.push(`saturate(${p.saturation})`);
  if (p.invert     > 0  ) parts.push(`invert(${p.invert})`);
  if (p.hue        !== 0) parts.push(`hue-rotate(${p.hue}deg)`);
  return parts.length ? parts.join(" ") : "none";
}

/**
 * Flood-fill from a single seed pixel, making all connected similar-colored
 * pixels transparent. Uses per-channel tolerance (not squared Euclidean).
 */
export function floodFillTransparent(
  imageData: ImageData,
  startX: number,
  startY: number,
  tolerance: number,
): void {
  const w = imageData.width;
  const h = imageData.height;
  const d = imageData.data;
  const startIdx = (startY * w + startX) * 4;
  if (d[startIdx + 3] < 8) return; // already transparent — skip
  const sr = d[startIdx];
  const sg = d[startIdx + 1];
  const sb = d[startIdx + 2];

  const visited = new Uint8Array(w * h);
  const stack: [number, number][] = [[startX, startY]];

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const i = y * w + x;
    if (visited[i]) continue;
    const o = i * 4;
    if (d[o + 3] < 8) continue; // already transparent
    if (
      Math.abs(d[o]     - sr) > tolerance ||
      Math.abs(d[o + 1] - sg) > tolerance ||
      Math.abs(d[o + 2] - sb) > tolerance
    ) continue;
    visited[i] = 1;
    d[o + 3] = 0;
    if (x + 1 < w) stack.push([x + 1, y]);
    if (x - 1 >= 0) stack.push([x - 1, y]);
    if (y + 1 < h) stack.push([x, y + 1]);
    if (y - 1 >= 0) stack.push([x, y - 1]);
  }
}

/**
 * Remove background by flood-filling from every edge pixel.
 * Removes all contiguous regions connected to the image border.
 */
export function floodRemoveEdgeBg(imageData: ImageData, tolerance: number): void {
  const w = imageData.width;
  const h = imageData.height;
  for (let x = 0; x < w; x++) {
    floodFillTransparent(imageData, x, 0,     tolerance);
    floodFillTransparent(imageData, x, h - 1, tolerance);
  }
  for (let y = 0; y < h; y++) {
    floodFillTransparent(imageData, 0,     y, tolerance);
    floodFillTransparent(imageData, w - 1, y, tolerance);
  }
}
