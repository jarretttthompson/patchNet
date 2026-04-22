/**
 * Fixture profile schema + validator.
 *
 * A profile describes how a single fixture is laid out on the DMX bus: how
 * many channels it occupies, what attribute each channel drives, whether a
 * parameter is 8-bit or 16-bit, and what the factory defaults are.
 *
 * Instances (a profile placed at a specific start address in a universe)
 * live in Patch.ts — the profile itself is address-agnostic.
 */

export type AttributeRole =
  | "intensity"
  | "color.r" | "color.g" | "color.b" | "color.w" | "color.a" | "color.uv"
  | "position.pan" | "position.tilt"
  | "gobo" | "prism" | "strobe" | "shutter" | "macro" | "speed"
  | "zoom" | "focus"
  | "other";

export interface AttributeDef {
  /** Patch-friendly name, unique within profile: /^[a-z][a-zA-Z0-9_-]*$/ */
  name: string;
  role?: AttributeRole;
  /** 0-based offset from the fixture's start address. */
  offset: number;
  type: "8bit" | "16bit";
  /** Required iff type === "16bit". Offset of the fine byte. */
  fineOffset?: number;
  /** Factory default. 0..255 for 8bit, 0..65535 for 16bit. */
  default: number;
  /** Inclusive. Defaults to [0,255] / [0,65535]. */
  range?: [number, number];
}

