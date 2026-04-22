import type {
  DmxTransport,
  TransportEvent,
  TransportInfo,
  TransportListener,
  TransportState,
} from "./DmxTransport";

// ── Minimal Web Serial types (lib.dom.d.ts coverage varies) ──────────────────

interface WSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface WSerialOpenOptions {
  baudRate: number;
  dataBits?: 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  flowControl?: "none" | "hardware";
}
interface WSerialPort {
  readonly writable: WritableStream<Uint8Array> | null;
  readonly readable: ReadableStream<Uint8Array> | null;
  open(options: WSerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): WSerialPortInfo;
  addEventListener(type: "connect" | "disconnect", listener: () => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: () => void): void;
}
interface WSerial {
  requestPort(options?: { filters?: WSerialPortInfo[] }): Promise<WSerialPort>;
  getPorts(): Promise<WSerialPort[]>;
  addEventListener(type: "connect" | "disconnect", listener: (e: Event) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (e: Event) => void): void;
}

function getSerial(): WSerial | null {
  const s = (navigator as unknown as { serial?: WSerial }).serial;
  return s ?? null;
}

// ── ENTTEC Pro framing ────────────────────────────────────────────────────────

const SOM = 0x7e;
const EOM = 0xe7;
const LABEL_SEND_DMX = 0x06;
const START_CODE = 0x00;

const HEADER_SIZE = 4; // SOM + label + lenLSB + lenMSB
const FOOTER_SIZE = 1; // EOM

/**
 * Encodes a frame for the "Output Only Send DMX Packet Request" (label 6).
 * Wire layout:
 *   [SOM][label][lenLSB][lenMSB][startCode][ch1..chN][EOM]
 * The length field covers the data block only — i.e. startCode + channels.
 * For a 512-channel universe the full frame is 4 + 513 + 1 = 518 bytes.
 */
function encodeDmxFrame(channels: Uint8Array): Uint8Array {
  const dataLen = 1 + channels.length; // startCode + channels
  const frame = new Uint8Array(HEADER_SIZE + dataLen + FOOTER_SIZE);
  frame[0] = SOM;
  frame[1] = LABEL_SEND_DMX;
  frame[2] = dataLen & 0xff;
  frame[3] = (dataLen >> 8) & 0xff;
  frame[4] = START_CODE;
  frame.set(channels, HEADER_SIZE + 1);
  frame[frame.length - 1] = EOM;
  return frame;
}

// ── Transport ─────────────────────────────────────────────────────────────────

/**
 * ENTTEC DMX USB PRO host-side baud rate. The widget's FT245 chip clocks the
 * DMX wire at 250 kbps internally; host-side baud should match to minimise
 * API-frame jitter. OLA and most working open-source drivers use 250000.
 * Older libs and some tutorials use 57600 — that value *opens* and accepts
 * API frames but produces unreliable DMX on the wire.
 */
const DEFAULT_BAUD = 250000;

export interface EnttecProTransportOptions {
  /** Serial baud rate. Most ENTTEC Pro units accept 57600 happily. */
  baudRate?: number;
}

const RECONNECT_INTERVAL_MS = 2000;
const RECONNECT_TIMEOUT_MS  = 30_000;

export class EnttecProTransport implements DmxTransport {
  private readonly baudRate: number;
  private port: WSerialPort | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private info: TransportInfo | null = null;
  private state: TransportState = "idle";
  private rateHz = 40;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private getFrame: (() => Uint8Array) | null = null;
  private readonly listeners = new Set<TransportListener>();
  private onPortDisconnect = () => this.handleDisconnected();
  private framesSent = 0;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectStart = 0;
  private reconnecting = false;

  constructor(options: EnttecProTransportOptions = {}) {
    this.baudRate = options.baudRate ?? DEFAULT_BAUD;
  }

  getBaudRate(): number {
    return this.baudRate;
  }

  getFramesSent(): number {
    return this.framesSent;
  }

  isSupported(): boolean {
    return getSerial() !== null;
  }

  async requestDevice(): Promise<TransportInfo | null> {
    const serial = getSerial();
    if (!serial) return null;
    try {
      const port = await serial.requestPort();
      this.setPort(port);
      return this.info;
    } catch {
      return null;
    }
  }

  async reacquire(usbVendorId: number | null, usbProductId: number | null): Promise<TransportInfo | null> {
    const serial = getSerial();
    if (!serial) return null;
    try {
      const ports = await serial.getPorts();
      const match = ports.find(p => {
        const info = p.getInfo();
        if (usbVendorId != null && info.usbVendorId !== usbVendorId) return false;
        if (usbProductId != null && info.usbProductId !== usbProductId) return false;
        return true;
      }) ?? ports[0];
      if (!match) return null;
      this.setPort(match);
      return this.info;
    } catch {
      return null;
    }
  }

