import type { LayerNode } from "./LayerNode";
import type { IRenderContext } from "./IRenderContext";
import type { IRenderer } from "../control/IRenderer";
import type { DownstreamMessage, UpstreamMessage } from "../control/ControlMessage";

/**
 * PatchVizNode — inline render context that lives inside a patchViz object.
 *
 * Unlike VisualizerNode (popup), this composites layers directly into an
 * embedded <canvas> in the patch canvas DOM. Layers target it by context
 * name, the same way they target a popup VisualizerNode.
 *
 * The render loop starts automatically and runs continuously so the canvas
 * stays live as soon as layers are wired in.
 *
 * Implements IRenderer (Phase 1 of control/render split) as a forwarder
 * over its existing methods. Phase 2 migrates this to a dedicated
 * `CanvasRenderer` class and drops direct method access in favor of
 * ControlMessages only.
 */
export class PatchVizNode implements IRenderContext, IRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private rafId: number | null = null;
  private layers: LayerNode[] = [];
  private _contextName: string;
  private _enabled = true;

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
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, 320, 240);

    this.startLoop();
  }

  set contextName(name: string) { this._contextName = name; }
  get contextName(): string     { return this._contextName; }

  get rendererId(): string { return this._contextName; }

  // ── IRenderer ─────────────────────────────────────────────────────

  onUpstream?: (msg: UpstreamMessage) => void;

  apply(msg: DownstreamMessage): void {
    switch (msg.t) {
      case "Command":
        switch (msg.cmd) {
          case "enable":  this.enable();  break;
          case "disable": this.disable(); break;
          case "toggle":  this.toggle();  break;
        }
        break;
      case "Trigger":
        if (msg.event === "bang") this.toggle();
        break;
      default:
        // Scene* / ParamUpdate / Tick / ScenePreset — Phase 2+ will wire these
        break;
    }
  }

  enable(): void  { this._enabled = true; }
  disable(): void { this._enabled = false; }
  toggle(): void  { this._enabled = !this._enabled; }
  get enabled(): boolean { return this._enabled; }

  // ── IRenderContext ────────────────────────────────────────────────

  addLayer(layer: LayerNode): void {
    if (!this.layers.includes(layer)) this.layers.push(layer);
  }

  removeLayer(layer: LayerNode): void {
    this.layers = this.layers.filter(l => l !== layer);
  }

  clearLayers(): void {
    this.layers = [];
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  // ── Render loop ───────────────────────────────────────────────────

  private startLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.drawFrame();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private drawFrame(): void {
    const { ctx, canvas } = this;
    if (!this._enabled) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sorted = [...this.layers].sort((a, b) => a.priority - b.priority);
    for (const layer of sorted) {
      layer.draw(ctx, canvas.width, canvas.height);
    }
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.layers = [];
    this.canvas.remove();
  }
}
