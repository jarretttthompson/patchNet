import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode }  from "../graph/PatchNode";
import {
  getPatchLibrary,
  getGlobalLibrary,
  setGlobalLibrary,
  writePatchLibrary,
  removeEntry,
  renameEntry,
  upsertEntry,
  uniqueName,
  type LibraryEntry,
} from "../runtime/jsfx/library";

/**
 * Modal dialog for managing the js~ effect library.
 *
 * Two-column view (patch left, global right). Each row has rename / delete
 * / move-to-other-scope actions. Mirrors ImageFXPanel's overlay pattern:
 * backdrop click + Escape both close; click inside the modal body stays.
 */
export class JsEffectLibraryDialog {
  private readonly overlay: HTMLDivElement;
  private readonly patchColumn: HTMLDivElement;
  private readonly globalColumn: HTMLDivElement;
  private closeListener: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    /** Called after any library mutation so the parent panel can refresh
     *  its dropdown UI and — if the currently-loaded effect was renamed —
     *  update the title. */
    private readonly onChanged: () => void,
  ) {
    this.patchColumn  = document.createElement("div");
    this.patchColumn.className = "pn-jslib-col";
    this.globalColumn = document.createElement("div");
    this.globalColumn.className = "pn-jslib-col";

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
    this.renderColumn(this.patchColumn,  "patch",  getPatchLibrary(this.patchNode));
    this.renderColumn(this.globalColumn, "global", getGlobalLibrary());
  }

  private renderColumn(root: HTMLDivElement, scope: "patch" | "global", entries: LibraryEntry[]): void {
    root.textContent = "";

    const heading = document.createElement("div");
    heading.className = "pn-jslib-col-heading";
    heading.textContent = scope === "patch" ? "patch library" : "global library";
    root.appendChild(heading);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-jslib-empty";
      empty.textContent = "empty";
      root.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "pn-jslib-list";
    // Alphabetical, case-insensitive.
    const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const entry of sorted) {
      list.appendChild(this.buildRow(entry, scope));
    }
    root.appendChild(list);
  }

  private buildRow(entry: LibraryEntry, scope: "patch" | "global"): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-jslib-row";

    const name = document.createElement("span");
    name.className = "pn-jslib-name";
    name.textContent = entry.name;
    row.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "pn-jslib-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "pn-jslib-btn";
    renameBtn.type = "button";
    renameBtn.textContent = "rename";
    renameBtn.addEventListener("click", () => this.renameFlow(entry, scope, row, name));

    const moveBtn = document.createElement("button");
    moveBtn.className = "pn-jslib-btn";
    moveBtn.type = "button";
    moveBtn.textContent = scope === "patch" ? "→ global" : "→ patch";
    moveBtn.title = scope === "patch" ? "copy to global library" : "copy to patch library";
    moveBtn.addEventListener("click", () => this.moveFlow(entry, scope));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pn-jslib-btn pn-jslib-btn-danger";
    deleteBtn.type = "button";
    deleteBtn.textContent = "delete";
    deleteBtn.addEventListener("click", () => this.deleteFlow(entry, scope));

    actions.append(renameBtn, moveBtn, deleteBtn);
    row.appendChild(actions);
    return row;
  }

  // ── Flows ───────────────────────────────────────────────────────────

  private renameFlow(entry: LibraryEntry, scope: "patch" | "global", row: HTMLDivElement, nameEl: HTMLSpanElement): void {
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
        const entries = scope === "patch" ? getPatchLibrary(this.patchNode) : getGlobalLibrary();
        const next = renameEntry(entries, entry.name, proposed);
        // renameEntry returns input unchanged if name collides — no-op in that case.
        if (next !== entries) {
          if (scope === "patch") writePatchLibrary(this.graph, this.patchNode, next);
          else                   setGlobalLibrary(next);
          this.onChanged();
        }
      }
      this.render();
    };
    const cancel = () => {
      // Re-render restores the original row.
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
    void row;  // (reference kept for potential future inline styling hooks)
  }

  private deleteFlow(entry: LibraryEntry, scope: "patch" | "global"): void {
    const confirmed = confirm(`Delete "${entry.name}" from the ${scope} library?`);
    if (!confirmed) return;
    if (scope === "patch") {
      const next = removeEntry(getPatchLibrary(this.patchNode), entry.name);
      writePatchLibrary(this.graph, this.patchNode, next);
    } else {
      const next = removeEntry(getGlobalLibrary(), entry.name);
      setGlobalLibrary(next);
    }
    this.onChanged();
    this.render();
  }

  private moveFlow(entry: LibraryEntry, fromScope: "patch" | "global"): void {
    const toScope: "patch" | "global" = fromScope === "patch" ? "global" : "patch";
    const toEntries = toScope === "patch" ? getPatchLibrary(this.patchNode) : getGlobalLibrary();
    // Ensure no name collision in the destination; otherwise append (2), (3), …
    const finalName = uniqueName(entry.name, toEntries);
    const copied: LibraryEntry = { name: finalName, code: entry.code };

    if (toScope === "patch") {
      writePatchLibrary(this.graph, this.patchNode, upsertEntry(toEntries, copied));
    } else {
      setGlobalLibrary(upsertEntry(toEntries, copied));
    }
    // Only remove from source after successful add. We leave removal up to
    // the user's next action if they want to keep it in both — currently
    // this is a move, not a copy, so remove unconditionally. If a future
    // iteration adds an explicit "copy" button, that would skip this.
    if (fromScope === "patch") {
      writePatchLibrary(this.graph, this.patchNode, removeEntry(getPatchLibrary(this.patchNode), entry.name));
    } else {
      setGlobalLibrary(removeEntry(getGlobalLibrary(), entry.name));
    }
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
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pn-jslib-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close (Esc)";
    closeBtn.addEventListener("click", () => this.close());
    header.append(title, closeBtn);

    const body = document.createElement("div");
    body.className = "pn-jslib-body";
    body.append(this.patchColumn, this.globalColumn);

    modal.append(header, body);
    overlay.appendChild(modal);
    return overlay;
  }
}
