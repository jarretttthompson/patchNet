/**
 * js~ effect library — per-patch (stored in args) + global (localStorage).
 *
 * Entries are plain `{name, code}`. The `scope` field is a UI-only tag
 * the Panel attaches when merging the two buckets; it isn't serialised.
 */

import type { PatchGraph } from "../../graph/PatchGraph";
import type { PatchNode } from "../../graph/PatchNode";

export interface LibraryEntry {
  name: string;
  code: string;
}

export interface ScopedLibraryEntry extends LibraryEntry {
  scope: "patch" | "global";
}

const GLOBAL_LIB_KEY = "patchnet-js-global-library";

// ── Per-patch library (args[1] on each js~ node) ────────────────────────

export function getPatchLibrary(node: PatchNode): LibraryEntry[] {
  const raw = node.args[1] ?? "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    // Corrupt JSON — treat as empty rather than throwing. A save will
    // overwrite the bad data with fresh JSON.
    return [];
  }
}

/**
 * Update args[1] on a specific js~ node. Does NOT emit graph changes;
 * callers decide whether to go through `broadcastPatchLibrary` (which
 * emits once after updating every js~) or fire `change` themselves.
 */
function writePatchLibraryOnNode(node: PatchNode, entries: LibraryEntry[]): void {
  node.args[1] = entries.length > 0 ? JSON.stringify(entries) : "";
}

/**
 * Mirror `entries` to every js~ node in the graph so all objects share the
 * same patch library. Emits a single `change` at the end so autosave fires
 * once rather than per-node.
 */
export function broadcastPatchLibrary(graph: PatchGraph, entries: LibraryEntry[]): void {
  const normalised = entries.length > 0 ? JSON.stringify(entries) : "";
  for (const node of graph.getNodes()) {
    if (node.type !== "js~") continue;
    node.args[1] = normalised;
  }
  graph.emit("change");
}

// ── Global library (localStorage) ───────────────────────────────────────

export function getGlobalLibrary(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(GLOBAL_LIB_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

export function setGlobalLibrary(entries: LibraryEntry[]): void {
  try {
    localStorage.setItem(GLOBAL_LIB_KEY, JSON.stringify(entries));
  } catch {
    // localStorage may be full or disabled (private browsing).
    // Silent fail — user sees via next read that it didn't stick.
  }
}

// ── Operations shared across both scopes ────────────────────────────────

/**
 * Append or replace an entry in a library. If an entry with the same name
 * already exists, it's overwritten. Returns the new list.
 */
export function upsertEntry(entries: LibraryEntry[], entry: LibraryEntry): LibraryEntry[] {
  const next = entries.filter(e => e.name !== entry.name);
  next.push({ name: entry.name, code: entry.code });
  return next;
}

export function removeEntry(entries: LibraryEntry[], name: string): LibraryEntry[] {
  return entries.filter(e => e.name !== name);
}

export function renameEntry(entries: LibraryEntry[], oldName: string, newName: string): LibraryEntry[] {
  if (!newName || oldName === newName) return entries;
  // If newName already exists in this library, refuse rather than merging
  // silently — surface the collision to the caller so it can prompt the
  // user for a different name.
  if (entries.some(e => e.name === newName)) return entries;
  return entries.map(e => e.name === oldName ? { ...e, name: newName } : e);
}

/**
 * Make a proposed name unique within a library by appending (2), (3), …
 * until no collision. Used when `desc:` falls back to a duplicate.
 */
export function uniqueName(base: string, existing: readonly LibraryEntry[]): string {
  if (!existing.some(e => e.name === base)) return base;
  let n = 2;
  while (existing.some(e => e.name === `${base} (${n})`)) n++;
  return `${base} (${n})`;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isValidEntry(e: unknown): e is LibraryEntry {
  return !!e && typeof (e as { name: unknown }).name === "string"
            && typeof (e as { code: unknown }).code === "string"
            && (e as { name: string }).name.length > 0;
}

/** Derive a default effect name from JSFX source. Uses the first `desc:`
 *  line if present, else returns an empty string (caller decides fallback).
 *  Same regex conservatism as parser.ts. */
export function deriveNameFromCode(code: string): string {
  const lines = code.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*desc\s*:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return "";
}

export function writePatchLibrary(graph: PatchGraph, nodeIdOrigin: PatchNode, entries: LibraryEntry[]): void {
  // Convenience wrapper: write to the originating node first (so callers
  // can read-after-write on the same node without a round-trip), then
  // broadcast to the rest. Kept for symmetry with setGlobalLibrary.
  writePatchLibraryOnNode(nodeIdOrigin, entries);
  broadcastPatchLibrary(graph, entries);
}
