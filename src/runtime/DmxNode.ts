import { EnttecProTransport } from "./dmx/EnttecProTransport";
import type {
  DmxTransport,
  TransportEvent,
  TransportInfo,
  TransportState,
} from "./dmx/DmxTransport";
import { Universe } from "./dmx/Universe";
import { FixtureRegistry } from "./dmx/FixtureRegistry";
import type { FixtureProfile } from "./dmx/FixtureProfile";
import { Patch, describePatchError, type FixtureInstance, type PatchError } from "./dmx/Patch";

export interface DmxNodeOptions {
  /** Serial baud rate for the transport. Ignored if a custom transport is passed. */
  baudRate?: number;
}

export type DmxStateEvent = TransportEvent & {
  rateHz: number;
  framesSent: number;
};

export type DmxLogLevel = "info" | "error";
export interface DmxLogEntry {
  time: number;
  level: DmxLogLevel;
  message: string;
}

export type DmxListener = (ev: DmxStateEvent) => void;

const LOG_CAP = 32;

/**
 * Per-object runtime shell. Owns one Universe and one DmxTransport. Message
 * dispatch is implemented as method calls — the patch-side controller parses
 * selectors and calls the method directly.
 *
 * State changes (connect/disconnect/error/rate) fan out via listeners so the
 * Device panel and the on-canvas body both stay live without re-rendering
 * the patch graph every tick.
 */
export class DmxNode {
  private readonly universe = new Universe();
  private readonly transport: DmxTransport;
  private readonly registry = new FixtureRegistry();
  private readonly patchLib: Patch;
  private rateHz = 40;
  private readonly log: DmxLogEntry[] = [];
  private readonly listeners = new Set<DmxListener>();
  private unsubscribeTransport: () => void;

  constructor(options: DmxNodeOptions = {}, transport?: DmxTransport) {
    this.transport = transport ?? new EnttecProTransport({ baudRate: options.baudRate });
    this.patchLib = new Patch(this.registry, this.universe);
    this.unsubscribeTransport = this.transport.onEvent((ev) => this.handleTransportEvent(ev));
  }

  getFramesSent(): number {
    const t = this.transport as unknown as { getFramesSent?: () => number };
    return typeof t.getFramesSent === "function" ? t.getFramesSent() : 0;
  }

  // ── Public API (invoked by ObjectInteractionController) ────────────

  isSupported(): boolean {
    return this.transport.isSupported();
  }

  getState(): TransportState {
    return this.transport.getState();
  }

  getInfo(): TransportInfo | null {
    return this.transport.getInfo();
  }

  getRateHz(): number {
    return this.rateHz;
  }

  getUniverseSnapshot(): Uint8Array {
    return this.universe.snapshot();
  }

  getLog(): readonly DmxLogEntry[] {
    return this.log;
  }

  /** Prompts the browser's port picker. Must be called from a user gesture. */
  async requestDevice(): Promise<TransportInfo | null> {
    const info = await this.transport.requestDevice();
    if (info) this.pushLog("info", `Selected ${info.label}`);
    return info;
  }

  /** Try to reacquire a previously-granted port by VID/PID — no prompt. */
  async reacquire(vid: number | null, pid: number | null): Promise<TransportInfo | null> {
    const info = await this.transport.reacquire(vid, pid);
    if (info) this.pushLog("info", `Reacquired ${info.label}`);
    return info;
  }

  /**
   * Attempt a silent reacquire + connect using persisted VID/PID. Intended
   * for patch-load time. Fails silently if permission hasn't been granted
   * yet — the user's next manual connect will prompt as usual.
   */
  async autoReconnect(vid: number, pid: number): Promise<void> {
    const info = await this.transport.reacquire(vid, pid);
    if (!info) {
      this.pushLog("info", "Auto-reconnect skipped (device not available or permission not granted)");
      return;
    }
    this.pushLog("info", `Auto-reconnect: reacquired ${info.label}`);
    await this.connect();
  }

