/**
 * Inline object-creation text entry box — Max/MSP style.
 *
 * Placed at (x, y) in world coordinates inside the pan group.
 * User types the object name + optional args (e.g. "metro 500"),
 * presses Enter to confirm or Escape to cancel.
 *
 * Shows an autocomplete dropdown below the input as the user types.
 * Arrow keys navigate the list; Tab or Enter on a highlighted item
 * completes the type name.
 *
 * IMPORTANT: VALID_TYPES is derived from OBJECT_DEFS — do NOT maintain a
 * separate list here. Adding a new type to objectDefs.ts is sufficient.
 */

import { OBJECT_DEFS } from "../graph/objectDefs";

const VALID_TYPES: readonly string[] = Object.keys(OBJECT_DEFS).sort();

export class ObjectEntryBox {
  private readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly dropdown: HTMLDivElement;
  private destroyed = false;
  private activeIndex = -1;
  private matches: string[] = [];

  constructor(
    panGroup: HTMLElement,
    x: number,
    y: number,
    onConfirm: (type: string, args: string[]) => void,
    onCancel: () => void,
  ) {
    // ── Wrapper ──────────────────────────────────────────────────────
    this.el = document.createElement("div");
    this.el.className = "pn-object-entry";
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;

    // ── Input ────────────────────────────────────────────────────────
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "pn-object-entry-input";
    this.input.placeholder = "type name…";
    this.input.spellcheck = false;
    this.input.setAttribute("autocomplete", "off");

    // ── Dropdown ─────────────────────────────────────────────────────
    this.dropdown = document.createElement("div");
    this.dropdown.className = "pn-object-ac";

    this.el.appendChild(this.input);
    this.el.appendChild(this.dropdown);
    panGroup.appendChild(this.el);
    this.input.focus();

    // ── Events ───────────────────────────────────────────────────────
    this.input.addEventListener("input", () => {
      this.refreshDropdown();
    });

    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();

      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveActive(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.moveActive(-1);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (this.activeIndex >= 0) {
          this.acceptSuggestion(this.matches[this.activeIndex]);
        } else if (this.matches.length > 0) {
          this.acceptSuggestion(this.matches[0]);
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // If an autocomplete item is highlighted, accept it first
        if (this.activeIndex >= 0 && this.matches[this.activeIndex]) {
          this.acceptSuggestion(this.matches[this.activeIndex]);
          return;
        }
        const tokens = this.input.value.trim().split(/\s+/);
        const type = tokens[0] ?? "";
        if (!VALID_TYPES.includes(type)) return;
        const args = tokens.slice(1);
        this.destroy();
        onConfirm(type, args);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.destroy();
        onCancel();
      }
    });

    // Click outside = cancel
    const onOutside = (e: MouseEvent) => {
      if (this.destroyed) return;
      if (!this.el.contains(e.target as Node)) {
        document.removeEventListener("mousedown", onOutside, true);
        this.destroy();
        onCancel();
      }
    };
    setTimeout(() => {
      if (!this.destroyed) {
        document.addEventListener("mousedown", onOutside, true);
      }
    }, 0);

    // Initialise empty state
    this.refreshDropdown();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.el.remove();
  }

  // ── Autocomplete helpers ──────────────────────────────────────────

  private refreshDropdown(): void {
    const raw = this.input.value.trim();
    const typePart = raw.split(/\s+/)[0] ?? "";

    // Only show dropdown while user is still typing the type name
    // (no space yet — once they type a space they're on args)
    const onArgs = raw.includes(" ");

    this.matches = onArgs
      ? []
      : VALID_TYPES.filter(
          (t) => typePart === "" || t.startsWith(typePart),
        );

    // Validate error state on the wrapper
    const hasArgs = raw.includes(" ");
    const knownType = VALID_TYPES.includes(typePart);
    const unknown = typePart.length > 0 && !knownType;
    this.el.classList.toggle("pn-object-entry--error", unknown && !hasArgs);

    this.activeIndex = -1;
    this.renderDropdown();
  }

  private renderDropdown(): void {
    this.dropdown.innerHTML = "";

    if (this.matches.length === 0) {
      this.dropdown.classList.remove("pn-object-ac--visible");
      return;
    }

    this.dropdown.classList.add("pn-object-ac--visible");

    for (let i = 0; i < this.matches.length; i++) {
      const item = document.createElement("div");
      item.className = "pn-object-ac-item";
      item.textContent = this.matches[i];
      item.dataset.index = String(i);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent blur on input
        this.acceptSuggestion(this.matches[i]);
      });

      this.dropdown.appendChild(item);
    }
  }

  private moveActive(delta: 1 | -1): void {
    const len = this.matches.length;
    if (len === 0) return;
    this.activeIndex = (this.activeIndex + delta + len) % len;
    this.updateActiveClass();
  }

  private updateActiveClass(): void {
    const items = this.dropdown.querySelectorAll<HTMLElement>(".pn-object-ac-item");
    items.forEach((el, i) => {
      el.classList.toggle("pn-object-ac-item--active", i === this.activeIndex);
    });
  }

  private acceptSuggestion(type: string): void {
    // Keep any args the user already typed after the old type name
    const tokens = this.input.value.trim().split(/\s+/);
    const args = tokens.slice(1);
    this.input.value = args.length ? `${type} ${args.join(" ")}` : type;
    this.activeIndex = -1;
    this.matches = [];
    this.dropdown.classList.remove("pn-object-ac--visible");
    this.el.classList.remove("pn-object-entry--error");
    // Move cursor to end
    this.input.selectionStart = this.input.selectionEnd = this.input.value.length;
  }
}
