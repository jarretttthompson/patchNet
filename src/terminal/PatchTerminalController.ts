import type { ActionContext } from "../actions/types";
import { PatchTerminalEngine, type TerminalResult } from "./PatchTerminalEngine";

const MAX_HISTORY = 100;
const MAX_LOG_ROWS = 80;

export class PatchTerminalController {
  private readonly engine = new PatchTerminalEngine();
  private readonly root: HTMLDivElement;
  private readonly logEl: HTMLDivElement;
  private readonly inputEl: HTMLInputElement;
  private readonly statusEl: HTMLDivElement;
  private readonly history: string[] = [];
  private historyIndex = 0;
  private open = false;

  constructor(private readonly contextProvider: () => ActionContext) {
    this.root = document.createElement("div");
    this.root.className = "pn-terminal";
    this.root.dataset.patchTerminal = "root";
    this.root.setAttribute("aria-hidden", "true");

    const header = document.createElement("div");
    header.className = "pn-terminal__header";

    const title = document.createElement("span");
    title.className = "pn-terminal__title";
    title.textContent = "patch terminal";
    header.appendChild(title);

    const spacer = document.createElement("span");
    spacer.className = "pn-terminal__spacer";
    header.appendChild(spacer);

    const closeBtn = document.createElement("button");
    closeBtn.className = "pn-terminal__close";
    closeBtn.type = "button";
    closeBtn.textContent = "x";
    closeBtn.title = "Close terminal (Esc)";
    closeBtn.setAttribute("aria-label", "Close patch terminal");
    closeBtn.addEventListener("click", () => this.hide());
    header.appendChild(closeBtn);

    this.logEl = document.createElement("div");
    this.logEl.className = "pn-terminal__log";
    this.logEl.dataset.patchTerminal = "log";

    const promptRow = document.createElement("form");
    promptRow.className = "pn-terminal__prompt";
    promptRow.dataset.patchTerminal = "form";

    const prompt = document.createElement("span");
    prompt.className = "pn-terminal__prompt-mark";
    prompt.textContent = ">";
    promptRow.appendChild(prompt);

    this.inputEl = document.createElement("input");
    this.inputEl.className = "pn-terminal__input";
    this.inputEl.dataset.patchTerminal = "input";
    this.inputEl.type = "text";
    this.inputEl.autocomplete = "off";
    this.inputEl.spellcheck = false;
    this.inputEl.placeholder = "";
    promptRow.appendChild(this.inputEl);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "pn-terminal__status";
    this.statusEl.dataset.patchTerminal = "status";

    this.root.append(header, this.logEl, promptRow, this.statusEl);
    document.body.appendChild(this.root);

    promptRow.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submit();
    });

    this.inputEl.addEventListener("keydown", (e) => this.handleInputKey(e));
  }

  toggle(): void {
    this.open ? this.hide() : this.show();
  }

  show(): void {
    this.open = true;
    this.root.classList.add("is-open");
    this.root.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => this.inputEl.focus());
  }

  hide(): void {
    this.open = false;
    this.root.classList.remove("is-open");
    this.root.setAttribute("aria-hidden", "true");
    this.inputEl.blur();
  }

  private async submit(): Promise<void> {
    const command = this.inputEl.value.trim();
    if (!command) return;

    this.pushHistory(command);
    this.appendLog("input", `> ${command}`);
    this.inputEl.value = "";

    const result = await this.engine.execute(command, this.contextProvider());
    this.renderResult(result);
  }

  private renderResult(result: TerminalResult): void {
    if (!result.message) return;
    this.statusEl.textContent = result.message;
    this.statusEl.classList.toggle("is-error", !result.ok);
    this.appendLog(result.ok ? "ok" : "error", result.message);
  }

  private handleInputKey(e: KeyboardEvent): void {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.recallHistory(-1);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      this.recallHistory(1);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void this.submit();
    }
  }

  private pushHistory(command: string): void {
    if (this.history[this.history.length - 1] !== command) {
      this.history.push(command);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.historyIndex = this.history.length;
  }

  private recallHistory(delta: -1 | 1): void {
    if (this.history.length === 0) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    this.inputEl.value = this.history[this.historyIndex] ?? "";
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
  }

  private appendLog(kind: "input" | "ok" | "error", text: string): void {
    const row = document.createElement("div");
    row.className = `pn-terminal__log-row pn-terminal__log-row--${kind}`;
    row.textContent = text;
    this.logEl.appendChild(row);

    while (this.logEl.childElementCount > MAX_LOG_ROWS) {
      this.logEl.firstElementChild?.remove();
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
