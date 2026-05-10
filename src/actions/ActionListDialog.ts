import type { ActionRegistry } from "./ActionRegistry";
import type { ActionKeymap } from "./ActionKeymap";
import { chordFromEventForUi } from "./ActionKeymap";
import type { ActionContext, PatchAction } from "./types";

/**
 * REAPER-inspired Actions window.
 *
 * Layout
 * ──────
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Filter [_____________]  [Clear]  Section: [All ▾]          │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Shortcut │ Description                  │ Section          │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ ⌘S        Save patch to file              Application      │
 *   │ ⌘Z        Undo                            Canvas           │
 *   │ …                                                            │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Shortcuts for selected action: Save patch to file          │
 *   │ [⌘S]   [Add shortcut…]  [Delete]                           │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │            [New action…(macros, soon)] [Run] [Run/close] [Close] │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Differences from REAPER worth calling out:
 *   - "New action…" / "Edit action…" defer to milestone 3 (custom macros).
 *     The button is rendered disabled with a tooltip so the affordance is
 *     visible.
 *   - Section dropdown filters by the registry's action.section; values
 *     are derived live from the registry.
 *   - Add shortcut surfaces conflicts inline ("Already bound to <other>.
 *     Replace?") rather than auto-replacing silently.
 */

const STYLE = `
.pn-actionlist-overlay {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  background: rgba(0, 0, 0, 0.32);
}
.pn-actionlist-panel {
  width: min(880px, 92vw);
  height: min(720px, 84vh);
  display: flex;
  flex-direction: column;
  background: var(--pn-surface-raised);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-md);
  box-shadow: var(--pn-shadow-panel);
  font-family: var(--pn-font-mono);
  color: var(--pn-text);
  overflow: hidden;
}
.pn-actionlist-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--pn-surface);
  border-bottom: 1px solid var(--pn-border);
  font-size: var(--pn-type-chip);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pn-accent);
}
.pn-actionlist-titlebar-close {
  background: none;
  border: none;
  color: var(--pn-muted);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
}
.pn-actionlist-titlebar-close:hover { color: var(--pn-text); }

.pn-actionlist-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--pn-border);
}
.pn-actionlist-filter-label,
.pn-actionlist-section-label {
  font-size: var(--pn-type-micro);
  color: var(--pn-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.pn-actionlist-input {
  flex: 1 1 auto;
  background: var(--pn-surface);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-sm);
  padding: 6px 8px;
  color: var(--pn-text);
  font-family: var(--pn-font-mono);
  font-size: 13px;
  caret-color: var(--pn-accent);
  outline: none;
}
.pn-actionlist-input:focus { border-color: var(--pn-accent); }
.pn-actionlist-input::placeholder { color: var(--pn-muted); }

.pn-actionlist-btn {
  background: var(--pn-surface);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-sm);
  padding: 5px 12px;
  color: var(--pn-text);
  font-family: var(--pn-font-mono);
  font-size: var(--pn-type-micro);
  cursor: pointer;
  white-space: nowrap;
}
.pn-actionlist-btn:hover:not(:disabled) {
  border-color: var(--pn-accent);
  color: var(--pn-accent);
}
.pn-actionlist-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pn-actionlist-btn--primary {
  background: var(--pn-accent);
  color: var(--pn-bg);
  border-color: var(--pn-accent);
}
.pn-actionlist-btn--primary:hover:not(:disabled) {
  filter: brightness(1.1);
  color: var(--pn-bg);
}

.pn-actionlist-select {
  background: var(--pn-surface);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-sm);
  padding: 5px 8px;
  color: var(--pn-text);
  font-family: var(--pn-font-mono);
  font-size: var(--pn-type-micro);
  cursor: pointer;
}

.pn-actionlist-table-head {
  display: grid;
  grid-template-columns: 140px 1.4fr 1.2fr 140px;
  gap: 12px;
  padding: 6px 14px;
  background: var(--pn-surface);
  border-bottom: 1px solid var(--pn-border);
  font-size: var(--pn-type-micro);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pn-muted);
}
.pn-actionlist-results {
  flex: 1 1 auto;
  overflow-y: auto;
  background: var(--pn-bg);
}
.pn-actionlist-section {
  display: grid;
  grid-template-columns: 140px 1.4fr 1.2fr 140px;
  gap: 12px;
  padding: 6px 14px;
  background: var(--pn-surface);
  border-top: 1px solid var(--pn-border);
  border-bottom: 1px solid var(--pn-border);
  cursor: pointer;
  user-select: none;
  font-size: var(--pn-type-micro);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pn-muted);
}
.pn-actionlist-section:hover {
  background: var(--pn-hover-accent);
  color: var(--pn-accent);
}
.pn-actionlist-section-caret {
  display: inline-block;
  width: 10px;
  margin-right: 6px;
  color: var(--pn-text-dim);
  transition: transform 0.08s ease-out;
}
.pn-actionlist-section.is-collapsed .pn-actionlist-section-caret {
  transform: rotate(-90deg);
}
.pn-actionlist-section-name {
  color: var(--pn-text);
  text-transform: none;
  letter-spacing: 0.04em;
}
.pn-actionlist-section-count {
  color: var(--pn-muted);
}
.pn-actionlist-row {
  display: grid;
  grid-template-columns: 140px 1.4fr 1.2fr 140px;
  gap: 12px;
  padding: 5px 14px;
  cursor: pointer;
  font-size: var(--pn-type-chip);
  border-bottom: 1px solid color-mix(in srgb, var(--pn-border) 40%, transparent);
}
.pn-actionlist-row:hover { background: var(--pn-hover-accent); }
.pn-actionlist-row.is-active {
  background: var(--pn-hover-accent);
  color: var(--pn-accent);
}
.pn-actionlist-row.is-active .pn-actionlist-cell { color: var(--pn-accent); }
.pn-actionlist-row.is-disabled { opacity: 0.45; cursor: not-allowed; }

.pn-actionlist-cell {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--pn-text);
}
.pn-actionlist-cell--shortcut { color: var(--pn-text-dim); }
.pn-actionlist-cell--section { color: var(--pn-muted); }
/* Terminal-form cell — monospace; the click-to-copy pulse uses --copied. */
.pn-actionlist-cell--terminal {
  color: var(--pn-text-dim);
  font-family: var(--pn-font-mono);
  cursor: copy;
  transition: color 0.12s ease-out;
}
.pn-actionlist-cell--terminal:hover { color: var(--pn-accent); }
.pn-actionlist-cell--terminal.is-copied { color: var(--pn-accent); }

.pn-actionlist-empty {
  padding: 24px 14px;
  color: var(--pn-muted);
  font-size: var(--pn-type-micro);
  text-align: center;
}

.pn-actionlist-shortcuts-panel {
  border-top: 1px solid var(--pn-border);
  padding: 10px 14px;
  background: var(--pn-surface);
}
.pn-actionlist-shortcuts-label {
  font-size: var(--pn-type-micro);
  text-transform: uppercase;
  color: var(--pn-muted);
  letter-spacing: 0.06em;
  margin-bottom: 6px;
}
.pn-actionlist-shortcuts-target {
  color: var(--pn-text);
  text-transform: none;
  letter-spacing: 0;
}
.pn-actionlist-shortcuts-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pn-actionlist-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--pn-bg);
  border: 1px solid var(--pn-border);
  border-radius: 3px;
  padding: 3px 8px;
  font-size: var(--pn-type-micro);
  color: var(--pn-text);
}
.pn-actionlist-chip--user { border-color: var(--pn-accent); color: var(--pn-accent); }
.pn-actionlist-chip-x {
  background: none;
  border: none;
  color: var(--pn-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 0 2px;
  line-height: 1;
}
.pn-actionlist-chip-x:hover { color: var(--pn-text); }

.pn-actionlist-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--pn-border);
}
.pn-actionlist-footer-left,
.pn-actionlist-footer-right {
  display: flex;
  gap: 8px;
}

.pn-actionlist-conflict {
  margin-top: 6px;
  padding: 6px 8px;
  background: color-mix(in srgb, var(--pn-accent) 12%, transparent);
  border: 1px solid var(--pn-accent);
  border-radius: var(--pn-radius-sm);
  font-size: var(--pn-type-micro);
  color: var(--pn-text);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pn-chord-capture {
  position: fixed;
  inset: 0;
  z-index: 340;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
.pn-chord-capture-panel {
  background: var(--pn-surface-raised);
  border: 1px solid var(--pn-accent);
  border-radius: var(--pn-radius-md);
  padding: 24px 32px;
  text-align: center;
  font-family: var(--pn-font-mono);
  color: var(--pn-text);
  min-width: 320px;
}
.pn-chord-capture-prompt {
  font-size: var(--pn-type-micro);
  text-transform: uppercase;
  color: var(--pn-muted);
  letter-spacing: 0.08em;
  margin-bottom: 14px;
}
.pn-chord-capture-display {
  font-size: 22px;
  color: var(--pn-accent);
  margin-bottom: 18px;
  min-height: 30px;
}
.pn-chord-capture-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

/* "New action…" form — sits over the action list overlay. Higher z-index
   than the list itself so the user can confirm/cancel without losing the
   list state underneath. */
.pn-macro-form-overlay {
  position: fixed;
  inset: 0;
  z-index: 340;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  font-family: var(--pn-font-mono);
}
.pn-macro-form-card {
  width: min(560px, 92vw);
  background: var(--pn-surface-raised);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-md);
  box-shadow: var(--pn-shadow-panel);
  padding: 18px;
  color: var(--pn-text);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pn-macro-form-heading {
  margin: 0;
  font-size: var(--pn-type-chip);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--pn-accent);
}
.pn-macro-form-explain {
  margin: 0 0 4px 0;
  font-size: var(--pn-type-micro);
  color: var(--pn-muted);
  line-height: 1.5;
}
.pn-macro-form-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--pn-type-micro);
  color: var(--pn-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
/* Shortcut field row: input + Clear button side-by-side. */
.pn-macro-form-shortcut-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.pn-macro-form-shortcut {
  flex: 1;
  cursor: pointer;
  caret-color: transparent;
}
.pn-macro-form-shortcut.is-capturing {
  border-color: var(--pn-accent);
  background: color-mix(in srgb, var(--pn-accent) 8%, var(--pn-surface));
}
.pn-macro-form-textarea {
  background: var(--pn-surface);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-sm);
  padding: 6px 8px;
  color: var(--pn-text);
  font-family: var(--pn-font-mono);
  font-size: 13px;
  caret-color: var(--pn-accent);
  outline: none;
  resize: vertical;
  min-height: 90px;
}
.pn-macro-form-textarea:focus { border-color: var(--pn-accent); }
.pn-macro-form-error {
  font-size: var(--pn-type-micro);
  color: var(--pn-secondary, #ff7a3c);
  min-height: 16px;
}
.pn-macro-form-buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
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

const ALL_SECTIONS = "__all__";

const COLLAPSE_STORAGE_KEY = "patchnet-actionlist-collapse-v2";

export class ActionListDialog {
  private overlay: HTMLDivElement | null = null;
  private filterInput: HTMLInputElement | null = null;
  private sectionSelect: HTMLSelectElement | null = null;
  private resultsEl: HTMLDivElement | null = null;
  private shortcutsPanelEl: HTMLDivElement | null = null;
  private runBtn: HTMLButtonElement | null = null;
  private runCloseBtn: HTMLButtonElement | null = null;
  /** Filtered set of actions to display (after search + section dropdown). */
  private rows: PatchAction[] = [];
  /** Subset of `rows` actually rendered (children of expanded sections only).
   *  `activeIndex` is an index into this list, not `rows`. */
  private visibleActions: PatchAction[] = [];
  private activeIndex = 0;
  private sectionFilter = ALL_SECTIONS;
  /** Pending conflict surfaced by an Add-shortcut attempt — null while idle. */
  private pendingConflict: { actionId: string; chord: string; conflictIds: string[] } | null = null;
  /** Section names the user has collapsed. Persisted across sessions.
   *  When the filter is non-empty, this is ignored — every section with
   *  matches expands so search results are always reachable. */
  private collapsedSections = new Set<string>();
  /** True only on the first ever render so we can seed default collapse for
   *  any oversized section the user hasn't already touched. */
  private appliedDefaultCollapse = false;
  /** Active "New action…" form overlay, or null when closed. */
  private macroFormOverlay: HTMLDivElement | null = null;

  constructor(
    private readonly registry: ActionRegistry,
    private readonly keymap: ActionKeymap,
    private readonly contextProvider: () => ActionContext,
    private readonly runner: (id: string) => void | Promise<void>,
    /** Programmatic macro creator; when null, the "New action…" footer
     *  button stays disabled. Wired in main.ts to the patch terminal. */
    private readonly macroCreator:
      | ((spec: { name: string; body: string; chord?: string | null }) =>
          { ok: boolean; message: string })
      | null = null,
  ) {
    injectStyles();
    this.keymap.onChange = () => this.refreshShortcutsPanel();
    this.loadCollapseState();
  }

  private loadCollapseState(): void {
    try {
      const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (!raw) { this.appliedDefaultCollapse = false; return; }
      const parsed = JSON.parse(raw) as { v: 1; collapsed: string[]; sawDefault: boolean };
      if (parsed && parsed.v === 1) {
        this.collapsedSections = new Set(parsed.collapsed ?? []);
        // Once defaults have been applied (and possibly modified), stop
        // re-seeding them — preserve whatever the user chose.
        this.appliedDefaultCollapse = !!parsed.sawDefault;
      }
    } catch {
      // private browsing / corrupt — start fresh
    }
  }

  private saveCollapseState(): void {
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify({
        v: 1,
        collapsed: [...this.collapsedSections],
        sawDefault: true,
      }));
    } catch { /* ignore */ }
  }

  /** First-open seeding: every section starts collapsed so the dialog
   *  opens to a clean section list. The user expands the ones they want. */
  private seedDefaultCollapse(rowsBySection: Map<string, PatchAction[]>): void {
    if (this.appliedDefaultCollapse) return;
    for (const section of rowsBySection.keys()) {
      this.collapsedSections.add(section);
    }
    this.appliedDefaultCollapse = true;
    this.saveCollapseState();
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
    panel.setAttribute("aria-label", "Actions");

    panel.appendChild(this.buildTitleBar());
    panel.appendChild(this.buildToolbar());
    panel.appendChild(this.buildTableHead());

    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "pn-actionlist-results";
    panel.appendChild(this.resultsEl);

    this.shortcutsPanelEl = document.createElement("div");
    this.shortcutsPanelEl.className = "pn-actionlist-shortcuts-panel";
    panel.appendChild(this.shortcutsPanelEl);

    panel.appendChild(this.buildFooter());

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    this.refresh();
    this.filterInput?.focus();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.filterInput = null;
    this.sectionSelect = null;
    this.resultsEl = null;
    this.shortcutsPanelEl = null;
    this.runBtn = null;
    this.runCloseBtn = null;
    this.rows = [];
    this.visibleActions = [];
    this.activeIndex = 0;
    this.pendingConflict = null;
  }

  // ── Top chrome ──────────────────────────────────────────────────────

  private buildTitleBar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "pn-actionlist-titlebar";

    const title = document.createElement("span");
    title.textContent = "Actions";
    bar.appendChild(title);

    const close = document.createElement("button");
    close.className = "pn-actionlist-titlebar-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", () => this.close());
    bar.appendChild(close);

    return bar;
  }

  private buildToolbar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "pn-actionlist-toolbar";

    const filterLabel = document.createElement("span");
    filterLabel.className = "pn-actionlist-filter-label";
    filterLabel.textContent = "Filter";
    bar.appendChild(filterLabel);

    this.filterInput = document.createElement("input");
    this.filterInput.className = "pn-actionlist-input";
    this.filterInput.placeholder = "search…";
    this.filterInput.autocomplete = "off";
    this.filterInput.spellcheck = false;
    this.filterInput.addEventListener("input", () => this.refresh());
    this.filterInput.addEventListener("keydown", (e) => this.handleInputKey(e));
    bar.appendChild(this.filterInput);

    const clearBtn = document.createElement("button");
    clearBtn.className = "pn-actionlist-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      if (this.filterInput) {
        this.filterInput.value = "";
        this.refresh();
        this.filterInput.focus();
      }
    });
    bar.appendChild(clearBtn);

    const sectionLabel = document.createElement("span");
    sectionLabel.className = "pn-actionlist-section-label";
    sectionLabel.textContent = "Section:";
    bar.appendChild(sectionLabel);

    this.sectionSelect = document.createElement("select");
    this.sectionSelect.className = "pn-actionlist-select";
    this.sectionSelect.appendChild(this.makeOption(ALL_SECTIONS, "All"));
    const sections = [...new Set(this.registry.list().map((a) => a.section))].sort();
    for (const section of sections) {
      this.sectionSelect.appendChild(this.makeOption(section, section));
    }
    this.sectionSelect.value = this.sectionFilter;
    this.sectionSelect.addEventListener("change", () => {
      this.sectionFilter = this.sectionSelect!.value;
      this.refresh();
    });
    bar.appendChild(this.sectionSelect);

    return bar;
  }

  private makeOption(value: string, label: string): HTMLOptionElement {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  private buildTableHead(): HTMLDivElement {
    const head = document.createElement("div");
    head.className = "pn-actionlist-table-head";

    for (const label of ["Shortcut", "Description", "Terminal", "Section"]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      head.appendChild(cell);
    }
    return head;
  }

  private buildFooter(): HTMLDivElement {
    const foot = document.createElement("div");
    foot.className = "pn-actionlist-footer";

    const left = document.createElement("div");
    left.className = "pn-actionlist-footer-left";

    const newAction = document.createElement("button");
    newAction.className = "pn-actionlist-btn";
    newAction.textContent = "New action…";
    if (this.macroCreator) {
      newAction.title = "Define a custom action by typing terminal commands";
      newAction.addEventListener("click", () => this.openMacroForm());
    } else {
      newAction.disabled = true;
      newAction.title = "Custom macros need a wired patch terminal";
    }
    left.appendChild(newAction);

    foot.appendChild(left);

    const right = document.createElement("div");
    right.className = "pn-actionlist-footer-right";

    this.runBtn = document.createElement("button");
    this.runBtn.className = "pn-actionlist-btn";
    this.runBtn.textContent = "Run";
    this.runBtn.title = "Run selected action without closing the dialog";
    this.runBtn.addEventListener("click", () => this.runActive(false));
    right.appendChild(this.runBtn);

    this.runCloseBtn = document.createElement("button");
    this.runCloseBtn.className = "pn-actionlist-btn pn-actionlist-btn--primary";
    this.runCloseBtn.textContent = "Run/close";
    this.runCloseBtn.title = "Run selected action and close (Enter)";
    this.runCloseBtn.addEventListener("click", () => this.runActive(true));
    right.appendChild(this.runCloseBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "pn-actionlist-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => this.close());
    right.appendChild(closeBtn);

    foot.appendChild(right);
    return foot;
  }

  // ── New-action (macro) form ────────────────────────────────────────

  private openMacroForm(): void {
    if (this.macroFormOverlay || !this.macroCreator) return;

    const overlay = document.createElement("div");
    overlay.className = "pn-macro-form-overlay";

    const card = document.createElement("div");
    card.className = "pn-macro-form-card";

    const heading = document.createElement("h3");
    heading.className = "pn-macro-form-heading";
    heading.textContent = "New action";
    card.appendChild(heading);

    const explain = document.createElement("p");
    explain.className = "pn-macro-form-explain";
    explain.textContent =
      "Type a name, an optional keyboard shortcut, and one or more terminal commands. " +
      "Steps can be separated by ‘;’ or by line break. Cmd+Enter saves; Esc cancels.";
    card.appendChild(explain);

    const nameField = this.buildLabeledInput(card, "Name", "", "input");

    // Keyboard-shortcut field captures keystrokes instead of typed characters:
    // focus it, press a chord (e.g. Cmd+K), and the canonical form fills the
    // input. We keep the displayed form (prettyChord) and the raw form
    // (engine input) in sync via the closure variable below.
    const chordWrap = document.createElement("label");
    chordWrap.className = "pn-macro-form-label";
    chordWrap.textContent = "Keyboard shortcut (optional)";
    const chordRow = document.createElement("div");
    chordRow.className = "pn-macro-form-shortcut-row";
    const chordField = document.createElement("input");
    chordField.className = "pn-actionlist-input pn-macro-form-shortcut";
    chordField.readOnly = true;
    chordField.placeholder = "Click here, then press a key combination";
    const clearChordBtn = document.createElement("button");
    clearChordBtn.type = "button";
    clearChordBtn.className = "pn-actionlist-btn";
    clearChordBtn.textContent = "Clear";
    chordRow.appendChild(chordField);
    chordRow.appendChild(clearChordBtn);
    chordWrap.appendChild(chordRow);
    card.appendChild(chordWrap);
    let capturedShortcut: string | null = null;
    const setShortcut = (raw: string | null) => {
      capturedShortcut = raw;
      chordField.value = raw ? prettyChord(raw) : "";
    };
    clearChordBtn.addEventListener("click", () => {
      setShortcut(null);
      chordField.focus();
    });
    chordField.addEventListener("focus", () => chordField.classList.add("is-capturing"));
    chordField.addEventListener("blur", () => chordField.classList.remove("is-capturing"));
    chordField.addEventListener("keydown", (e: Event) => {
      const event = e as KeyboardEvent;
      // Plain Tab / Shift+Tab keep their normal "move between fields" role
      // so the user can navigate out of the capture field.
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
      // Cmd/Ctrl+Enter is reserved for the form's "save" shortcut so it must
      // not be captured as a keyboard binding.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return;
      // Plain Escape clears the field when one is captured; otherwise it
      // falls through so the form's outer Esc-handler closes the dialog.
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey
          && !event.shiftKey && capturedShortcut) {
        event.preventDefault();
        event.stopPropagation();
        setShortcut(null);
        return;
      }
      const captured = chordFromEventForUi(event);
      if (!captured) return; // user is still mid-chord (only modifier down)
      event.preventDefault();
      event.stopPropagation();
      setShortcut(captured);
    });

    const bodyField = this.buildLabeledInput(card, "Terminal commands", "", "textarea") as HTMLTextAreaElement;

    const errorBox = document.createElement("div");
    errorBox.className = "pn-macro-form-error";
    card.appendChild(errorBox);

    const buttons = document.createElement("div");
    buttons.className = "pn-macro-form-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "pn-actionlist-btn";
    cancelBtn.textContent = "Cancel";
    buttons.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "pn-actionlist-btn pn-actionlist-btn--primary";
    saveBtn.textContent = "Save";
    buttons.appendChild(saveBtn);

    card.appendChild(buttons);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.macroFormOverlay = overlay;
    nameField.focus();

    const close = () => this.closeMacroForm();
    cancelBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    const submit = () => {
      const creator = this.macroCreator;
      if (!creator) return;
      errorBox.textContent = "";
      const name = nameField.value.trim();
      const chord = capturedShortcut;
      // Normalize multi-line input: split on newlines OR `;`, drop empties,
      // re-join with `;` so the engine parses the same way the user wrote
      // the body whether they used returns or semicolons.
      const body = bodyField.value
        .split(/[\n;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ; ");
      if (!name) { errorBox.textContent = "Name is required"; return; }
      if (!body) { errorBox.textContent = "Body is required"; return; }
      let result: { ok: boolean; message: string };
      try {
        result = creator({ name, body, chord });
      } catch (err) {
        errorBox.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
      if (!result.ok) {
        errorBox.textContent = result.message;
        return;
      }
      close();
      this.refresh();
      // Surface the new macro at the top of the visible list by filtering on
      // its name, then highlight the first row so a follow-up Run/keybind
      // works without extra clicks.
      if (this.filterInput) {
        this.filterInput.value = name;
        this.refresh();
        this.activeIndex = 0;
        this.applyActiveHighlight();
      }
    };
    saveBtn.addEventListener("click", submit);
    const onKey = (rawEvent: Event) => {
      const e = rawEvent as KeyboardEvent;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    };
    nameField.addEventListener("keydown", onKey);
    chordField.addEventListener("keydown", onKey);
    bodyField.addEventListener("keydown", onKey);
  }

  private closeMacroForm(): void {
    if (!this.macroFormOverlay) return;
    this.macroFormOverlay.remove();
    this.macroFormOverlay = null;
  }

  private buildLabeledInput(
    parent: HTMLElement,
    label: string,
    placeholder: string,
    kind: "input" | "textarea",
  ): HTMLInputElement | HTMLTextAreaElement {
    const wrap = document.createElement("label");
    wrap.className = "pn-macro-form-label";
    wrap.textContent = label;
    const field = document.createElement(kind === "input" ? "input" : "textarea") as
      HTMLInputElement | HTMLTextAreaElement;
    field.className = kind === "input"
      ? "pn-actionlist-input"
      : "pn-actionlist-input pn-macro-form-textarea";
    field.placeholder = placeholder;
    if (kind === "textarea") (field as HTMLTextAreaElement).rows = 5;
    wrap.appendChild(field);
    parent.appendChild(wrap);
    return field;
  }

  // ── Refresh / render ───────────────────────────────────────────────

  private refresh(): void {
    if (!this.filterInput || !this.resultsEl) return;
    const matches = this.registry.search(this.filterInput.value).filter((a) => {
      if (this.sectionFilter === ALL_SECTIONS) return true;
      return a.section === this.sectionFilter;
    });
    this.rows = matches;
    this.pendingConflict = null;
    // renderResults rebuilds visibleActions and clamps activeIndex.
    this.renderResults();
    this.refreshShortcutsPanel();
  }

  private renderResults(): void {
    if (!this.resultsEl) return;
    this.resultsEl.textContent = "";

    if (this.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-actionlist-empty";
      empty.textContent = "no matches";
      this.resultsEl.appendChild(empty);
      this.visibleActions = [];
      this.updateRunButtons(null);
      return;
    }

    // Group filtered rows by section, preserving registry sort within groups.
    const groups = new Map<string, PatchAction[]>();
    for (const action of this.rows) {
      let bucket = groups.get(action.section);
      if (!bucket) { bucket = []; groups.set(action.section, bucket); }
      bucket.push(action);
    }
    this.seedDefaultCollapse(groups);

    const filterIsActive = (this.filterInput?.value ?? "").trim() !== "";

    // Carry forward selection by id so toggling collapse / refiltering doesn't
    // jump the highlight to row zero on every keystroke.
    const previouslyActive = this.visibleActions[this.activeIndex] ?? null;

    const ctx = this.contextProvider();
    this.visibleActions = [];

    const sortedSections = [...groups.keys()].sort();
    for (const section of sortedSections) {
      const actions = groups.get(section)!;
      // While filtering, force-expand every matching section so search
      // results are always visible — but don't mutate the user's saved
      // state; just present an expanded view.
      const collapsed = !filterIsActive && this.collapsedSections.has(section);
      this.resultsEl.appendChild(this.buildSectionHeader(section, actions.length, collapsed));
      if (collapsed) continue;

      for (const action of actions) {
        this.visibleActions.push(action);
        this.resultsEl.appendChild(this.buildActionRow(action, ctx));
      }
    }

    // Restore highlight to the same action if it's still visible; otherwise
    // fall back to the first row.
    if (previouslyActive) {
      const idx = this.visibleActions.indexOf(previouslyActive);
      this.activeIndex = idx >= 0 ? idx : 0;
    } else {
      this.activeIndex = 0;
    }
    this.applyActiveHighlight();

    this.updateRunButtons(this.visibleActions[this.activeIndex] ?? null);
  }

  private buildSectionHeader(section: string, count: number, collapsed: boolean): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "pn-actionlist-section" + (collapsed ? " is-collapsed" : "");
    header.setAttribute("role", "button");
    header.setAttribute("aria-expanded", String(!collapsed));

    const left = document.createElement("span");
    const caret = document.createElement("span");
    caret.className = "pn-actionlist-section-caret";
    caret.textContent = "▼";
    left.appendChild(caret);
    const name = document.createElement("span");
    name.className = "pn-actionlist-section-name";
    name.textContent = section;
    left.appendChild(name);
    header.appendChild(left);

    // Spacer so the count column lines up with the description column.
    header.appendChild(document.createElement("span"));

    const countEl = document.createElement("span");
    countEl.className = "pn-actionlist-section-count";
    countEl.textContent = `${count} action${count === 1 ? "" : "s"}`;
    header.appendChild(countEl);

    header.addEventListener("mousedown", (e) => {
      // Keep the filter input focused (chord-capture path needs it).
      e.preventDefault();
    });
    header.addEventListener("click", () => this.toggleSection(section));
    return header;
  }

  private buildActionRow(action: PatchAction, ctx: ActionContext): HTMLDivElement {
    const disabled = action.enabled ? !action.enabled(ctx) : false;
    const row = document.createElement("div");
    row.className = "pn-actionlist-row";
    row.dataset.actionId = action.id;
    if (disabled) row.classList.add("is-disabled");

    const shortcuts = this.keymap.shortcutsFor(action.id);
    const shortcutCell = document.createElement("span");
    shortcutCell.className = "pn-actionlist-cell pn-actionlist-cell--shortcut";
    shortcutCell.textContent = shortcuts.length > 0 ? prettyChord(shortcuts[0]) : "";
    row.appendChild(shortcutCell);

    const descCell = document.createElement("span");
    descCell.className = "pn-actionlist-cell";
    descCell.textContent = action.title;
    row.appendChild(descCell);

    const terminalCell = document.createElement("span");
    terminalCell.className = "pn-actionlist-cell pn-actionlist-cell--terminal";
    const terminalText = `/run ${action.title}`;
    terminalCell.textContent = terminalText;
    terminalCell.title = "Click to copy";
    terminalCell.addEventListener("click", (e) => {
      // Don't let the copy click bubble into the row click (which selects /
      // the dblclick path).
      e.stopPropagation();
      void navigator.clipboard?.writeText(terminalText).then(() => {
        terminalCell.classList.add("is-copied");
        setTimeout(() => terminalCell.classList.remove("is-copied"), 600);
      });
    });
    row.appendChild(terminalCell);

    const sectionCell = document.createElement("span");
    sectionCell.className = "pn-actionlist-cell pn-actionlist-cell--section";
    sectionCell.textContent = [action.section, action.category].filter(Boolean).join(" · ");
    row.appendChild(sectionCell);

    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => {
      const idx = this.visibleActions.indexOf(action);
      if (idx >= 0) {
        this.activeIndex = idx;
        this.pendingConflict = null;
        this.applyActiveHighlight();
        this.refreshShortcutsPanel();
        this.updateRunButtons(action);
      }
    });
    row.addEventListener("dblclick", () => {
      if (!disabled) this.runActive(true);
    });

    return row;
  }

  /** Toggle visual highlight without rebuilding the DOM — keeps scroll
   *  position stable when the user moves through rows with arrow keys. */
  private applyActiveHighlight(): void {
    if (!this.resultsEl) return;
    const rows = this.resultsEl.querySelectorAll<HTMLElement>(".pn-actionlist-row");
    rows.forEach((row, i) => {
      row.classList.toggle("is-active", i === this.activeIndex);
    });
  }

  private toggleSection(section: string): void {
    if (this.collapsedSections.has(section)) {
      this.collapsedSections.delete(section);
    } else {
      this.collapsedSections.add(section);
    }
    this.saveCollapseState();
    this.renderResults();
    this.refreshShortcutsPanel();
  }

  private updateRunButtons(action: PatchAction | null): void {
    if (!this.runBtn || !this.runCloseBtn) return;
    const ctx = this.contextProvider();
    const disabled = !action || (action.enabled ? !action.enabled(ctx) : false);
    this.runBtn.disabled = disabled;
    this.runCloseBtn.disabled = disabled;
  }

  private refreshShortcutsPanel(): void {
    if (!this.shortcutsPanelEl) return;
    this.shortcutsPanelEl.textContent = "";

    const action = this.visibleActions[this.activeIndex];

    const label = document.createElement("div");
    label.className = "pn-actionlist-shortcuts-label";
    label.textContent = "Shortcuts for selected action: ";
    if (action) {
      const target = document.createElement("span");
      target.className = "pn-actionlist-shortcuts-target";
      target.textContent = action.title;
      label.appendChild(target);
    }
    this.shortcutsPanelEl.appendChild(label);

    const row = document.createElement("div");
    row.className = "pn-actionlist-shortcuts-row";

    if (action) {
      const specs = this.keymap.shortcutSpecsFor(action.id);
      if (specs.length === 0) {
        const empty = document.createElement("span");
        empty.className = "pn-actionlist-cell--section";
        empty.textContent = "(none)";
        row.appendChild(empty);
      } else {
        for (const { chord, source } of specs) {
          const chip = document.createElement("span");
          chip.className = "pn-actionlist-chip" + (source === "user" ? " pn-actionlist-chip--user" : "");
          const text = document.createElement("span");
          text.textContent = prettyChord(chord);
          chip.appendChild(text);
          const x = document.createElement("button");
          x.className = "pn-actionlist-chip-x";
          x.textContent = "×";
          x.title = source === "default" ? "Remove (default chord)" : "Remove";
          x.addEventListener("click", () => {
            this.keymap.removeUserBinding(action.id, chord);
          });
          chip.appendChild(x);
          row.appendChild(chip);
        }
      }

      const addBtn = document.createElement("button");
      addBtn.className = "pn-actionlist-btn";
      addBtn.textContent = "Add shortcut…";
      addBtn.addEventListener("click", () => this.startChordCapture(action));
      row.appendChild(addBtn);
    }

    this.shortcutsPanelEl.appendChild(row);

    if (this.pendingConflict && action && this.pendingConflict.actionId === action.id) {
      this.shortcutsPanelEl.appendChild(this.buildConflictBanner());
    }
  }

  private buildConflictBanner(): HTMLDivElement {
    const banner = document.createElement("div");
    banner.className = "pn-actionlist-conflict";
    if (!this.pendingConflict) return banner;

    const { chord, conflictIds } = this.pendingConflict;
    const others = conflictIds
      .map((id) => this.registry.get(id)?.title ?? id)
      .join(", ");

    const text = document.createElement("span");
    text.textContent = `${prettyChord(chord)} is also bound to ${others}.`;
    banner.appendChild(text);

    const keep = document.createElement("button");
    keep.className = "pn-actionlist-btn";
    keep.textContent = "Keep both";
    keep.title = "Both actions stay bound; the first one matched at runtime wins";
    keep.addEventListener("click", () => {
      this.pendingConflict = null;
      this.refreshShortcutsPanel();
    });
    banner.appendChild(keep);

    const replace = document.createElement("button");
    replace.className = "pn-actionlist-btn pn-actionlist-btn--primary";
    replace.textContent = "Replace";
    replace.addEventListener("click", () => {
      if (!this.pendingConflict) return;
      const { chord, conflictIds } = this.pendingConflict;
      for (const otherId of conflictIds) {
        this.keymap.removeUserBinding(otherId, chord);
      }
      this.pendingConflict = null;
      this.refreshShortcutsPanel();
    });
    banner.appendChild(replace);

    return banner;
  }

  // ── Chord capture ──────────────────────────────────────────────────

  private startChordCapture(action: PatchAction): void {
    const overlay = document.createElement("div");
    overlay.className = "pn-chord-capture";

    const panel = document.createElement("div");
    panel.className = "pn-chord-capture-panel";

    const prompt = document.createElement("div");
    prompt.className = "pn-chord-capture-prompt";
    prompt.textContent = `Press a shortcut for "${action.title}"`;
    panel.appendChild(prompt);

    const display = document.createElement("div");
    display.className = "pn-chord-capture-display";
    display.textContent = "(waiting…)";
    panel.appendChild(display);

    const actions = document.createElement("div");
    actions.className = "pn-chord-capture-actions";

    const cancel = document.createElement("button");
    cancel.className = "pn-actionlist-btn";
    cancel.textContent = "Cancel";

    const ok = document.createElement("button");
    ok.className = "pn-actionlist-btn pn-actionlist-btn--primary";
    ok.textContent = "OK";
    ok.disabled = true;

    actions.appendChild(cancel);
    actions.appendChild(ok);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let captured: string | null = null;

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Cancel/confirm via dedicated keys are explicit clicks only; otherwise
      // the user couldn't bind Escape/Enter as a shortcut.
      const chord = chordFromEventForUi(e);
      if (chord) {
        captured = chord;
        display.textContent = prettyChord(chord);
        ok.disabled = false;
      }
    };

    const finish = (commit: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (commit && captured) {
        const conflicts = this.keymap.addUserBinding(action.id, captured);
        if (conflicts.length > 0) {
          this.pendingConflict = { actionId: action.id, chord: captured, conflictIds: conflicts };
        }
        this.refreshShortcutsPanel();
        this.renderResults();
      }
    };

    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(false); });

    document.addEventListener("keydown", onKey, true);
  }

  // ── Keyboard nav inside the dialog ─────────────────────────────────

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
      this.runActive(true);
    }
  }

  private move(delta: number): void {
    if (this.visibleActions.length === 0) return;
    this.activeIndex = (this.activeIndex + delta + this.visibleActions.length) % this.visibleActions.length;
    this.pendingConflict = null;
    this.applyActiveHighlight();
    this.refreshShortcutsPanel();
    this.updateRunButtons(this.visibleActions[this.activeIndex]);

    const rows = this.resultsEl?.querySelectorAll<HTMLElement>(".pn-actionlist-row");
    rows?.[this.activeIndex]?.scrollIntoView({ block: "nearest" });
  }

  private runActive(closeAfter: boolean): void {
    const action = this.visibleActions[this.activeIndex];
    if (!action) return;
    const ctx = this.contextProvider();
    if (action.enabled && !action.enabled(ctx)) return;
    if (closeAfter) this.close();
    void this.runner(action.id);
  }
}
