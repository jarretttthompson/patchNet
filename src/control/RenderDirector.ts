import type { PatchGraph } from "../graph/PatchGraph";
import type { IControlBus } from "./ControlBus";
import type { IRenderer } from "./IRenderer";
import type {
  Command,
  ParamUpdate,
  Trigger,
  UpstreamMessage,
} from "./ControlMessage";

/**
 * RenderDirector — translates patch-side events into ControlMessages
 * and publishes them on the ControlBus.
 *
 * Phase 1 exposes three primitives (`command`, `param`, `trigger`) and
 * subscribes to upstream status — that is the surface Phase 2 needs to
 * migrate the remaining deliver* paths off VisualizerGraph. No direct
 * renderer access goes through here; the bus is the seam.
 */
export class RenderDirector {
  private unsubscribeUp: () => void;

  constructor(
    readonly graph: PatchGraph,
    readonly bus: IControlBus,
  ) {
    this.unsubscribeUp = bus.onUpstream((msg) => this.handleUpstream(msg));
  }

  // ── Renderer registration ────────────────────────────────────────

  attach(rendererId: string, renderer: IRenderer): void {
    this.bus.attach(rendererId, renderer);
  }

  detach(rendererId: string): void {
    this.bus.detach(rendererId);
  }

  hasRenderer(rendererId: string): boolean {
    return this.bus.hasRenderer(rendererId);
  }

  // ── Downstream primitives ────────────────────────────────────────

  command(rendererId: string, cmd: string, args?: (number | string | boolean)[]): void {
    const msg: Command = { t: "Command", id: rendererId, cmd, ...(args ? { args } : {}) };
    this.bus.publishDown(rendererId, msg);
  }

  param(rendererId: string, params: Record<string, number | string | boolean>): void {
    const msg: ParamUpdate = { t: "ParamUpdate", id: rendererId, params };
    this.bus.publishDown(rendererId, msg);
  }

  trigger(rendererId: string, event: string): void {
    const msg: Trigger = { t: "Trigger", id: rendererId, event };
    this.bus.publishDown(rendererId, msg);
  }

  // ── Upstream handling ────────────────────────────────────────────

  /**
   * Status messages from renderers are mirrored into PatchGraph args
   * the same way the old onResize/onMove closures did. Phase 1 leaves
   * per-renderer args wiring in VisualizerGraph; this hook is where
   * Phase 2 moves it.
   */
  private handleUpstream(_msg: UpstreamMessage): void {
    // Placeholder — Phase 1 keeps args mirroring in VisualizerGraph's
    // own callback closures. Reserved for Phase 2 migration.
  }

  destroy(): void {
    this.unsubscribeUp();
  }
}
