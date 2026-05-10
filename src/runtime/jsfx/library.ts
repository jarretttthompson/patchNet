/**
 * js~ effect library — single source backed by localStorage.
 *
 * Entries are plain `{name, code}`. Names may use `/` to express a folder
 * hierarchy (e.g. `delay/feedback`) — the dialog groups by the first
 * segment so users can scan a few hundred imported effects without
 * scrolling through a flat list.
 *
 * Earlier versions had a per-patch library (in args[1]) plus a global
 * library; the patch-library was rolled into the single library here.
 */

export interface LibraryEntry {
  name: string;
  code: string;
}

const LIBRARY_STORAGE_KEY = "patchnet-js-global-library";

// ── Library (localStorage) ─────────────────────────────────────────────

export function getGlobalLibrary(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
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
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage may be full or disabled (private browsing).
    // Silent fail — user sees via next read that it didn't stick.
  }
}

// ── List operations ────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────

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

/**
 * Split an entry name into `(category, leaf)`. Slash-separated names map
 * folder-style: `delay/feedback` → category "delay", leaf "feedback".
 * Names without a slash sit under category "" (rendered as "Uncategorized"
 * by the dialog).
 */
export function splitCategory(name: string): { category: string; leaf: string } {
  const idx = name.indexOf("/");
  if (idx < 0) return { category: "", leaf: name };
  return { category: name.slice(0, idx), leaf: name.slice(idx + 1) };
}