  async start(getFrame: () => Uint8Array, rateHz: number): Promise<void> {
    if (!this.port) throw new Error("No device selected");
    if (this.state === "connected" || this.state === "connecting") return;

    this.getFrame = getFrame;
    this.rateHz = clampRate(rateHz);
    this.setState("connecting");

    try {
      await this.port.open({ baudRate: this.baudRate });
      if (!this.port.writable) throw new Error("Port has no writable stream");
      this.writer = this.port.writable.getWriter();
      this.port.addEventListener("disconnect", this.onPortDisconnect);
      this.setState("connected");
      this.startLoop();
    } catch (err) {
      await this.teardown();
      this.setState("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopReconnectLoop();
    await this.teardown();
    this.setState("idle");
  }

  setRate(rateHz: number): void {
    this.rateHz = clampRate(rateHz);
    if (this.intervalId !== null) {
      this.startLoop();
    }
  }

  getState(): TransportState {
    return this.state;
  }

  getInfo(): TransportInfo | null {
    return this.info;
  }

  onEvent(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Internal ────────────────────────────────────────────────────────

  private setPort(port: WSerialPort): void {
    this.port = port;
    const raw = port.getInfo();
    this.info = {
      label: formatPortLabel(raw),
      usbVendorId: raw.usbVendorId ?? null,
      usbProductId: raw.usbProductId ?? null,
    };
  }

  private startLoop(): void {
    if (this.intervalId !== null) clearInterval(this.intervalId);
    const period = Math.max(10, Math.round(1000 / this.rateHz));
    this.intervalId = setInterval(() => this.tick(), period);
  }

  private async tick(): Promise<void> {
    if (!this.writer || !this.getFrame) return;
    const channels = this.getFrame();
    const frame = encodeDmxFrame(channels);
    try {
      await this.writer.write(frame);
      this.framesSent++;
    } catch (err) {
      this.handleWriteError(err);
    }
  }

  private handleWriteError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    void this.teardown();
    // Only try to reconnect if we had a successfully-selected port; otherwise
    // there's nothing to reacquire against.
    if (this.info) {
      this.setState("reconnecting", msg);
      this.startReconnectLoop();
    } else {
      this.setState("error", msg);
    }
  }

  private handleDisconnected(): void {
    void this.teardown();
    if (this.info) {
      this.setState("reconnecting", "Device disconnected");
      this.startReconnectLoop();
    } else {
      this.setState("error", "Device disconnected");
    }
  }

  private startReconnectLoop(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectStart = Date.now();
    // First attempt fires on next tick, not immediately — gives the OS a beat
    // to re-enumerate the device after a yank.
    this.reconnectTimer = setInterval(() => void this.tryReconnect(), RECONNECT_INTERVAL_MS);
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer !== null) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
  }

  private async tryReconnect(): Promise<void> {
    // Guard against overlapping async attempts — setInterval fires regardless
    // of whether the previous call resolved.
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      if (Date.now() - this.reconnectStart > RECONNECT_TIMEOUT_MS) {
        this.stopReconnectLoop();
        this.setState("error", "Reconnect timed out after 30s");
        return;
      }

      const vid = this.info?.usbVendorId ?? null;
      const pid = this.info?.usbProductId ?? null;
      const freshInfo = await this.reacquire(vid, pid);
      if (!freshInfo || !this.port) return; // no matching port yet — keep waiting

      try {
        await this.port.open({ baudRate: this.baudRate });
        if (!this.port.writable) throw new Error("Port has no writable stream");
        this.writer = this.port.writable.getWriter();
        this.port.addEventListener("disconnect", this.onPortDisconnect);
      } catch (err) {
        // Port reappeared but couldn't open — likely still initialising.
        // Drop the port handle and keep polling.
        this.writer = null;
        this.port = null;
        this.info = freshInfo; // keep the last-known ids for subsequent retries
        void err;
        return;
      }

      this.stopReconnectLoop();
      this.setState("connected");
      this.startLoop();
    } finally {
      this.reconnecting = false;
    }
  }

  private async teardown(): Promise<void> {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch { /* already released */ }
      this.writer = null;
    }
    if (this.port) {
      this.port.removeEventListener("disconnect", this.onPortDisconnect);
      try {
        await this.port.close();
      } catch { /* already closed */ }
    }
  }

  private setState(state: TransportState, error?: string): void {
    if (this.state === state && !error) return;
    this.state = state;
    const event: TransportEvent = { state, info: this.info };
    if (error) event.error = error;
    for (const l of this.listeners) l(event);
  }
}

function clampRate(hz: number): number {
  if (!Number.isFinite(hz)) return 40;
  return Math.max(10, Math.min(44, hz));
}

/**
 * Build a whitespace-free label so it round-trips through the PatchNet
 * serializer (which splits args on whitespace). The "USB " prefix we used
 * in Phase 1 fragmented `USB 0403:6001` into two arg tokens on reload.
 */
function formatPortLabel(info: WSerialPortInfo): string {
  const v = info.usbVendorId;
  const p = info.usbProductId;
  if (v != null && p != null) {
    return `${v.toString(16).padStart(4, "0")}:${p.toString(16).padStart(4, "0")}`;
  }
  return "serial";
}
