/**
 * Chord parsing/normalization and event-to-chord matching for the action
 * system. Keymap stores user-visible chord strings ("Mod+S", "Delete", "?")
 * and matches incoming KeyboardEvents against them.
 *
 * Mod normalization
 * ─────────────────
 * "Mod" resolves to Meta on macOS, Ctrl elsewhere. Both Meta+S and Ctrl+S
 * are matched by "Mod+S" so patches behave the same on both platforms.
 *
 * Printable vs special keys
 * ─────────────────────────
 * Printable leaves match e.key directly (case-insensitive for letters).
 * Explicit shifted-letter bindings ("Shift+T") win over bare-letter
 * bindings ("T"). If no shifted binding exists, shifted bare letters fall
 * back to their unshifted binding so "Q" still matches q or Q.
 *
 * Special leaves match named keys exactly: Escape, Delete, Backspace,
 * Space, Tab, Enter, ArrowUp/Down/Left/Right, Home, End.
 *
 * Editable-target gating
 * ──────────────────────
 * By default, no action fires while the event target is an INPUT,
 * TEXTAREA, SELECT, or contenteditable element. Actions that need to fire
 * while typing must set `runsInEditable: true` (none today).
 */

import type { ActionRegistry } from "./ActionRegistry";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

interface ParsedChord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase for letters, exact for symbols and named keys. */
  key: string;
}

/**
 * Strip modifier prefixes left-to-right; whatever remains is the key.
 * Plain split("+") fails on chords whose key is itself "+" — "Mod++"
 * collapses to ["Mod"] under split + filter(Boolean). Prefix-stripping
 * leaves the literal "+" intact as the key.
 */
function parseChord(chord: string): ParsedChord {
  let mod = false;
  let alt = false;
  let shift = false;
  let rest = chord.trim();

  const prefixes: { re: RegExp; apply: () => void }[] = [
    { re: /^mod\+/i,     apply: () => { mod = true; } },
    { re: /^cmd\+/i,     apply: () => { mod = true; } },
    { re: /^ctrl\+/i,    apply: () => { mod = true; } },
    { re: /^control\+/i, apply: () => { mod = true; } },
    { re: /^meta\+/i,    apply: () => { mod = true; } },
    { re: /^alt\+/i,     apply: () => { alt = true; } },
    { re: /^option\+/i,  apply: () => { alt = true; } },
    { re: /^shift\+/i,   apply: () => { shift = true; } },
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const { re, apply } of prefixes) {
      if (re.test(rest)) {
        rest = rest.replace(re, "");
        apply();
        changed = true;
        break;
      }
    }
  }

  if (!rest) throw new Error(`Invalid chord (no key): "${chord}"`);
  const key = rest.length === 1 ? rest.toLowerCase() : rest;
  return { mod, alt, shift, key };
}

/**
 * Build a canonical chord string from a KeyboardEvent.
 * Used for tests and for deduplication; not for matching directly (use
 * matches() so Mod-on-mac vs Mod-on-PC works correctly).
 */
export function eventToChord(e: KeyboardEvent): string {
  const parts: string[] = [];
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd) parts.push("Mod");
  if (e.altKey) parts.push("Alt");

  const leaf = leafFromEvent(e);
  const isPrintable = leaf.length === 1;
  if (e.shiftKey && shouldPreserveShift(isPrintable, leaf)) parts.push("Shift");

  parts.push(leaf.length === 1 ? leaf.toLowerCase() : leaf);
  return parts.join("+");
}

/**
 * UI-facing chord builder. Same shape as eventToChord but uppercases
 * single-letter leaves (so the user sees "Mod+S" not "Mod+s") and drops
 * pure modifier-only events (no leaf). Returns null while the user is
 * still mid-chord (only a modifier pressed).
 */
export function chordFromEventForUi(e: KeyboardEvent): string | null {
  const leaf = leafFromEvent(e);
  // Skip events where the user is only holding a modifier — wait for the
  // actual leaf key.
  if (leaf === "Meta" || leaf === "Control" || leaf === "Alt" || leaf === "Shift") return null;

  const parts: string[] = [];
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  const isPrintable = leaf.length === 1;
  if (e.shiftKey && shouldPreserveShift(isPrintable, leaf)) parts.push("Shift");
  parts.push(isPrintable ? leaf.toUpperCase() : leaf);
  return parts.join("+");
}

