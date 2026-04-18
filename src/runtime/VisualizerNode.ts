import type { LayerNode } from "./LayerNode";
import type { IRenderContext } from "./IRenderContext";

/**
 * VisualizerNode — manages one named popup render window.
 *
 * Opened by the visualizer patchNet object on bang.
 * Runs its own requestAnimationFrame loop that composites
 * registered LayerNodes sorted by priority each frame.
 *
 * Priority semantics: lower number = drawn first (background).
 *                     Higher number = drawn last (foreground / on top).
 */
export class VisualizerNode implements IRenderContext {
  private popup: Window | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private layers: LayerNode[] = [];

  private positionPollId: number | null = null;
  private _lastScreenX = 0;
  private _lastScreenY = 0;

  /** Fired when the popup successfully opens. */
  onOpen?: () => void;
  /** Fired when the popup is closed. */
  onClose?: () => void;
  /** Fired when the popup is resized — args are new inner width/height. */
  onResize?: (w: number, h: number) => void;
  /** Fired when the popup is moved — args are new screen x/y. */
  onMove?: (x: number, y: number) => void;

  /**
   * When true, the popup is brought to the front each time the main
   * patchNet window gains focus — the closest a browser can get to
   * an always-on-top / floating window within OS window management.
   */
  private _floating = false;
  private _focusHandler: (() => void) | null = null;

  constructor(
    public readonly name: string,
    private width = 640,
    private height = 480,
  ) {}

  /** Open the popup window and start the render loop. */
  open(): void {
    if (this.popup && !this.popup.closed) {
      this.popup.focus();
      return;
    }

    const features = [
      `width=${this.width}`,
      `height=${this.height}`,
      "resizable=yes",
      "scrollbars=no",
      "toolbar=no",
      "menubar=no",
      "location=no",
      "status=no",
    ].join(",");

    this.popup = window.open("", `patchNet_${this.name}`, features);
    if (!this.popup) {
      console.warn(
        `[VisualizerNode] Popup blocked for context "${this.name}". ` +
        `Trigger bang directly from a user gesture (button click), not from metro.`
      );
      return;
    }
    this.popup.focus();

    const doc = this.popup.document;
    // Reset the document so any canvas/content from a previous session is gone.
    // This handles the case where window.open() returns an existing popup without
    // navigating it, leaving stale DOM that would stack on top of our new canvas.
    doc.open();
    doc.close();
    doc.title = `patchNet — ${this.name}`;
    doc.documentElement.style.cssText = "height:100%;background:#000;";
    doc.body.style.cssText = "margin:0;width:100%;height:100%;background:#000;overflow:hidden;";

    this.canvas = doc.createElement("canvas");
    this.canvas.width  = this.width;
    this.canvas.height = this.height;
    this.canvas.style.cssText = "display:block;width:100%;height:100%;";
    doc.body.appendChild(this.canvas);

    this.ctx = this.canvas.getContext("2d");

    this.popup.addEventListener("resize", () => {
      if (!this.popup || !this.canvas) return;
      this.width  = this.popup.innerWidth;
      this.height = this.popup.innerHeight;
      this.canvas.width  = this.width;
      this.canvas.height = this.height;
      this.onResize?.(this.width, this.height);
    });

    this.popup.addEventListener("beforeunload", () => {
      this.stopPositionPoll();
      // Capture final position before the popup reference goes stale
      if (this.popup) this.onMove?.(this.popup.screenX, this.popup.screenY);
      this.stopLoop();
      this.popup  = null;
      this.canvas = null;
      this.ctx    = null;
      this.onClose?.();
    });

    this.startLoop();
    this._lastScreenX = this.popup.screenX;
    this._lastScreenY = this.popup.screenY;
    this.startPositionPoll();
    this.onOpen?.();
  }

  /** Hide (close) the popup window. */
  close(): void {
    this.stopPositionPoll();
    if (this.popup && !this.popup.closed) this.onMove?.(this.popup.screenX, this.popup.screenY);
    this.onClose?.();
    this.stopLoop();
    this.popup?.close();
    this.popup  = null;
    this.canvas = null;
    this.ctx    = null;
    // Keep float setting intact so re-opening re-applies it,
    // but the focus handler stays registered — no popup to focus is harmless.
  }

  moveTo(x: number, y: number): void { this.popup?.moveTo(x, y); }

  /** Set dimensions before open() so the popup is created at the right size. */
  setDimensions(w: number, h: number): void {
    this.width  = w;
    this.height = h;
  }

  resizeTo(w: number, h: number): void {
    this.width  = w;
    this.height = h;
    this.popup?.resizeTo(w, h);
    if (this.canvas) {
      this.canvas.width  = w;
      this.canvas.height = h;
    }
  }

  isOpen(): boolean {
    return !!this.popup && !this.popup.closed;
  }

  /**
   * Enable or disable floating mode.
   *
   * While enabled, a `focus` listener on the main window calls
   * `popup.focus()` whenever the user returns to the patchNet tab,
   * keeping the visualizer popup in front of the patchNet window.
   */
  setFloat(enabled: boolean): void {
    this._floating = enabled;

    // Tear down any existing listener
    if (this._focusHandler) {
      window.removeEventListener("focus", this._focusHandler);
      this._focusHandler = null;
    }

    if (enabled) {
      this._focusHandler = () => {
        if (this.popup && !this.popup.closed) {
          // Small delay so the main window finishes activating before
          // we transfer focus to the popup — avoids focus ping-pong.
          setTimeout(() => this.popup?.focus(), 80);
        }
      };
      window.addEventListener("focus", this._focusHandler);
    }
  }

  get floating(): boolean { return this._floating; }

  // ── Layer management ─────────────────────────────────────────────

  addLayer(layer: LayerNode): void {
    if (!this.layers.includes(layer)) this.layers.push(layer);
  }

  removeLayer(layer: LayerNode): void {
    this.layers = this.layers.filter(l => l !== layer);
  }

  clearLayers(): void {
    this.layers = [];
  }

  // ── Render loop ──────────────────────────────────────────────────

  private startLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      if (!this.popup || this.popup.closed) { this.rafId = null; return; }
      this.drawFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private drawFrame(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    // Sort: lower priority number = drawn first (background), higher = drawn last (foreground/on top)
    const sorted = [...this.layers].sort((a, b) => a.priority - b.priority);
    for (const layer of sorted) {
      layer.draw(ctx, this.width, this.height);
    }
  }

  // ── Position polling ─────────────────────────────────────────────

  private startPositionPoll(): void {
    const poll = () => {
      if (!this.popup || this.popup.closed) { this.positionPollId = null; return; }
      const x = this.popup.screenX;
      const y = this.popup.screenY;
      if (x !== this._lastScreenX || y !== this._lastScreenY) {
        this._lastScreenX = x;
        this._lastScreenY = y;
        this.onMove?.(x, y);
      }
      this.positionPollId = requestAnimationFrame(poll);
    };
    this.positionPollId = requestAnimationFrame(poll);
  }

  private stopPositionPoll(): void {
    if (this.positionPollId !== null) {
      cancelAnimationFrame(this.positionPollId);
      this.positionPollId = null;
    }
  }

  /** Exposes the popup canvas so patchViz nodes can drawImage() from it. */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  destroy(): void {
    this.setFloat(false); // remove focus listener
    this.close();
    this.layers = [];
  }
}
