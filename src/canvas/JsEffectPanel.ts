import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { AudioGraph } from "../runtime/AudioGraph";
import type { JsEffectNode, JsEffectStatus, JsEffectCompileInput } from "../runtime/JsEffectNode";
import { parseJsfx, type SliderDecl } from "../runtime/jsfx/parser";
import { translateJsfxBody } from "../runtime/jsfx/translate";
import { deriveJsEffectPorts, JS_EFFECT_SIDE_INLET_START } from "../graph/objectDefs";
import {
  getGlobalLibrary,
  setGlobalLibrary,
  upsertEntry,
  deriveNameFromCode,
  splitCategory,
  type LibraryEntry,
} from "../runtime/jsfx/library";
import { JsEffectLibraryDialog } from "./JsEffectLibraryDialog";

const COMPILE_DEBOUNCE_MS = 300;

const LOCK_ICON_CLOSED = `<svg viewBox="0 0 14 16" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="7" width="10" height="8" rx="1.5" fill="currentColor"/>
  <path d="M4.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
const LOCK_ICON_OPEN = `<svg viewBox="0 0 14 16" width="11" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="7" width="10" height="8" rx="1.5" fill="currentColor"/>
  <path d="M4.5 7V5.5a2.5 2.5 0 0 1 5 0V3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

/**
 * Inline expanded panel for a `js~` object.
 *
 * Header (from left to right):
 *   [ ▾ js~ — <desc> ]  [ save ]  [ manage ]  [ 🔒 ]
 *
 * Clicking the title opens a dropdown of saved effects, grouped by the
 * first folder segment in the entry name (e.g. `delay/feedback` →
 * "delay" section). Selecting one loads its code into the editor. The
 * save button prompts inline for a name and writes into the global
 * library. The lock button toggles `args[2]` — when locked, the editor
 * and dropdown are non-interactive and the object can be dragged by
 * clicking anywhere on the panel *except* over a slider (which stays
 * interactive in both states).
 */
export class JsEffectPanel {
  private readonly root: HTMLDivElement;
  private readonly codeHost: HTMLDivElement;
  private readonly sliderPane: HTMLDivElement;
  private readonly statusLine: HTMLDivElement;

  // Header controls
  private readonly titleButton: HTMLButtonElement;
  private readonly titleText: HTMLSpanElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly manageButton: HTMLButtonElement;
  private readonly lockButton: HTMLButtonElement;
  private readonly dropdownEl: HTMLDivElement;

  private readonly view: EditorView;
  private sliderValues = new Map<number, number>();
  private sliderInputs = new Map<number, { wrap: HTMLDivElement; range: HTMLInputElement; readout: HTMLSpanElement; label: HTMLSpanElement }>();

  private currentHost: HTMLElement | null = null;
  private jsEffectNode: JsEffectNode | null = null;
  private readyUnsubscribe: (() => void) | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  private compileTimeout: number | null = null;
  private dropdownOpen = false;
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private currentDialog: JsEffectLibraryDialog | null = null;

  private latestCompile: JsEffectCompileInput | null = null;
  private lastError = "";
  private currentDesc = "";

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    private audioGraph: AudioGraph | null,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pn-jseffect-panel";
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    // Swallow mousedown ONLY when unlocked — unlocked = panel interactive,
    // so clicks mustn't trigger DragController. Locked = object drags from
    // anywhere on the body (except sliders + lock button, which DragController
    // filters out explicitly), so the event MUST bubble up to panGroup.
    this.root.addEventListener("mousedown", (e) => {
      const locked = (this.patchNode.args[2] ?? "0") === "1";
      if (locked) return;
      e.stopPropagation();
    });

