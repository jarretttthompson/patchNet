import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, placeholder } from "@codemirror/view";

import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import type { ReaperVideoNode } from "../runtime/ReaperVideoNode";
import type { ParamDecl } from "../runtime/rvideo/parser";
import { deriveReaperVideoPorts, getReaperVideoSideInletStart } from "../graph/objectDefs";
import {
  getPatchLibrary,
  getGlobalLibrary,
  setGlobalLibrary,
  writePatchLibrary,
  upsertEntry,
  deriveNameFromCode,
  type LibraryEntry,
  type ScopedLibraryEntry,
} from "../runtime/rvideo/library";
import { ReaperVideoLibraryDialog } from "./ReaperVideoLibraryDialog";

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
 * Inline expanded panel for a `reaperVideo` object.
 *
 * Header: [ ▾ title ] [ save ] [ manage ] [ 🔒 ]
 * Body  : [ knobs LEFT ] | [ code RIGHT ]
 * Status: compile + param count (bottom)
 *
 * args[0] = code (raw)
 * args[1] = library (JSON of patch-scoped entries)
 * args[2] = locked  ("0" | "1")
 */
export class ReaperVideoPanel {
  private readonly root: HTMLDivElement;
  private readonly codeHost: HTMLDivElement;
  private readonly knobPane: HTMLDivElement;
  private readonly statusLine: HTMLDivElement;

  // Header controls
  private readonly titleButton: HTMLButtonElement;
  private readonly titleText: HTMLSpanElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly manageButton: HTMLButtonElement;
  private readonly lockButton: HTMLButtonElement;
  private readonly dropdownEl: HTMLDivElement;

  private readonly view: EditorView;

  private paramDecls: ParamDecl[] = [];
  private paramValuesByName = new Map<string, number>();
  private knobInputs = new Map<number, { range: HTMLInputElement; readout: HTMLSpanElement }>();

  /** Wet/dry slider widgets. Built once at panel construction and never
   *  rebuilt — unlike user knobs which rebuild on every recompile, this is
   *  a host-level control whose identity doesn't depend on the script. */
  private wetRange!: HTMLInputElement;
  private wetReadout!: HTMLSpanElement;
  /** "No //@params declared" hint, pinned below the wet row. */
  private emptyHint!: HTMLDivElement;

  private currentHost: HTMLElement | null = null;
  private compileTimeout: number | null = null;

  private dropdownOpen = false;
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private currentDialog: ReaperVideoLibraryDialog | null = null;

  private currentTitle = "";

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    private readonly vizGraph: VisualizerGraph,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pn-rvideo-panel";
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    // Swallow mousedown ONLY when unlocked — unlocked = panel interactive,
    // so clicks mustn't trigger DragController. Locked = drag bubbles through.
    this.root.addEventListener("mousedown", (e) => {
      const locked = (this.patchNode.args[2] ?? "0") === "1";
      if (locked) return;
      e.stopPropagation();
    });

    // ── Buttons (re-parented into the knob-column header below) ──────
    this.titleButton = document.createElement("button");
    this.titleButton.type = "button";
    this.titleButton.className = "pn-rvideo-title-btn";
    const caret = document.createElement("span");
    caret.className = "pn-rvideo-caret";
    caret.textContent = "▾";
    this.titleText = document.createElement("span");
    this.titleText.className = "pn-rvideo-title";
    this.titleText.textContent = "reaperVideo*";
    this.titleButton.append(caret, this.titleText);
    this.titleButton.addEventListener("click", (e) => { e.stopPropagation(); this.toggleDropdown(); });

    this.saveButton = document.createElement("button");
    this.saveButton.type = "button";
    this.saveButton.className = "pn-rvideo-hdr-btn";
    this.saveButton.textContent = "save";
    this.saveButton.title = "save current effect to library";
    this.saveButton.addEventListener("click", (e) => { e.stopPropagation(); this.openSavePrompt(); });

