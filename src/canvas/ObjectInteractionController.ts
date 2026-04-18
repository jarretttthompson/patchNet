import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { AudioGraph } from "../runtime/AudioGraph";
import type { CodeboxController } from "./CodeboxController";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import {
  OBJECT_DEFS,
  getObjectDef,
  syncAttributeNode,
  resetAttributeNode,
  buildArgMessage,
  getVisibleArgs,
} from "../graph/objectDefs";
import { ImageFXPanel } from "./ImageFXPanel";
import { buildNumboxContent } from "./ObjectRenderer";

function applyDollarArgs(template: string, values: string[]): string {
  return template.replace(/\$(\d)/g, (_, n: string) => values[Number.parseInt(n, 10) - 1] ?? `$${n}`);
}

function splitOnComma(content: string): string[] {
  return content.split(",").map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Handles interactive behavior and the Phase 2/3 message bus for UI/control
 * objects. Audio objects stay inert until AudioRuntime lands.
 */
export class ObjectInteractionController {
  private readonly onPanGroupClick: (e: MouseEvent) => void;
  private readonly onPanGroupMouseDown: (e: MouseEvent) => void;
  private readonly onPanGroupDblClick: (e: MouseEvent) => void;
  private readonly onGraphChangeUnsubscribe: () => void;

  private mouseDownX = 0;
  private mouseDownY = 0;
  private readonly DRAG_THRESHOLD = 4;

  private sliderDrag: {
    node: PatchNode;
    trackEl: HTMLElement;
    thumbEl: HTMLElement;
  } | null = null;

  private numboxDrag: {
    node: PatchNode;
    el: HTMLElement;
    startY: number;
    startValue: number;
    increment: number;
    isFloat: boolean;
    activePlace: number | null;
  } | null = null;

  private readonly onDocMouseMove: (e: MouseEvent) => void;
  private readonly onDocMouseUp: (e: MouseEvent) => void;
  private readonly onAttrInput: (e: Event) => void;
  private readonly onAttrChange: (e: Event) => void;
  private readonly metroTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly mathLeftOps = new Map<string, number>();
  private codeboxController?: CodeboxController;
  private visualizerGraph?: VisualizerGraph;
  private attrDragging = false;

  constructor(
    private readonly panGroup: HTMLElement,
    private readonly graph: PatchGraph,
    private audioGraph?: AudioGraph,
  ) {
    this.onPanGroupClick = this.handleClick.bind(this);
    this.onPanGroupMouseDown = this.handleMouseDown.bind(this);
    this.onPanGroupDblClick = this.handleDblClick.bind(this);
    this.onDocMouseMove = this.handleSliderMove.bind(this);
    this.onDocMouseUp = this.handleSliderUp.bind(this);
    this.onAttrInput  = this.handleAttrInput.bind(this);
    this.onAttrChange = this.handleAttrChange.bind(this);
    this.onGraphChangeUnsubscribe = this.graph.on("change", () => {
      this.pruneMetroTimers();
      this.restoreMetroTimers();
      this.syncAttributeNodes();
    });

    this.panGroup.addEventListener("click", this.onPanGroupClick);
    this.panGroup.addEventListener("mousedown", this.onPanGroupMouseDown);
    this.panGroup.addEventListener("dblclick", this.onPanGroupDblClick);
    this.panGroup.addEventListener("input",  this.onAttrInput);
    this.panGroup.addEventListener("change", this.onAttrChange);
  }

  setAudioGraph(ag: AudioGraph | undefined): void {
    this.audioGraph = ag;
  }

  setCodeboxController(cc: CodeboxController): void {
    this.codeboxController = cc;
  }

  setVisualizerGraph(vg: VisualizerGraph): void {
    this.visualizerGraph = vg;
  }

  destroy(): void {
    this.panGroup.removeEventListener("click", this.onPanGroupClick);
    this.panGroup.removeEventListener("mousedown", this.onPanGroupMouseDown);
    this.panGroup.removeEventListener("dblclick", this.onPanGroupDblClick);
    this.panGroup.removeEventListener("input",  this.onAttrInput);
    this.panGroup.removeEventListener("change", this.onAttrChange);
    document.removeEventListener("mousemove", this.onDocMouseMove);
    document.removeEventListener("mouseup", this.onDocMouseUp);
    this.onGraphChangeUnsubscribe();
    for (const nodeId of this.metroTimers.keys()) {
      this.stopMetro(nodeId, false);
    }
  }

  private getObjectEl(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    if (target.closest(".pn-resize-handle")) return null;
    return target.closest<HTMLElement>(".patch-object");
  }

  private getNode(objectEl: HTMLElement): PatchNode | null {
    const nodeId = objectEl.dataset.nodeId;
    if (!nodeId) return null;
    return this.graph.nodes.get(nodeId) ?? null;
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;

    const objectEl = this.getObjectEl(e.target);
    if (!objectEl) return;

    const node = this.getNode(objectEl);
    if (!node) return;

    this.mouseDownX = e.clientX;
    this.mouseDownY = e.clientY;

    if (node.type === "slider") {
      const trackEl = objectEl.querySelector<HTMLElement>(".patch-object-slider-track");
      const thumbEl = objectEl.querySelector<HTMLElement>(".patch-object-slider-thumb");
      if (!trackEl || !thumbEl) return;

      e.preventDefault();

      this.sliderDrag = { node, trackEl, thumbEl };
      document.body.classList.add("pn-state-slider-drag");
      document.addEventListener("mousemove", this.onDocMouseMove);
      document.addEventListener("mouseup", this.onDocMouseUp);

      this.updateSliderFromEvent(e);

    } else if (node.type === "integer" || node.type === "float") {
      const numboxEl = objectEl.querySelector<HTMLElement>(".pn-numbox");
      if (!numboxEl) return;

      e.preventDefault();

      const isFloat = node.type === "float";
      const digitEl = (e.target as Element).closest<HTMLElement>(".pn-numbox__digit");
      const activePlace = digitEl?.dataset.place !== undefined
        ? parseInt(digitEl.dataset.place, 10)
        : (isFloat ? 0 : null);
      const increment = activePlace !== null ? Math.pow(10, activePlace) : 1;
      const startValue = parseFloat(node.args[0] ?? "0") || 0;

      this.numboxDrag = { node, el: numboxEl, startY: e.clientY, startValue, increment, isFloat, activePlace };
      document.body.classList.add("pn-state-numbox-drag");
      document.addEventListener("mousemove", this.onDocMouseMove);
      document.addEventListener("mouseup", this.onDocMouseUp);
    }
  }

  private handleClick(e: MouseEvent): void {
    if (e.button !== 0) return;

    const dx = e.clientX - this.mouseDownX;
    const dy = e.clientY - this.mouseDownY;
    if (Math.sqrt(dx * dx + dy * dy) > this.DRAG_THRESHOLD) return;

    const objectEl = this.getObjectEl(e.target);
    if (!objectEl) return;

    const node = this.getNode(objectEl);
    if (!node) return;

    if (node.type === "button") {
      this.handleButtonClick(node);
    } else if (node.type === "toggle") {
      this.handleToggleClick(node);
    } else if (node.type === "message") {
      this.handleMessageClick(node);
    } else if (node.type === "visualizer") {
      this.visualizerGraph?.deliverMessage(node.id, "bang", []);
    } else if (node.type === "patchViz") {
      this.visualizerGraph?.deliverPatchVizMessage(node.id, "bang", []);
    }
  }

  private handleButtonClick(node: PatchNode): void {
    this.dispatchBang(node.id, 0);
    this.flashButton(node.id);
  }

  private handleToggleClick(node: PatchNode): void {
    this.toggleNode(node);
  }

  private dispatchBang(fromNodeId: string, fromOutlet: number): void {
    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId !== fromNodeId || edge.fromOutlet !== fromOutlet) continue;
      const target = this.graph.nodes.get(edge.toNodeId);
      if (!target) continue;
      this.deliverBang(target, edge.toInlet);
    }
  }

  /** Route a value from a node outlet to all connected inlets. */
  fireOutlet(fromNodeId: string, fromOutlet: number, value: string): void {
    this.dispatchValue(fromNodeId, fromOutlet, value);
  }

  private dispatchValue(fromNodeId: string, fromOutlet: number, value: string): void {
    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId !== fromNodeId || edge.fromOutlet !== fromOutlet) continue;
      const target = this.graph.nodes.get(edge.toNodeId);
      if (!target) continue;
      this.deliverMessageValue(target, edge.toInlet, value);
    }
  }

  deliverBang(node: PatchNode, inlet: number): void {
    switch (node.type) {
      case "toggle":
        this.toggleNode(node);
        break;

      case "button":
        this.flashButton(node.id);
        this.dispatchBang(node.id, 0);
        break;

      case "slider":
        if (inlet === 1) {
          this.dispatchValue(node.id, 0, this.getSliderValue(node));
        }
        break;

      case "message":
        if (inlet === 0) {
          this.dispatchStoredMessage(node);
          this.flashButton(node.id);
        }
        break;

      case "metro":
        if (inlet === 0) {
          if (this.isMetroRunning(node.id)) {
            this.stopMetro(node.id);
          } else {
            this.startMetro(node);
          }
        }
        break;

      case "click~":
        this.audioGraph?.triggerClick(node.id);
        break;

      case "codebox":
        this.codeboxController?.executeBang(node, inlet);
        break;

      case "visualizer":
        if (inlet === 0) this.visualizerGraph?.deliverMessage(node.id, "bang", []);
        break;

      case "patchViz":
        if (inlet === 0) this.visualizerGraph?.deliverPatchVizMessage(node.id, "bang", []);
        break;

      case "mediaVideo":
        if (inlet === 0) this.visualizerGraph?.deliverMediaMessage(node.id, "mediaVideo", "bang", []);
        break;

      case "mediaImage":
        break;

      case "imageFX":
        break; // bang has no effect on imageFX

      case "vfxCRT":
      case "vfxBlur":
        break; // bang has no effect on vFX nodes

      case "layer":
        break;

      case "integer":
      case "float":
        if (inlet === 0) this.dispatchValue(node.id, 0, node.args[0] ?? "0");
        break;

      case "scale":
        break; // bang has no effect on scale

      case "+": case "-": case "*": case "/": case "%":
      case "==": case "!=": case ">": case "<": case ">=": case "<=":
        if (inlet === 0) {
          const left  = this.mathLeftOps.get(node.id) ?? 0;
          const right = parseFloat(node.args[0] ?? "0");
          this.dispatchValue(node.id, 0, String(this.applyMathOp(node.type, left, right)));
        }
        break;

      case "s":
        if (inlet === 0) this.broadcastToReceivers(node.args[0] ?? "", n => this.dispatchBang(n.id, 0));
        break;

      case "attribute":
        if (node.inlets.some(p => p.index === inlet && p.side === "left")) {
          this.setAttrSideInlet(node, inlet, "1");
        } else if (inlet === 0) {
          this.dispatchAttributeAll(node);
        }
        break;

      default:
        break;
    }
  }

  deliverMessageValue(node: PatchNode, inlet: number, value: string): void {
    switch (node.type) {
      case "toggle": {
        // Handle attribute-style "value 0|1" message in addition to plain float
        const toggleVal = value.startsWith("value ") ? value.slice(6).trim() : value;
        this.setToggleFromValue(node, toggleVal);
        break;
      }

      case "slider":
        if (inlet === 0) {
          const sliderRaw = value.startsWith("value ") ? value.slice(6).trim() : value;
          const parsed = Number.parseFloat(sliderRaw);
          if (Number.isNaN(parsed)) break;
          const { min, max } = this.getSliderRange(node);
          const clamped = Math.round(Math.max(min, Math.min(max, parsed)));
          node.args[0] = String(clamped);
          this.syncSliderThumb(node.id, clamped, node);
          this.graph.emit("change");
          this.dispatchValue(node.id, 0, String(clamped));
        }
        break;

      case "button": {
        const parsed = Number.parseFloat(value);
        if (!Number.isNaN(parsed) && parsed !== 0) {
          this.flashButton(node.id);
          this.dispatchBang(node.id, 0);
        }
        break;
      }

      case "message":
        this.deliverStoredMessageValue(node, inlet, value);
        break;

      case "metro": {
        // Handle attribute-style "interval <ms>" on inlet 0
        const metroTokens = value.trim().split(/\s+/);
        if (inlet === 0 && metroTokens[0] === "interval") {
          const ms = parseFloat(metroTokens[1] ?? "500");
          if (!isNaN(ms)) {
            node.args[0] = String(Math.max(1, ms));
            this.graph.emit("change");
            if (this.isMetroRunning(node.id)) this.startMetro(node);
          }
        } else {
          this.deliverMetroValue(node, inlet, value);
        }
        break;
      }

      case "codebox":
        this.codeboxController?.executeValue(node, inlet, value);
        break;

      case "visualizer":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          // Plain float: nonzero = open, zero = close (jit.world style)
          if (tokens.length === 1 && !isNaN(parseFloat(selector))) {
            this.visualizerGraph?.deliverMessage(node.id, "open", [parseFloat(selector) !== 0 ? "1" : "0"]);
          } else {
            this.visualizerGraph?.deliverMessage(node.id, selector, args);
          }
        }
        break;

      case "mediaVideo":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          if (selector === "transport") {
            // Attribute panel sends "transport play|pause|stop" — route to the matching command
            const cmd = args[0] ?? "";
            if (cmd === "play" || cmd === "stop" || cmd === "pause") {
              this.visualizerGraph?.deliverMediaMessage(node.id, "mediaVideo", cmd, []);
            }
          } else {
            this.visualizerGraph?.deliverMediaMessage(node.id, "mediaVideo", selector, args);
          }
        }
        break;

      case "integer": {
        if (inlet === 0) {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            const intVal = Math.trunc(parsed);
            node.args[0] = String(intVal);
            this.syncNumboxDisplay(node);
            this.graph.emit("change");
            this.dispatchValue(node.id, 0, String(intVal));
          }
        }
        break;
      }

      case "float": {
        if (inlet === 0) {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            node.args[0] = String(parsed);
            this.syncNumboxDisplay(node);
            this.graph.emit("change");
            this.dispatchValue(node.id, 0, String(parsed));
          }
        }
        break;
      }

      case "scale": {
        const f = (i: number, def: number) => { const n = parseFloat(node.args[i] ?? ""); return isNaN(n) ? def : n; };
        if (inlet === 0) {
          const input = parseFloat(value);
          if (!isNaN(input)) {
            const inLow  = f(0, 0);
            const inHigh = f(1, 1);
            const outLow  = f(2, 0);
            const outHigh = f(3, 127);
            const t = inHigh === inLow ? 0 : (input - inLow) / (inHigh - inLow);
            const result = outLow + t * (outHigh - outLow);
            this.dispatchValue(node.id, 0, String(result));
          }
        } else if (inlet >= 1 && inlet <= 4) {
          const v = parseFloat(value);
          if (!isNaN(v)) { node.args[inlet - 1] = String(v); this.graph.emit("change"); }
        }
        break;
      }

      case "+": case "-": case "*": case "/": case "%":
      case "==": case "!=": case ">": case "<": case ">=": case "<=": {
        if (inlet === 0) {
          const left = parseFloat(value);
          if (!isNaN(left)) {
            this.mathLeftOps.set(node.id, left);
            const right = parseFloat(node.args[0] ?? "0");
            const result = this.applyMathOp(node.type, left, right);
            this.dispatchValue(node.id, 0, String(result));
          }
        } else if (inlet === 1) {
          const right = parseFloat(value);
          if (!isNaN(right)) {
            node.args[0] = String(right);
            this.updateMathOpTitle(node.id, node.type, right);
          }
        }
        break;
      }

      case "s":
        if (inlet === 0) this.broadcastToReceivers(node.args[0] ?? "", n => this.dispatchValue(n.id, 0, value));
        break;

      case "attribute":
        if (inlet >= 0 && node.inlets.some(p => p.index === inlet && p.side === "left")) {
          this.setAttrSideInlet(node, inlet, value);
        }
        break;

      case "mediaImage":
        break;

      case "patchViz":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          // Plain float: nonzero = enable, zero = disable
          if (tokens.length === 1 && !isNaN(parseFloat(selector))) {
            this.visualizerGraph?.deliverPatchVizMessage(node.id, parseFloat(selector) !== 0 ? "enable" : "disable", []);
          } else {
            this.visualizerGraph?.deliverPatchVizMessage(node.id, selector, args);
          }
        }
        break;

      case "imageFX":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.visualizerGraph?.deliverImageFXMessage(node.id, selector, args);
          if (!this.attrDragging) this.graph.emit("change");
          else this.graph.emit("display");
        }
        break;

      case "vfxCRT":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.visualizerGraph?.deliverVfxMessage(node.id, "vfxCRT", selector, args);
          if (!this.attrDragging) this.graph.emit("change");
          else this.graph.emit("display");
        }
        break;

      case "vfxBlur":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.visualizerGraph?.deliverVfxMessage(node.id, "vfxBlur", selector, args);
          if (!this.attrDragging) this.graph.emit("change");
          else this.graph.emit("display");
        }
        break;

      case "layer":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          if (selector === "priority") {
            const p = parseInt(args[0] ?? "0", 10);
            if (!isNaN(p)) {
              node.args[1] = String(Math.max(0, p));
              if (!this.attrDragging) this.graph.emit("change");
              else this.graph.emit("display");
            }
          } else if (selector === "context" && args[0]) {
            node.args[0] = args[0];
            if (!this.attrDragging) this.graph.emit("change");
            else this.graph.emit("display");
          } else {
            this.visualizerGraph?.deliverLayerMessage(node.id, selector, args);
          }
        }
        break;

      default:
        break;
    }

    // Generic attribute-style arg setter: handles "argName value" for any object
    // type, now and in the future. Updates node.args and emits change so runtime
    // watchers (VisualizerGraph.sync, etc.) pick up the new value automatically.
    this.trySetArgByName(node, value);
  }

  // ── External DOM sync ───────────────────────────────────────────────

  /**
   * Updates a single attribute panel slider/readout without dispatching
   * or re-rendering. Called by VisualizerGraph to push live window state
   * (position, size) back into the connected attribute panel.
   */
  updateAttrSlider(nodeId: string, argIdx: number, value: string): void {
    const nodeEl = this.panGroup.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
    if (!nodeEl) return;

    const slider = nodeEl.querySelector<HTMLInputElement>(`.pn-attrui__slider[data-arg-index="${argIdx}"]`);
    if (slider) {
      slider.value = value;
      const readout = slider.closest<HTMLElement>(".pn-attrui__row")
        ?.querySelector<HTMLElement>(".pn-attrui__readout");
      if (readout) {
        const node = this.graph.nodes.get(nodeId);
        const targetType = node?.args[0] ?? "";
        const def = OBJECT_DEFS[targetType];
        const visible = def ? getVisibleArgs(def) : [];
        const arg = visible[argIdx];
        readout.textContent = arg?.type === "int"
          ? String(Math.round(parseFloat(value)))
          : parseFloat(value).toFixed(3);
      }
    }

    const textInput = nodeEl.querySelector<HTMLInputElement>(`.pn-attrui__text[data-arg-index="${argIdx}"]`);
    if (textInput) textInput.value = value;
  }

  // ── Send / Receive ──────────────────────────────────────────────────

  private broadcastToReceivers(channel: string, dispatchFn: (r: PatchNode) => void): void {
    if (!channel) return;
    for (const node of this.graph.getNodes()) {
      if (node.type === "r" && node.args[0] === channel) dispatchFn(node);
    }
  }

  // ── Attribute panel helpers ─────────────────────────────────────────

  /**
   * Receive a value on a side inlet (index = arg index, 0-based).
   * Updates the arg, syncs the slider DOM, dispatches to the target, and
   * updates the text panel — without triggering a full canvas re-render.
   */
  private setAttrSideInlet(node: PatchNode, argIndex: number, rawValue: string): void {
    const targetType = node.args[0] ?? "";
    const def = OBJECT_DEFS[targetType];
    if (!def) return;

    const visible = getVisibleArgs(def);
    const arg = visible[argIndex];
    if (!arg) return;

    // Clamp numeric values to arg range
    let val = rawValue;
    if (arg.type === "float" || arg.type === "int") {
      const num = parseFloat(rawValue);
      if (!isNaN(num)) {
        const min = arg.min ?? 0;
        const max = arg.max ?? (arg.type === "int" ? 100 : 1);
        const clamped = Math.max(min, Math.min(max, num));
        val = arg.type === "int" ? String(Math.round(clamped)) : clamped.toFixed(3);
      }
    }

    node.args[argIndex + 1] = val;

    // Update slider/readout in DOM without a full re-render
    const nodeEl = this.panGroup.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
    if (nodeEl) {
      const slider = nodeEl.querySelector<HTMLInputElement>(`.pn-attrui__slider[data-arg-index="${argIndex}"]`);
      if (slider) {
        slider.value = val;
        const readout = slider.closest<HTMLElement>(".pn-attrui__row")
          ?.querySelector<HTMLElement>(".pn-attrui__readout");
        if (readout) {
          readout.textContent = arg.type === "int"
            ? String(Math.round(parseFloat(val)))
            : parseFloat(val).toFixed(3);
        }
      }
    }

    // Dispatch to the connected target object
    const msg = buildArgMessage(targetType, argIndex, val);
    this.attrDragging = true;
    this.dispatchValue(node.id, 0, msg);
    this.attrDragging = false;

    this.graph.emit("display");
  }

  /**
   * Re-dispatches all current slider values through outlet 0.
   * Useful when something downstream needs a full state refresh.
   */
  private dispatchAttributeAll(node: PatchNode): void {
    const targetType = node.args[0] ?? "";
    const def = OBJECT_DEFS[targetType];
    if (!def) return;

    const visible = def.args.filter(a => !a.hidden);
    visible.forEach((_, i) => {
      const val = node.args[i + 1] ?? "0";
      const msg = buildArgMessage(targetType, i, val);
      this.dispatchValue(node.id, 0, msg);
    });
  }

  /**
   * Detects attribute node outlet-0 connections on every graph change.
   * Writes discovered target type into node.args[0] and seeds per-arg defaults.
   * Runs before render so the updated state is visible immediately.
   */
  private syncAttributeNodes(): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "attribute") continue;

      // Find the type of whatever outlet 0 is connected to (first edge wins)
      let targetType: string | null = null;
      for (const edge of this.graph.getEdges()) {
        if (edge.fromNodeId === node.id && edge.fromOutlet === 0) {
          targetType = this.graph.nodes.get(edge.toNodeId)?.type ?? null;
          break;
        }
      }

      if (!targetType) {
        // Outlet disconnected — clear panel if it was previously configured
        if ((node.args[0] ?? "") !== "") {
          resetAttributeNode(node);
          // No emit — render fires after all change handlers complete
        }
        continue;
      }

      // Skip rebuild only if type matches AND inlets are already populated
      if (node.args[0] === targetType && node.inlets.length > 0) continue;

      syncAttributeNode(node, targetType);
      // render picks up the new args on this same change cycle
    }
  }

  /**
   * Generic fallback: if `value` looks like "argName someValue" and argName
   * matches a known arg on this object type, update node.args[argIdx] and emit.
   * This ensures every object type works with the attribute panel automatically,
   * including types added in the future.
   */
  private trySetArgByName(node: PatchNode, value: string): void {
    const tokens = value.trim().split(/\s+/);
    if (tokens.length < 2) return;

    const selector = tokens[0];
    const argVal   = tokens.slice(1).join(" ");

    const def = OBJECT_DEFS[node.type];
    if (!def) return;

    const argIdx = def.args.findIndex(a => a.name === selector);
    if (argIdx < 0) return;

    // Only emit if value actually changed (avoids re-render loops)
    if (node.args[argIdx] === argVal) return;

    node.args[argIdx] = argVal;
    // During attribute drag/text-entry, emit "display" only so the text panel
    // stays in sync without triggering render(). render() destroys all DOM
    // including the currently-focused input, which loses focus and lets
    // subsequent keystrokes fall through to canvas shortcuts (Delete, letters).
    // handleAttrChange emits "change" on commit, so a full render always follows.
    this.graph.emit(this.attrDragging ? "display" : "change");
  }

  // ── Attribute slider delegation ─────────────────────────────────────

  private handleAttrInput(e: Event): void {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("pn-attrui__slider") &&
        !target.classList.contains("pn-attrui__text")) return;

    const objectEl = target.closest<HTMLElement>(".patch-object");
    if (!objectEl) return;
    const node = this.getNode(objectEl);
    if (!node || node.type !== "attribute") return;

    const input      = target as HTMLInputElement;
    const argIndex   = parseInt(input.dataset.argIndex ?? "0", 10);
    const val        = input.value;
    const targetType = node.args[0] ?? "";

    // Cache value so the next re-render restores the slider to the right position
    node.args[argIndex + 1] = val;

    // Update readout live — no graph emit so the DOM isn't destroyed mid-drag
    const readout = input.closest<HTMLElement>(".pn-attrui__row")
      ?.querySelector<HTMLElement>(".pn-attrui__readout");
    if (readout) {
      const def     = OBJECT_DEFS[targetType];
      const visible = def?.args.filter(a => !a.hidden) ?? [];
      const arg     = visible[argIndex];
      readout.textContent = (arg?.type === "int")
        ? String(Math.round(parseFloat(val)))
        : parseFloat(val).toFixed(3);
    }

    // Dispatch live — guard flag prevents any graph.emit("change") from
    // cascading through deliverMessageValue and destroying the slider mid-drag
    this.attrDragging = true;
    const msg = buildArgMessage(targetType, argIndex, val);
    this.dispatchValue(node.id, 0, msg);
    this.attrDragging = false;

    // Update the text panel without a full re-render
    this.graph.emit("display");
  }

  private handleAttrChange(e: Event): void {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("pn-attrui__slider") &&
        !target.classList.contains("pn-attrui__text")) return;

    const objectEl = target.closest<HTMLElement>(".patch-object");
    if (!objectEl) return;
    const node = this.getNode(objectEl);
    if (!node || node.type !== "attribute") return;

    // Drag is finished — dispatch the final value to the connected target
    // and emit change to persist + re-render with the committed value
    const input      = target as HTMLInputElement;
    const argIndex   = parseInt(input.dataset.argIndex ?? "0", 10);
    const val        = input.value;
    const targetType = node.args[0] ?? "";

    node.args[argIndex + 1] = val;

    const msg = buildArgMessage(targetType, argIndex, val);
    this.dispatchValue(node.id, 0, msg);

    this.graph.emit("change");
  }

  private toggleNode(node: PatchNode): void {
    const isOn = node.args[0] !== "1";
    node.args[0] = isOn ? "1" : "0";
    this.graph.emit("change");
    this.dispatchValue(node.id, 0, isOn ? "1.0" : "0.0");
  }

  private setToggleFromValue(node: PatchNode, value: string): void {
    const parsed = Number.parseFloat(value);
    const isOn = Number.isNaN(parsed) ? value !== "0" : parsed !== 0;
    node.args[0] = isOn ? "1" : "0";
    this.graph.emit("change");
    this.dispatchValue(node.id, 0, isOn ? "1.0" : "0.0");
  }

  private flashButton(nodeId: string): void {
    const el = this.panGroup.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
    if (!el) return;
    el.classList.add("patch-object--active");
    setTimeout(() => el.classList.remove("patch-object--active"), 150);
  }

  private updateSliderFromEvent(e: MouseEvent): void {
    if (!this.sliderDrag) return;
    const { node, trackEl, thumbEl } = this.sliderDrag;

    const rect = trackEl.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const { min, max, range } = this.getSliderRange(node);
    const clamped = Math.round(Math.max(min, Math.min(max, min + t * range)));

    node.args[0] = String(clamped);
    thumbEl.style.left = `${((clamped - min) / range) * 100}%`;
  }

  private handleSliderMove(e: MouseEvent): void {
    if (this.sliderDrag) {
      this.updateSliderFromEvent(e);
    } else if (this.numboxDrag) {
      this.updateNumboxFromEvent(e);
    }
  }

  private handleSliderUp(e: MouseEvent): void {
    if (e.button !== 0) return;

    if (this.sliderDrag) {
      const { node } = this.sliderDrag;
      this.updateSliderFromEvent(e);
      this.graph.emit("change");
      this.dispatchValue(node.id, 0, this.getSliderValue(node));
      this.sliderDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
      document.removeEventListener("mousemove", this.onDocMouseMove);
      document.removeEventListener("mouseup", this.onDocMouseUp);
    } else if (this.numboxDrag) {
      const { node } = this.numboxDrag;
      this.updateNumboxFromEvent(e);
      this.graph.emit("change");
      this.dispatchValue(node.id, 0, node.args[0] ?? "0");
      this.numboxDrag = null;
      document.body.classList.remove("pn-state-numbox-drag");
      document.removeEventListener("mousemove", this.onDocMouseMove);
      document.removeEventListener("mouseup", this.onDocMouseUp);
    }
  }

  private updateNumboxFromEvent(e: MouseEvent): void {
    if (!this.numboxDrag) return;
    const { node, el, startY, startValue, increment, isFloat, activePlace } = this.numboxDrag;

    const deltaY = startY - e.clientY; // up = positive = increase
    const raw = startValue + deltaY * increment;
    const value = isFloat ? raw : Math.round(raw);

    node.args[0] = String(value);
    buildNumboxContent(el, value, isFloat, activePlace);
    // Live output during drag
    this.dispatchValue(node.id, 0, String(value));
  }

  private handleMessageClick(node: PatchNode): void {
    this.dispatchStoredMessage(node);
    this.flashButton(node.id);
  }

  private handleDblClick(e: MouseEvent): void {
    if (e.button !== 0) return;

    const objectEl = this.getObjectEl(e.target);
    if (!objectEl) return;
    const node = this.getNode(objectEl);
    if (!node) return;

    if (node.type === "imageFX") {
      e.preventDefault();
      e.stopPropagation();
      const fxNode = this.visualizerGraph?.getImageFXNode(node.id);
      if (!fxNode) return;
      new ImageFXPanel(fxNode, node, this.graph).open();
      return;
    }

    if (node.type !== "message") {
      // Any object whose body renders a .patch-object-title can have its args
      // edited inline on double-click (Max-style).
      const titleEl = objectEl.querySelector<HTMLElement>(".patch-object-title");
      const def = OBJECT_DEFS[node.type];
      if (titleEl && def) {
        e.preventDefault();
        e.stopPropagation();
        this.beginArgEdit(objectEl, node, titleEl);
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    this.beginMessageEdit(objectEl, node);
  }

  startMessageEdit(nodeId: string): void {
    const objectEl = this.panGroup.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
    if (!objectEl) return;
    const node = this.getNode(objectEl);
    if (!node || node.type !== "message") return;
    this.beginMessageEdit(objectEl, node);
  }

  private beginArgEdit(objectEl: HTMLElement, node: PatchNode, titleEl: HTMLElement): void {
    const originalText = titleEl.textContent ?? node.type;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "patch-object-title-input";
    // Pre-fill: "type arg1 arg2 ..."
    input.value = node.args.length ? `${node.type} ${node.args.join(" ")}` : node.type;
    titleEl.textContent = "";
    titleEl.appendChild(input);
    objectEl.classList.add("patch-object--editing");
    input.focus();
    input.select();

    let settled = false;

    const commit = () => {
      if (settled) return;
      settled = true;
      objectEl.classList.remove("patch-object--editing");

      const tokens = input.value.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) { this.graph.emit("change"); return; }

      const newType = tokens[0];
      const newArgs = tokens.slice(1);

      if (newType !== node.type && OBJECT_DEFS[newType]) {
        // Type changed to a valid type — swap ports from the new def
        const newDef = getObjectDef(newType);
        node.type = newType;
        node.args = newArgs;
        node.inlets  = newDef.inlets.map(p => ({ ...p }));
        node.outlets = newDef.outlets.map(p => ({ ...p }));
        // Remove edges that now reference out-of-range ports
        for (const edge of this.graph.getEdges()) {
          const isFromThis = edge.fromNodeId === node.id;
          const isToThis   = edge.toNodeId   === node.id;
          if (isFromThis && edge.fromOutlet >= node.outlets.length) this.graph.removeEdge(edge.id);
          if (isToThis   && edge.toInlet    >= node.inlets.length)  this.graph.removeEdge(edge.id);
        }
      } else {
        // Same type (or invalid new type) — just update args
        node.args = newArgs;
      }

      this.graph.emit("change");
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      objectEl.classList.remove("patch-object--editing");
      titleEl.textContent = originalText;
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
      ev.stopPropagation();
    });
    input.addEventListener("blur", commit);
  }

  private beginMessageEdit(objectEl: HTMLElement, node: PatchNode): void {
    const contentEl = objectEl.querySelector<HTMLElement>(".patch-object-message-content");
    if (!contentEl) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "patch-object-message-input";
    input.value = this.getStoredMessage(node);
    contentEl.textContent = "";
    contentEl.appendChild(input);
    input.focus();
    input.select();

    let settled = false;

    const commit = () => {
      if (settled) return;
      settled = true;
      node.args = input.value ? [input.value] : [];
      this.graph.emit("change");
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      this.graph.emit("change");
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        cancel();
      }
      ev.stopPropagation();
    });
    input.addEventListener("blur", commit);
  }

  private deliverStoredMessageValue(node: PatchNode, inlet: number, value: string): void {
    const selector = this.parseSelectorMessage(value);
    if (selector) {
      switch (selector.selector) {
        case "set":
          this.setStoredMessage(node, selector.payload);
          return;
        case "append":
          this.setStoredMessage(node, this.joinSegments(this.getStoredMessage(node), selector.payload));
          return;
        case "prepend":
          this.setStoredMessage(node, this.joinSegments(selector.payload, this.getStoredMessage(node)));
          return;
        default:
          break;
      }
    }

    if (inlet !== 0) {
      // Right-hand inlets: store incoming value and update display
      this.setStoredMessage(node, value);
      return;
    }

    const template = this.getStoredMessage(node);
    const isBang = value.trim() === "";
    const values = isBang ? [] : value.trim().split(/\s+/);

    // Only treat the stored string as a template when it has $1/$2/… vars.
    // A box with a plain literal (no $ vars) acts as pass-through on inlet 0;
    // a bang into a literal box sends the literal; an empty box passes through.
    const hasDollarVars = /\$\d/.test(template);
    const effectiveTemplate = hasDollarVars
      ? template                          // substitute into template
      : (isBang ? template : value.trim()); // bang → send stored literal; value → pass through

    const resolved = applyDollarArgs(effectiveTemplate, values);

    // Update args + DOM whenever the displayed value changes
    if (resolved !== (node.args[0] ?? "")) {
      node.args = resolved ? [resolved] : [];
      this.updateMessageDom(node.id, resolved);
    }

    this.dispatchMessageContent(node, resolved);
    this.flashButton(node.id);
  }

  /** Update the message box DOM without emitting a change event. */
  private updateMessageDom(nodeId: string, content: string): void {
    const el = this.panGroup.querySelector<HTMLElement>(
      `[data-node-id="${nodeId}"] .patch-object-message-content`,
    );
    if (el) el.textContent = content;
  }

  private dispatchStoredMessage(node: PatchNode): void {
    const content = this.getStoredMessage(node);
    this.dispatchMessageContent(node, content);
  }

  private dispatchMessageContent(node: PatchNode, content: string): void {
    const trimmed = content.trim();
    if (trimmed.startsWith(";")) {
      console.warn(`Semicolon message routing is not implemented in patchNet v1: "${content}"`);
      return;
    }

    const segments = splitOnComma(trimmed);
    if (segments.length > 1) {
      for (const segment of segments) {
        this.dispatchMessageSegment(node, segment);
      }
      return;
    }

    this.dispatchMessageSegment(node, trimmed);
  }

  private dispatchMessageSegment(node: PatchNode, content: string): void {
    if (content === "" || content === "bang") {
      this.dispatchBang(node.id, 0);
      return;
    }

    this.dispatchValue(node.id, 0, content);
  }

  private parseSelectorMessage(value: string): { selector: "set" | "append" | "prepend"; payload: string } | null {
    if (value.startsWith("set ")) {
      return { selector: "set", payload: value.slice(4) };
    }
    if (value === "set") {
      return { selector: "set", payload: "" };
    }
    if (value.startsWith("append ")) {
      return { selector: "append", payload: value.slice(7) };
    }
    if (value === "append") {
      return { selector: "append", payload: "" };
    }
    if (value.startsWith("prepend ")) {
      return { selector: "prepend", payload: value.slice(8) };
    }
    if (value === "prepend") {
      return { selector: "prepend", payload: "" };
    }
    return null;
  }

  private applyMathOp(op: string, left: number, right: number): number {
    switch (op) {
      case "+":  return left + right;
      case "-":  return left - right;
      case "*":  return left * right;
      case "/":  return right === 0 ? 0 : left / right;
      case "%":  return right === 0 ? 0 : left % right;
      case "==": return left === right ? 1 : 0;
      case "!=": return left !== right ? 1 : 0;
      case ">":  return left >  right  ? 1 : 0;
      case "<":  return left <  right  ? 1 : 0;
      case ">=": return left >= right  ? 1 : 0;
      case "<=": return left <= right  ? 1 : 0;
      default:   return 0;
    }
  }

  private updateMathOpTitle(nodeId: string, op: string, rightOp: number): void {
    const el = this.panGroup.querySelector<HTMLElement>(
      `[data-node-id="${nodeId}"] .patch-object-title`,
    );
    if (el) el.textContent = `${op} ${rightOp}`;
  }

  private getStoredMessage(node: PatchNode): string {
    return node.args[0] ?? "";
  }

  private setStoredMessage(node: PatchNode, content: string): void {
    node.args = content ? [content] : [];
    this.updateMessageDom(node.id, content);
    this.graph.emit("change");
  }

  private joinSegments(left: string, right: string): string {
    if (!left) return right;
    if (!right) return left;
    return `${left} ${right}`;
  }

  private getSliderValue(node: PatchNode): string {
    const val = Number.parseFloat(node.args[0] ?? "0");
    const min = Number.parseFloat(node.args[1] ?? "0");
    const max = Number.parseFloat(node.args[2] ?? "127");
    const clamped = Math.round(isNaN(val) ? min : Math.max(min, Math.min(max, val)));
    return String(clamped);
  }

  private getSliderRange(node: PatchNode): { min: number; max: number; range: number } {
    const min = Number.parseFloat(node.args[1] ?? "0");
    const max = Number.parseFloat(node.args[2] ?? "127");
    return { min: isNaN(min) ? 0 : min, max: isNaN(max) ? 127 : max, range: (isNaN(max) ? 127 : max) - (isNaN(min) ? 0 : min) || 1 };
  }

  private syncNumboxDisplay(node: PatchNode): void {
    const el = this.panGroup.querySelector<HTMLElement>(
      `[data-node-id="${node.id}"] .pn-numbox`,
    );
    if (el) {
      buildNumboxContent(el, parseFloat(node.args[0] ?? "0"), node.type === "float", null);
    }
  }

  private syncSliderThumb(nodeId: string, value: number, node: PatchNode): void {
    const thumbEl = this.panGroup.querySelector<HTMLElement>(
      `[data-node-id="${nodeId}"] .patch-object-slider-thumb`,
    );
    if (thumbEl) {
      const { min, range } = this.getSliderRange(node);
      thumbEl.style.left = `${Math.max(0, Math.min(100, ((value - min) / range) * 100))}%`;
    }
  }

  private deliverMetroValue(node: PatchNode, inlet: number, value: string): void {
    if (inlet === 0) {
      const parsed = Number.parseFloat(value);
      if (!Number.isNaN(parsed) && parsed === 0) {
        this.stopMetro(node.id);
      } else {
        this.startMetro(node);
      }
      return;
    }

    if (inlet === 1) {
      const parsed = Number.parseFloat(value);
      if (Number.isNaN(parsed)) return;
      node.args[0] = `${Math.max(1, parsed)}`;
      this.graph.emit("change");
      if (this.isMetroRunning(node.id)) {
        this.startMetro(node);
      }
    }
  }

  private startMetro(node: PatchNode): void {
    this.stopMetro(node.id, false);
    const ms = Math.max(1, Number.parseFloat(node.args[0] ?? "500"));
    const handle = setInterval(() => this.dispatchBang(node.id, 0), ms);
    this.metroTimers.set(node.id, handle);
    node.args[1] = "1";
    this.graph.emit("change");
  }

  private stopMetro(nodeId: string, persist = true): void {
    const handle = this.metroTimers.get(nodeId);
    if (handle !== undefined) {
      clearInterval(handle);
      this.metroTimers.delete(nodeId);
    }
    if (persist) {
      const node = this.graph.nodes.get(nodeId);
      if (node) {
        node.args[1] = "0";
        this.graph.emit("change");
      }
    }
  }

  private isMetroRunning(nodeId: string): boolean {
    return this.metroTimers.has(nodeId);
  }

  private pruneMetroTimers(): void {
    for (const nodeId of this.metroTimers.keys()) {
      if (!this.graph.nodes.has(nodeId)) {
        this.stopMetro(nodeId, false);
      }
    }
  }

  private restoreMetroTimers(): void {
    for (const node of this.graph.getNodes()) {
      if (node.type === "metro" && node.args[1] === "1" && !this.isMetroRunning(node.id)) {
        const ms = Math.max(1, Number.parseFloat(node.args[0] ?? "500"));
        const handle = setInterval(() => this.dispatchBang(node.id, 0), ms);
        this.metroTimers.set(node.id, handle);
      }
    }
  }
}