    // ── Buttons (re-parented into the slider-column header below) ────
    this.titleButton = document.createElement("button");
    this.titleButton.type = "button";
    this.titleButton.className = "pn-jseffect-title-btn";
    const caret = document.createElement("span");
    caret.className = "pn-jseffect-caret";
    caret.textContent = "▾";
    this.titleText = document.createElement("span");
    this.titleText.className = "pn-jseffect-title";
    this.titleText.textContent = "js~";
    this.titleButton.append(caret, this.titleText);
    this.titleButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    this.saveButton = document.createElement("button");
    this.saveButton.type = "button";
    this.saveButton.className = "pn-jseffect-hdr-btn";
    this.saveButton.textContent = "save";
    this.saveButton.title = "save current effect to library";
    this.saveButton.addEventListener("click", (e) => { e.stopPropagation(); this.openSavePrompt(); });

    this.manageButton = document.createElement("button");
    this.manageButton.type = "button";
    this.manageButton.className = "pn-jseffect-hdr-btn";
    this.manageButton.textContent = "manage";
    this.manageButton.title = "open library manager";
    this.manageButton.addEventListener("click", (e) => { e.stopPropagation(); this.openManageDialog(); });

    this.lockButton = document.createElement("button");
    this.lockButton.type = "button";
    this.lockButton.className = "pn-jseffect-lock";
    this.lockButton.addEventListener("click", (e) => { e.stopPropagation(); this.toggleLock(); });
    this.renderLockIcon();

    this.dropdownEl = document.createElement("div");
    this.dropdownEl.className = "pn-jseffect-dropdown";
    this.dropdownEl.hidden = true;

    // ── Body: sliders LEFT (full-height column) / code RIGHT ─────────
    // Two-column layout. Slider column owns its own 22px header so slider
    // rows begin at exactly ATTR_SIDE_INLET_HEADER_H from the object top —
    // which is where ObjectRenderer's side-inlet formula places the nubs.
    // No runtime sync required.
    const body = document.createElement("div");
    body.className = "pn-jseffect-body";

    const sliderCol = document.createElement("div");
    sliderCol.className = "pn-jseffect-slider-col";

    const sliderHeader = document.createElement("div");
    sliderHeader.className = "pn-jseffect-slider-header";
    sliderHeader.append(this.titleButton, this.saveButton, this.manageButton, this.lockButton);
    sliderHeader.appendChild(this.dropdownEl);

    this.sliderPane = document.createElement("div");
    this.sliderPane.className = "pn-jseffect-sliders";

    sliderCol.append(sliderHeader, this.sliderPane);

    const codeCol = document.createElement("div");
    codeCol.className = "pn-jseffect-code-col";

    this.codeHost = document.createElement("div");
    this.codeHost.className = "pn-jseffect-code";

    this.statusLine = document.createElement("div");
    this.statusLine.className = "pn-jseffect-status";

    codeCol.append(this.codeHost, this.statusLine);

    body.append(sliderCol, codeCol);
    this.root.appendChild(body);

    this.sliderValues = this.readSliderValuesFromArgs();

