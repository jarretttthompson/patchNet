/**
 * ControlMessage — v1 control-plane message types.
 *
 * Phase 1 of the control/render split (docs/CONTROL_RENDER_SPLIT.md).
 * These types describe *what* the renderer should do, never how.
 * A `ControlBus` transports them; an `IRenderer` applies them.
 *
 * Versioned so a BroadcastChannel or WebSocket transport in Phase 2+
 * can round-trip the same shapes as JSON.
 */

export const CONTROL_PROTOCOL_VERSION = 1;

// ── Scene graph messages ─────────────────────────────────────────────

export interface SceneAdd {
  t: "SceneAdd";
  id: string;
  kind: "layer" | "fx" | "media";
  priority?: number;
}

export interface SceneRemove {
  t: "SceneRemove";
  id: string;
}

export interface SceneWire {
  t: "SceneWire";
  layerId: string;
  source:
    | { kind: "mediaVideo" | "mediaImage" | "imageFX" | "vfxCRT" | "vfxBlur"; id: string }
    | null;
}

// ── Parameter / command / trigger ────────────────────────────────────

export interface ParamUpdate {
  t: "ParamUpdate";
  id: string;
  params: Record<string, number | string | boolean>;
}

export interface Command {
  t: "Command";
  id: string;
  cmd: string;
  args?: (number | string | boolean)[];
}

export interface Trigger {
  t: "Trigger";
  id: string;
  event: string;
}

// ── Transport / timing ──────────────────────────────────────────────

export interface Tick {
  t: "Tick";
  ts: number;
  beat?: number;
}

export interface ScenePreset {
  t: "ScenePreset";
  name: string;
  state: Record<string, unknown>;
}

// ── Upstream (renderer → controller) ────────────────────────────────

export interface StatusMessage {
  t: "Status";
  id: string;
  state: Record<string, number | string | boolean>;
}

export interface Telemetry {
  t: "Telemetry";
  id: string;
  fps: number;
  droppedFrames?: number;
}

export interface ErrorMessage {
  t: "Error";
  id: string;
  code: string;
  msg: string;
}

export interface Heartbeat {
  t: "Heartbeat";
  ts: number;
}

// ── Unions ──────────────────────────────────────────────────────────

export type DownstreamMessage =
  | SceneAdd
  | SceneRemove
  | SceneWire
  | ParamUpdate
  | Command
  | Trigger
  | Tick
  | ScenePreset;

export type UpstreamMessage =
  | StatusMessage
  | Telemetry
  | ErrorMessage
  | Heartbeat;

export type ControlMessage = DownstreamMessage | UpstreamMessage;

/**
 * Transport envelope. Single-context batches coalesce a frame's worth
 * of messages; v1 local dispatch can pass an unwrapped array.
 */
export interface ControlEnvelope<M extends ControlMessage = ControlMessage> {
  v: number;
  contextName: string;
  seq: number;
  messages: M[];
}