  async connect(): Promise<void> {
    try {
      await this.transport.start(() => this.universe.snapshot(), this.rateHz);
      this.pushLog("info", `Connected at ${this.rateHz} Hz`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.pushLog("error", `Connect failed: ${msg}`);
    }
  }

  async disconnect(): Promise<void> {
    await this.transport.stop();
    this.pushLog("info", "Disconnected");
  }

  setRateHz(hz: number): void {
    if (!Number.isFinite(hz)) return;
    const clamped = Math.max(10, Math.min(44, hz));
    this.rateHz = clamped;
    this.transport.setRate(clamped);
    this.emit();
  }

  writeChannel(address: number, value: number): void {
    if (!this.universe.writeChannel(address, value)) {
      this.pushLog("error", `dmx: channel ${address} out of 1..512`);
      return;
    }
    this.pushLog("info", `ch ${address} = ${Math.max(0, Math.min(255, Math.trunc(value)))}`);
  }

  writeRange(address: number, values: readonly number[]): void {
    const n = this.universe.writeRange(address, values);
    if (n === 0) {
      this.pushLog("error", `dmx: channel ${address} out of 1..512`);
      return;
    }
    this.pushLog("info", `ch ${address}..${address + n - 1} set (${n} bytes)`);
  }

  blackout(): void {
    this.universe.blackout();
    this.pushLog("info", "Blackout");
  }

  // ── Fixture patch / profile API ─────────────────────────────────────

  patchFixture(name: string, profileId: string, startAddress: number): PatchError | null {
    const err = this.patchLib.patch(name, profileId, startAddress);
    if (err) {
      this.pushLog("error", `patch ${name}: ${describePatchError(err)}`);
    } else {
      this.pushLog("info", `patched ${name} (${profileId}) @ ${startAddress}`);
    }
    return err;
  }

  unpatchFixture(name: string): PatchError | null {
    const err = this.patchLib.unpatch(name);
    if (err) {
      this.pushLog("error", `unpatch ${name}: ${describePatchError(err)}`);
    } else {
      this.pushLog("info", `unpatched ${name}`);
    }
    return err;
  }

  renameFixture(oldName: string, newName: string): PatchError | null {
    const err = this.patchLib.rename(oldName, newName);
    if (err) {
      this.pushLog("error", `rename ${oldName}→${newName}: ${describePatchError(err)}`);
    } else {
      this.pushLog("info", `renamed ${oldName} → ${newName}`);
    }
    return err;
  }

  repointFixture(name: string, newProfileId: string): PatchError | null {
    const err = this.patchLib.repoint(name, newProfileId);
    if (err) this.pushLog("error", `repoint ${name}→${newProfileId}: ${describePatchError(err)}`);
    else     this.pushLog("info",  `repoint ${name} → ${newProfileId}`);
    return err;
  }

  setFixtureMuted(name: string, muted: boolean): PatchError | null {
    const err = this.patchLib.setMuted(name, muted);
    if (err) this.pushLog("error", `mute ${name}: ${describePatchError(err)}`);
    return err;
  }

  /**
   * Write one attribute on one fixture. Successful writes are NOT logged —
   * hot paths (e.g., `metro → set spot dimmer $1` at 40 Hz) would drown the
   * log. Errors ARE logged, rate-limited to one line per (fixture, attr,
   * error-kind) tuple per 2 seconds so a persistently-broken patch doesn't
   * flood either.
   */
  writeFixtureAttr(name: string, attr: string, value: number): PatchError | null {
    const err = this.patchLib.writeAttr(name, attr, value);
    if (err) this.logWriteError(name, attr, err);
    return err;
  }

  private readonly writeErrorLastLogged = new Map<string, number>();
  private logWriteError(name: string, attr: string, err: PatchError): void {
    const key = `${name}.${attr}.${err.kind}`;
    const now = Date.now();
    const last = this.writeErrorLastLogged.get(key) ?? 0;
    if (now - last < 2000) return;
    this.writeErrorLastLogged.set(key, now);
    this.pushLog("error", `set ${name}.${attr}: ${describePatchError(err)}`);
  }

  blackoutFixture(name: string): PatchError | null {
    const err = this.patchLib.blackoutFixture(name);
    if (err) this.pushLog("error", `blackout ${name}: ${describePatchError(err)}`);
    else this.pushLog("info", `blackout ${name}`);
    return err;
  }

  fixtureDefaults(name: string): PatchError | null {
    const err = this.patchLib.fixtureDefaults(name);
    if (err) this.pushLog("error", `defaults ${name}: ${describePatchError(err)}`);
    else this.pushLog("info", `defaults ${name}`);
    return err;
  }

  /** Write `value` to every fixture that has an attribute with this name. */
  writeAllFixtures(attr: string, value: number): number {
    const written = this.patchLib.writeAll(attr, value);
    if (written === 0) {
      this.pushLog("error", `setall ${attr}: no fixture has this attribute`);
    }
    return written;
  }

  /** Write profile defaults to every patched fixture. */
  allFixturesDefaults(): number {
    const touched = this.patchLib.allFixturesDefaults();
    this.pushLog("info", `defaults (all): ${touched} fixtures`);
    return touched;
  }

  /** Import or update a profile. Returns error string on invalid, null on success. */
  importProfile(raw: unknown): string | null {
    const err = this.registry.upsert(raw);
    if (err) {
      this.pushLog("error", `profile: ${err}`);
    } else {
      const id = (raw as FixtureProfile).id;
      this.pushLog("info", `imported profile ${id}`);
    }
    return err;
  }

  removeProfile(id: string): boolean {
    const ok = this.registry.remove(id);
    if (ok) this.pushLog("info", `removed profile ${id}`);
    else    this.pushLog("error", `remove profile ${id}: not a user profile`);
    return ok;
  }

  listProfiles(): FixtureProfile[] {
    return this.registry.list();
  }

  listFixtures(): readonly FixtureInstance[] {
    return this.patchLib.list();
  }

  occupancy(): Array<string | null> {
    return this.patchLib.occupancy();
  }

  // ── Rehydration / export for persistence ─────────────────────────────

  exportUserProfiles(): FixtureProfile[] {
    return this.registry.exportUserProfiles();
  }

  exportInstances(): FixtureInstance[] {
    return this.patchLib.exportInstances();
  }

  /** Replace the user-profile set wholesale. Returns errors for invalid entries. */
  loadUserProfiles(profiles: readonly FixtureProfile[]): string[] {
    return this.registry.setUserProfiles(profiles);
  }

  /** Replace the instance list wholesale. */
  loadInstances(instances: readonly FixtureInstance[]): void {
    this.patchLib.setInstances(instances);
  }

  onChange(listener: DmxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.unsubscribeTransport();
    void this.transport.stop();
    this.listeners.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private handleTransportEvent(ev: TransportEvent): void {
    if (ev.state === "error" && ev.error) {
      this.pushLog("error", ev.error);
    } else if (ev.state === "connected") {
      this.pushLog("info", "Link up");
    } else if (ev.state === "idle") {
      this.pushLog("info", "Link down");
    }
    this.emit(ev);
  }

  private emit(ev?: TransportEvent): void {
    const base: TransportEvent = ev ?? {
      state: this.transport.getState(),
      info: this.transport.getInfo(),
    };
    const out: DmxStateEvent = {
      ...base,
      rateHz: this.rateHz,
      framesSent: this.getFramesSent(),
    };
    for (const l of this.listeners) l(out);
  }

  private pushLog(level: DmxLogLevel, message: string): void {
    this.log.push({ time: Date.now(), level, message });
    while (this.log.length > LOG_CAP) this.log.shift();
    this.emit();
  }
}
