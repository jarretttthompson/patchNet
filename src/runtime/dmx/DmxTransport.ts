/**
 * Abstract DMX transport. Phase 1 implements `EnttecProTransport`; future
 * backends (Art-Net bridge, sACN, other USB widgets) plug in here without
 * changing DmxNode.
 */

export type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface TransportInfo {
  /** Human-readable label shown in the UI (e.g., "ENTTEC DMX USB PRO"). */
  label: string;
  /** USB vendor id (0x0000..0xFFFF) if known, else null. Used to match a */
  /** previously-granted port on next session. */
  usbVendorId: number | null;
  usbProductId: number | null;
}

export interface TransportEvent {
  state: TransportState;
  info: TransportInfo | null;
  /** Present only when state === "error". */
  error?: string;
}

export type TransportListener = (e: TransportEvent) => void;

export interface DmxTransport {
  /** Feature probe — false means this transport cannot run in this browser. */
  isSupported(): boolean;

  /**
   * Request a device from the user (prompts the browser's port picker on
   * first call per origin). Must be invoked inside a user gesture handler.
   * Returns the chosen port's info, or null if the user dismissed the picker.
   */
  requestDevice(): Promise<TransportInfo | null>;

  /**
   * Attempt to connect to a previously-granted device matching the given
   * vendor/product IDs. Returns info on success, null if no match found.
   * Does NOT prompt the user.
   */
  reacquire(usbVendorId: number | null, usbProductId: number | null): Promise<TransportInfo | null>;

  /** Open the currently-selected device and begin the refresh loop. */
  start(getFrame: () => Uint8Array, rateHz: number): Promise<void>;

  /** Stop the refresh loop and close the device. Idempotent. */
  stop(): Promise<void>;

  /** Update refresh rate on a running transport. */
  setRate(rateHz: number): void;

  getState(): TransportState;
  getInfo(): TransportInfo | null;

  onEvent(listener: TransportListener): () => void;
}
