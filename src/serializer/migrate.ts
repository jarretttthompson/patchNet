import type { ParsedPatch } from "./parse";

/**
 * The format version this codebase emits. Patches parsed at an older version
 * are walked up to this version by `migrate()` before the rest of the app
 * touches them, so consumers can assume they're always working with the
 * current shape.
 *
 * Bumping this is **part** of shipping a new format version — the other parts
 * are extending `KNOWN_VERSIONS` in `parse.ts` and registering a step in the
 * `STEPS` table below.
 */
export const LATEST_VERSION = 2;

/** A single-step migration: take a patch at version N, return it at version
 *  N+1. Pure — must not mutate the input. */
type MigrationStep = (patch: ParsedPatch) => ParsedPatch;

/**
 * Step registry. Keyed by *from* version: `STEPS[1]` migrates v1 → v2.
 *
 * v1 → v2 is identity-with-version-bump today because v1 and v2 share the
 * same in-memory shape — the version distinction was introduced ahead of any
 * real format change (see docs/serialization-format.md §10) so the upgrade
 * path is wired before it's needed. When v2 actually diverges from v1,
 * replace this entry with the real transform.
 */
const STEPS: Record<number, MigrationStep> = {
  1: (patch) => ({ ...patch, version: 2 }),
};

/**
 * Walk a parsed patch up to `LATEST_VERSION`, applying every registered step
 * along the way. Today this is a single identity-with-relabel hop; the shape
 * exists so adding the next step is a one-function change in `STEPS`.
 *
 * Throws if a required step is missing (a contract bug — every version in
 * `KNOWN_VERSIONS` below `LATEST_VERSION` must have a step). Throws if a
 * step fails to advance the version (would loop forever). Throws if the
 * input version is newer than `LATEST_VERSION` (parser's `KNOWN_VERSIONS`
 * check should prevent this; defensive).
 */
export function migrate(patch: ParsedPatch): ParsedPatch {
  if (patch.version > LATEST_VERSION) {
    throw new Error(
      `Cannot migrate patch from v${patch.version}: newer than ` +
        `LATEST_VERSION=v${LATEST_VERSION}. Parser KNOWN_VERSIONS guard ` +
        `should have rejected this earlier.`,
    );
  }
  let current = patch;
  while (current.version < LATEST_VERSION) {
    const fromVersion = current.version;
    const step = STEPS[fromVersion];
    if (!step) {
      const registered = Object.keys(STEPS)
        .map((v) => `v${v}→v${Number(v) + 1}`)
        .join(", ") || "(none registered)";
      throw new Error(
        `No migration step from v${fromVersion} to v${fromVersion + 1}. ` +
          `Registered: ${registered}.`,
      );
    }
    current = step(current);
    if (current.version <= fromVersion) {
      throw new Error(
        `Migration step from v${fromVersion} did not advance the version ` +
          `(got v${current.version}).`,
      );
    }
  }
  return current;
}
