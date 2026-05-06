import type { SubPatchSession } from "./SubPatchSession";
import type { ScratchTabSession } from "./ScratchTabSession";
import type { CanvasController } from "./CanvasController";

type TabKind = "main" | "subpatch" | "scratch";

interface TabEntry {
  id: string;
  label: string;
  kind: TabKind;
  session: SubPatchSession | ScratchTabSession | null;
}

export class TabManager {
  private tabs: TabEntry[] = [{ id: "main", label: "Main", kind: "main", session: null }];
  private activeId = "main";
  private scrollPositions = new Map<string, { left: number; top: number }>();
  private zoomLevels = new Map<string, number>();
  // Subpatch tabs the user closed via the "x" — syncTabs must not re-register
  // them even though the underlying subPatch node still lives on the canvas.
  // Scratch tabs are destroyed outright on close, so they don't need this.
  private closedSubpatchTabs = new Set<string>();

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
  /** Called when a tab becomes the active tab (any kind). main.ts uses this
   *  to retarget shared chrome — toolbar, text panel — at the active session. */
  onTabActivate?: (id: string, kind: TabKind) => void;
  /** Called when the user clicks the "+" button or hits cmd+t to add a new tab. */
  onAddTab?: () => void;
  /** Called when the user closes a scratch tab via "x". main.ts destroys the
   *  ScratchTabSession in response (no equivalent of subpatch's "node still
   *  on canvas" preservation). */
  onScratchClose?: (id: string) => void;

  constructor(
    private readonly tabBarEl: HTMLElement,
    private readonly mainPanGroup: HTMLElement,
    private readonly mainCanvasController: CanvasController,
  ) {
    this.renderBar();
  }

  /** Add tab and switch to it (double-click open from canvas). */
  openSubPatch(nodeId: string, label: string, session: SubPatchSession): void {
    this.closedSubpatchTabs.delete(nodeId);
    const existing = this.tabs.find(t => t.id === nodeId);
    if (!existing) {
      this.tabs.push({ id: nodeId, label, kind: "subpatch", session });
    } else {
      existing.label = label;
    }
    this.switchTo(nodeId);
  }

  /** Add tab without switching (used on patch load / graph change sync). */
  registerSubPatch(nodeId: string, label: string, session: SubPatchSession): void {
    if (this.closedSubpatchTabs.has(nodeId)) return;
    const existing = this.tabs.find(t => t.id === nodeId);
    if (!existing) {
      this.tabs.push({ id: nodeId, label, kind: "subpatch", session });
      this.renderBar();
    } else if (existing.label !== label) {
      existing.label = label;
      this.renderBar();
    }
  }

  /** Register a scratch tab. Optionally switch to it. */
  registerScratchTab(id: string, label: string, session: ScratchTabSession, switchTo = true): void {
    const existing = this.tabs.find(t => t.id === id);
    if (!existing) {
      this.tabs.push({ id, label, kind: "scratch", session });
    } else {
      existing.label = label;
    }
    if (switchTo) this.switchTo(id);
    else this.renderBar();
  }

  /** Called by the X button (user-initiated) and by SubPatchManager when the
   *  underlying node was removed from the graph. The user-initiated path
   *  handles subpatch vs scratch differently:
   *    - subpatch: keep the underlying node, mark id closed so syncTabs
   *      doesn't immediately resurrect the tab.
   *    - scratch:  delegate destruction to main.ts via onScratchClose. */
  closeTab(id: string, userInitiated = false): void {
    if (id === "main") return;
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    if (userInitiated && tab.kind === "subpatch") this.closedSubpatchTabs.add(id);
    if (this.activeId === id) this.switchTo("main");
    this.tabs.splice(idx, 1);
    this.scrollPositions.delete(id);
    this.zoomLevels.delete(id);
    this.renderBar();
    if (userInitiated && tab.kind === "scratch") this.onScratchClose?.(id);
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

    const activeTab = this.tabs.find(t => t.id === id);
    if (activeTab) this.onTabActivate?.(id, activeTab.kind);
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
        x.addEventListener("click", e => { e.stopPropagation(); this.closeTab(tid, true); });
        btn.appendChild(x);
      }

      this.tabBarEl.appendChild(btn);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "pn-tab-add";
    addBtn.textContent = "+";
    addBtn.title = "New tab (⌘T)";
    addBtn.setAttribute("aria-label", "New tab");
    addBtn.addEventListener("click", () => this.onAddTab?.());
    this.tabBarEl.appendChild(addBtn);
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

  /** List of currently-open scratch tabs in tab bar order. main.ts uses this
   *  for serializing all-tabs state to localStorage. */
  getScratchTabs(): { id: string; label: string; session: ScratchTabSession }[] {
    return this.tabs
      .filter(t => t.kind === "scratch" && t.session)
      .map(t => ({ id: t.id, label: t.label, session: t.session as ScratchTabSession }));
  }

  /** Currently-active tab's id. */
  getActiveId(): string {
    return this.activeId;
  }

  /** Active tab's session (subpatch or scratch). null when "main" is active —
   *  the caller resolves main's graph/canvas/interaction from app singletons. */
  getActiveSession(): SubPatchSession | ScratchTabSession | null {
    if (this.activeId === "main") return null;
    return this.tabs.find(t => t.id === this.activeId)?.session ?? null;
  }
}