function leafFromEvent(e: KeyboardEvent): string {
  if (e.code === "Space") return "Space";
  return e.key;
}

interface ChordSpec extends ParsedChord {
  raw: string;
  /** "default" = from action.defaultKeys; "user" = added through the UI. */
  source: "default" | "user";
}

/** Persisted shape: per-action additions and removals layered on top of
 *  defaults. Keeps user overrides minimal — if defaults change in code,
 *  unmodified actions automatically pick up the new defaults. */
export interface UserKeymapV1 {
  v: 1;
  /** action id → chord strings the user added on top of defaults. */
  added: Record<string, string[]>;
  /** action id → chord strings the user removed from defaults. */
  removed: Record<string, string[]>;
}

const STORAGE_KEY = "patchnet-keymap-v1";

function emptyOverrides(): UserKeymapV1 {
  return { v: 1, added: {}, removed: {} };
}

export class ActionKeymap {
  /** chord string → set of action IDs. Multiple actions can share a chord
   *  if their `enabled(ctx)` predicates make them mutually exclusive. */
  private readonly chordToActions = new Map<string, Set<string>>();
  /** action id → chord specs (parsed from defaultKeys ± user overrides). */
  private readonly actionToChords = new Map<string, ChordSpec[]>();
  /** User-only layer; survives across sessions via localStorage. */
  private overrides: UserKeymapV1 = emptyOverrides();

  /** Called on any user-driven binding change so the UI can refresh and
   *  the overrides can be flushed to localStorage. */
  onChange?: () => void;

  constructor(private readonly registry: ActionRegistry) {}

  /** Read defaults from registered actions, layer user overrides, build the
   *  resolution map. Idempotent — call after registering new actions or
   *  loading overrides. */
  rebuild(): void {
    this.chordToActions.clear();
    this.actionToChords.clear();
    for (const action of this.registry.list()) {
      const removed = new Set(this.overrides.removed[action.id] ?? []);
      for (const raw of action.defaultKeys ?? []) {
        if (removed.has(raw)) continue;
        this.bindInternal(action.id, raw, "default");
      }
      for (const raw of this.overrides.added[action.id] ?? []) {
        this.bindInternal(action.id, raw, "user");
      }
    }
  }

  /** Backwards-compat alias. */
  rebuildFromDefaults(): void { this.rebuild(); }

