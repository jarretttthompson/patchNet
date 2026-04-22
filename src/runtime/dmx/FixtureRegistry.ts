import { BUNDLED_PROFILES } from "./bundledProfiles";
import {
  describeValidationError,
  validateProfile,
  type FixtureProfile,
} from "./FixtureProfile";

/**
 * Per-dmx-object profile library. Bundled profiles are always present.
 * User-imported profiles are layered on top and persist in the dmx node's
 * `userProfiles` arg as a base64-encoded JSON array — moving a .patchnet
 * file to another machine carries the profiles with it, no localStorage
 * dependency.
 *
 * An import with an id that matches a bundled profile overrides the bundled
 * entry (so users can patch vendor-shipped profiles without forking). A
 * subsequent `remove` restores the bundled version.
 */
export class FixtureRegistry {
  private userProfiles = new Map<string, FixtureProfile>();

  /** Merged lookup: user profiles take precedence over bundled. */
  get(id: string): FixtureProfile | null {
    return this.userProfiles.get(id) ?? BUNDLED_PROFILES.find(p => p.id === id) ?? null;
  }

  /** All profiles: bundled merged with user-overrides, sorted by id. */
  list(): FixtureProfile[] {
    const merged = new Map<string, FixtureProfile>();
    for (const p of BUNDLED_PROFILES) merged.set(p.id, p);
    for (const [id, p] of this.userProfiles) merged.set(id, p);
    return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Does this registry contain a user-imported profile with this id? */
  hasUser(id: string): boolean {
    return this.userProfiles.has(id);
  }

  /** Returns the read-only array of bundled profiles (for UI distinction). */
  getBundled(): readonly FixtureProfile[] {
    return BUNDLED_PROFILES;
  }

  /**
   * Validate + upsert. Returns an error message on failure, null on success.
   * Deep-clones the profile so mutations on the input don't corrupt state.
   */
  upsert(raw: unknown): string | null {
    const errors = validateProfile(raw);
    if (errors.length > 0) {
      return errors.map(describeValidationError).join("; ");
    }
    const profile = raw as FixtureProfile;
    const clone: FixtureProfile = {
      id: profile.id,
      name: profile.name,
      manufacturer: profile.manufacturer,
      mode: profile.mode,
      channelCount: profile.channelCount,
      attributes: profile.attributes.map(a => ({ ...a })),
    };
    this.userProfiles.set(profile.id, clone);
    return null;
  }

  /** Remove a user profile. Bundled profiles cannot be deleted. */
  remove(id: string): boolean {
    return this.userProfiles.delete(id);
  }

  /** Replace the user-profile set wholesale — used when rehydrating args. */
  setUserProfiles(profiles: readonly FixtureProfile[]): string[] {
    this.userProfiles.clear();
    const errors: string[] = [];
    for (const p of profiles) {
      const err = this.upsert(p);
      if (err) errors.push(`${p?.id ?? "<unnamed>"}: ${err}`);
    }
    return errors;
  }

  /** Serialize just the user-imported profiles for persistence. */
  exportUserProfiles(): FixtureProfile[] {
    return Array.from(this.userProfiles.values()).map(p => ({
      ...p,
      attributes: p.attributes.map(a => ({ ...a })),
    }));
  }
}
