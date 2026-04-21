import type { DownstreamMessage, UpstreamMessage } from "./ControlMessage";
import type { IRenderer } from "./IRenderer";

/**
 * IControlBus — transport-agnostic bus interface.
 *
 * Phase 1 ships one implementation: `LocalBus` (direct dispatch, same JS
 * context). Phase 2 will add `BroadcastChannelBus`; Phase 5, `WebSocketBus`.
 * All implementations honor the same contract so swapping the transport
 * is a one-line change in `main.ts`.
 *
 * `rendererId` is opaque to the bus — the caller chooses the namespace.
 * Phase 1 uses `patchNodeId`. Phase 4 may switch to `contextName` once
 * shared-context routing is unified.
 */
export interface IControlBus {
  /** Register a renderer so publishDown can target it. */
  attach(rendererId: string, renderer: IRenderer): void;
  detach(rendererId: string): void;
  hasRenderer(rendererId: string): boolean;

  /** Send a message to the renderer bound to `rendererId`. */
  publishDown(rendererId: string, msg: DownstreamMessage): void;

  /** Renderer-side — called by a renderer when it has upstream state. */
  publishUp(msg: UpstreamMessage): void;

  /** Controller-side subscription to upstream messages. */
  onUpstream(handler: (msg: UpstreamMessage) => void): () => void;

  destroy(): void;
}

/**
 * LocalBus — direct in-process dispatch.
 *
 * Calls `renderer.apply(msg)` synchronously. Upstream messages fan out to
 * all subscribers. No batching, no seq tracking — that is Phase 2+ work
 * when the transport becomes async.
 */
export class LocalBus implements IControlBus {
  private renderers    = new Map<string, IRenderer>();
  private upstreamSubs = new Set<(msg: UpstreamMessage) => void>();

  attach(rendererId: string, renderer: IRenderer): void {
    this.renderers.set(rendererId, renderer);
    renderer.onUpstream = (msg) => this.publishUp(msg);
  }

  detach(rendererId: string): void {
    const r = this.renderers.get(rendererId);
    if (r) r.onUpstream = undefined;
    this.renderers.delete(rendererId);
  }

  hasRenderer(rendererId: string): boolean {
    return this.renderers.has(rendererId);
  }

  publishDown(rendererId: string, msg: DownstreamMessage): void {
    const r = this.renderers.get(rendererId);
    if (!r) return;
    r.apply(msg);
  }

  publishUp(msg: UpstreamMessage): void {
    for (const sub of this.upstreamSubs) sub(msg);
  }

  onUpstream(handler: (msg: UpstreamMessage) => void): () => void {
    this.upstreamSubs.add(handler);
    return () => this.upstreamSubs.delete(handler);
  }

  destroy(): void {
    for (const r of this.renderers.values()) r.onUpstream = undefined;
    this.renderers.clear();
    this.upstreamSubs.clear();
  }
}
