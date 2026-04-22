/**
 * A single 512-channel DMX universe backed by a Uint8Array.
 *
 * Channels are 1-based on the wire and to callers (DMX convention); internal
 * storage is 0-indexed. `snapshot()` returns a fresh copy of the 512 bytes
 * — the public read path for transports that send a full frame per tick.
 */
export class Universe {
  static readonly CHANNEL_COUNT = 512;

  private readonly data = new Uint8Array(Universe.CHANNEL_COUNT);
  private version = 0;

  /** Set a single channel (1-based address). Silently clamps value to 0..255. */
  writeChannel(address: number, value: number): boolean {
    if (address < 1 || address > Universe.CHANNEL_COUNT) return false;
    const clamped = Math.max(0, Math.min(255, Math.trunc(value)));
    const idx = address - 1;
    if (this.data[idx] === clamped) return true;
    this.data[idx] = clamped;
    this.version++;
    return true;
  }

  /** Set contiguous channels starting at `address` (1-based). Stops at 512. */
  writeRange(address: number, values: readonly number[]): number {
    if (address < 1 || address > Universe.CHANNEL_COUNT) return 0;
    let written = 0;
    for (let i = 0; i < values.length; i++) {
      const addr = address + i;
      if (addr > Universe.CHANNEL_COUNT) break;
      const clamped = Math.max(0, Math.min(255, Math.trunc(values[i])));
      const idx = addr - 1;
      if (this.data[idx] !== clamped) {
        this.data[idx] = clamped;
        this.version++;
      }
      written++;
    }
    return written;
  }

  readChannel(address: number): number {
    if (address < 1 || address > Universe.CHANNEL_COUNT) return 0;
    return this.data[address - 1];
  }

  blackout(): void {
    for (let i = 0; i < this.data.length; i++) this.data[i] = 0;
    this.version++;
  }

  /** Returns a fresh copy — safe to hand to a transport without aliasing. */
  snapshot(): Uint8Array {
    return new Uint8Array(this.data);
  }

  /** Monotonic counter bumped on every mutation. */
  getVersion(): number {
    return this.version;
  }
}