    this.manageButton = document.createElement("button");
    this.manageButton.type = "button";
    this.manageButton.className = "pn-rvideo-hdr-btn";
    this.manageButton.textContent = "manage";
    this.manageButton.title = "open library manager";
    this.manageButton.addEventListener("click", (e) => { e.stopPropagation(); this.openManageDialog(); });

    this.lockButton = document.createElement("button");
    this.lockButton.type = "button";
    this.lockButton.className = "pn-rvideo-lock";
    this.lockButton.addEventListener("click", (e) => { e.stopPropagation(); this.toggleLock(); });
    this.renderLockIcon();

    this.dropdownEl = document.createElement("div");
    this.dropdownEl.className = "pn-rvideo-dropdown";
    this.dropdownEl.hidden = true;

    // ── Body: knobs LEFT (full-height column) / code RIGHT ────────────
    // Two-column layout. Each column owns its own header slice so the
    // knob-column header is exactly ATTR_SIDE_INLET_HEADER_H (22px) tall,
    // which is what the side-inlet nub formula in ObjectRenderer assumes.
    // That alignment is the whole point — it means slot N's nub is at
    // object.top + 22 + N*24 + 12, which is also where the Nth knob row
    // renders. No runtime sync required.
    const body = document.createElement("div");
    body.className = "pn-rvideo-body";

    // Left column: knob header (with label buttons) + knob rows.
    const knobCol = document.createElement("div");
    knobCol.className = "pn-rvideo-knob-col";

    const knobHeader = document.createElement("div");
    knobHeader.className = "pn-rvideo-knob-header";
    knobHeader.append(this.titleButton, this.saveButton, this.manageButton, this.lockButton);
    knobHeader.appendChild(this.dropdownEl);

    this.knobPane = document.createElement("div");
    this.knobPane.className = "pn-rvideo-knobs";

    // Host-level wet/dry row — rendered directly below the user @param knobs
    // (grid slot = paramCount) so its side-inlet nub aligns on the same
    // 22px-header / 24px-row grid as the param nubs. Always present; doesn't
    // rebuild when the user's params change. A scroll wrapper holds both the
    // knob pane and the wet row so the header stays pinned while the rows
    // scroll together as one unit.
    const wetRow = this.buildWetRow();

    // "No //@params declared" hint. Lives *below* the wet row (not inside
    // knobPane) so it never displaces the wet row from grid slot 0 when the
    // script has no params — that alignment is what keeps the wet inlet nub
    // on the wet row. Shown/hidden by rebuildKnobPane.
    this.emptyHint = document.createElement("div");
    this.emptyHint.className = "pn-rvideo-empty";
    this.emptyHint.textContent = "no //@params declared";
    this.emptyHint.hidden = true;

    const knobScroll = document.createElement("div");
    knobScroll.className = "pn-rvideo-knob-scroll";
    knobScroll.append(this.knobPane, wetRow, this.emptyHint);

    knobCol.append(knobHeader, knobScroll);

    // Right column: code editor + status line.
    const codeCol = document.createElement("div");
    codeCol.className = "pn-rvideo-code-col";

    this.codeHost = document.createElement("div");
    this.codeHost.className = "pn-rvideo-code";

    this.statusLine = document.createElement("div");
    this.statusLine.className = "pn-rvideo-status";

    codeCol.append(this.codeHost, this.statusLine);

    body.append(knobCol, codeCol);
    this.root.appendChild(body);

    this.paramValuesByName = this.readParamValuesFromArgs();

    const initial = this.readSourceFromArgs();
    this.view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          placeholder("// paste REAPER video-processor code here…"),
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

  attach(host: HTMLElement): void {
    if (this.currentHost === host) return;
    host.appendChild(this.root);
    this.currentHost = host;
    // Nub positioning now follows the fixed 22/24px grid baked into CSS
    // (matches ObjectRenderer's side-inlet formula). No ResizeObserver
    // needed — the rows align by layout alone.
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
    this.view.destroy();
    this.root.remove();
    this.currentHost = null;
  }

