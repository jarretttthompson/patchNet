import { VisualizerRuntime } from "./VisualizerRuntime";

/**
 * PatchVizNode — live in-patch mirror of a named VisualizerNode context.
 *
 * Owns a <canvas> that copies the visualizer popup canvas every frame via
 * drawImage(). Mount this canvas into the patchViz object DOM slot after
 * each render pass (same pattern as CodeboxController).
 *
 * If the named visualizer is closed / not open, the canvas shows black.
 */
export class PatchVizNode {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private rafId: number | null = null;
  private _contextName: string;

  constructor(contextName: string) {
    this._contextName = contextName;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "pn-patchviz-canvas";
    this.canvas.width  = 320;
    this.canvas.height = 240;
    Object.assign(this.canvas.style, {
      display: "block",
      width:   "100%",
      height:  "100%",
    });

    this.ctx = this.canvas.getContext("2d")!;
    this.startLoop();
  }

  set contextName(name: string) { this._contextName = name; }
  get contextName(): string     { return this._contextName; }

  private startLoop(): void {
    if (this.rafId !== null) return;
    const runtime = VisualizerRuntime.getInstance();

    const tick = () => {
      this.rafId = requestAnimationFrame(tick);

      const vn  = runtime.get(this._contextName);
      const src = vn?.getCanvas() ?? null;

      if (!src || src.width === 0 || src.height === 0) {
        this.ctx.fillStyle = "#000";
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        return;
      }

      // Match internal resolution to source so drawImage is pixel-accurate
      if (this.canvas.width !== src.width || this.canvas.height !== src.height) {
        this.canvas.width  = src.width;
        this.canvas.height = src.height;
      }

      try {
        this.ctx.drawImage(src, 0, 0);
      } catch {
        // Popup was closed mid-frame — ignore tainted/detached canvas errors
      }
    };

    this.rafId = requestAnimationFrame(tick);
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.canvas.remove();
  }
}
