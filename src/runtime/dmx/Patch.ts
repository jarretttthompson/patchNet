import type { AttributeDef } from "./FixtureProfile";
import { attributeMax, attributeMin } from "./FixtureProfile";
import type { FixtureRegistry } from "./FixtureRegistry";
import type { Universe } from "./Universe";

/**
 * A fixture instance is a profile placed at a specific start address on a
 * specific universe. In Phase 2 we're still single-universe so `universe`
 * stays at 1 — the field is here so Phase 5 multi-universe doesn't need a
 * schema migration.
 */
export interface FixtureInstance {
  /** User-given, unique within the Patch. Patch-friendly: matches profile attr-name regex. */
  name: string;
  /** Profile id; must resolve in the registry at write time. */
  profileId: string;
  /** 1-based DMX address for the fixture's first byte. */
  startAddress: number;
  /** 1 in Phase 2; reserved for Phase 5. */
  universe: number;
  /** If true, writes to this fixture are dropped. */
  muted?: boolean;
}

export type PatchError =
  | { kind: "no-profile"; profileId: string }
  | { kind: "bad-address"; address: number; channelCount: number }
  | { kind: "duplicate-name"; name: string }
  | { kind: "bad-name"; name: string }
  | { kind: "overlap"; existingName: string; startByte: number }
  | { kind: "no-such-fixture"; name: string }
  | { kind: "no-such-attribute"; fixture: string; attribute: string };

const INSTANCE_NAME_PATTERN = /^[a-z][a-zA-Z0-9_-]*$/;

export function describePatchError(err: PatchError): string {
  switch (err.kind) {
    case "no-profile":         return `unknown profile id "${err.profileId}"`;
    case "bad-address":        return `address ${err.address} + ${err.channelCount} channels exceeds universe (1..512)`;
    case "duplicate-name":     return `fixture name "${err.name}" already exists`;
    case "bad-name":           return `fixture name "${err.name}" must match /^[a-z][a-zA-Z0-9_-]*$/`;
    case "overlap":            return `channel ${err.startByte} is already claimed by "${err.existingName}"`;
    case "no-such-fixture":    return `no fixture named "${err.name}"`;
    case "no-such-attribute":  return `fixture "${err.fixture}" has no attribute "${err.attribute}"`;
  }
}

/**
 * Holds the fixture instance list and drives writes through a Universe.
 * All patching operations return typed errors — the caller decides whether
 * to surface them via the Device panel, the object's message outlet, or both.
 */
export class Patch {
  private instances: FixtureInstance[] = [];

  constructor(
    private readonly registry: FixtureRegistry,
    private readonly universe: Universe,
  ) {}

  list(): readonly FixtureInstance[] {
    return this.instances;
  }

  get(name: string): FixtureInstance | null {
    return this.instances.find(i => i.name === name) ?? null;
  }

  /** Replace the instance list wholesale — used when rehydrating from args. */
  setInstances(raw: readonly FixtureInstance[]): void {
    this.instances = raw.map(i => ({ ...i, universe: i.universe ?? 1 }));
  }

  /** Snapshot for persistence. */
  exportInstances(): FixtureInstance[] {
    return this.instances.map(i => ({ ...i }));
  }

  /**
   * Create a new fixture instance. Validates name, address range, and
   * channel collisions against all currently-patched fixtures.
   */
  patch(name: string, profileId: string, startAddress: number): PatchError | null {
    if (!INSTANCE_NAME_PATTERN.test(name)) return { kind: "bad-name", name };
    if (this.get(name)) return { kind: "duplicate-name", name };

    const profile = this.registry.get(profileId);
    if (!profile) return { kind: "no-profile", profileId };

    if (!Number.isInteger(startAddress) || startAddress < 1 || startAddress + profile.channelCount - 1 > 512) {
      return { kind: "bad-address", address: startAddress, channelCount: profile.channelCount };
    }

    // Byte-level overlap check: every byte this fixture would claim must be
    // unclaimed by any existing instance on the same universe.
    for (let byte = startAddress; byte < startAddress + profile.channelCount; byte++) {
      const clash = this.findFixtureAtByte(byte, /* universe */ 1);
      if (clash) return { kind: "overlap", existingName: clash.name, startByte: byte };
    }

    this.instances.push({ name, profileId, startAddress, universe: 1 });
    // Seed the fixture's bytes with its profile defaults so moving-head
    // fixtures have a centered position + open shutter out of the gate.
    // Without this, a freshly-patched fixture's shutter sits at 0 (closed)
    // and `set dimmer 255` looks broken — the byte changes, no light.
    for (const attr of profile.attributes) {
      this.writeAttrBytes(startAddress, attr, attr.default);
    }
    return null;
  }

  unpatch(name: string): PatchError | null {
    const idx = this.instances.findIndex(i => i.name === name);
    if (idx === -1) return { kind: "no-such-fixture", name };
    this.instances.splice(idx, 1);
    return null;
  }

  rename(oldName: string, newName: string): PatchError | null {
    const inst = this.get(oldName);
    if (!inst) return { kind: "no-such-fixture", name: oldName };
    if (!INSTANCE_NAME_PATTERN.test(newName)) return { kind: "bad-name", name: newName };
    if (oldName === newName) return null;
    if (this.get(newName)) return { kind: "duplicate-name", name: newName };
    inst.name = newName;
    return null;
  }

