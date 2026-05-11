/**
 * Inline object-creation text entry box — Max/MSP style.
 *
 * Placed at (x, y) in world coordinates inside the pan group.
 * User types the object name + optional args (e.g. "metro 500"),
 * presses Enter to confirm or Escape to cancel.
 *
 * Shows an autocomplete dropdown below the input as the user types.
 * Arrow keys navigate the list and live-fill the input with the
 * highlighted match (browser-style autocomplete). Tab commits the
 * current match and hides the dropdown so the user can type args;
 * Enter confirms whatever's in the input.
 *
 * IMPORTANT: VALID_TYPES is derived from OBJECT_DEFS — do NOT maintain a
 * separate list here. Adding a new type to objectDefs.ts is sufficient.
 */

import { getAvailableObjectDefs } from "../graph/objectDefs";
import { PLATFORM } from "../platform/index";

// VALID_TYPES is filtered to the current platform so native-only objects
// don't appear in browser autocomplete.
const VALID_TYPES: readonly string[] = Object.keys(getAvailableObjectDefs(PLATFORM)).sort();

export class ObjectEntryBox {
  private readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly dropdown: HTMLDivElement;
  private destroyed = false;
  private activeIndex = -1;
  private matches: string[] = [];
  /**
   * What the user has actually typed, as opposed to what's currently shown
   * in the input (which may be an arrow-key preview of a suggestion).
   * Filtering keeps using this so previewing doesn't collapse the match set.
   */
  private userPrefix = "";
  private inChannelMode = false;

  constructor(
    panGroup: HTMLElement,
    x: number,
    y: number,
    onConfirm: (type: string, args: string[]) => void,
    onCancel: () => void,
    private readonly getChannels?: () => string[],
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
      // Any typed keystroke resets the "user prefix" — programmatic value
      // changes from arrow-preview don't fire the input event, so this is
      // always driven by real user input.
      this.userPrefix = this.input.value;
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
        // First Enter while the dropdown is open: accept the top (or arrow-
        // highlighted) suggestion — user must press Enter again, or click
        // outside, to actually create the object.
        if (this.matches.length > 0) {
          const idx = this.activeIndex >= 0 ? this.activeIndex : 0;
          this.acceptSuggestion(this.matches[idx]);
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

    // Click outside = commit if input holds a valid type, otherwise cancel.
    const onOutside = (e: MouseEvent) => {
      if (this.destroyed) return;
      if (!this.el.contains(e.target as Node)) {
        document.removeEventListener("mousedown", onOutside, true);
        const tokens = this.input.value.trim().split(/\s+/);
        const type = tokens[0] ?? "";
        if (VALID_TYPES.includes(type)) {
          this.destroy();
          onConfirm(type, tokens.slice(1));
        } else {
          this.destroy();
          onCancel();
        }
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
    const raw = this.userPrefix.trim();
    const typePart = raw.split(/\s+/)[0] ?? "";
    const onArgs = raw.includes(" ");

    this.inChannelMode = false;

    if (!onArgs && typePart !== "") {
      this.matches = VALID_TYPES.filter((t) => t.startsWith(typePart));
    } else if (onArgs && (typePart === "s" || typePart === "r") && this.getChannels) {
      this.inChannelMode = true;
      const argPart = raw.slice(typePart.length).trimStart();
      const channels = this.getChannels();
      this.matches = channels
        .filter((ch) => ch.startsWith(argPart))
        .map((ch) => `${typePart} ${ch}`);
    } else {
      this.matches = [];
    }

    const knownType = VALID_TYPES.includes(typePart);
    const unknown = typePart.length > 0 && !knownType;
    this.el.classList.toggle("pn-object-entry--error", unknown && !onArgs);

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
    this.previewActiveMatch();
  }

  /**
   * Fills the input with the highlighted suggestion (preserving any args
   * the user had already typed) so arrow-key navigation reads like live
   * autocomplete. Filtering still uses `userPrefix`, so the match set
   * doesn't collapse to just the previewed value.
   */
  private previewActiveMatch(): void {
    if (this.activeIndex < 0) return;
    const match = this.matches[this.activeIndex];
    if (this.inChannelMode) {
      this.input.value = match;
      this.input.setSelectionRange(match.length, match.length);
    } else {
      const userTokens = this.userPrefix.trim().split(/\s+/);
      const userArgs = userTokens.slice(1);
      this.input.value = userArgs.length ? `${match} ${userArgs.join(" ")}` : match;
      this.input.setSelectionRange(match.length, match.length);
    }
    this.el.classList.remove("pn-object-entry--error");
  }

  private updateActiveClass(): void {
    const items = this.dropdown.querySelectorAll<HTMLElement>(".pn-object-ac-item");
    items.forEach((el, i) => {
      el.classList.toggle("pn-object-ac-item--active", i === this.activeIndex);
    });
  }

  private acceptSuggestion(suggestion: string): void {
    if (this.inChannelMode) {
      this.input.value = suggestion;
      this.userPrefix = suggestion;
    } else {
      const tokens = this.input.value.trim().split(/\s+/);
      const args = tokens.slice(1);
      this.input.value = args.length ? `${suggestion} ${args.join(" ")}` : suggestion;
    }
    this.activeIndex = -1;
    this.matches = [];
    this.inChannelMode = false;
    this.dropdown.classList.remove("pn-object-ac--visible");
    this.el.classList.remove("pn-object-entry--error");
    this.input.selectionStart = this.input.selectionEnd = this.input.value.length;
  }
}
