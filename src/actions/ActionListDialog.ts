import type { ActionRegistry } from "./ActionRegistry";
import type { ActionKeymap } from "./ActionKeymap";
import type { ActionContext, PatchAction } from "./types";

const STYLE = `
.pn-actionlist-overlay {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.32);
}
.pn-actionlist-panel {
  width: min(620px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--pn-surface-raised);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-md);
  box-shadow: var(--pn-shadow-panel);
  font-family: var(--pn-font-mono);
  color: var(--pn-text);
}
.pn-actionlist-search {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--pn-border);
}
.pn-actionlist-input {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--pn-text);
  font-family: var(--pn-font-mono);
  font-size: 14px;
  caret-color: var(--pn-accent);
}
.pn-actionlist-input::placeholder {
  color: var(--pn-muted);
}
.pn-actionlist-results {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 6px 0;
}
.pn-actionlist-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: var(--pn-type-chip);
}
.pn-actionlist-row.is-active {
  background: var(--pn-hover-accent);
  color: var(--pn-accent);
}
.pn-actionlist-row.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pn-actionlist-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pn-actionlist-title-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--pn-text);
}
.pn-actionlist-row.is-active .pn-actionlist-title-line {
  color: var(--pn-accent);
}
.pn-actionlist-meta {
  font-size: var(--pn-type-micro);
  color: var(--pn-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pn-actionlist-shortcut {
  display: flex;
  gap: 4px;
  align-items: center;
}
.pn-actionlist-key {
  font-size: var(--pn-type-micro);
  color: var(--pn-text-dim);
  border: 1px solid var(--pn-border);
  border-radius: 3px;
  padding: 1px 6px;
  white-space: nowrap;
}
.pn-actionlist-empty {
  padding: 24px 14px;
  color: var(--pn-muted);
  font-size: var(--pn-type-micro);
  text-align: center;
}
`;

function injectStyles(): void {
  if (document.getElementById("pn-actionlist-styles")) return;
  const el = document.createElement("style");
  el.id = "pn-actionlist-styles";
  el.textContent = STYLE;
  document.head.appendChild(el);
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

function prettyChord(raw: string): string {
  return raw.split("+").map((p) => {
    const lc = p.toLowerCase();
    if (lc === "mod") return IS_MAC ? "⌘" : "Ctrl";
    if (lc === "alt") return IS_MAC ? "⌥" : "Alt";
    if (lc === "shift") return IS_MAC ? "⇧" : "Shift";
    if (p.length === 1) return p.toUpperCase();
    return p;
  }).join(IS_MAC ? "" : "+");
}

export class ActionListDialog {
  private overlay: HTMLDivElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsEl: HTMLDivElement | null = null;
  private rows: PatchAction[] = [];
  private activeIndex = 0;

  constructor(
    private readonly registry: ActionRegistry,
    private readonly keymap: ActionKeymap,
    private readonly contextProvider: () => ActionContext,
    private readonly runner: (id: string) => void | Promise<void>,
  ) {
    injectStyles();
  }

  toggle(): void {
    this.overlay ? this.close() : this.open();
  }

  open(): void {
    if (this.overlay) return;

    const overlay = document.createElement("div");
    overlay.className = "pn-actionlist-overlay";
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.close();
    });

    const panel = document.createElement("div");
    panel.className = "pn-actionlist-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Action list");

    const searchWrap = document.createElement("div");
    searchWrap.className = "pn-actionlist-search";
    const input = document.createElement("input");
    input.className = "pn-actionlist-input";
    input.placeholder = "Search actions…";
    input.autocomplete = "off";
    input.spellcheck = false;
    searchWrap.appendChild(input);

    const results = document.createElement("div");
    results.className = "pn-actionlist-results";

    panel.appendChild(searchWrap);
    panel.appendChild(results);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.input = input;
    this.resultsEl = results;

    input.addEventListener("input", () => this.refresh());
    input.addEventListener("keydown", (e) => this.handleInputKey(e));

    this.refresh();
    input.focus();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.input = null;
    this.resultsEl = null;
    this.rows = [];
    this.activeIndex = 0;
  }

  private refresh(): void {
    if (!this.input || !this.resultsEl) return;
    const ctx = this.contextProvider();
    const matches = this.registry.search(this.input.value);
    this.rows = matches;
    this.activeIndex = 0;
    this.renderResults(ctx);
  }

  private renderResults(ctx: ActionContext): void {
    if (!this.resultsEl) return;
    this.resultsEl.textContent = "";

    if (this.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-actionlist-empty";
      empty.textContent = "no matches";
      this.resultsEl.appendChild(empty);
      return;
    }

    this.rows.forEach((action, i) => {
      const disabled = action.enabled ? !action.enabled(ctx) : false;
      const row = document.createElement("div");
      row.className = "pn-actionlist-row";
      if (i === this.activeIndex) row.classList.add("is-active");
      if (disabled) row.classList.add("is-disabled");

      const titleCol = document.createElement("div");
      titleCol.className = "pn-actionlist-title";

      const titleLine = document.createElement("div");
      titleLine.className = "pn-actionlist-title-line";
      titleLine.textContent = action.title;
      titleCol.appendChild(titleLine);

      const meta = document.createElement("div");
      meta.className = "pn-actionlist-meta";
      const metaParts = [action.section];
      if (action.category) metaParts.push(action.category);
      metaParts.push(action.id);
      meta.textContent = metaParts.join("  ·  ");
      titleCol.appendChild(meta);

      row.appendChild(titleCol);

      const shortcuts = this.keymap.shortcutsFor(action.id);
      if (shortcuts.length > 0) {
        const sc = document.createElement("div");
        sc.className = "pn-actionlist-shortcut";
        for (const raw of shortcuts) {
          const k = document.createElement("span");
          k.className = "pn-actionlist-key";
          k.textContent = prettyChord(raw);
          sc.appendChild(k);
        }
        row.appendChild(sc);
      }

      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus on input
      });
      row.addEventListener("click", () => {
        if (disabled) return;
        this.runActive(i);
      });

      this.resultsEl!.appendChild(row);
    });
  }

  private handleInputKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.runActive(this.activeIndex);
    }
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.activeIndex = (this.activeIndex + delta + this.rows.length) % this.rows.length;
    const ctx = this.contextProvider();
    this.renderResults(ctx);

    const rows = this.resultsEl?.querySelectorAll<HTMLElement>(".pn-actionlist-row");
    rows?.[this.activeIndex]?.scrollIntoView({ block: "nearest" });
  }

  private runActive(index: number): void {
    const action = this.rows[index];
    if (!action) return;
    const ctx = this.contextProvider();
    if (action.enabled && !action.enabled(ctx)) return;
    this.close();
    void this.runner(action.id);
  }
}