    const initial = this.readSourceFromArgs();
    this.view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            this.scheduleCompile();
          }),
        ],
      }),
      parent: this.codeHost,
    });

    this.compileNow();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  attach(host: HTMLElement): void {
    if (this.currentHost === host) return;
    host.appendChild(this.root);
    this.currentHost = host;
    this.subscribeToAudioGraph();
    // Nub positioning now follows the fixed 22/24px grid baked into CSS
    // (matches ObjectRenderer's side-inlet formula). No ResizeObserver
    // needed — rows align by layout alone.
  }

  setAudioGraph(audioGraph: AudioGraph | null): void {
    if (this.audioGraph === audioGraph) return;
    this.readyUnsubscribe?.();
    this.readyUnsubscribe = null;
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = null;
    this.jsEffectNode = null;
    this.audioGraph = audioGraph;
    if (audioGraph && this.currentHost) this.subscribeToAudioGraph();
    if (!audioGraph) this.renderStatus("(start audio to hear effect)", "");
  }

  private subscribeToAudioGraph(): void {
    if (!this.audioGraph || this.readyUnsubscribe) return;
    this.readyUnsubscribe = this.audioGraph.onJsEffectReady(
      this.patchNode.id,
      (node) => this.bindJsEffectNode(node),
    );
  }

  detach(): void {
    this.closeDropdown();
    this.root.remove();
    this.currentHost = null;
  }

  destroy(): void {
    if (this.compileTimeout !== null) {
      window.clearTimeout(this.compileTimeout);
      this.compileTimeout = null;
    }
    this.closeDropdown();
    this.currentDialog?.close();
    this.currentDialog = null;
    this.readyUnsubscribe?.();
    this.readyUnsubscribe = null;
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = null;
    this.view.destroy();
    this.root.remove();
    this.currentHost = null;
    this.jsEffectNode = null;
  }

  /** Called when args[0] / args[1] / args[2] were updated externally
   *  (patch-file load, broadcast from another js~, etc.). Re-syncs
   *  editor doc + lock icon + dropdown contents without re-running
   *  persistSource (which would ping-pong). */
  syncFromArgs(): void {
    const source = this.readSourceFromArgs();
    const current = this.view.state.doc.toString();
    if (source !== current) {
      this.view.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    }
    this.renderLockIcon();
    if (this.dropdownOpen) this.renderDropdown();
  }

  // ── JsEffectNode binding ──────────────────────────────────────────────

  private bindJsEffectNode(node: JsEffectNode): void {
    this.jsEffectNode = node;
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = node.onStatus((status) => this.onStatus(status));
    for (const [idx, value] of this.sliderValues) node.setSlider(idx - 1, value);
    if (this.latestCompile) node.setCode(this.latestCompile);
  }

  private onStatus(status: JsEffectStatus): void {
    if (status.kind === "runtime-error") {
      const whereLabel = status.where ? ` (@${status.where})` : "";
      this.renderStatus(`runtime error${whereLabel}: ${status.message}`, "error");
    } else if (status.kind === "compile-error") {
      this.renderStatus(`compile error: ${status.message}`, "error");
    } else if (status.kind === "compiled") {
      if (!this.lastError) this.renderStatus("", "ok");
    }
  }

  // ── Code editing ──────────────────────────────────────────────────────

  private scheduleCompile(): void {
    if (this.compileTimeout !== null) window.clearTimeout(this.compileTimeout);
    this.compileTimeout = window.setTimeout(() => {
      this.compileTimeout = null;
      // Write args[0] before compileNow — syncNodePorts emits "change" which
      // re-runs syncFromArgs on this same panel. If args[0] is stale the
      // editor would revert to the pre-edit source.
      this.persistSource();
      this.compileNow();
    }, COMPILE_DEBOUNCE_MS);
  }

  private compileNow(): void {
    const source = this.view.state.doc.toString();
    const parsed = parseJsfx(source);
    if (!parsed.ok) {
      this.lastError = `line ${parsed.error.line}: ${parsed.error.message}`;
      this.renderStatus(this.lastError, "error");
      return;
    }
    const program = parsed.program;
    this.currentDesc = program.desc;
    this.updateTitle(program.desc);
    this.rebuildSliderPane(program.sliders);
    this.syncNodePorts();

    const translateOpts = { sliders: program.sliders };
    const tInit   = translateJsfxBody(program.initBody, translateOpts);
    const tSlider = translateJsfxBody(program.sliderBody, translateOpts);
    const tBlock  = translateJsfxBody(program.blockBody, translateOpts);
    const tSample = translateJsfxBody(program.sampleBody, translateOpts);
    for (const [label, result] of [["@init", tInit], ["@slider", tSlider], ["@block", tBlock], ["@sample", tSample]] as const) {
      if (!result.ok) {
        this.lastError = `${label}: ${result.error.message}`;
        this.renderStatus(this.lastError, "error");
        return;
      }
    }
    if (!tInit.ok || !tSlider.ok || !tBlock.ok || !tSample.ok) return;

    const userVars = new Set<string>();
    for (const v of tInit.userVars)   userVars.add(v);
    for (const v of tSlider.userVars) userVars.add(v);
    for (const v of tBlock.userVars)  userVars.add(v);
    for (const v of tSample.userVars) userVars.add(v);

    this.latestCompile = {
      init:   tInit.js,
      slider: tSlider.js,
      block:  tBlock.js,
      sample: tSample.js,
      userVars: Array.from(userVars),
    };
    this.lastError = "";
    const sliderCount = program.sliders.length;
    const sliderLabel = `${sliderCount} slider${sliderCount === 1 ? "" : "s"}`;
    this.renderStatus(
      this.audioGraph ? `compiled · ${sliderLabel}` : `compiled · ${sliderLabel} · start audio to hear`,
      this.audioGraph ? "ok" : "",
    );

    if (this.jsEffectNode) {
      for (const [idx, value] of this.sliderValues) this.jsEffectNode.setSlider(idx - 1, value);
      this.jsEffectNode.setCode(this.latestCompile);
    }
  }

  // ── Slider pane ───────────────────────────────────────────────────────

  private rebuildSliderPane(sliders: SliderDecl[]): void {
    this.latestSliderDeclsRef = sliders;
    const nextValues = new Map<number, number>();
    for (const s of sliders) {
      const prev = this.sliderValues.get(s.index);
      nextValues.set(s.index, prev !== undefined ? clamp(prev, s.min, s.max) : s.defaultValue);
    }
    this.sliderValues = nextValues;

    this.sliderPane.textContent = "";
    this.sliderInputs.clear();

    if (sliders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-jseffect-empty";
      empty.textContent = "no sliders declared";
      this.sliderPane.appendChild(empty);
      return;
    }

    for (const s of sliders) {
      // Attribute-style horizontal row: [label] [──slider──] [readout].
      // Fixed 24px height matches ATTR_SIDE_INLET_ROW_H so side-inlet nubs
      // land on row centers via the ObjectRenderer formula (no sync).
      const wrap = document.createElement("div");
      wrap.className = "pn-jseffect-slider-row";

      const label = document.createElement("span");
      label.className = "pn-jseffect-slider-label";
      label.textContent = s.label;
      label.title = s.label;

      const initialValue = this.sliderValues.get(s.index) ?? s.defaultValue;

      const range = document.createElement("input");
      range.type = "range";
      range.className = "pn-jseffect-slider-range";
      range.min = String(s.min);
      range.max = String(s.max);
      range.step = s.step !== undefined ? String(s.step) : String((s.max - s.min) / 1000);
      range.value = String(initialValue);

      const readout = document.createElement("span");
      readout.className = "pn-jseffect-slider-readout";
      readout.textContent = formatSliderReadout(initialValue, s);

      range.addEventListener("input", () => {
        const v = parseFloat(range.value);
        if (!Number.isFinite(v)) return;
        this.sliderValues.set(s.index, v);
        readout.textContent = formatSliderReadout(v, s);
        this.jsEffectNode?.setSlider(s.index - 1, v);
        // Write args[3] in place and emit display only — emitting "change"
        // here triggers a full render(), which destroys the slider DOM
        // mid-drag and breaks smooth scrubbing.
        this.writeSliderValuesToArgs();
        this.graph.emit("display");
      });
      range.addEventListener("change", () => {
        // Drag committed — emit change so undo / text panel sees final value.
        this.graph.emit("change");
      });

      wrap.append(label, range, readout);
      this.sliderPane.appendChild(wrap);
      this.sliderInputs.set(s.index, { wrap, range, readout, label });

      this.jsEffectNode?.setSlider(s.index - 1, initialValue);
    }

    this.ensureMinHeight(sliders.length);
  }

  /** Grow the object vertically so every slider row (22px header + N*24px)
   *  fits inside the object body. Prevents side-inlet nubs from rendering
   *  past the bottom edge when the preset has more sliders than the current
   *  object height accommodates. */
  private ensureMinHeight(sliderCount: number): void {
    // 22 (header) + N*24 (rows) + 22 (status line on right column)
    const needed = 22 + sliderCount * 24 + 22;
    const current = this.patchNode.height ?? 0;
    if (current < needed) {
      this.patchNode.height = needed;
      this.graph.emit("display");
    }
  }

  // ── Dropdown ──────────────────────────────────────────────────────────

  private toggleDropdown(): void {
    if (this.dropdownOpen) this.closeDropdown();
    else this.openDropdown();
  }

  private openDropdown(): void {
    if (this.dropdownOpen) return;
    this.dropdownOpen = true;
    this.dropdownEl.hidden = false;
    this.renderDropdown();

    // Close-on-outside-click. Bound to document so any click anywhere
    // (including on the canvas) shuts the menu.
    this.documentClickHandler = (e: MouseEvent) => {
      if (!this.dropdownEl.contains(e.target as Node) && !this.titleButton.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeDropdown();
    };
    // Defer listener until after this click finishes bubbling.
    setTimeout(() => {
      if (this.documentClickHandler) document.addEventListener("mousedown", this.documentClickHandler);
    }, 0);
    document.addEventListener("keydown", this.escapeHandler);
  }

  private closeDropdown(): void {
    this.dropdownOpen = false;
    this.dropdownEl.hidden = true;
    if (this.documentClickHandler) {
      document.removeEventListener("mousedown", this.documentClickHandler);
      this.documentClickHandler = null;
    }
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
      this.escapeHandler = null;
    }
  }

  private renderDropdown(): void {
    this.dropdownEl.textContent = "";

    const entries = getGlobalLibrary();

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-jseffect-dd-empty";
      empty.textContent = 'no saved effects — click "save" to add the current one';
      this.dropdownEl.appendChild(empty);
    } else {
      // Group by first folder segment (e.g. "delay/feedback" → "delay").
      const byCategory = new Map<string, LibraryEntry[]>();
      for (const e of entries) {
        const { category } = splitCategory(e.name);
        const list = byCategory.get(category);
        if (list) list.push(e);
        else byCategory.set(category, [e]);
      }
      const categories = Array.from(byCategory.keys()).sort((a, b) => {
        // Uncategorized ("") at the bottom.
        if (a === "" && b !== "") return 1;
        if (b === "" && a !== "") return -1;
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });
      for (const cat of categories) {
        const heading = cat === "" ? "uncategorized" : cat;
        this.dropdownEl.appendChild(this.buildDropdownSection(heading, byCategory.get(cat)!));
      }
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "pn-jseffect-dd-actions";
    const saveAction = document.createElement("button");
    saveAction.type = "button";
    saveAction.className = "pn-jseffect-dd-action";
    saveAction.textContent = "⭑ save current to library…";
    saveAction.addEventListener("click", () => { this.closeDropdown(); this.openSavePrompt(); });

    const manageAction = document.createElement("button");
    manageAction.type = "button";
    manageAction.className = "pn-jseffect-dd-action";
    manageAction.textContent = "⚙ manage library…";
    manageAction.addEventListener("click", () => { this.closeDropdown(); this.openManageDialog(); });

    actionsRow.append(saveAction, manageAction);
    this.dropdownEl.appendChild(actionsRow);
  }

  private buildDropdownSection(heading: string, entries: LibraryEntry[]): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "pn-jseffect-dd-section";

    const h = document.createElement("div");
    h.className = "pn-jseffect-dd-heading";
    h.textContent = heading;
    section.appendChild(h);

    const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const entry of sorted) {
      const row = document.createElement("div");
      row.className = "pn-jseffect-dd-row";

      const { leaf } = splitCategory(entry.name);
      const name = document.createElement("button");
      name.type = "button";
      name.className = "pn-jseffect-dd-name";
      name.textContent = leaf || entry.name;
      name.title = `load "${entry.name}"`;
      name.addEventListener("click", () => this.loadEntry(entry));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pn-jseffect-dd-del";
      del.textContent = "×";
      del.title = `delete "${entry.name}" from library`;
      del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteEntry(entry); });

      row.append(name, del);
      section.appendChild(row);
    }
    return section;
  }

  private loadEntry(entry: LibraryEntry): void {
    this.closeDropdown();
    const current = this.view.state.doc.toString();
    // Replace editor content — the updateListener will fire scheduleCompile
    // which persists + recompiles.
    this.view.dispatch({ changes: { from: 0, to: current.length, insert: entry.code } });
  }

  private deleteEntry(entry: LibraryEntry): void {
    const confirmed = confirm(`Delete "${entry.name}" from the library?`);
    if (!confirmed) return;
    setGlobalLibrary(getGlobalLibrary().filter(e => e.name !== entry.name));
    this.renderDropdown();
  }

  // ── Save flow ─────────────────────────────────────────────────────────

  private openSavePrompt(): void {
    // Remove any existing prompt so a double-click doesn't stack them.
    this.root.querySelector(".pn-jseffect-save-prompt")?.remove();
    const code = this.view.state.doc.toString().trim();
    if (!code) {
      this.renderStatus("nothing to save — editor is empty", "error");
      return;
    }

    const prompt = document.createElement("div");
    prompt.className = "pn-jseffect-save-prompt";
    prompt.addEventListener("mousedown", (e) => e.stopPropagation());

    const label = document.createElement("div");
    label.className = "pn-jseffect-save-label";
    label.textContent = "save as…";
    prompt.appendChild(label);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "pn-jseffect-save-name";
    nameInput.placeholder = "effect name";
    nameInput.value = deriveNameFromCode(code) || this.currentDesc || "";
    prompt.appendChild(nameInput);

    const actions = document.createElement("div");
    actions.className = "pn-jseffect-save-actions";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "pn-jseffect-hdr-btn pn-jseffect-save-ok";
    ok.textContent = "save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pn-jseffect-hdr-btn";
    cancel.textContent = "cancel";
    actions.append(ok, cancel);
    prompt.appendChild(actions);

    const close = () => prompt.remove();
    cancel.addEventListener("click", close);

    const commit = () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      this.saveEntry({ name, code });
      close();
    };
    ok.addEventListener("click", commit);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });

    this.root.appendChild(prompt);
    nameInput.focus();
    nameInput.select();
  }

  private saveEntry(entry: LibraryEntry): void {
    setGlobalLibrary(upsertEntry(getGlobalLibrary(), entry));
    if (this.dropdownOpen) this.renderDropdown();
  }

  // ── Manage dialog ─────────────────────────────────────────────────────

  private openManageDialog(): void {
    this.currentDialog?.close();
    this.currentDialog = new JsEffectLibraryDialog(this.patchNode, this.graph, () => {
      if (this.dropdownOpen) this.renderDropdown();
    });
    this.currentDialog.open();
  }

  // ── Lock ──────────────────────────────────────────────────────────────

  private toggleLock(): void {
    const currentlyLocked = (this.patchNode.args[2] ?? "0") === "1";
    this.patchNode.args[2] = currentlyLocked ? "0" : "1";
    // Update the live body's data-locked attribute without waiting for a
    // full re-render, so the CSS locked-state kicks in instantly.
    if (this.currentHost) {
      const body = this.currentHost.closest<HTMLElement>(".patch-object-jseffect-body");
      if (body) body.dataset.locked = this.patchNode.args[2];
    }
    this.renderLockIcon();
    // "change" so autosave flushes the new lock state to disk.
    this.graph.emit("change");
  }

  private renderLockIcon(): void {
    const locked = (this.patchNode.args[2] ?? "0") === "1";
    this.lockButton.innerHTML = locked ? LOCK_ICON_CLOSED : LOCK_ICON_OPEN;
    this.lockButton.dataset.locked = locked ? "1" : "0";
    this.lockButton.title = locked ? "locked — click to unlock + edit" : "unlocked — click to lock + move";
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private readSourceFromArgs(): string {
    return this.patchNode.args[0] ?? "";
  }

  private persistSource(): void {
    const source = this.view.state.doc.toString();
    if (this.patchNode.args[0] === source) return;
    this.patchNode.args[0] = source;
    this.graph.emit("change");
  }

  /** Decode args[3] into a sliderIndex→value map. Tolerant of missing/malformed. */
  private readSliderValuesFromArgs(): Map<number, number> {
    const result = new Map<number, number>();
    const raw = this.patchNode.args[3] ?? "";
    if (!raw) return result;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          const idx = Number.parseInt(k, 10);
          const val = typeof v === "number" ? v : Number.parseFloat(String(v));
          if (Number.isInteger(idx) && Number.isFinite(val)) result.set(idx, val);
        }
      }
    } catch { /* ignore — treat as empty */ }
    return result;
  }

  /**
   * Write sliderValues to args[3] without emitting. Used during slider drag
   * (input tick) so the DOM isn't destroyed mid-drag; caller emits "display"
   * for the text panel and "change" on commit.
   */
  private writeSliderValuesToArgs(): boolean {
    const obj: Record<string, number> = {};
    const keys = Array.from(this.sliderValues.keys()).sort((a, b) => a - b);
    for (const k of keys) obj[String(k)] = this.sliderValues.get(k)!;
    const encoded = keys.length === 0 ? "" : JSON.stringify(obj);
    if ((this.patchNode.args[3] ?? "") === encoded) return false;
    this.patchNode.args[3] = encoded;
    return true;
  }

  /**
   * Re-derive node.inlets from the current source and prune edges that now
   * point to indices that no longer exist. Called after every successful parse.
   */
  private syncNodePorts(): void {
    const { inlets, outlets } = deriveJsEffectPorts(this.patchNode.args);
    const prev = this.patchNode.inlets;
    const changed =
      prev.length !== inlets.length ||
      prev.some((p, i) => p.index !== inlets[i].index || p.label !== inlets[i].label);
    if (!changed) return;

    this.patchNode.inlets = inlets;
    this.patchNode.outlets = outlets;

    for (const edge of this.graph.getEdges()) {
      if (edge.toNodeId === this.patchNode.id && edge.toInlet >= inlets.length) {
        this.graph.removeEdge(edge.id);
      }
    }
    this.graph.emit("change");
  }

  /**
   * Called by ObjectInteractionController when a value arrives on a side-inlet.
   * Maps inlet index → slider index, updates the DOM range + readout, pushes
   * to the AudioWorklet node, and persists.
   */
  applyInletValue(inletIndex: number, rawValue: string): void {
    const sliderSlot = inletIndex - JS_EFFECT_SIDE_INLET_START;
    if (sliderSlot < 0) return;
    const sliderEntries = Array.from(this.sliderInputs.entries()); // insertion order = display order
    const entry = sliderEntries[sliderSlot];
    if (!entry) return;
    const [sliderIdx, { range, readout }] = entry;
    const decl = this.latestSliderDeclByIndex(sliderIdx);
    if (!decl) return;

    const num = Number.parseFloat(rawValue);
    if (!Number.isFinite(num)) return;
    const clamped = clamp(num, decl.min, decl.max);

    this.sliderValues.set(sliderIdx, clamped);
    range.value = String(clamped);
    readout.textContent = formatSliderReadout(clamped, decl);
    this.jsEffectNode?.setSlider(sliderIdx - 1, clamped);
    if (this.writeSliderValuesToArgs()) this.graph.emit("display");
  }

  private latestSliderDeclsRef: SliderDecl[] = [];
  private latestSliderDeclByIndex(index: number): SliderDecl | undefined {
    return this.latestSliderDeclsRef.find(s => s.index === index);
  }

  // ── UI helpers ────────────────────────────────────────────────────────

  private updateTitle(desc: string): void {
    this.titleText.textContent = desc ? `js~ — ${desc}` : "js~";
  }

  private renderStatus(message: string, kind: "ok" | "error" | ""): void {
    this.statusLine.textContent = message;
    if (kind) this.statusLine.dataset.kind = kind;
    else delete this.statusLine.dataset.kind;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function formatSliderReadout(value: number, s: SliderDecl): string {
  if (s.enumLabels.length > 0) {
    const stepSize = s.step && s.step > 0 ? s.step : 1;
    const idx = Math.round((value - s.min) / stepSize);
    if (idx >= 0 && idx < s.enumLabels.length) return s.enumLabels[idx];
  }
  if (s.step !== undefined && s.step >= 1 && Number.isInteger(s.step)) {
    return String(Math.round(value));
  }
  const decimals = s.step === undefined ? 3 : Math.min(6, Math.max(0, Math.ceil(-Math.log10(s.step))));
  return value.toFixed(decimals);
}