export interface FixtureProfile {
  /** Machine id, unique within registry. kebab-case. */
  id: string;
  name: string;
  manufacturer?: string;
  /** Free-form mode string shown in UI, e.g. "13ch" or "extended". */
  mode?: string;
  /** Total contiguous channels the fixture occupies on the bus. */
  channelCount: number;
  attributes: AttributeDef[];
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ProfileValidationError =
  | { kind: "missing-field"; field: string }
  | { kind: "bad-id"; id: string }
  | { kind: "bad-channel-count"; channelCount: unknown }
  | { kind: "bad-attribute-name"; name: string; index: number }
  | { kind: "duplicate-attribute-name"; name: string }
  | { kind: "bad-offset"; name: string; offset: number }
  | { kind: "bad-fine-offset"; name: string; fineOffset: number | undefined }
  | { kind: "bad-default"; name: string; value: unknown }
  | { kind: "bad-range"; name: string }
  | { kind: "channel-overlap"; aName: string; bName: string; byte: number };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ATTR_NAME_PATTERN = /^[a-z][a-zA-Z0-9_-]*$/;

export function describeValidationError(err: ProfileValidationError): string {
  switch (err.kind) {
    case "missing-field":              return `missing field "${err.field}"`;
    case "bad-id":                     return `invalid id "${err.id}" — must match /^[a-z0-9][a-z0-9-]*$/`;
    case "bad-channel-count":          return `channelCount must be a positive integer (got ${String(err.channelCount)})`;
    case "bad-attribute-name":         return `attribute #${err.index} has invalid name "${err.name}" — must match /^[a-z][a-zA-Z0-9_-]*$/`;
    case "duplicate-attribute-name":   return `attribute name "${err.name}" appears more than once`;
    case "bad-offset":                 return `attribute "${err.name}" offset ${err.offset} is out of range`;
    case "bad-fine-offset":            return `attribute "${err.name}" needs a valid fineOffset for 16bit type (got ${String(err.fineOffset)})`;
    case "bad-default":                return `attribute "${err.name}" has invalid default ${String(err.value)}`;
    case "bad-range":                  return `attribute "${err.name}" has invalid range`;
    case "channel-overlap":            return `byte ${err.byte} is claimed by both "${err.aName}" and "${err.bName}"`;
  }
}

/**
 * Validates a candidate profile object and returns a list of errors. Empty
 * array means the profile is valid and safe to register.
 */
export function validateProfile(raw: unknown): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];
  if (!raw || typeof raw !== "object") {
    errors.push({ kind: "missing-field", field: "<root>" });
    return errors;
  }
  const p = raw as Partial<FixtureProfile>;

  if (typeof p.id !== "string" || !p.id) {
    errors.push({ kind: "missing-field", field: "id" });
  } else if (!ID_PATTERN.test(p.id)) {
    errors.push({ kind: "bad-id", id: p.id });
  }

  if (typeof p.name !== "string" || !p.name) {
    errors.push({ kind: "missing-field", field: "name" });
  }

  if (typeof p.channelCount !== "number" || !Number.isInteger(p.channelCount) || p.channelCount < 1 || p.channelCount > 512) {
    errors.push({ kind: "bad-channel-count", channelCount: p.channelCount });
  }

  if (!Array.isArray(p.attributes) || p.attributes.length === 0) {
    errors.push({ kind: "missing-field", field: "attributes" });
    return errors; // can't validate occupancy without attributes
  }

  const seenNames = new Set<string>();
  const occupancy = new Int16Array(typeof p.channelCount === "number" ? p.channelCount : 0);
  const attrIndexById = new Map<number, string>(); // byte index → attr name
  occupancy.fill(-1);

  p.attributes.forEach((attrRaw, i) => {
    const attr = attrRaw as Partial<AttributeDef>;
    const name = typeof attr.name === "string" ? attr.name : "";

    if (!ATTR_NAME_PATTERN.test(name)) {
      errors.push({ kind: "bad-attribute-name", name, index: i });
    }
    if (seenNames.has(name)) {
      errors.push({ kind: "duplicate-attribute-name", name });
    } else if (name) {
      seenNames.add(name);
    }

    const count = typeof p.channelCount === "number" ? p.channelCount : 0;
    const offset = typeof attr.offset === "number" ? attr.offset : -1;
    if (offset < 0 || offset >= count) {
      errors.push({ kind: "bad-offset", name, offset });
    }

    const is16 = attr.type === "16bit";
    if (is16) {
      const fo = attr.fineOffset;
      if (typeof fo !== "number" || fo < 0 || fo >= count || fo === offset) {
        errors.push({ kind: "bad-fine-offset", name, fineOffset: fo });
      }
    } else if (attr.type !== "8bit") {
      errors.push({ kind: "bad-attribute-name", name, index: i });
    }

    if (typeof attr.default !== "number" || !Number.isFinite(attr.default) || attr.default < 0) {
      errors.push({ kind: "bad-default", name, value: attr.default });
    } else {
      const upper = is16 ? 65535 : 255;
      if (attr.default > upper) {
        errors.push({ kind: "bad-default", name, value: attr.default });
      }
    }

    if (attr.range !== undefined) {
      if (!Array.isArray(attr.range) || attr.range.length !== 2
          || typeof attr.range[0] !== "number" || typeof attr.range[1] !== "number"
          || attr.range[0] >= attr.range[1]) {
        errors.push({ kind: "bad-range", name });
      }
    }

    // Occupancy: claim the byte(s) this attribute uses and detect overlap.
    const claim = (byte: number) => {
      if (byte < 0 || byte >= occupancy.length) return;
      if (occupancy[byte] !== -1) {
        const aName = attrIndexById.get(byte) ?? "?";
        errors.push({ kind: "channel-overlap", aName, bName: name, byte });
      } else {
        occupancy[byte] = i;
        attrIndexById.set(byte, name);
      }
    };
    if (offset >= 0) claim(offset);
    if (is16 && typeof attr.fineOffset === "number") claim(attr.fineOffset);
  });

  return errors;
}

export function isValid(profile: unknown): profile is FixtureProfile {
  return validateProfile(profile).length === 0;
}

/** Returns the byte-count upper bound for an attribute's value. */
export function attributeMax(attr: AttributeDef): number {
  return attr.range?.[1] ?? (attr.type === "16bit" ? 65535 : 255);
}

/** Returns the byte-count lower bound for an attribute's value. */
export function attributeMin(attr: AttributeDef): number {
  return attr.range?.[0] ?? 0;
}