  /** External re-sync (patch load / text-panel edit). */
  syncFromArgs(): void {
    const source = this.readSourceFromArgs();
    const current = this.view.state.doc.toString();
    if (source !== current) {
      this.view.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    }
    // Refresh the host-level wet slider too — patch load, undo, attribute
    // inspector, or a text-panel edit can all change args[5] under us.
    if (this.wetRange) {
      const w = this.readWetFromArgs();
      if (parseFloat(this.wetRange.value) !== w) {
        this.wetRange.value = String(w);
        this.wetReadout.textContent = formatWetReadout(w);
      }
    }
    this.renderLockIcon();
    if (this.dropdownOpen) this.renderDropdown();
  }

  // ── Compile ─────────────────────────────────────────────────────────

  private scheduleCompile(): void {
    if (this.compileTimeout !== null) window.clearTimeout(this.compileTimeout);
    this.compileTimeout = window.setTimeout(() => {
      this.compileTimeout = null;
      // persistSource before compileNow so the "change" emit inside
      // syncNodePorts sees the latest args[0] (avoids syncFromArgs reverting
      // the editor doc).
      this.persistSource();
      this.compileNow();
    }, COMPILE_DEBOUNCE_MS);
  }

  private compileNow(): void {
    const source = this.view.state.doc.toString();
    const node = this.getNode();
    if (!node) {
      this.renderStatus("(runtime node not ready)", "");
      return;
    }

    this.currentTitle = deriveNameFromCode(source);
    this.updateTitle(this.currentTitle);

    const result = node.compile(source);
    if (!result.ok) {
      const where = result.line !== undefined ? `line ${result.line}: ` : "";
      this.renderStatus(`${where}${result.message}`, "error");
      return;
    }

    this.paramDecls = result.params;
    this.rebuildKnobPane();
    this.syncNodePorts();
    for (let i = 0; i < this.paramDecls.length; i++) {
      const decl = this.paramDecls[i];
      const v = this.paramValuesByName.get(decl.name);
      if (v !== undefined) node.setParam(i, v);
    }
    const n = this.paramDecls.length;
    this.renderStatus(`compiled · ${n} param${n === 1 ? "" : "s"}`, "ok");
  }

  // ── Host-level wet/dry control ─────────────────────────────────────

  /** Build the persistent wet/dry row that sits below the user @param
   *  knobs at grid slot = paramCount. The slider value lives in `args[5]`
   *  (positional, persists with the patch); the runtime node reads it via
   *  VisualizerGraph's per-sync push, and the panel pushes directly on drag
   *  so scrubbing feels live. The "divider" above it is a CSS border-top on
   *  the row itself (box-sizing: border-box) so it adds no vertical height —
   *  keeping the row exactly ROW_H tall so the side-inlet nub formula lands
   *  on its center. */
  private buildWetRow(): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-rvideo-knob-row pn-rvideo-knob-row--wet";

    // End-labelled fader: "dry" hugs the slider's low (left) end, "wet" hugs
    // the high (right) end — so the direction of the mix is self-evident
    // instead of relying on the user to remember which way is wet. The
    // shared knob-label slot carries "dry" (right-aligned, so it sits right
    // against the track); a small "wet" marker sits just past the track.
    const wetTitle = "Wet/dry mix — applies after the script's frame fn.\nLeft (dry) = pure input / bypass, right (wet) = pure effect.\nDrive it from a cable on the left-side wet/dry inlet.";

    const label = document.createElement("span");
    label.className = "pn-rvideo-knob-label";
    label.textContent = "dry";
    label.title = wetTitle;

    const range = document.createElement("input");
    range.type = "range";
    range.className = "pn-rvideo-knob-range";
    range.min = "0";
    range.max = "1";
    range.step = "0.01";
    range.value = String(this.readWetFromArgs());
    range.title = wetTitle;

