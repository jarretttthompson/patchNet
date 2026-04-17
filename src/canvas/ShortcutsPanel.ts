/**
 * Keyboard shortcuts reference panel.
 * Toggled by the "?" toolbar button.
 * Closes on Escape or click-outside.
 */

interface ShortcutGroup {
  label: string;
  rows: [key: string, description: string][];
}

const GROUPS: ShortcutGroup[] = [
  {
    label: "Create objects",
    rows: [
      ["N", "New object (type name + Enter)"],
      ["B", "Place button"],
      ["T", "Place toggle"],
      ["S", "Place slider"],
      ["M", "Place metro"],
      ["Double-click", "New object at cursor"],
    ],
  },
  {
    label: "Edit",
    rows: [
      ["Click", "Select object or cable"],
      ["Del / Backspace", "Delete selected"],
      ["Escape", "Deselect all"],
      ["Drag object", "Move object"],
    ],
  },
  {
    label: "Connect",
    rows: [
      ["Drag outlet →  inlet", "Draw cable"],
      ["Click cable", "Select cable"],
    ],
  },
  {
    label: "Navigate",
    rows: [
      ["Space + drag", "Pan canvas"],
      ["Middle-click drag", "Pan canvas"],
    ],
  },
];

const PANEL_STYLE = `
.pn-shortcuts-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 52px 16px 0 0;
  pointer-events: none;
}
.pn-shortcuts-panel {
  pointer-events: all;
  background: var(--pn-surface-raised);
  border: 1px solid var(--pn-border);
  border-radius: var(--pn-radius-md);
  box-shadow: var(--pn-shadow-panel);
  padding: 16px 20px 18px;
  min-width: 300px;
  max-width: 360px;
  font-family: var(--pn-font-mono);
}
.pn-shortcuts-title {
  font-size: var(--pn-type-chip);
  color: var(--pn-accent);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin: 0 0 12px;
}
.pn-shortcuts-group {
  margin-bottom: 12px;
}
.pn-shortcuts-group:last-child {
  margin-bottom: 0;
}
.pn-shortcuts-group-label {
  font-size: var(--pn-type-micro);
  color: var(--pn-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 5px;
}
.pn-shortcuts-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 0;
  font-size: var(--pn-type-micro);
  color: var(--pn-text-dim);
}
.pn-shortcuts-key {
  color: var(--pn-text);
  white-space: nowrap;
  flex-shrink: 0;
}
.pn-shortcuts-desc {
  color: var(--pn-muted);
  text-align: right;
}
.pn-shortcuts-divider {
  border: none;
  border-top: 1px solid var(--pn-border);
  margin: 10px 0;
}
`;

function injectPanelStyles(): void {
  if (document.getElementById("pn-shortcuts-styles")) return;
  const style = document.createElement("style");
  style.id = "pn-shortcuts-styles";
  style.textContent = PANEL_STYLE;
  document.head.appendChild(style);
}

export class ShortcutsPanel {
  private overlayEl: HTMLElement | null = null;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onOutsideClick: (e: MouseEvent) => void;

  constructor() {
    injectPanelStyles();

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.hide();
    };

    this.onOutsideClick = (e: MouseEvent) => {
      if (this.overlayEl && !this.overlayEl.querySelector(".pn-shortcuts-panel")?.contains(e.target as Node)) {
        this.hide();
      }
    };
  }

  toggle(): void {
    this.overlayEl ? this.hide() : this.show();
  }

  show(): void {
    if (this.overlayEl) return;

    const overlay = document.createElement("div");
    overlay.className = "pn-shortcuts-overlay";

    const panel = document.createElement("div");
    panel.className = "pn-shortcuts-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Keyboard shortcuts");

    const title = document.createElement("p");
    title.className = "pn-shortcuts-title";
    title.textContent = "Keyboard shortcuts";
    panel.appendChild(title);

    GROUPS.forEach((group, i) => {
      if (i > 0) {
        const hr = document.createElement("hr");
        hr.className = "pn-shortcuts-divider";
        panel.appendChild(hr);
      }

      const groupEl = document.createElement("div");
      groupEl.className = "pn-shortcuts-group";

      const labelEl = document.createElement("div");
      labelEl.className = "pn-shortcuts-group-label";
      labelEl.textContent = group.label;
      groupEl.appendChild(labelEl);

      for (const [key, desc] of group.rows) {
        const row = document.createElement("div");
        row.className = "pn-shortcuts-row";

        const keyEl = document.createElement("span");
        keyEl.className = "pn-shortcuts-key";
        keyEl.textContent = key;

        const descEl = document.createElement("span");
        descEl.className = "pn-shortcuts-desc";
        descEl.textContent = desc;

        row.appendChild(keyEl);
        row.appendChild(descEl);
        groupEl.appendChild(row);
      }

      panel.appendChild(groupEl);
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.overlayEl = overlay;

    document.addEventListener("keydown", this.onKeyDown);
    // Deferred so the button click that opened it doesn't immediately close it
    setTimeout(() => {
      document.addEventListener("mousedown", this.onOutsideClick, true);
    }, 0);
  }

  hide(): void {
    if (!this.overlayEl) return;
    this.overlayEl.remove();
    this.overlayEl = null;
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("mousedown", this.onOutsideClick, true);
  }

  destroy(): void {
    this.hide();
  }
}
