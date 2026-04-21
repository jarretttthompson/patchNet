import type { SubPatchSession } from "./SubPatchSession";
import type { CanvasController } from "./CanvasController";

interface TabEntry {
  id: string;
  label: string;
  session: SubPatchSession | null;
}

export class TabManager {
  private tabs: TabEntry[] = [{ id: "main", label: "Main", session: null }];
  private activeId = "main";
  private scrollPositions = new Map<string, { left: number; top: number }>();
  private zoomLevels = new Map<string, number>();

  private get canvasEl(): HTMLElement {
    return this.mainPanGroup.parentElement as HTMLElement;
  }

  private getActiveController(): CanvasController {
    if (this.activeId === "main") return this.mainCanvasController;
    const t = this.tabs.find(e => e.id === this.activeId);
    return t?.session?.canvasController ?? this.mainCanvasController;
  }

  /** Called when a tab label is changed via double-click rename. */
  onLabelChange?: (id: string, label: string) => void;
  /** Called when the main tab becomes active so main.ts can flush any render deferred while hidden. */
  onMainActivate?: () => void;

  constructor(
    private readonly tabBarEl: HTMLElement,
    private readonly mainPanGroup: HTMLElement,
    private readonly mainCanvasController: CanvasController,
  ) {
    this.renderBar();
  }

  /** Add tab and switch to it (double-click open from canvas). */
  openSubPatch(nodeId: string, label: string, session: SubPatchSession): void {
    const existing = this.tabs.find(t => t.id === nodeId);
    if (!existing) {
      this.tabs.push({ id: nodeId, label, session });
    } else {
      existing.label = label;
    }
    this.switchTo(nodeId);
  }

  /** Add tab without switching (used on patch load / graph change sync). */
  registerSubPatch(nodeId: string, label: string, session: SubPatchSession): void {
    const existing = this.tabs.find(t => t.id === nodeId);
    if (!existing) {
      this.tabs.push({ id: nodeId, label, session });
      this.renderBar();
    } else if (existing.label !== label) {
      existing.label = label;
      this.renderBar();
    }
  }

  closeTab(id: string): void {
    if (id === "main") return;
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    if (this.activeId === id) this.switchTo("main");
    this.tabs.splice(idx, 1);
    this.scrollPositions.delete(id);
    this.zoomLevels.delete(id);
    this.renderBar();
  }

  switchTo(id: string): void {
    // Save scroll and zoom for the departing tab
    this.scrollPositions.set(this.activeId, {
      left: this.canvasEl.scrollLeft,
      top:  this.canvasEl.scrollTop,
    });
    this.zoomLevels.set(this.activeId, this.getActiveController().getZoom());

    this.applyActive(this.activeId, false);
    this.activeId = id;

    // Restore zoom BEFORE activating the new tab so its render() sees the
    // correct global _zoom. Activating first caused the first frame to render
    // with the previous tab's zoom, scaling cable endpoints incorrectly until
    // the next frame corrected it.
    const savedZoom = this.zoomLevels.get(id) ?? 1;
    this.getActiveController().setZoom(savedZoom);

    this.applyActive(id, true);

    // Restore scroll last so setZoom's anchor math doesn't drift it.
    const savedScroll = this.scrollPositions.get(id) ?? { left: 0, top: 0 };
    this.canvasEl.scrollLeft = savedScroll.left;
    this.canvasEl.scrollTop  = savedScroll.top;

    this.renderBar();
  }

  private applyActive(id: string, active: boolean): void {
    if (id === "main") {
      this.mainPanGroup.style.display = active ? "" : "none";
      this.mainCanvasController.setActive(active);
      if (active) this.onMainActivate?.();
    } else {
      const t = this.tabs.find(e => e.id === id);
      if (!t?.session) return;
      t.session.panGroup.style.display = active ? "" : "none";
      t.session.canvasController.setActive(active);
      // Re-render after making visible so cables and panGroup size are correct.
      if (active) t.session.render();
    }
  }

  private renderBar(): void {
    this.tabBarEl.innerHTML = "";
    for (const tab of this.tabs) {
      const btn = document.createElement("button");
      btn.className = `pn-tab${tab.id === this.activeId ? " pn-tab--active" : ""}`;

      const labelSpan = document.createElement("span");
      labelSpan.textContent = tab.label;
      btn.appendChild(labelSpan);

      const tid = tab.id;
      btn.addEventListener("click", () => this.switchTo(tid));

      if (tab.id !== "main") {
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showContextMenu(e.clientX, e.clientY, btn, tid, tab.label);
        });

        const x = document.createElement("span");
        x.className = "pn-tab-close";
        x.textContent = "×";
        x.addEventListener("click", e => { e.stopPropagation(); this.closeTab(tid); });
        btn.appendChild(x);
      }

      this.tabBarEl.appendChild(btn);
    }
  }

  private showContextMenu(x: number, y: number, btn: HTMLElement, id: string, currentLabel: string): void {
    this.dismissContextMenu();

    const menu = document.createElement("div");
    menu.className = "pn-tab-context-menu";
    menu.style.cssText = `left:${x}px;top:${y}px;`;

    const renameItem = document.createElement("button");
    renameItem.className = "pn-tab-context-item";
    renameItem.textContent = "Rename";
    renameItem.addEventListener("click", () => {
      this.dismissContextMenu();
      // Re-query the live label span after renderBar may have run
      const labelSpan = btn.querySelector("span:first-child") as HTMLElement | null;
      if (labelSpan) this.startRename(btn, labelSpan, id, currentLabel);
    });

    menu.appendChild(renameItem);
    document.body.appendChild(menu);
    this.activeContextMenu = menu;

    const onDismiss = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        this.dismissContextMenu();
        document.removeEventListener("mousedown", onDismiss);
        document.removeEventListener("keydown", onEscDismiss);
      }
    };
    const onEscDismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.dismissContextMenu();
        document.removeEventListener("mousedown", onDismiss);
        document.removeEventListener("keydown", onEscDismiss);
      }
    };

    // Defer so the current mousedown that opened this menu isn't caught
    setTimeout(() => {
      document.addEventListener("mousedown", onDismiss);
      document.addEventListener("keydown", onEscDismiss);
    }, 0);
  }

  private activeContextMenu: HTMLElement | null = null;

  private dismissContextMenu(): void {
    this.activeContextMenu?.remove();
    this.activeContextMenu = null;
  }

  private startRename(btn: HTMLElement, labelSpan: HTMLElement, id: string, currentLabel: string): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pn-tab-rename-input";
    input.value = currentLabel;
    input.size = Math.max(4, currentLabel.length + 2);

    labelSpan.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    const commit = () => {
      if (committed) return;
      committed = true;
      const raw = input.value.trim().replace(/\s+/g, "_") || currentLabel;
      const tab = this.tabs.find(t => t.id === id);
      if (tab) {
        tab.label = raw;
        this.onLabelChange?.(id, raw);
      }
      this.renderBar();
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      this.renderBar();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });

    input.addEventListener("blur", commit, { once: true });

    // Suppress the button's click handler while the input is active
    btn.addEventListener("click", e => e.stopPropagation(), { once: true });
  }
}
