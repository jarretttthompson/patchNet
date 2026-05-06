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
 * "?" matches when e.key === "?", which already accounts for Shift+/ on a
 * US keyboard — chord strings describe what the user types, not which
 * physical keys they press.
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

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform);

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
  const cmd = IS_MAC ? e.metaKey : e.ctrlKey;
  if (cmd) parts.push("Mod");
  if (e.altKey) parts.push("Alt");

  // Shift is only an explicit modifier when the leaf is a non-printable key
  // (Shift+Tab, Shift+ArrowDown). For printable characters the shifted form
  // is already encoded in e.key ("?" not "Shift+/").
  const leaf = leafFromEvent(e);
  const isPrintable = leaf.length === 1;
  if (e.shiftKey && !isPrintable) parts.push("Shift");

  parts.push(leaf.length === 1 ? leaf.toLowerCase() : leaf);
  return parts.join("+");
}

function leafFromEvent(e: KeyboardEvent): string {
  if (e.code === "Space") return "Space";
  return e.key;
}

interface ChordSpec extends ParsedChord {
  raw: string;
}

export class ActionKeymap {
  /** chord string → set of action IDs. Multiple actions can share a chord
   *  if their `enabled(ctx)` predicates make them mutually exclusive. */
  private readonly chordToActions = new Map<string, Set<string>>();
  /** action id → chord specs (parsed from defaultKeys + user overrides). */
  private readonly actionToChords = new Map<string, ChordSpec[]>();

  constructor(private readonly registry: ActionRegistry) {}

  /** Re-read defaultKeys from every registered action and rebuild the map.
   *  Idempotent — call after registering a new batch of actions. */
  rebuildFromDefaults(): void {
    this.chordToActions.clear();
    this.actionToChords.clear();
    for (const action of this.registry.list()) {
      const keys = action.defaultKeys ?? [];
      for (const raw of keys) {
        this.bind(action.id, raw);
      }
    }
  }

  bind(actionId: string, chord: string): void {
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
    specs.push({ ...parsed, raw: chord });
  }

  /** Display strings for a given action — used by the action list UI. */
  shortcutsFor(actionId: string): string[] {
    return (this.actionToChords.get(actionId) ?? []).map((s) => s.raw);
  }

  /** Resolve a keyboard event to candidate action IDs, ordered by registration.
   *  Editable-target gating is the dispatcher's job, not ours — we just
   *  return what matches.
   *  Returns [] if no chord matches. */
  resolve(e: KeyboardEvent): string[] {
    const cmd = IS_MAC ? e.metaKey : e.ctrlKey;
    const canonical = canonicalEvent(e, cmd);
    const set = this.chordToActions.get(canonical);
    return set ? [...set] : [];
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
  // Shift is only meaningful for non-printable leaves
  const isPrintable = p.key.length === 1;
  if (p.shift && !isPrintable) parts.push("shift");
  parts.push(isPrintable ? p.key.toLowerCase() : p.key);
  return parts.join("+");
}

function canonicalEvent(e: KeyboardEvent, cmd: boolean): string {
  const leaf = e.code === "Space" ? "Space" : e.key;
  const isPrintable = leaf.length === 1;
  const parts: string[] = [];
  if (cmd) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && !isPrintable) parts.push("shift");
  parts.push(isPrintable ? leaf.toLowerCase() : leaf);
  return parts.join("+");
}
