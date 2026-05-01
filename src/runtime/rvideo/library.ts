/**
 * reaperVideo effect library — per-patch (stored in args[1]) + global
 * (localStorage). Mirrors `jsfx/library.ts` with rvideo-specific adjustments:
 *
 *   - patch-scoped entries live in `args[1]` on every reaperVideo node
 *     (js~ uses the same slot); mirrored to all nodes of the same type so
 *     libraries are shared across a patch file.
 *   - global storage key is distinct from js~'s.
 *   - name derivation from code uses the first `// <name>` or `// @name …`
 *     comment line rather than `desc:` (REAPER video files don't use `desc:`).
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

const GLOBAL_LIB_KEY = "patchnet-rvideo-global-library";
const PATCH_ARG_INDEX = 1;
const NODE_TYPE = "reaperVideo*";

// ── Per-patch library ───────────────────────────────────────────────────

export function getPatchLibrary(node: PatchNode): LibraryEntry[] {
  const raw = node.args[PATCH_ARG_INDEX] ?? "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

function writePatchLibraryOnNode(node: PatchNode, entries: LibraryEntry[]): void {
  node.args[PATCH_ARG_INDEX] = entries.length > 0 ? JSON.stringify(entries) : "";
}

export function broadcastPatchLibrary(graph: PatchGraph, entries: LibraryEntry[]): void {
  const normalised = entries.length > 0 ? JSON.stringify(entries) : "";
  for (const node of graph.getNodes()) {
    if (node.type !== NODE_TYPE) continue;
    node.args[PATCH_ARG_INDEX] = normalised;
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
    /* localStorage may be full / disabled in private browsing */
  }
}

// ── Shared ops ──────────────────────────────────────────────────────────

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
  if (entries.some(e => e.name === newName)) return entries;
  return entries.map(e => e.name === oldName ? { ...e, name: newName } : e);
}

export function uniqueName(base: string, existing: readonly LibraryEntry[]): string {
  if (!existing.some(e => e.name === base)) return base;
  let n = 2;
  while (existing.some(e => e.name === `${base} (${n})`)) n++;
  return `${base} (${n})`;
}

function isValidEntry(e: unknown): e is LibraryEntry {
  return !!e && typeof (e as { name: unknown }).name === "string"
            && typeof (e as { code: unknown }).code === "string"
            && (e as { name: string }).name.length > 0;
}

/** Derive a default effect name from video-processor source. Uses the first
 *  top-of-file `// …` comment that is NOT a `//@param` pragma. Returns "" if
 *  no suitable comment is found. */
export function deriveNameFromCode(code: string): string {
  const lines = code.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip @param pragmas — they're declarations, not titles.
    if (/^\/\/\s*@param\b/.test(trimmed)) continue;
    const m = /^\/\/\s*(.+?)\s*$/.exec(trimmed);
    if (m) return m[1];
    // First non-comment, non-blank line: stop searching.
    break;
  }
  return "";
}

export function writePatchLibrary(graph: PatchGraph, nodeIdOrigin: PatchNode, entries: LibraryEntry[]): void {
  writePatchLibraryOnNode(nodeIdOrigin, entries);
  broadcastPatchLibrary(graph, entries);
}
