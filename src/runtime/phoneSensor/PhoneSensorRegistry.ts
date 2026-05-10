import type { PatchGraph } from "../../graph/PatchGraph";
import type { PatchNode } from "../../graph/PatchNode";

/**
 * PhoneSensorRegistry — patch-scoped registry of `phoneTilt` runtime sessions.
 *
 * Each [phoneTilt] node opens a WebSocket to the dev server's
 * /__sensor/ws relay (see vite-plugin-phone-sensor.ts) as the "host" side
 * of a room. A phone scans the QR rendered on the node face, opens the
 * sensor page in its browser, and joins the same room as the "phone" side.
 * The relay forwards orientation samples from phone → host; this registry
 * smooths/throttles them and pushes pitch/roll/yaw/connected onto the
 * node's outlets via the registered emit callback.
 *
 * Lifecycle mirrors PeerRegistry: sync(graph) is called on every graph
 * "change" and reconciles sessions against live phoneTilt nodes.
 */

export type PhoneSensorEmit = (
  nodeId: string,
  outlet: number,
  value: string,
) => void;

const ARG_ROOM      = 0;
const ARG_SMOOTH    = 1;
const ARG_RATE      = 2;
const ARG_ZERO_P    = 3;
const ARG_ZERO_R    = 4;
const ARG_ZERO_Y    = 5;

interface RawSample { a: number; b: number; g: number }