    const wetEnd = document.createElement("span");
    wetEnd.className = "pn-rvideo-wet-end";
    wetEnd.textContent = "wet";
    wetEnd.title = wetTitle;

    const readout = document.createElement("span");
    readout.className = "pn-rvideo-knob-readout";
    readout.textContent = formatWetReadout(parseFloat(range.value));

    range.addEventListener("input", () => {
      const v = parseFloat(range.value);
      if (!Number.isFinite(v)) return;
      readout.textContent = formatWetReadout(v);
      this.writeWetToArgs(v);
      // Push directly to the runtime node so dragging is responsive — the
      // periodic VisualizerGraph.sync also pushes wet, but that runs on
      // graph "change" which we deliberately don't fire mid-drag.
      this.getNode()?.setWet(v);
      this.graph.emit("display");
    });
    range.addEventListener("change", () => {
      // Commit the drag — emit "change" so the patch becomes dirty and
      // autosave/undo notice the new wet value.
      this.graph.emit("change");
    });
    range.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      range.value = "1";
      readout.textContent = formatWetReadout(1);
      this.writeWetToArgs(1);
      this.getNode()?.setWet(1);
      this.graph.emit("change");
    });

    row.append(label, range, wetEnd, readout);

    this.wetRange = range;
    this.wetReadout = readout;
    return row;
  }

  /** Read wet from args[5], defaulting to 1 (full effect) when unset or
   *  unparseable. Clamped to [0, 1]. */
  private readWetFromArgs(): number {
    const raw = parseFloat(this.patchNode.args[5] ?? "1");
    if (!Number.isFinite(raw)) return 1;
    return raw < 0 ? 0 : raw > 1 ? 1 : raw;
  }

  /** Write wet to args[5]. Returns true if the stored string changed, so
   *  callers can gate their `display` emit (avoids spamming the text-panel
   *  sync when an inlet delivers the same value repeatedly). */
  private writeWetToArgs(v: number): boolean {
    const next = String(v);
    if ((this.patchNode.args[5] ?? "") === next) return false;
    this.patchNode.args[5] = next;
    return true;
  }

  // ── Knobs ───────────────────────────────────────────────────────────

  private rebuildKnobPane(): void {
    this.knobPane.textContent = "";
    this.knobInputs.clear();

    if (this.paramDecls.length === 0) {
      // No knobs — knobPane stays empty (height 0) so the wet row sits at
      // grid slot 0. The hint shows below the wet row instead.
      this.emptyHint.hidden = false;
      this.ensureMinHeight(0);
      return;
    }
    this.emptyHint.hidden = true;

    for (let i = 0; i < this.paramDecls.length; i++) {
      const decl = this.paramDecls[i];
      const prev = this.paramValuesByName.get(decl.name);
      const value = prev !== undefined ? clamp(prev, decl.min, decl.max) : decl.defaultValue;
      this.paramValuesByName.set(decl.name, value);

      // Attribute-style horizontal row: [label] [──slider──] [readout].
      // Fixed 24px height matches ATTR_SIDE_INLET_ROW_H so side-inlet nubs
      // land on row centers via the ObjectRenderer formula (no sync).
      const row = document.createElement("div");
      row.className = "pn-rvideo-knob-row";

      const label = document.createElement("span");
      label.className = "pn-rvideo-knob-label";
      label.textContent = decl.label || decl.name;
      label.title = decl.label || decl.name;

      const range = document.createElement("input");
      range.type = "range";
      range.className = "pn-rvideo-knob-range";
      range.min = String(decl.min);
      range.max = String(decl.max);
      range.step = decl.step !== undefined && decl.step > 0 ? String(decl.step) : String((decl.max - decl.min) / 1000);
      range.value = String(value);

      const readout = document.createElement("span");
      readout.className = "pn-rvideo-knob-readout";
      readout.textContent = formatReadout(value, decl);

      const paramIndex = i;
      range.addEventListener("input", () => {
        const v = parseFloat(range.value);
        if (!Number.isFinite(v)) return;
        this.paramValuesByName.set(decl.name, v);
        readout.textContent = formatReadout(v, decl);
        this.getNode()?.setParam(paramIndex, v);
        // In-place args write + display emit — emitting "change" on every
        // tick destroys the slider DOM mid-drag and breaks smooth scrubbing.
        this.writeParamValuesToArgs();
        this.graph.emit("display");
      });
      range.addEventListener("change", () => {
        this.graph.emit("change");
      });

      // Double-click the slider track → reset to the param's declared default.
      range.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const v = decl.defaultValue;
        range.value = String(v);
        readout.textContent = formatReadout(v, decl);
        this.paramValuesByName.set(decl.name, v);
        this.getNode()?.setParam(paramIndex, v);
        this.writeParamValuesToArgs();
        this.graph.emit("change");
      });

      // Double-click the readout number → open an inline text-entry field.
      readout.style.cursor = "text";
      readout.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.beginInlineEdit(readout, range, decl, paramIndex);
      });

      row.append(label, range, readout);
      this.knobPane.appendChild(row);
      this.knobInputs.set(i, { range, readout });
    }

    this.ensureMinHeight(this.paramDecls.length);
  }

  /**
   * Replace the readout span with a text <input> so the user can type a value.
   * Commits on Enter or blur; cancels on Escape. Keyboard events are stopped
   * at the input so canvas shortcuts don't fire while the user types numbers.
   */
  private beginInlineEdit(
    readout: HTMLSpanElement,
    range:   HTMLInputElement,
    decl:    ParamDecl,
    paramIndex: number,
  ): void {
    // Don't open a second editor if one is already active on this row.
    if (readout.querySelector("input")) return;

    const currentVal = this.paramValuesByName.get(decl.name) ?? decl.defaultValue;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "pn-rvideo-knob-edit";
    input.value = formatReadout(currentVal, decl);
    // Prevent canvas keyboard shortcuts while typing.
    input.addEventListener("keydown", (e) => e.stopPropagation());
    input.addEventListener("keyup",   (e) => e.stopPropagation());

    // Swap span text out, insert the input.
    readout.textContent = "";
    readout.appendChild(input);
    input.focus();
    input.select();

    let committed = false;

    const commit = () => {
      if (committed) return;
      committed = true;

      const raw = input.value.trim();
      const parsed = parseFloat(raw);
      const v = Number.isFinite(parsed) ? clamp(parsed, decl.min, decl.max) : currentVal;

      // Restore the span first (removes input from DOM).
      readout.textContent = formatReadout(v, decl);

      if (v !== currentVal) {
        range.value = String(v);
        this.paramValuesByName.set(decl.name, v);
        this.getNode()?.setParam(paramIndex, v);
        this.writeParamValuesToArgs();
        this.graph.emit("change");
      }
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      readout.textContent = formatReadout(currentVal, decl);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });

    // blur fires after Enter's keydown in most browsers, so the `committed`
    // guard keeps us from double-applying.
    input.addEventListener("blur", commit);
  }

  /** Grow the object vertically so every knob row (22px header + N*24px) fits
   *  inside the object body. Prevents side-inlet nubs from rendering past the
   *  bottom edge when the user resized the object down or the preset has more
   *  params than the current height accommodates. */
  private ensureMinHeight(paramCount: number): void {
    // 22 (header) + (N+1)*24 (param rows + the always-present wet/dry row)
    // + 22 (status line on right column). Floor: don't shrink a manually-
    // widened object; only grow.
    const needed = 22 + (paramCount + 1) * 24 + 22;
    const current = this.patchNode.height ?? 0;
    if (current < needed) {
      this.patchNode.height = needed;
      this.graph.emit("display");
    }
  }

  /**
   * Called by ObjectInteractionController when a value arrives on a side-inlet.
   * Maps inlet index → param slot, updates the knob DOM, pushes to the video
   * node, and persists.
   */
  applyInletValue(inletIndex: number, rawValue: string): void {
    const sideStart = getReaperVideoSideInletStart(this.getSource());
    const slot = inletIndex - sideStart;
    if (slot < 0) return;

    // The wet/dry inlet is the slot directly after the last param (matches
    // deriveReaperVideoPorts). Handle it before the param-range bounds check
    // since it lives outside the paramDecls array.
    if (slot === this.paramDecls.length) {
      const num = Number.parseFloat(rawValue);
      if (!Number.isFinite(num)) return;
      const clamped = clamp(num, 0, 1);
      if (this.wetRange) {
        this.wetRange.value = String(clamped);
        this.wetReadout.textContent = formatWetReadout(clamped);
      }
      // Always push to the runtime node (cheap, and the value may differ
      // from args even when the string matches after rounding); only emit
      // display when the persisted string actually changed.
      this.getNode()?.setWet(clamped);
      if (this.writeWetToArgs(clamped)) this.graph.emit("display");
      return;
    }

    if (slot >= this.paramDecls.length) return;
    const decl = this.paramDecls[slot];
    const input = this.knobInputs.get(slot);
    if (!decl || !input) return;

    const num = Number.parseFloat(rawValue);
    if (!Number.isFinite(num)) return;
    const clamped = clamp(num, decl.min, decl.max);

    this.paramValuesByName.set(decl.name, clamped);
    input.range.value = String(clamped);
    input.readout.textContent = formatReadout(clamped, decl);
    this.getNode()?.setParam(slot, clamped);
    if (this.writeParamValuesToArgs()) this.graph.emit("display");
  }

  /**
   * Re-derive node.inlets from current source and prune edges pointing to
   * removed inlets. Called after every successful parse.
   */
  private syncNodePorts(): void {
    const { inlets, outlets } = deriveReaperVideoPorts(this.patchNode.args);
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

  private readParamValuesFromArgs(): Map<string, number> {
    const result = new Map<string, number>();
    const raw = this.patchNode.args[3] ?? "";
    if (!raw) return result;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          const val = typeof v === "number" ? v : Number.parseFloat(String(v));
          if (typeof k === "string" && Number.isFinite(val)) result.set(k, val);
        }
      }
    } catch { /* ignore */ }
    return result;
  }

  /**
   * Write paramValues to args[3] without emitting. Caller handles emit:
   * "display" during drag (cheap text-panel sync), "change" on commit.
   */
  private writeParamValuesToArgs(): boolean {
    const obj: Record<string, number> = {};
    const keys = Array.from(this.paramValuesByName.keys()).sort();
    for (const k of keys) obj[k] = this.paramValuesByName.get(k)!;
    const encoded = keys.length === 0 ? "" : JSON.stringify(obj);
    if ((this.patchNode.args[3] ?? "") === encoded) return false;
    this.patchNode.args[3] = encoded;
    return true;
  }

  // ── Dropdown ────────────────────────────────────────────────────────

  private toggleDropdown(): void {
    if (this.dropdownOpen) this.closeDropdown();
    else this.openDropdown();
  }

  private openDropdown(): void {
    if (this.dropdownOpen) return;
    this.dropdownOpen = true;
    this.dropdownEl.hidden = false;
    this.renderDropdown();

    this.documentClickHandler = (e: MouseEvent) => {
      if (!this.dropdownEl.contains(e.target as Node) && !this.titleButton.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    this.escapeHandler = (e: KeyboardEvent) => { if (e.key === "Escape") this.closeDropdown(); };
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

    const patchEntries: ScopedLibraryEntry[]  = getPatchLibrary(this.patchNode).map(e => ({ ...e, scope: "patch" }));
    const globalEntries: ScopedLibraryEntry[] = getGlobalLibrary().map(e => ({ ...e, scope: "global" }));

    if (patchEntries.length === 0 && globalEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-rvideo-dd-empty";
      empty.textContent = 'no saved effects — click "save" to add the current one';
      this.dropdownEl.appendChild(empty);
    } else {
      if (patchEntries.length > 0) {
        this.dropdownEl.appendChild(this.buildDropdownSection("saved effects (patch)", patchEntries));
      }
      if (globalEntries.length > 0) {
        this.dropdownEl.appendChild(this.buildDropdownSection("⌂ saved effects (global)", globalEntries));
      }
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "pn-rvideo-dd-actions";

    const saveAction = document.createElement("button");
    saveAction.type = "button";
    saveAction.className = "pn-rvideo-dd-action";
    saveAction.textContent = "⭑ save current to library…";
    saveAction.addEventListener("click", () => { this.closeDropdown(); this.openSavePrompt(); });

    const manageAction = document.createElement("button");
    manageAction.type = "button";
    manageAction.className = "pn-rvideo-dd-action";
    manageAction.textContent = "⚙ manage library…";
    manageAction.addEventListener("click", () => { this.closeDropdown(); this.openManageDialog(); });

    actionsRow.append(saveAction, manageAction);
    this.dropdownEl.appendChild(actionsRow);
  }

  private buildDropdownSection(heading: string, entries: ScopedLibraryEntry[]): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "pn-rvideo-dd-section";

    const h = document.createElement("div");
    h.className = "pn-rvideo-dd-heading";
    h.textContent = heading;
    section.appendChild(h);

    const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const entry of sorted) {
      const row = document.createElement("div");
      row.className = "pn-rvideo-dd-row";

      const name = document.createElement("button");
      name.type = "button";
      name.className = "pn-rvideo-dd-name";
      name.textContent = entry.name;
      name.title = `load "${entry.name}"`;
      name.addEventListener("click", () => this.loadEntry(entry));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pn-rvideo-dd-del";
      del.textContent = "×";
      del.title = `delete "${entry.name}" from ${entry.scope} library`;
      del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteEntry(entry); });

      row.append(name, del);
      section.appendChild(row);
    }
    return section;
  }

  private loadEntry(entry: ScopedLibraryEntry): void {
    this.closeDropdown();
    const current = this.view.state.doc.toString();
    this.view.dispatch({ changes: { from: 0, to: current.length, insert: entry.code } });
  }

  private deleteEntry(entry: ScopedLibraryEntry): void {
    const confirmed = confirm(`Delete "${entry.name}" from the ${entry.scope} library?`);
    if (!confirmed) return;
    if (entry.scope === "patch") {
      const next = getPatchLibrary(this.patchNode).filter(e => e.name !== entry.name);
      writePatchLibrary(this.graph, this.patchNode, next);
    } else {
      const next = getGlobalLibrary().filter(e => e.name !== entry.name);
      setGlobalLibrary(next);
    }
    this.renderDropdown();
  }

  // ── Save flow ───────────────────────────────────────────────────────

  private openSavePrompt(): void {
    this.root.querySelector(".pn-rvideo-save-prompt")?.remove();
    const code = this.view.state.doc.toString().trim();
    if (!code) {
      this.renderStatus("nothing to save — editor is empty", "error");
      return;
    }

    const prompt = document.createElement("div");
    prompt.className = "pn-rvideo-save-prompt";
    prompt.addEventListener("mousedown", (e) => e.stopPropagation());

    const label = document.createElement("div");
    label.className = "pn-rvideo-save-label";
    label.textContent = "save as…";
    prompt.appendChild(label);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "pn-rvideo-save-name";
    nameInput.placeholder = "effect name";
    nameInput.value = deriveNameFromCode(code) || this.currentTitle || "";
    prompt.appendChild(nameInput);

    const scopeRow = document.createElement("div");
    scopeRow.className = "pn-rvideo-save-scope";
    const mkRadio = (value: "patch" | "global", text: string, checked: boolean): HTMLLabelElement => {
      const wrap = document.createElement("label");
      wrap.className = "pn-rvideo-save-radio";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `rvideo-save-${this.patchNode.id}`;
      radio.value = value;
      radio.checked = checked;
      const txt = document.createElement("span");
      txt.textContent = text;
      wrap.append(radio, txt);
      return wrap;
    };
    scopeRow.append(mkRadio("patch", "patch", true), mkRadio("global", "global (⌂)", false));
    prompt.appendChild(scopeRow);

    const actions = document.createElement("div");
    actions.className = "pn-rvideo-save-actions";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "pn-rvideo-hdr-btn pn-rvideo-save-ok";
    ok.textContent = "save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pn-rvideo-hdr-btn";
    cancel.textContent = "cancel";
    actions.append(ok, cancel);
    prompt.appendChild(actions);

    const close = () => prompt.remove();
    cancel.addEventListener("click", close);

    const commit = () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const scope = (prompt.querySelector<HTMLInputElement>(`input[name="rvideo-save-${this.patchNode.id}"]:checked`)?.value ?? "patch") as "patch" | "global";
      this.saveEntry({ name, code }, scope);
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

  private saveEntry(entry: LibraryEntry, scope: "patch" | "global"): void {
    if (scope === "patch") {
      const next = upsertEntry(getPatchLibrary(this.patchNode), entry);
      writePatchLibrary(this.graph, this.patchNode, next);
    } else {
      setGlobalLibrary(upsertEntry(getGlobalLibrary(), entry));
    }
    if (this.dropdownOpen) this.renderDropdown();
  }

  // ── Manage dialog ───────────────────────────────────────────────────

  private openManageDialog(): void {
    this.currentDialog?.close();
    this.currentDialog = new ReaperVideoLibraryDialog(this.patchNode, this.graph, () => {
      if (this.dropdownOpen) this.renderDropdown();
    });
    this.currentDialog.open();
  }

  // ── Lock ────────────────────────────────────────────────────────────

  private toggleLock(): void {
    const locked = (this.patchNode.args[2] ?? "0") === "1";
    this.patchNode.args[2] = locked ? "0" : "1";
    if (this.currentHost) {
      const body = this.currentHost.closest<HTMLElement>(".patch-object-rvideo-body");
      if (body) body.dataset.locked = this.patchNode.args[2];
    }
    this.renderLockIcon();
    this.graph.emit("change");
  }

  private renderLockIcon(): void {
    const locked = (this.patchNode.args[2] ?? "0") === "1";
    this.lockButton.innerHTML = locked ? LOCK_ICON_CLOSED : LOCK_ICON_OPEN;
    this.lockButton.dataset.locked = locked ? "1" : "0";
    this.lockButton.title = locked ? "locked — click to unlock + edit" : "unlocked — click to lock + move";
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private getNode(): ReaperVideoNode | undefined {
    return this.vizGraph.getReaperVideoNode(this.patchNode.id);
  }

  private getSource(): string {
    return this.view.state.doc.toString();
  }

  private readSourceFromArgs(): string {
    return this.patchNode.args[0] ?? "";
  }

  private persistSource(): void {
    const source = this.view.state.doc.toString();
    if (this.patchNode.args[0] === source) return;
    this.patchNode.args[0] = source;
    this.graph.emit("change");
  }

  private updateTitle(desc: string): void {
    this.titleText.textContent = desc ? `reaperVideo* — ${desc}` : "reaperVideo*";
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

function formatReadout(value: number, decl: ParamDecl): string {
  if (decl.step !== undefined && decl.step >= 1 && Number.isInteger(decl.step)) {
    return String(Math.round(value));
  }
  const decimals = decl.step === undefined
    ? 3
    : Math.min(6, Math.max(0, Math.ceil(-Math.log10(decl.step))));
  return value.toFixed(decimals);
}

/** Wet/dry readout: percentage at integer precision so the slider reads as
 *  "0–100%" rather than "0.00–1.00". Matches the conceptual model users
 *  bring from DAW wet/dry knobs. */
function formatWetReadout(value: number): string {
  const pct = Math.round(value * 100);
  return `${pct}%`;
}
