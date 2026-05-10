import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode }  from "../graph/PatchNode";
import { parseJsfx } from "../runtime/jsfx/parser";
import {
  getGlobalLibrary,
  setGlobalLibrary,
  removeEntry,
  renameEntry,
  upsertEntry,
  uniqueName,
  splitCategory,
  deriveNameFromCode,
  type LibraryEntry,
} from "../runtime/jsfx/library";

/**
 * Modal dialog for managing the js~ effect library.
 *
 * Single-library view. Entries are grouped by the first folder segment in
 * their name (e.g. `delay/feedback` → "delay" section) into collapsible
 * sections so the imported Reaper library (200+ entries) is browseable.
 * Backdrop click + Escape both close; click inside the modal body stays.
 */
export class JsEffectLibraryDialog {
  private readonly overlay: HTMLDivElement;
  private readonly listColumn: HTMLDivElement;
  /** Categories whose section is currently expanded. Persists across renders
   *  within a single open dialog so re-rendering after rename/delete doesn't
   *  re-collapse what the user just opened. */
  private readonly expanded = new Set<string>();
  private closeListener: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    /** Called after any library mutation so the parent panel can refresh
     *  its dropdown UI and — if the currently-loaded effect was renamed —
     *  update the title. */
    private readonly onChanged: () => void,
  ) {
    this.listColumn = document.createElement("div");
    this.listColumn.className = "pn-jslib-col";

    this.overlay = this.buildOverlay();
  }

  open(): void {
    document.body.appendChild(this.overlay);
    this.render();
    this.closeListener = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.close();
    };
    document.addEventListener("keydown", this.closeListener);
  }

  close(): void {
    this.overlay.remove();
    if (this.closeListener) {
      document.removeEventListener("keydown", this.closeListener);
      this.closeListener = null;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  private render(): void {
    this.listColumn.textContent = "";

    const entries = getGlobalLibrary();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-jslib-empty";
      empty.textContent = 'empty — click "Import from Reaper" or save an effect from a js~ object';
      this.listColumn.appendChild(empty);
      return;
    }

    // Group by first folder segment.
    const byCategory = new Map<string, LibraryEntry[]>();
    for (const e of entries) {
      const { category } = splitCategory(e.name);
      const list = byCategory.get(category);
      if (list) list.push(e);
      else byCategory.set(category, [e]);
    }
    const categories = Array.from(byCategory.keys()).sort((a, b) => {
      // Uncategorized at the bottom.
      if (a === "" && b !== "") return 1;
      if (b === "" && a !== "") return -1;
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });

    for (const cat of categories) {
      this.listColumn.appendChild(this.buildCategorySection(cat, byCategory.get(cat)!));
    }
  }

  private buildCategorySection(category: string, entries: LibraryEntry[]): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "pn-jslib-section";

    const isOpen = this.expanded.has(category);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "pn-jslib-section-header";
    header.dataset.open = isOpen ? "1" : "0";

    const caret = document.createElement("span");
    caret.className = "pn-jslib-section-caret";
    caret.textContent = isOpen ? "▾" : "▸";

    const label = document.createElement("span");
    label.className = "pn-jslib-section-label";
    label.textContent = category === "" ? "uncategorized" : category;

    const count = document.createElement("span");
    count.className = "pn-jslib-section-count";
    count.textContent = `(${entries.length})`;

    header.append(caret, label, count);
    header.addEventListener("click", () => {
      if (this.expanded.has(category)) this.expanded.delete(category);
      else this.expanded.add(category);
      this.render();
    });
    section.appendChild(header);

    if (isOpen) {
      const list = document.createElement("div");
      list.className = "pn-jslib-list";
      const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      for (const entry of sorted) list.appendChild(this.buildRow(entry));
      section.appendChild(list);
    }

    return section;
  }

  private buildRow(entry: LibraryEntry): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-jslib-row";

    const { leaf } = splitCategory(entry.name);
    const name = document.createElement("span");
    name.className = "pn-jslib-name";
    name.textContent = leaf || entry.name;
    name.title = entry.name + " — double-click to load into this js~ object";
    name.addEventListener("dblclick", () => this.loadFlow(entry));
    row.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "pn-jslib-actions";

    const loadBtn = document.createElement("button");
    loadBtn.className = "pn-jslib-btn pn-jslib-btn-primary";
    loadBtn.type = "button";
    loadBtn.textContent = "load";
    loadBtn.title = "Replace this js~ object's code with the entry's source";
    loadBtn.addEventListener("click", () => this.loadFlow(entry));

    const renameBtn = document.createElement("button");
    renameBtn.className = "pn-jslib-btn";
    renameBtn.type = "button";
    renameBtn.textContent = "rename";
    renameBtn.addEventListener("click", () => this.renameFlow(entry, row, name));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pn-jslib-btn pn-jslib-btn-danger";
    deleteBtn.type = "button";
    deleteBtn.textContent = "delete";
    deleteBtn.addEventListener("click", () => this.deleteFlow(entry));

    actions.append(loadBtn, renameBtn, deleteBtn);
    row.appendChild(actions);
    return row;
  }

  /**
   * Replace this js~ node's source with `entry.code`. Slider values are
   * cleared because the new effect almost certainly has a different slider
   * layout and stale values would map to the wrong knobs. The panel's
   * `syncFromArgs` picks up the change and recompiles automatically.
   */
  private loadFlow(entry: LibraryEntry): void {
    this.patchNode.args[0] = entry.code;
    if (this.patchNode.args[3]) this.patchNode.args[3] = "";
    this.graph.emit("change");
    this.onChanged();
    this.close();
  }

  // ── Flows ───────────────────────────────────────────────────────────

  private renameFlow(entry: LibraryEntry, row: HTMLDivElement, nameEl: HTMLSpanElement): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pn-jslib-name-input";
    input.value = entry.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const proposed = input.value.trim();
      if (proposed && proposed !== entry.name) {
        const entries = getGlobalLibrary();
        const next = renameEntry(entries, entry.name, proposed);
        // renameEntry returns input unchanged if name collides — no-op then.
        if (next !== entries) {
          setGlobalLibrary(next);
          // Keep the new category expanded so the renamed entry stays visible.
          this.expanded.add(splitCategory(proposed).category);
          this.onChanged();
        }
      }
      this.render();
    };
    const cancel = () => this.render();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
    void row;
  }

  private deleteFlow(entry: LibraryEntry): void {
    const confirmed = confirm(`Delete "${entry.name}" from the library?`);
    if (!confirmed) return;
    setGlobalLibrary(removeEntry(getGlobalLibrary(), entry.name));
    this.onChanged();
    this.render();
  }

  // ── DOM scaffolding ─────────────────────────────────────────────────

  private buildOverlay(): HTMLDivElement {
    const overlay = document.createElement("div");
    overlay.className = "pn-jslib-overlay";
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.close();
    });

    const modal = document.createElement("div");
    modal.className = "pn-jslib-modal";

    const header = document.createElement("div");
    header.className = "pn-jslib-modal-header";
    const title = document.createElement("div");
    title.className = "pn-jslib-modal-title";
    title.textContent = "js~ effect library";

    // Import button — pulls .jsfx files from the user's local REAPER
    // Effects folder via the dev-server middleware. Disabled while a
    // request is in flight so impatient double-clicks don't spam imports.
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "pn-jslib-import-btn";
    importBtn.textContent = "Import from Reaper";
    importBtn.title = "Read your local REAPER Effects folder and add every parseable JSFX to the library";
    importBtn.addEventListener("click", () => void this.importFromReaper(importBtn, importStatus));

    const importStatus = document.createElement("span");
    importStatus.className = "pn-jslib-import-status";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pn-jslib-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close (Esc)";
    closeBtn.addEventListener("click", () => this.close());
    header.append(title, importBtn, importStatus, closeBtn);

    const body = document.createElement("div");
    body.className = "pn-jslib-body";
    body.appendChild(this.listColumn);

    modal.append(header, body);
    overlay.appendChild(modal);
    return overlay;
  }

  // ── Import from Reaper ──────────────────────────────────────────────

  private async importFromReaper(
    btn: HTMLButtonElement,
    status: HTMLSpanElement,
  ): Promise<void> {
    btn.disabled = true;
    status.textContent = "Reading…";
    status.classList.remove("is-error");
    try {
      const res = await fetch("/__jsfx-import");
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(errBody.error ?? `Import failed (${res.status})`);
      }
      const data = (await res.json()) as {
        root: string;
        files: Array<{ relpath: string; content: string }>;
        skipped: number;
      };

      // Validate each file by parsing it. Anything that fails the parser is
      // reported in the skip count rather than dumped into the library —
      // imported entries should at least *load* cleanly when picked.
      let entries = getGlobalLibrary();
      let imported = 0;
      let parseFailed = 0;
      for (const file of data.files) {
        const parsed = parseJsfx(file.content);
        if (!parsed.ok) {
          parseFailed += 1;
          continue;
        }
        // Name preference: "folder/filename" so the category split groups
        // by the source subfolder. Falls back to `desc:` only when the
        // file sits at the root with no folder prefix.
        const fallback = file.relpath.replace(/\.[^.]+$/, "");
        const fromDesc = deriveNameFromCode(file.content);
        const base = fallback.includes("/") ? fallback : (fromDesc || fallback);
        const name = uniqueName(base, entries);
        entries = upsertEntry(entries, { name, code: file.content });
        imported += 1;
      }
      setGlobalLibrary(entries);
      this.onChanged();
      this.render();

      const totalSkipped = data.skipped + parseFailed;
      status.textContent =
        `Imported ${imported} from ${data.root}` +
        (totalSkipped > 0 ? ` (${totalSkipped} skipped)` : "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = `Import failed: ${msg}`;
      status.classList.add("is-error");
    } finally {
      btn.disabled = false;
    }
  }
}
