import type { IRenderContext } from "../runtime/IRenderContext";
import type { DownstreamMessage, UpstreamMessage } from "./ControlMessage";

/**
 * IRenderer — v1 pluggable render surface.
 *
 * Phase 1 extends IRenderContext (layer management + canvas access) with
 * a single downstream entry point (`apply`) and an optional upstream
 * status callback. Existing renderers (VisualizerNode, PatchVizNode)
 * implement this as a forwarder over their existing methods.
 *
 * Phase 2+ swap the concrete classes for dedicated PopupRenderer /
 * CanvasRenderer that stop exposing their window/DOM methods directly.
 */
export interface IRenderer extends IRenderContext {
  /** Stable id for this renderer (usually the `contextName`). */
  readonly rendererId: string;

  /** Apply a single downstream control message. */
  apply(msg: DownstreamMessage): void;

  /**
   * Optional upstream hook — renderers call this when they have
   * Status/Telemetry/Error to report. The ControlBus installs the
   * callback; renderers never subscribe to their own output.
   */
  onUpstream?: (msg: UpstreamMessage) => void;
}