function genRoomId(): string {
  // Six base36 chars — collision-resistant enough for "rooms in one dev
  // session", short enough to print under a QR if we ever want to.
  const rnd = Math.random().toString(36).slice(2, 8);
  return rnd.padEnd(6, "0");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

class PhoneSensorSession {
  private ws: WebSocket | null = null;
  private nodeId: string;
  private node: PatchNode;
  private emit: PhoneSensorEmit;
  private graph: PatchGraph;
  private destroyed = false;

  // Smoothed orientation, in degrees, post-calibration.
  private pitch = 0;
  private roll  = 0;
  private yaw   = 0;
  private hasSample = false;
  private connected = false;
  private lastEmitMs = 0;
  // Pending sample waiting for the rate gate to reopen.
  private pendingRaw: RawSample | null = null;
  private flushTimer: number | null = null;
  // Reconnect bookkeeping.
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;

  constructor(node: PatchNode, graph: PatchGraph, emit: PhoneSensorEmit) {
    this.node = node;
    this.nodeId = node.id;
    this.graph = graph;
    this.emit = emit;
    this.ensureRoomId();
    this.open();
  }

  /** Re-bind to the current PatchNode instance and re-read settings. The
   *  PatchNode reference is stable for a given id, but we refresh defensively
   *  so arg changes from the attribute panel take effect immediately. */
  syncFromNode(node: PatchNode): void {
    this.node = node;
    this.ensureRoomId();
  }

  /** Get the current room id (for the renderer to build the QR URL). */
  get roomId(): string {
    return this.node.args[ARG_ROOM] ?? "";
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Current smoothed orientation, post-calibration. UI panels poll this on
   *  rAF to render the live readout. Returns nulls if no sample yet. */
  getCurrent(): { pitch: number; roll: number; yaw: number; connected: boolean; hasSample: boolean } {
    return {
      pitch: this.pitch,
      roll: this.roll,
      yaw: wrapDeg360(this.yaw),
      connected: this.connected,
      hasSample: this.hasSample,
    };
  }

  /** Snapshot the most recent raw reading as the new zero point. */
  calibrate(): void {
    if (!this.hasSample) return;
    // Pull the *raw* (pre-calibration) reading by adding back current zeros.
    const rawP = this.pitch + (parseFloat(this.node.args[ARG_ZERO_P] ?? "0") || 0);
    const rawR = this.roll  + (parseFloat(this.node.args[ARG_ZERO_R] ?? "0") || 0);
    const rawY = this.yaw   + (parseFloat(this.node.args[ARG_ZERO_Y] ?? "0") || 0);
    this.node.args[ARG_ZERO_P] = String(rawP);
    this.node.args[ARG_ZERO_R] = String(rawR);
    // Yaw zero is stored modulo 360 — without this, calibrating after
    // several spins would bake the accumulated turns into the offset.
    this.node.args[ARG_ZERO_Y] = String(wrapDeg360(rawY));
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.flushNow();
    this.graph.emit("change");
  }

  resetCalibration(): void {
    this.node.args[ARG_ZERO_P] = "0";
    this.node.args[ARG_ZERO_R] = "0";
    this.node.args[ARG_ZERO_Y] = "0";
    this.graph.emit("change");
  }

  /** Re-emit the last known orientation regardless of rate gate. */
  bang(): void {
    if (!this.hasSample) return;
    this.emit(this.nodeId, 0, formatNum(this.pitch));
    this.emit(this.nodeId, 1, formatNum(this.roll));
    this.emit(this.nodeId, 2, formatNum(wrapDeg360(this.yaw)));
  }

  reconnect(): void {
    this.closeWs();
    this.reconnectAttempts = 0;
    this.open();
  }

  destroy(): void {
    this.destroyed = true;
    this.closeWs();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private ensureRoomId(): void {
    if (!this.node.args[ARG_ROOM] || !this.node.args[ARG_ROOM].trim()) {
      this.node.args[ARG_ROOM] = genRoomId();
      this.graph.emit("change");
    }
  }

  private open(): void {
    if (this.destroyed) return;
    if (this.ws) return;
    let url: string;
    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      url = `${proto}//${window.location.host}/__sensor/ws?room=${encodeURIComponent(this.roomId)}&role=host`;
    } catch {
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.onmessage = (ev) => this.onMessage(ev);
    socket.onclose = () => {
      this.ws = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };
    socket.onerror = () => { /* close handler will fire after */ };
    socket.onopen = () => {
      this.reconnectAttempts = 0;
      // We stay "disconnected" from the patch's POV until a phone joins;
      // the relay tells us via {kind:"phone-connected"}.
    };
  }

  private closeWs(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.setConnected(false);
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer !== null) return;
    // Linear backoff capped at 5s — the dev server going down is a normal
    // occurrence (Vite restart) and we want to recover quickly.
    const delay = Math.min(500 + this.reconnectAttempts * 500, 5000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private onMessage(ev: MessageEvent): void {
    let data: unknown;
    try {
      data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    const obj = data as Record<string, unknown>;
    if (obj.kind === "phone-connected")    { this.setConnected(true);  return; }
    if (obj.kind === "phone-disconnected") { this.setConnected(false); return; }

    const a = typeof obj.a === "number" ? obj.a : null;
    const b = typeof obj.b === "number" ? obj.b : null;
    const g = typeof obj.g === "number" ? obj.g : null;
    if (a === null || b === null || g === null) return;
    this.pendingRaw = { a, b, g };
    this.tryFlush();
  }

  private setConnected(state: boolean): void {
    if (this.connected === state) return;
    this.connected = state;
    this.emit(this.nodeId, 3, state ? "1" : "0");
  }

  private rateMs(): number {
    const hz = clamp(parseInt(this.node.args[ARG_RATE] ?? "60", 10) || 60, 1, 240);
    return 1000 / hz;
  }

  private smoothK(): number {
    return clamp(parseFloat(this.node.args[ARG_SMOOTH] ?? "0.2") || 0, 0, 0.99);
  }

  private tryFlush(): void {
    const now = performance.now();
    const gap = this.rateMs();
    const elapsed = now - this.lastEmitMs;
    if (elapsed >= gap) {
      this.flushNow();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => {
        this.flushTimer = null;
        this.flushNow();
      }, gap - elapsed);
    }
  }

  private flushNow(): void {
    if (!this.pendingRaw) return;
    const k = this.smoothK();
    const zeroP = parseFloat(this.node.args[ARG_ZERO_P] ?? "0") || 0;
    const zeroR = parseFloat(this.node.args[ARG_ZERO_R] ?? "0") || 0;
    const zeroY = parseFloat(this.node.args[ARG_ZERO_Y] ?? "0") || 0;
    const targetPitch = this.pendingRaw.b - zeroP;
    const targetRoll  = this.pendingRaw.g - zeroR;
    // Yaw wraps at 0/360 — smooth via the unwrapped delta so going across
    // the seam doesn't sweep through the long way around.
    const rawYaw = this.pendingRaw.a - zeroY;
    const targetYaw = unwrapDeg(this.yaw, rawYaw);
    if (!this.hasSample) {
      this.pitch = targetPitch;
      this.roll  = targetRoll;
      this.yaw   = targetYaw;
      this.hasSample = true;
    } else {
      this.pitch = lerp(targetPitch, this.pitch, k);
      this.roll  = lerp(targetRoll,  this.roll,  k);
      this.yaw   = lerp(targetYaw,   this.yaw,   k);
    }
    this.pendingRaw = null;
    this.lastEmitMs = performance.now();
    this.emit(this.nodeId, 0, formatNum(this.pitch));
    this.emit(this.nodeId, 1, formatNum(this.roll));
    // `this.yaw` is kept unwrapped so seam-crossing smoothing works; the
    // outlet is wrapped to the documented 0–360° range.
    this.emit(this.nodeId, 2, formatNum(wrapDeg360(this.yaw)));
  }
}

function lerp(target: number, current: number, smoothK: number): number {
  // smoothK = 0 → snap to target; smoothK = 0.99 → barely move.
  return current * smoothK + target * (1 - smoothK);
}

function wrapDeg360(n: number): number {
  // Bring any real value into [0, 360). Used at the outlet boundary so a
  // continuously-spinning phone reports yaw within the documented range.
  return ((n % 360) + 360) % 360;
}

function unwrapDeg(prev: number, target: number): number {
  // Bring `target` into the half-turn around `prev` so smoothing won't
  // sweep across the 0/360 seam.
  let t = target;
  while (t - prev >  180) t -= 360;
  while (t - prev < -180) t += 360;
  return t;
}

function formatNum(n: number): string {
  // Outlet payloads are strings; trim to 3 decimals to keep the patch panel
  // from getting noisy with float jitter.
  return n.toFixed(3);
}

export class PhoneSensorRegistry {
  private sessions = new Map<string, PhoneSensorSession>();
  private emit: PhoneSensorEmit | null = null;

  setEmit(fn: PhoneSensorEmit | null): void {
    this.emit = fn;
  }

  /** Reconcile sessions against live phoneTilt nodes. */
  sync(graph: PatchGraph): void {
    if (!this.emit) return;
    const live = new Set<string>();
    for (const node of graph.getNodes()) {
      if (node.type !== "phoneTilt") continue;
      live.add(node.id);
      const existing = this.sessions.get(node.id);
      if (existing) {
        existing.syncFromNode(node);
      } else {
        this.sessions.set(node.id, new PhoneSensorSession(node, graph, this.emit));
      }
    }
    for (const id of Array.from(this.sessions.keys())) {
      if (!live.has(id)) {
        this.sessions.get(id)?.destroy();
        this.sessions.delete(id);
      }
    }
  }

  getSession(nodeId: string): PhoneSensorSession | null {
    return this.sessions.get(nodeId) ?? null;
  }

  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.sessions.get(id)?.destroy();
    }
    this.sessions.clear();
  }
}

export type { PhoneSensorSession };
