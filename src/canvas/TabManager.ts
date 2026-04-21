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

  constructor(
    private readonly tabBarEl: HTMLElement,
    private readonly mainPanGroup: HTMLElement,
    private readonly mainCanvasController: CanvasController,
  ) {
    this.renderBar();
  }

  openSubPatch(nodeId: string, label: string, session: SubPatchSession): void {
    if (!this.tabs.find(t => t.id === nodeId)) {
      this.tabs.push({ id: nodeId, label, session });
    }
    this.switchTo(nodeId);
  }

  switchTo(id: string): void {
    this.applyActive(this.activeId, false);
    this.activeId = id;
    this.applyActive(id, true);
    this.renderBar();
  }

  private applyActive(id: string, active: boolean): void {
    if (id === "main") {
      this.mainPanGroup.style.display = active ? "" : "none";
      this.mainCanvasController.setActive(active);
    } else {
      const t = this.tabs.find(e => e.id === id);
      if (!t?.session) return;
      t.session.panGroup.style.display = active ? "" : "none";
      t.session.canvasController.setActive(active);
      // Re-render after making visible so cables and panGroup size are correct.
      // The initial render in the constructor runs while the panGroup is hidden,
      // so getBoundingClientRect returns zeros and cables/size are wrong.
      if (active) t.session.render();
    }
  }

  private closeTab(id: string): void {
    if (id === "main") return;
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    if (this.activeId === id) this.switchTo("main");
    // Don't destroy the session — SubPatchManager owns it
    this.tabs.splice(idx, 1);
    this.renderBar();
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
        const x = document.createElement("span");
        x.className = "pn-tab-close";
        x.textContent = "×";
        x.addEventListener("click", e => { e.stopPropagation(); this.closeTab(tid); });
        btn.appendChild(x);
      }

      this.tabBarEl.appendChild(btn);
    }
  }
}
