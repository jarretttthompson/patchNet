import type { PatchAction } from "./types";

export class ActionRegistry {
  private readonly actions = new Map<string, PatchAction>();

  register(action: PatchAction): void {
    if (this.actions.has(action.id)) {
      throw new Error(`Action already registered: ${action.id}`);
    }
    this.actions.set(action.id, action);
  }

  registerAll(actions: PatchAction[]): void {
    for (const a of actions) this.register(a);
  }

  unregister(id: string): void {
    this.actions.delete(id);
  }

  get(id: string): PatchAction | undefined {
    return this.actions.get(id);
  }

  has(id: string): boolean {
    return this.actions.has(id);
  }

  list(): PatchAction[] {
    return [...this.actions.values()];
  }

  /**
   * Score-and-rank fuzzy match across title, id, category, section, keywords.
   * Empty query returns every action sorted by section then title.
   */
  search(query: string): PatchAction[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return this.list().sort(byDisplayOrder);
    }

    type Scored = { action: PatchAction; score: number };
    const scored: Scored[] = [];
    for (const action of this.actions.values()) {
      const score = scoreAction(action, q);
      if (score > 0) scored.push({ action, score });
    }
    scored.sort((a, b) => b.score - a.score || byDisplayOrder(a.action, b.action));
    return scored.map((s) => s.action);
  }
}

function scoreAction(action: PatchAction, q: string): number {
  const title = action.title.toLowerCase();
  const id = action.id.toLowerCase();
  const section = action.section.toLowerCase();
  const category = (action.category ?? "").toLowerCase();
  const keywords = (action.keywords ?? []).join(" ").toLowerCase();

  if (title === q || id === q) return 1000;
  if (title.startsWith(q)) return 800;
  if (id.startsWith(q)) return 700;

  // Word-boundary contains in title
  if (new RegExp(`\\b${escapeRegExp(q)}`).test(title)) return 600;

  if (title.includes(q)) return 400;
  if (id.includes(q)) return 300;
  if (keywords.includes(q)) return 250;
  if (category.includes(q)) return 200;
  if (section.includes(q)) return 150;

  // Subsequence (every char of q appears in title in order) — typo-tolerant
  if (isSubsequence(q, title)) return 100;

  return 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function byDisplayOrder(a: PatchAction, b: PatchAction): number {
  return a.section.localeCompare(b.section) || a.title.localeCompare(b.title);
}