  /** Load user overrides from localStorage and rebuild. Safe to call when
   *  storage is unavailable (private browsing) — falls back to defaults. */
  loadUserOverrides(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { this.rebuild(); return; }
      const parsed = JSON.parse(raw) as UserKeymapV1;
      if (parsed && parsed.v === 1) {
        this.overrides = {
          v: 1,
          added: parsed.added ?? {},
          removed: parsed.removed ?? {},
        };
      }
    } catch {
      // corrupt or unavailable — keep defaults
      this.overrides = emptyOverrides();
    }
    this.rebuild();
  }

  private saveOverrides(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.overrides));
    } catch {
      // private browsing / quota — UI keeps working in-memory
    }
  }

  /** Direct binding (no persistence). Used internally during rebuild. */
  bind(actionId: string, chord: string): void {
    this.bindInternal(actionId, chord, "default");
  }

  private bindInternal(actionId: string, chord: string, source: "default" | "user"): void {
    const parsed = parseChord(chord);
    const canonical = canonicalKey(parsed);
    let set = this.chordToActions.get(canonical);
    if (!set) {
      set = new Set();
      this.chordToActions.set(canonical, set);
    }
    set.add(actionId);

    let specs = this.actionToChords.get(actionId);
    if (!specs) {
      specs = [];
      this.actionToChords.set(actionId, specs);
    }
    specs.push({ ...parsed, raw: chord, source });
  }

  /**
   * Add a user binding to an action. Also removes the chord from the
   * "removed" override list if it was a default the user previously deleted.
   * Returns the action IDs the chord was previously bound to (for conflict UI).
   */
  addUserBinding(actionId: string, chord: string): string[] {
    parseChord(chord); // validate early
    const conflicts = this.findActionsForChord(chord).filter((id) => id !== actionId);

    const removed = this.overrides.removed[actionId] ?? [];
    this.overrides.removed[actionId] = removed.filter((c) => c !== chord);
    if (this.overrides.removed[actionId].length === 0) delete this.overrides.removed[actionId];

    const added = this.overrides.added[actionId] ?? [];
    if (!added.includes(chord)) added.push(chord);
    this.overrides.added[actionId] = added;

    this.saveOverrides();
    this.rebuild();
    this.onChange?.();
    return conflicts;
  }

  /**
   * Remove a binding from an action. If the chord was a default, it goes on
   * the removed list. If it was user-added, it leaves the added list.
   */
  removeUserBinding(actionId: string, chord: string): void {
    const wasUserAdded = (this.overrides.added[actionId] ?? []).includes(chord);
    if (wasUserAdded) {
      this.overrides.added[actionId] = this.overrides.added[actionId].filter((c) => c !== chord);
      if (this.overrides.added[actionId].length === 0) delete this.overrides.added[actionId];
    } else {
      const removed = this.overrides.removed[actionId] ?? [];
      if (!removed.includes(chord)) removed.push(chord);
      this.overrides.removed[actionId] = removed;
    }

    this.saveOverrides();
    this.rebuild();
    this.onChange?.();
  }

  /** Drop all user overrides — restores factory defaults. */
  resetUserOverrides(): void {
    this.overrides = emptyOverrides();
    this.saveOverrides();
    this.rebuild();
    this.onChange?.();
  }

  /** Lookup which actions a chord currently resolves to. */
  findActionsForChord(chord: string): string[] {
    const parsed = parseChord(chord);
    const canonical = canonicalKey(parsed);
    return [...(this.chordToActions.get(canonical) ?? [])];
  }

  /** Display strings for a given action — used by the action list UI. */
  shortcutsFor(actionId: string): string[] {
    return (this.actionToChords.get(actionId) ?? []).map((s) => s.raw);
  }

  /** Like shortcutsFor but tagged so UI can render user vs default differently. */
  shortcutSpecsFor(actionId: string): { chord: string; source: "default" | "user" }[] {
    return (this.actionToChords.get(actionId) ?? []).map((s) => ({ chord: s.raw, source: s.source }));
  }

  /** Resolve a keyboard event to candidate action IDs, ordered by registration.
   *  Editable-target gating is the dispatcher's job, not ours — we just
   *  return what matches.
   *  Returns [] if no chord matches. */
  resolve(e: KeyboardEvent): string[] {
    const cmd = e.metaKey || e.ctrlKey;
    const canonical = canonicalEvent(e, cmd);
    const exact = this.chordToActions.get(canonical);
    if (exact) return [...exact];

    const fallback = fallbackCanonicalEvent(e, cmd, canonical);
    if (fallback) {
      const set = this.chordToActions.get(fallback);
      if (set) return [...set];
    }

    return [];
  }

  /** All chords currently bound — for conflict detection in future shortcut UI. */
  allBindings(): { chord: string; actionId: string }[] {
    const out: { chord: string; actionId: string }[] = [];
    for (const [actionId, specs] of this.actionToChords.entries()) {
      for (const s of specs) out.push({ chord: s.raw, actionId });
    }
    return out;
  }
}

function canonicalKey(p: ParsedChord): string {
  const parts: string[] = [];
  if (p.mod) parts.push("mod");
  if (p.alt) parts.push("alt");
  const isPrintable = p.key.length === 1;
  if (p.shift && shouldPreserveShift(isPrintable, p.key)) parts.push("shift");
  parts.push(isPrintable ? p.key.toLowerCase() : p.key);
  return parts.join("+");
}

function canonicalEvent(e: KeyboardEvent, cmd: boolean): string {
  const leaf = e.code === "Space" ? "Space" : e.key;
  const isPrintable = leaf.length === 1;
  const parts: string[] = [];
  if (cmd) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && shouldPreserveShift(isPrintable, leaf)) parts.push("shift");
  parts.push(isPrintable ? leaf.toLowerCase() : leaf);
  return parts.join("+");
}

function fallbackCanonicalEvent(e: KeyboardEvent, cmd: boolean, exact: string): string | null {
  if (!e.shiftKey || cmd || e.altKey) return null;
  const leaf = e.code === "Space" ? "Space" : e.key;
  if (!isLetterLeaf(leaf)) return null;
  const fallback = leaf.toLowerCase();
  return fallback === exact ? null : fallback;
}

function shouldPreserveShift(isPrintable: boolean, leaf: string): boolean {
  return !isPrintable || isLetterLeaf(leaf);
}

function isLetterLeaf(leaf: string): boolean {
  return /^[a-z]$/i.test(leaf);
}