  /**
   * Swap a fixture's profile to a different id, re-validating channel span
   * against every OTHER instance. Keeps the existing start address. Useful
   * for fixing orphans (profile removed under-foot) or upgrading a fixture
   * to a different mode without losing its address.
   */
  repoint(name: string, newProfileId: string): PatchError | null {
    const inst = this.get(name);
    if (!inst) return { kind: "no-such-fixture", name };
    const profile = this.registry.get(newProfileId);
    if (!profile) return { kind: "no-profile", profileId: newProfileId };

    if (inst.startAddress + profile.channelCount - 1 > 512) {
      return { kind: "bad-address", address: inst.startAddress, channelCount: profile.channelCount };
    }

    // Overlap check against every other instance (ignore self).
    for (let byte = inst.startAddress; byte < inst.startAddress + profile.channelCount; byte++) {
      for (const other of this.instances) {
        if (other === inst) continue;
        const op = this.registry.get(other.profileId);
        if (!op) continue;
        if (byte >= other.startAddress && byte < other.startAddress + op.channelCount) {
          return { kind: "overlap", existingName: other.name, startByte: byte };
        }
      }
    }

    inst.profileId = newProfileId;
    return null;
  }

  setMuted(name: string, muted: boolean): PatchError | null {
    const inst = this.get(name);
    if (!inst) return { kind: "no-such-fixture", name };
    inst.muted = muted || undefined;
    return null;
  }

  // ── Writes ────────────────────────────────────────────────────────

  /**
   * Write a named attribute on a fixture. Handles 16-bit split (coarse +
   * fine bytes). Value is clamped to the attribute's declared range.
   */
  writeAttr(name: string, attr: string, value: number): PatchError | null {
    const inst = this.get(name);
    if (!inst) return { kind: "no-such-fixture", name };
    if (inst.muted) return null;

    const profile = this.registry.get(inst.profileId);
    if (!profile) return { kind: "no-profile", profileId: inst.profileId };

    const def = profile.attributes.find(a => a.name === attr);
    if (!def) return { kind: "no-such-attribute", fixture: name, attribute: attr };

    const clamped = Math.max(attributeMin(def), Math.min(attributeMax(def), value));
    this.writeAttrBytes(inst.startAddress, def, clamped);
    return null;
  }

  /** Zero every byte claimed by this fixture. */
  blackoutFixture(name: string): PatchError | null {
    const inst = this.get(name);
    if (!inst) return { kind: "no-such-fixture", name };
    const profile = this.registry.get(inst.profileId);
    if (!profile) return { kind: "no-profile", profileId: inst.profileId };
    for (let i = 0; i < profile.channelCount; i++) {
      this.universe.writeChannel(inst.startAddress + i, 0);
    }
    return null;
  }

  /**
   * Write `value` to every fixture whose profile defines an attribute with
   * the given name. Returns the number of fixtures actually written to (0
   * if no match — caller can surface that as a UX hint).
   */
  writeAll(attr: string, value: number): number {
    let written = 0;
    for (const inst of this.instances) {
      if (inst.muted) continue;
      const profile = this.registry.get(inst.profileId);
      if (!profile) continue;
      if (!profile.attributes.some(a => a.name === attr)) continue;
      this.writeAttr(inst.name, attr, value);
      written++;
    }
    return written;
  }

  /** Write profile defaults to every patched fixture. Returns count touched. */
  allFixturesDefaults(): number {
    let touched = 0;
    for (const inst of this.instances) {
      if (inst.muted) continue;
      if (this.fixtureDefaults(inst.name) === null) touched++;
    }
    return touched;
  }

  /** Write the profile's declared defaults for every attribute on the fixture. */
  fixtureDefaults(name: string): PatchError | null {
    const inst = this.get(name);
    if (!inst) return { kind: "no-such-fixture", name };
    const profile = this.registry.get(inst.profileId);
    if (!profile) return { kind: "no-profile", profileId: inst.profileId };
    for (const attr of profile.attributes) {
      this.writeAttrBytes(inst.startAddress, attr, attr.default);
    }
    return null;
  }

  // ── Introspection ──────────────────────────────────────────────────

  /**
   * Occupancy map for the universe: entry [byte-1] is the fixture name
   * claiming that byte, or null if unclaimed. Built fresh per call; cheap
   * enough at 512 entries that we don't cache.
   */
  occupancy(universe = 1): Array<string | null> {
    const out: Array<string | null> = new Array(512).fill(null);
    for (const inst of this.instances) {
      if (inst.universe !== universe) continue;
      const profile = this.registry.get(inst.profileId);
      if (!profile) continue;
      for (let i = 0; i < profile.channelCount; i++) {
        const byte = inst.startAddress + i - 1;
        if (byte >= 0 && byte < 512) out[byte] = inst.name;
      }
    }
    return out;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private findFixtureAtByte(address: number, universe: number): FixtureInstance | null {
    for (const inst of this.instances) {
      if (inst.universe !== universe) continue;
      const profile = this.registry.get(inst.profileId);
      if (!profile) continue;
      if (address >= inst.startAddress && address < inst.startAddress + profile.channelCount) {
        return inst;
      }
    }
    return null;
  }

  private writeAttrBytes(startAddress: number, def: AttributeDef, value: number): void {
    if (def.type === "16bit") {
      const v = Math.max(0, Math.min(65535, Math.trunc(value)));
      const coarse = (v >> 8) & 0xff;
      const fine   = v & 0xff;
      this.universe.writeChannel(startAddress + def.offset, coarse);
      if (def.fineOffset !== undefined) {
        this.universe.writeChannel(startAddress + def.fineOffset, fine);
      }
    } else {
      const v = Math.max(0, Math.min(255, Math.trunc(value)));
      this.universe.writeChannel(startAddress + def.offset, v);
    }
  }
}
