import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode, PortType } from "../graph/PatchNode";
import type { AudioGraph } from "../runtime/AudioGraph";
import type { CodeboxController } from "./CodeboxController";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import type { DmxGraph } from "../runtime/DmxGraph";
import type { SubPatchManager } from "./SubPatchManager";
import type { JsEffectPanelController } from "./JsEffectPanelController";
import type { ReaperVideoPanelController } from "./ReaperVideoPanelController";
import { broadcastSendReceive } from "./patchSessionRegistry";
import {
  OBJECT_DEFS,
  getObjectDef,
  syncAttributeNode,
  resetAttributeNode,
  buildArgMessage,
  getVisibleArgs,
  deriveTriggerPorts,
  derivePackPorts,
  deriveUnpackPorts,
  packSlotInit,
  deriveFftPorts,
  deriveMixerPorts,
  mixerDefaultWidth,
  canonicalizeType,
  ensureSequencerArgs,
  getSequencerCells,
  setSequencerCells,
  sequencerCols,
  sequencerRows,
  bufferControlInlet,
  deriveBufferPorts,
  JS_EFFECT_SIDE_INLET_START,
  getReaperVideoSideInletStart,
  extractJsEffectSliders,
  extractReaperVideoParams,
} from "../graph/objectDefs";
import { ImageFXPanel } from "./ImageFXPanel";
import { AudioConfigPanel } from "./AudioConfigPanel";
import {
  buildOdometerContent,
  formatThumbValue,
  formatFreq,
  formatMorph,
  formatLevel,
  waveKnobValueFromFraction,
  refreshAdsrEditorDom,
  adsrGeometry,
  ADSR_TOP,
  ADSR_BOTTOM,
  formatRate,
  formatDepth,
  formatShape,
  lfoKnobValueFromFraction,
  refreshTransientFollowerReadouts,
} from "./ObjectRenderer";
import { startDragSession, type DragSession } from "./dragSession";

/** Parse "90", "1m30s", "2m", "45s" → seconds. Plain numbers are interpreted
 *  as seconds. Returns null if the input doesn't parse. */
function parseSecondsLoose(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  const m = s.match(/^(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const minutes = m[1] ? parseInt(m[1], 10) : 0;
  const seconds = m[2] ? parseFloat(m[2])    : 0;
  return minutes * 60 + seconds;
}

function applyDollarArgs(template: string, values: string[]): string {
  return template.replace(/\$(\d)/g, (_, n: string) => values[Number.parseInt(n, 10) - 1] ?? `$${n}`);
}

function splitOnComma(content: string): string[] {
  return content.split(",").map((segment) => segment.trim()).filter(Boolean);
}

function normalizeNoiseColor(raw: string | undefined): "white" | "pink" | "brown" {
  const color = (raw ?? "white").trim().toLowerCase();
  return color === "pink" || color === "brown" ? color : "white";
}

/** Coerce a string-on-the-wire value into the typed payload shape that
 *  netsend forwards. A bare token may be a number, symbol, or empty (treated
 *  as bang); whitespace-separated tokens become a list. */
function parseNetPayload(raw: string): import("../runtime/peer/topicRouter").TopicPayload {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return coerceToken(tokens[0]);
  return tokens.map(coerceToken);
}
function coerceToken(tok: string): import("../runtime/peer/topicRouter").TopicPayload {
  if (tok === "") return null;
  const n = Number(tok);
  return Number.isNaN(n) ? tok : n;
}

/** UTF-8 safe base64 JSON encode for dmx profile/patch persistence. */
function encodeDmxBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json || json === "[]") return "";
  return btoa(unescape(encodeURIComponent(json)));
}

/** Lexical "int form" — a string like "0", "-7", "127" with no dot or exponent.
 *  Used by `scale` and `ezScale` to decide whether output should be rounded. */
function isIntForm(s: string): boolean {
  return /^-?\d+$/.test(s.trim());
}

/** Body height for a collapsed ezScale — toolbar + multiplier row + slider with their gaps. */
const EZSCALE_COLLAPSED_HEIGHT = 96;

/** Format a scaled number as a string. In int mode, round to nearest int and
 *  drop the decimal entirely so the wire value is "7" not "7.0". */
function formatScaled(n: number, intMode: boolean): string {
  return intMode ? String(Math.round(n)) : String(n);
}

/** Re-canonicalize a stored bound-value to match the current int/float mode.
 *  If we just flipped from float→int (user removed the dot), drop fractional
 *  part. If we flipped int→float, add a `.0` so the form is consistent. */
function canonicalizeBound(s: string, intMode: boolean): string {
  const n = parseFloat(s);
  if (!isFinite(n)) return s;
  if (intMode) return String(Math.round(n));
  return isIntForm(s) ? `${n}.0` : s;
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
    moved: boolean;
  } | null = null;

  private bufWaveDrag: {
    node: PatchNode;
    canvas: HTMLCanvasElement;
    startNorm: number;
    endNorm: number;
    shift: boolean;
  } | null = null;

  private vbufStripDrag: {
    node: PatchNode;
    canvas: HTMLCanvasElement;
    startNorm: number;
    endNorm: number;
    shift: boolean;
  } | null = null;

  /** Live drag-selection overlays for vbuf* — keyed by node id so they
   *  survive the DOM rebuilds that happen on emit("change"). drawVbufStrip
   *  reads this on every rAF tick. */
  private readonly vbufLiveSelection = new Map<string, [number, number]>();

  private ezScaleDrag: {
    node: PatchNode;
    trackEl: HTMLElement;
    which: "lo" | "hi" | "range";
    startX?: number;
    startLo?: number;
    startHi?: number;
  } | null = null;

  private ezSliderDrag: {
    node: PatchNode;
    trackEl: HTMLElement;
  } | null = null;

  private waveKnobDrag: {
    node: PatchNode;
    knob: "freq" | "morph" | "level";
    knobEl: HTMLElement;
    startY: number;
    startFrac: number;
  } | null = null;

  private lfoKnobDrag: {
    node: PatchNode;
    knob: "rate" | "depth" | "shape";
    knobEl: HTMLElement;
    startY: number;
    startFrac: number;
  } | null = null;

  private adsrHandleDrag: {
    node: PatchNode;
    handle: "attack" | "decay" | "sustainEnd" | "release";
    svgEl: SVGSVGElement;
    startMouseX: number;
    startMouseY: number;
    startA: number;            // ms
    startD: number;            // ms
    startSustain: number;      // 0..1
    startR: number;            // ms
    startSustainTime: number;  // ms
    /** SVG-pixel/CSS-pixel ratio at drag-start. Multiply mouse delta by this
     *  to convert into SVG units, then divide by `pxPerMs` for ms delta. */
    svgPxPerCssPx: number;
    /** SVG horizontal scale at drag-start. ms-equivalent of one SVG pixel. */
    msPerSvgPx: number;
  } | null = null;

  /** Single live drag session for any of the slider/numbox/buf/vbuf drags
   *  below — only one can be active at a time (they all branch off
   *  `handleMouseDown`). Replaces the older onDocMouseMove/Up document-
   *  listener pair. The session installs its own `window.blur` and
   *  `Escape`-key recovery so a missed mouseup can't strand the drag. */
  private currentDragSession: DragSession | null = null;
  /** Per-dispatch-root visited set for feedback-cycle detection in
   *  dispatchValue/dispatchBang. Non-null only while a dispatch chain is
   *  in progress; see `guardedFanout`. */
  private dispatchVisited: Set<string> | null = null;
  /** Single warn per dispatch chain so repeating cycles don't spam the
   *  console. Reset on dispatch-root unwind. */
  private dispatchCycleWarned = false;
  private readonly onAttrInput: (e: Event) => void;
  private readonly onAttrChange: (e: Event) => void;
  private readonly onCellFocusOut: (e: FocusEvent) => void;
  private readonly onCellKeyDown: (e: KeyboardEvent) => void;
  private readonly timerStamps = new Map<string, number>();
  private readonly metroTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly oscTimers = new Map<string, { rafId: number; startT: number }>();
  private readonly mathLeftOps = new Map<string, number>();
  private readonly drunkPositions = new Map<string, number>();
  /** Per-node current slot values for `pack`. Initialized from args lazily. */
  private readonly packSlots = new Map<string, string[]>();
  /** Per-node current stored slot values for `unpack`. Initialized lazily. */
  private readonly unpackSlots = new Map<string, string[]>();
  private codeboxController?: CodeboxController;
  private jsEffectPanelController?: JsEffectPanelController;
  private reaperVideoPanelController?: ReaperVideoPanelController;
  private visualizerGraph?: VisualizerGraph;
  private dmxGraph?: DmxGraph;
  private peerRegistry?: import("../runtime/peer/PeerRegistry").PeerRegistry;
  private outletCallback?: (outletIndex: number, value: string | null) => void;
  private subPatchManager?: SubPatchManager;
  /** Repaint a single buffer~ waveform without going through the audio rAF
   *  tick (so drag overlays update with DSP off). main.ts injects this. */
  private bufferRedraw?: (nodeId: string) => void;
  /** Presentation panel elements (in the main canvas) that this OIC also handles. */
  private readonly externalPanels: HTMLElement[] = [];
  /** Node ids currently mid-flash — re-applied after render() rebuilds the DOM. */
  private readonly activeFlashes = new Set<string>();

  constructor(
    private readonly panGroup: HTMLElement,
    private readonly graph: PatchGraph,
    private audioGraph?: AudioGraph,
  ) {
    this.onPanGroupClick = this.handleClick.bind(this);
    this.onPanGroupMouseDown = this.handleMouseDown.bind(this);
    this.onPanGroupDblClick = this.handleDblClick.bind(this);
    this.onAttrInput  = this.handleAttrInput.bind(this);
    this.onAttrChange = this.handleAttrChange.bind(this);
    this.onCellFocusOut = this.handleCellFocusOut.bind(this);
    this.onCellKeyDown  = this.handleCellKeyDown.bind(this);
    this.onGraphChangeUnsubscribe = this.graph.on("change", () => {
      this.pruneMetroTimers();
      this.restoreMetroTimers();
      this.pruneOscTimers();
      this.restoreOscTimers();
      this.syncAttributeNodes();
      this.syncEzScaleAutoInput();
      this.syncEzScaleAutoOutput();
      for (const id of this.timerStamps.keys()) {
        if (!this.graph.nodes.has(id)) this.timerStamps.delete(id);
      }
    });

    this.panGroup.addEventListener("click", this.onPanGroupClick);
    this.panGroup.addEventListener("mousedown", this.onPanGroupMouseDown);
    this.panGroup.addEventListener("dblclick", this.onPanGroupDblClick);
    this.panGroup.addEventListener("input",  this.onAttrInput);
    this.panGroup.addEventListener("change", this.onAttrChange);
    this.panGroup.addEventListener("focusout", this.onCellFocusOut);
    this.panGroup.addEventListener("keydown",  this.onCellKeyDown);
  }

  setAudioGraph(ag: AudioGraph | undefined): void {
    this.audioGraph = ag;
  }

  setCodeboxController(cc: CodeboxController): void {
    this.codeboxController = cc;
  }

  setJsEffectPanelController(c: JsEffectPanelController): void {
    this.jsEffectPanelController = c;
  }

  setReaperVideoPanelController(c: ReaperVideoPanelController): void {
    this.reaperVideoPanelController = c;
  }

  setVisualizerGraph(vg: VisualizerGraph): void {
    this.visualizerGraph = vg;
  }

  setDmxGraph(dg: DmxGraph): void {
    this.dmxGraph = dg;
  }

  setPeerRegistry(pr: import("../runtime/peer/PeerRegistry").PeerRegistry): void {
    this.peerRegistry = pr;
  }

  setOutletCallback(cb: (outletIndex: number, value: string | null) => void): void {
    this.outletCallback = cb;
  }

  setSubPatchManager(mgr: SubPatchManager): void {
    this.subPatchManager = mgr;
  }

  setBufferRedrawCallback(cb: (nodeId: string) => void): void {
    this.bufferRedraw = cb;
  }

  /** Live drag-selection on a vbuf* timeline strip, normalized [a,b]. Returns
   *  null when no drag is in progress for this node. main.ts's drawVbufStrip
   *  reads this each rAF tick to render the highlight without depending on
   *  the canvas DOM (which is rebuilt on emit("change")). */
  getVbufLiveSelection(nodeId: string): [number, number] | null {
    return this.vbufLiveSelection.get(nodeId) ?? null;
  }

  destroy(): void {
    this.panGroup.removeEventListener("click", this.onPanGroupClick);
    this.panGroup.removeEventListener("mousedown", this.onPanGroupMouseDown);
    this.panGroup.removeEventListener("dblclick", this.onPanGroupDblClick);
    this.panGroup.removeEventListener("input",  this.onAttrInput);
    this.panGroup.removeEventListener("change", this.onAttrChange);
    this.panGroup.removeEventListener("focusout", this.onCellFocusOut);
    this.panGroup.removeEventListener("keydown",  this.onCellKeyDown);
    for (const panel of this.externalPanels) {
      panel.removeEventListener("click",     this.onPanGroupClick);
      panel.removeEventListener("mousedown", this.onPanGroupMouseDown);
      panel.removeEventListener("dblclick",  this.onPanGroupDblClick);
      panel.removeEventListener("input",     this.onAttrInput);
      panel.removeEventListener("change",    this.onAttrChange);
      panel.removeEventListener("focusout",  this.onCellFocusOut);
      panel.removeEventListener("keydown",   this.onCellKeyDown);
    }
    this.externalPanels.length = 0;
    this.currentDragSession?.end();
    this.currentDragSession = null;
    this.onGraphChangeUnsubscribe();
    for (const nodeId of this.metroTimers.keys()) {
      this.stopMetro(nodeId, false);
    }
    for (const nodeId of this.oscTimers.keys()) {
      this.stopOsc(nodeId, false);
    }
  }

  /**
   * Attaches interaction handlers to an external panel element (e.g. a subPatch
   * presentation panel on the main canvas) so clicks/drags route through this OIC.
   */
  addInteractionPanel(el: HTMLElement): void {
    if (this.externalPanels.includes(el)) return;
    this.externalPanels.push(el);
    el.addEventListener("click",     this.onPanGroupClick);
    el.addEventListener("mousedown", this.onPanGroupMouseDown);
    el.addEventListener("dblclick",  this.onPanGroupDblClick);
    el.addEventListener("input",     this.onAttrInput);
    el.addEventListener("change",    this.onAttrChange);
    el.addEventListener("focusout",  this.onCellFocusOut);
    el.addEventListener("keydown",   this.onCellKeyDown);
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

    // buffer~ waveform: click + drag to play / commit a range. Caught before
    // generic numbox/odometer handling and before the canvas drag-select layer.
    if (node.type === "buffer~") {
      const waveEl = (e.target as Element).closest<HTMLCanvasElement>(".pn-buf-wave");
      if (waveEl) {
        e.preventDefault();
        e.stopPropagation();
        const rect = waveEl.getBoundingClientRect();
        const norm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.bufWaveDrag = {
          node,
          canvas: waveEl,
          startNorm: norm,
          endNorm:   norm,
          shift:     e.shiftKey,
        };
        this.startWidgetDragSession();
        return;
      }
    }

    // vbuf* timeline strip — same plain-drag / shift-drag / click-inside /
    // click-outside semantics as buffer~. The strip is redrawn every rAF so we
    // don't need a redraw callback; the canvas dataset selection overlay is
    // picked up by the rAF tick automatically (see drawVbufStrip).
    if (node.type === "vbuf*") {
      const stripEl = (e.target as Element).closest<HTMLCanvasElement>(".pn-vbuf-strip");
      if (stripEl) {
        e.preventDefault();
        e.stopPropagation();
        const rect = stripEl.getBoundingClientRect();
        const norm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.vbufStripDrag = {
          node,
          canvas: stripEl,
          startNorm: norm,
          endNorm:   norm,
          shift:     e.shiftKey,
        };
        this.startWidgetDragSession();
        return;
      }
    }

    if (node.type === "ezScale") {
      const trackEl = objectEl.querySelector<HTMLElement>(".pn-ezscale__track");
      if (trackEl && (e.target as Element).closest(".pn-ezscale__range")) {
        // Bounds must be set before the slider becomes interactive.
        const outMin = parseFloat(node.args[2] ?? "");
        const outMax = parseFloat(node.args[3] ?? "");
        if (!isFinite(outMin) || !isFinite(outMax) || outMin === outMax) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        let which: "lo" | "hi" | "range";
        let startX: number | undefined;
        let startLo: number | undefined;
        let startHi: number | undefined;
        const thumbEl = (e.target as Element).closest<HTMLElement>(".pn-ezscale__thumb");
        if (thumbEl) {
          which = thumbEl.dataset.ezscaleThumb === "hi" ? "hi" : "lo";
        } else if ((e.target as Element).closest(".pn-ezscale__fill")) {
          // Drag the filled region — shifts both handles uniformly.
          which = "range";
          startX = e.clientX;
          const outLoNum = parseFloat(node.args[4] ?? "");
          const outHiNum = parseFloat(node.args[5] ?? "");
          startLo = isFinite(outLoNum) ? outLoNum : outMin;
          startHi = isFinite(outHiNum) ? outHiNum : outMax;
        } else {
          // Click on the track — grab whichever handle is nearer to the click.
          const rect = trackEl.getBoundingClientRect();
          const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const outLoNum = parseFloat(node.args[4] ?? "");
          const outHiNum = parseFloat(node.args[5] ?? "");
          const outLo = isFinite(outLoNum) ? outLoNum : outMin;
          const outHi = isFinite(outHiNum) ? outHiNum : outMax;
          const span = outMax - outMin;
          const loT = (outLo - outMin) / span;
          const hiT = (outHi - outMin) / span;
          which = Math.abs(t - loT) <= Math.abs(t - hiT) ? "lo" : "hi";
        }

        e.preventDefault();
        e.stopPropagation();
        this.ezScaleDrag = { node, trackEl, which, startX, startLo, startHi };
        document.body.classList.add("pn-state-slider-drag");
        this.startWidgetDragSession();
        if (which !== "range") this.updateEzScaleFromEvent(e);
        return;
      }
      // Field clicks: native <input> handles focus/caret. DragController already
      // excludes INPUT from move drags.
    }

    if (node.type === "ezSlider") {
      const trackEl = objectEl.querySelector<HTMLElement>(".pn-ezslider__track");
      if (trackEl && (e.target as Element).closest(".pn-ezslider__track")) {
        const lo = parseFloat(node.args[0] ?? "");
        const hi = parseFloat(node.args[1] ?? "");
        if (!isFinite(lo) || !isFinite(hi)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.ezSliderDrag = { node, trackEl };
        document.body.classList.add("pn-state-slider-drag");
        this.startWidgetDragSession();
        this.updateEzSliderFromEvent(e);
        return;
      }
    }

    if (node.type === "wave~") {
      const locked = (node.args[3] ?? "0") !== "0";
      const knobEl = (e.target as Element).closest<HTMLElement>(".pn-wave-knob");
      if (knobEl && !locked) {
        const knob = knobEl.dataset.waveKnob as "freq" | "morph" | "level" | undefined;
        if (knob === "freq" || knob === "morph" || knob === "level") {
          e.preventDefault();
          e.stopPropagation();
          const startFrac = parseFloat(knobEl.dataset.waveFrac ?? "0") || 0;
          this.waveKnobDrag = { node, knob, knobEl, startY: e.clientY, startFrac };
          document.body.classList.add("pn-state-slider-drag");
          this.startWidgetDragSession();
          return;
        }
      }
      // Locked, or click outside a knob → fall through to drag/select.
    }

    if (node.type === "lfo~") {
      const locked = (node.args[3] ?? "0") !== "0";
      const knobEl = (e.target as Element).closest<HTMLElement>(".pn-lfo-knob");
      if (knobEl && !locked) {
        const knob = knobEl.dataset.lfoKnob as "rate" | "depth" | "shape" | undefined;
        if (knob === "rate" || knob === "depth" || knob === "shape") {
          e.preventDefault();
          e.stopPropagation();
          const startFrac = parseFloat(knobEl.dataset.lfoFrac ?? "0") || 0;
          this.lfoKnobDrag = { node, knob, knobEl, startY: e.clientY, startFrac };
          document.body.classList.add("pn-state-slider-drag");
          this.startWidgetDragSession();
          return;
        }
      }
      // Locked, or click outside a knob → fall through to drag/select.
    }

    if (node.type === "adsr~") {
      const locked = (node.args[5] ?? "0") !== "0";
      const handleEl = (e.target as Element).closest<SVGCircleElement>("circle.pn-adsr-handle");
      if (handleEl && !locked) {
        const handle = handleEl.dataset.adsrHandle as
          "attack" | "decay" | "sustainEnd" | "release" | undefined;
        const svgEl = handleEl.ownerSVGElement as SVGSVGElement | null;
        if ((handle === "attack" || handle === "decay" || handle === "sustainEnd" || handle === "release") && svgEl) {
          e.preventDefault();
          e.stopPropagation();
          const startA  = parseFloat(node.args[0] ?? "50");
          const startD  = parseFloat(node.args[1] ?? "100");
          const startS  = parseFloat(node.args[2] ?? "0.7");
          const startR  = parseFloat(node.args[3] ?? "200");
          const startSh = parseFloat(node.args[4] ?? "200");
          const rect = svgEl.getBoundingClientRect();
          const vbW = svgEl.viewBox.baseVal.width || 160;
          const vbH = svgEl.viewBox.baseVal.height || 50;
          const svgPxPerCssPxX = rect.width  > 0 ? vbW / rect.width  : 1;
          const svgPxPerCssPxY = rect.height > 0 ? vbH / rect.height : 1;
          const g = adsrGeometry(startA, startD, startS, startR, startSh);
          const msPerSvgPx = g.pxPerMs > 0 ? 1 / g.pxPerMs : 1;
          this.adsrHandleDrag = {
            node, handle, svgEl,
            startMouseX: e.clientX, startMouseY: e.clientY,
            startA, startD, startSustain: startS, startR, startSustainTime: startSh,
            svgPxPerCssPx: svgPxPerCssPxX,
            msPerSvgPx,
          };
          // Stash Y scale on the drag too — only the decay handle uses it.
          (this.adsrHandleDrag as unknown as { svgPxPerCssPxY: number }).svgPxPerCssPxY = svgPxPerCssPxY;
          document.body.classList.add("pn-state-slider-drag");
          this.startWidgetDragSession();
          return;
        }
      }
      // Locked, or click outside a handle → fall through to drag/select.
    }

    if (node.type === "slider") {
      const trackEl = objectEl.querySelector<HTMLElement>(".patch-object-slider-track");
      const thumbEl = objectEl.querySelector<HTMLElement>(".patch-object-slider-thumb");
      if (!trackEl || !thumbEl) return;

      e.preventDefault();

      this.sliderDrag = { node, trackEl, thumbEl };
      document.body.classList.add("pn-state-slider-drag");
      this.startWidgetDragSession();

      this.updateSliderFromEvent(e);

    } else if (node.type === "integer" || node.type === "float") {
      // Only intercept if the user clicked directly on a digit drum column.
      // Clicks on the frame, sign, or dot fall through to DragController for moving.
      const digitEl = (e.target as Element).closest<HTMLElement>(".pn-odo-col");
      if (!digitEl) return;

      const odoEl = objectEl.querySelector<HTMLElement>(".pn-odometer");
      if (!odoEl) return;

      e.preventDefault();

      const isFloat = node.type === "float";
      const activePlace = digitEl.dataset.place !== undefined
        ? parseInt(digitEl.dataset.place, 10)
        : null;
      const increment = activePlace !== null ? Math.pow(10, activePlace) : 1;
      const startValue = parseFloat(node.args[0] ?? "0") || 0;

      this.numboxDrag = { node, el: odoEl, startY: e.clientY, startValue, increment, isFloat, activePlace, moved: false };
      document.body.classList.add("pn-state-numbox-drag");
      this.startWidgetDragSession();
    }
  }

  private handleClick(e: MouseEvent): void {
    if (e.button !== 0) return;

    const dx = e.clientX - this.mouseDownX;
    const dy = e.clientY - this.mouseDownY;
    if (Math.sqrt(dx * dx + dy * dy) > this.DRAG_THRESHOLD) return;

    // Lock-toggle button on subPatch + sequencer objects
    const lockBtn = (e.target as Element).closest<HTMLElement>(".pn-subpatch-lock");
    if (lockBtn) {
      const objectEl = lockBtn.closest<HTMLElement>(".patch-object");
      const node = objectEl ? this.getNode(objectEl) : null;
      if (node?.type === "subPatch") {
        const nowLocked = (node.args[3] ?? "1") !== "0";
        node.args[3] = nowLocked ? "0" : "1";
        this.graph.emit("change");
        e.stopPropagation();
        return;
      }
      if (node?.type === "sequencer") {
        ensureSequencerArgs(node.args);
        const nowLocked = node.args[4] !== "0";
        node.args[4] = nowLocked ? "0" : "1";
        this.graph.emit("change");
        e.stopPropagation();
        return;
      }
      if (node?.type === "dmx") {
        const nowLocked = (node.args[8] ?? "0") === "1";
        node.args[8] = nowLocked ? "0" : "1";
        this.graph.emit("change");
        e.stopPropagation();
        return;
      }
      if (node?.type === "mixer~") {
        const nowLocked = (node.args[3] ?? "0") === "1";
        node.args[3] = nowLocked ? "0" : "1";
        this.graph.emit("change");
        e.stopPropagation();
        return;
      }
      if (node?.type === "youtube~*") {
        const nowLocked = (node.args[4] ?? "0") === "1";
        node.args[4] = nowLocked ? "0" : "1";
        this.graph.emit("change");
        e.stopPropagation();
        return;
      }
    }

    // ezScale [auto] toggle button.
    const ezAutoBtn = (e.target as Element).closest<HTMLElement>('.pn-ezscale__auto-btn[data-ezscale-action="toggle-auto"]');
    if (ezAutoBtn) {
      const objectElForBtn = ezAutoBtn.closest<HTMLElement>(".patch-object");
      const ezNode = objectElForBtn ? this.getNode(objectElForBtn) : null;
      if (ezNode?.type === "ezScale") {
        const nowOn = (ezNode.args[6] ?? "1") !== "0";
        ezNode.args[6] = nowOn ? "0" : "1";
        this.graph.emit("change");
        e.stopPropagation();
        return;
      }
    }

    // ezScale invert toggle.
    const ezInvertBtn = (e.target as Element).closest<HTMLElement>('.pn-ezscale__invert-btn[data-ezscale-action="toggle-invert"]');
    if (ezInvertBtn) {
      const objectElForBtn = ezInvertBtn.closest<HTMLElement>(".patch-object");
      const ezNode = objectElForBtn ? this.getNode(objectElForBtn) : null;
      if (ezNode?.type === "ezScale") {
        const wasInverted = (ezNode.args[10] ?? "0") === "1";
        ezNode.args[10] = wasInverted ? "0" : "1";
        // Swap output bounds + active sub-range so the visual + math reflect
        // the new direction immediately. Auto-output, if enabled, will keep
        // the swap consistent on subsequent reconnects.
        const tmpBound = ezNode.args[2]; ezNode.args[2] = ezNode.args[3] ?? ""; ezNode.args[3] = tmpBound ?? "";
        const tmpActive = ezNode.args[4]; ezNode.args[4] = ezNode.args[5] ?? ""; ezNode.args[5] = tmpActive ?? "";
        this.graph.emit("change");
        e.stopPropagation();
        return;
      }
    }

    // ezScale collapse / expand toggle.
    const ezCollapseBtn = (e.target as Element).closest<HTMLElement>('.pn-ezscale__collapse-btn[data-ezscale-action="toggle-collapse"]');
    if (ezCollapseBtn) {
      const objectElForBtn = ezCollapseBtn.closest<HTMLElement>(".patch-object");
      const ezNode = objectElForBtn ? this.getNode(objectElForBtn) : null;
      if (ezNode?.type === "ezScale") {
        const wasCollapsed = (ezNode.args[8] ?? "0") === "1";
        const def = getObjectDef("ezScale");
        if (wasCollapsed) {
          const stored = parseInt(ezNode.args[9] ?? "", 10);
          const restoreH = isFinite(stored) && stored > 0 ? stored : def.defaultHeight;
          ezNode.args[8] = "0";
          this.graph.setNodeSize(ezNode.id, ezNode.width ?? def.defaultWidth, restoreH);
        } else {
          const currentH = ezNode.height ?? def.defaultHeight;
          ezNode.args[9] = String(currentH);
          ezNode.args[8] = "1";
          this.graph.setNodeSize(ezNode.id, ezNode.width ?? def.defaultWidth, EZSCALE_COLLAPSED_HEIGHT);
        }
        e.stopPropagation();
        return;
      }
    }

    // buffer~ transport buttons — match by data-buf-action.
    const bufBtn = (e.target as Element).closest<HTMLElement>(".pn-buf-btn[data-buf-action]");
    if (bufBtn) {
      const objectElForBtn = bufBtn.closest<HTMLElement>(".patch-object");
      const bufNode = objectElForBtn ? this.getNode(objectElForBtn) : null;
      if (bufNode?.type === "buffer~") {
        const action = bufBtn.dataset.bufAction ?? "";
        this.deliverBufferMessage(bufNode, action, []);
        e.stopPropagation();
        return;
      }
    }

    // vbuf* transport buttons + loop toggle — match any .pn-vbuf-* control
    // that carries a data-vbuf-action attribute.
    const vbufBtn = (e.target as Element).closest<HTMLElement>("[data-vbuf-action]");
    if (vbufBtn) {
      const objectElForBtn = vbufBtn.closest<HTMLElement>(".patch-object");
      const vbufNode = objectElForBtn ? this.getNode(objectElForBtn) : null;
      if (vbufNode?.type === "vbuf*") {
        const action = vbufBtn.dataset.vbufAction ?? "";
        if (action === "loop-on")       this.deliverVideoBufferMessage(vbufNode, "loop", ["1"]);
        else if (action === "loop-off") this.deliverVideoBufferMessage(vbufNode, "loop", ["0"]);
        else                            this.deliverVideoBufferMessage(vbufNode, action, []);
        e.stopPropagation();
        return;
      }
    }

    // buffer~ maxLen — click on the "max:Nm" label to edit.
    const maxLenEl = (e.target as Element).closest<HTMLElement>("[data-buf-maxlen-display]");
    if (maxLenEl) {
      const objectElForMax = maxLenEl.closest<HTMLElement>(".patch-object");
      const bufNode = objectElForMax ? this.getNode(objectElForMax) : null;
      if (bufNode?.type === "buffer~") {
        this.beginEditBufferMaxLen(bufNode, maxLenEl);
        e.stopPropagation();
        return;
      }
    }

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
    } else if (node.type === "visualizer*") {
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
    this.guardedFanout(fromNodeId, fromOutlet, () => {
      for (const edge of this.graph.getEdges()) {
        if (edge.fromNodeId !== fromNodeId || edge.fromOutlet !== fromOutlet) continue;
        const target = this.graph.nodes.get(edge.toNodeId);
        if (!target) continue;
        this.deliverBang(target, edge.toInlet);
      }
    });
  }

  /** Route a value from a node outlet to all connected inlets. */
  fireOutlet(fromNodeId: string, fromOutlet: number, value: string): void {
    this.dispatchValue(fromNodeId, fromOutlet, value);
  }

  /** Public bang dispatcher — used by main.ts to fire outlet-1 done bangs
   *  from one-shot adsr~ envelope completions. */
  fireBang(fromNodeId: string, fromOutlet: number): void {
    this.dispatchBang(fromNodeId, fromOutlet);
  }

  private dispatchValue(fromNodeId: string, fromOutlet: number, value: string): void {
    this.guardedFanout(fromNodeId, fromOutlet, () => {
      for (const edge of this.graph.getEdges()) {
        if (edge.fromNodeId !== fromNodeId || edge.fromOutlet !== fromOutlet) continue;
        const target = this.graph.nodes.get(edge.toNodeId);
        if (!target) continue;
        this.deliverMessageValue(target, edge.toInlet, value);
      }
    });
  }

  /**
   * Wrap an outlet-fan-out in a per-dispatch-root visited set so feedback
   * cycles in user patches break with a single console.warn rather than
   * blowing the stack. The set is keyed on `${nodeId}:${outletIdx}` and
   * lives for the duration of one synchronous dispatch chain (top-level
   * call clears it on unwind, recursive calls share it).
   *
   * Legitimate fan-out (one outlet → many receivers) happens inside the
   * iterate() callback's for-loop — each edge calls deliverMessageValue
   * directly, not dispatchValue, so no false positives there. The guard
   * only fires when the SAME outlet would dispatch a SECOND time within
   * one chain, which is the signature of a cycle.
   *
   * Handles both `dispatchValue` and `dispatchBang` since both share the
   * same fan-out shape.
   */
  private guardedFanout(
    fromNodeId: string,
    fromOutlet: number,
    iterate: () => void,
  ): void {
    const key = `${fromNodeId}:${fromOutlet}`;
    const isRoot = this.dispatchVisited === null;
    if (isRoot) {
      this.dispatchVisited = new Set();
      this.dispatchCycleWarned = false;
    }
    if (this.dispatchVisited!.has(key)) {
      if (!this.dispatchCycleWarned) {
        const node = this.graph.nodes.get(fromNodeId);
        const desc = node ? `${node.type} (${fromNodeId.slice(0, 8)}…)` : fromNodeId;
        console.warn(
          `[OIC] feedback cycle detected — outlet ${fromOutlet} of ${desc} would fire for the second time in one dispatch chain. Aborting to prevent stack overflow. Check your patch for a connection that loops back to this node.`,
        );
        this.dispatchCycleWarned = true;
      }
      return;
    }
    this.dispatchVisited!.add(key);
    try {
      iterate();
    } finally {
      if (isRoot) {
        this.dispatchVisited = null;
        this.dispatchCycleWarned = false;
      }
    }
  }

  deliverBang(node: PatchNode, inlet: number): void {
    switch (node.type) {
      case "toggle":
        this.toggleNodeFromCable(node);
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

      case "ezSlider":
        if (inlet === 0) this.dispatchEzSliderOutput(node);
        break;

      case "message":
        if (inlet === 0) {
          this.dispatchStoredMessage(node);
          this.flashButton(node.id);
        } else if (inlet === 1) {
          this.setStoredMessage(node, "bang");
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

      case "oscillateNumbers":
        if (inlet === 0) {
          if (this.isOscRunning(node.id)) {
            this.stopOsc(node.id);
          } else {
            this.startOsc(node);
          }
        }
        break;

      case "sequencer":
        if (inlet === 0) this.advanceSequencer(node);
        break;

      case "click~":
        this.audioGraph?.triggerClick(node.id);
        break;

      case "adsr~":
        // Bang on inlet 1 = one-shot trigger (A → D → hold sustain → R, then
        // outlet-1 done bang). Inlet 0 is signal-only and never delivers
        // bangs through this path.
        if (inlet === 1) this.audioGraph?.triggerAdsr(node.id);
        break;

      case "buffer~":
        if (inlet === bufferControlInlet(node.args)) {
          this.deliverBufferMessage(node, "play", []);
        }
        break;

      case "codebox":
        this.codeboxController?.executeBang(node, inlet);
        break;

      case "visualizer*":
        if (inlet === 0) this.visualizerGraph?.deliverMessage(node.id, "bang", []);
        break;

      case "patchViz":
        if (inlet === 0) this.visualizerGraph?.deliverPatchVizMessage(node.id, "bang", []);
        break;

      case "mediaVideo*":
        if (inlet === 0) this.visualizerGraph?.deliverMediaMessage(node.id, "mediaVideo*", "bang", []);
        break;

      case "mediaImage*":
        break;

      case "imageFX*":
        break; // bang has no effect on imageFX

      case "vfxCRT*":
      case "vfxBlur*":
        break; // bang has no effect on vFX nodes

      case "shaderToy*":
        if (inlet === 0) this.visualizerGraph?.deliverShaderToyMessage(node.id, "reset", []);
        break;

      case "layer*":
        break;

      case "dmx":
        if (inlet === 0) this.deliverDmxMessage(node, "status", []);
        break;

      case "integer":
      case "float":
      case "f":
        if (inlet === 0) this.dispatchValue(node.id, 0, node.args[0] ?? "0");
        break;

      case "scale":
      case "ezScale":
        break; // bang has no effect on scale / ezScale

      case "t": {
        if (inlet !== 0) break;
        const letters = node.args.length > 0 ? node.args : ["i", "i"];
        for (let i = letters.length - 1; i >= 0; i--) {
          const letter = letters[i].toLowerCase();
          if (letter === "b") {
            this.dispatchBang(node.id, i);
          } else if (letter === "s" || letter === "l") {
            this.dispatchValue(node.id, i, "");
          } else {
            this.dispatchValue(node.id, i, "0");
          }
        }
        break;
      }

      case "+": case "-": case "*": case "/": case "%":
      case "==": case "!=": case ">": case "<": case ">=": case "<=":
        if (inlet === 0) {
          const left  = this.mathLeftOps.get(node.id) ?? 0;
          const right = parseFloat(node.args[0] ?? "0");
          this.dispatchValue(node.id, 0, String(this.applyMathOp(node.type, left, right)));
        }
        break;

      case "prepend":
        if (inlet === 0) this.dispatchValue(node.id, 0, this.composePrependAppend(node, "bang", "prepend"));
        break;

      case "append":
        if (inlet === 0) this.dispatchValue(node.id, 0, node.args.join(" "));
        break;

      case "pack":
        if (inlet === 0) this.dispatchValue(node.id, 0, this.getPackSlots(node).join(" "));
        break;

      case "unpack": {
        if (inlet !== 0) break;
        const slots = this.getUnpackSlots(node);
        const letters = node.args.length > 0 ? node.args : ["f", "f"];
        for (let i = slots.length - 1; i >= 0; i--) {
          this.dispatchValue(node.id, i, this.coerceUnpackOutput(letters[i] ?? "f", slots[i]));
        }
        break;
      }

      case "s":
        if (inlet === 0) broadcastSendReceive(node.args[0] ?? "", null);
        break;

      case "attribute":
        if (node.inlets.some(p => p.index === inlet && p.side === "left")) {
          this.setAttrSideInlet(node, inlet, "1");
        } else if (inlet === 0) {
          this.dispatchAttributeAll(node);
        }
        break;

      case "inlet":
        break; // inlet has 0 inlets — triggered externally by SubPatchManager

      case "outlet":
        if (inlet === 0) {
          const idx = parseInt(node.args[0] ?? "0", 10);
          this.outletCallback?.(isNaN(idx) ? 0 : idx, null);
        }
        break;

      case "subPatch":
        if (inlet >= 0) this.subPatchManager?.deliver(node.id, inlet, null);
        break;

      case "timer": {
        const now = performance.now();
        const last = this.timerStamps.get(node.id);
        const elapsed = last !== undefined ? now - last : 0;
        this.timerStamps.set(node.id, now);
        this.dispatchValue(node.id, 0, elapsed.toFixed(3));
        break;
      }

      case "drunk": {
        if (inlet === 0) {
          const max  = Math.max(1, Math.floor(Number(node.args[0] ?? "128")));
          const step = Math.max(1, Math.floor(Number(node.args[1] ?? "10")));
          const cur  = this.drunkPositions.get(node.id) ?? Math.floor(Number(node.args[2] ?? "0"));
          const delta = Math.floor(Math.random() * step) * (Math.random() < 0.5 ? 1 : -1);
          const next  = Math.min(max - 1, Math.max(0, cur + delta));
          this.drunkPositions.set(node.id, next);
          node.args[2] = String(next);
          this.dispatchValue(node.id, 0, String(next));
        }
        break;
      }

      case "netsend":
        if (inlet === 0) {
          const topic = (node.args[0] ?? "").trim();
          this.peerRegistry?.sendFromNetSend(this.graph, topic, null);
        }
        break;

      case "netreceive":
        // Input-only on the wire; no inlets to handle locally.
        break;

      case "peer":
        // Phase 7A: connect/disconnect happens through the panel UI.
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
          const clamped = Math.max(0, Math.min(1, parsed));
          node.args[0] = String(clamped);
          this.syncSliderThumb(node.id, clamped, node);
          this.graph.emit("display");
          this.dispatchValue(node.id, 0, clamped.toFixed(6));
        }
        break;

      case "ezSlider":
        if (inlet === 0) {
          const parsed = Number.parseFloat(value);
          if (Number.isNaN(parsed)) break;
          // Incoming values are interpreted in the slider's [lo, hi] range,
          // matching Pd's [hsl]/[vsl] convention — a bare float arriving here
          // is "the slider's current value." Previously we clamped to [0,1]
          // and treated it as a raw thumb position, which silently pinned
          // the thumb to max for any feedback path delivering bound-range or
          // ms values (e.g. vbuf*'s loopLen outlet). The drag path still
          // writes args[2] directly because the mouse already produces a
          // [0,1] track fraction.
          const lo = parseFloat(node.args[0] ?? "");
          const hi = parseFloat(node.args[1] ?? "");
          if (!isFinite(lo) || !isFinite(hi)) break;
          const span = hi - lo;
          const t = span === 0 ? 0 : Math.max(0, Math.min(1, (parsed - lo) / span));
          node.args[2] = String(t);
          const thumbEl = this.findNodeEl(node.id)?.querySelector<HTMLElement>(".pn-ezslider__thumb");
          if (thumbEl) thumbEl.style.left = `${t * 100}%`;
          this.graph.emit("display");
          this.dispatchEzSliderOutput(node);
        } else if (inlet === 1) {
          if (isFinite(parseFloat(value))) {
            node.args[0] = value.trim();
            const field = this.findNodeEl(node.id)?.querySelector<HTMLInputElement>('input[data-ezslider-field="lo"]');
            if (field && document.activeElement !== field) field.value = node.args[0];
            this.graph.emit("display");
          }
        } else if (inlet === 2) {
          if (isFinite(parseFloat(value))) {
            node.args[1] = value.trim();
            const field = this.findNodeEl(node.id)?.querySelector<HTMLInputElement>('input[data-ezslider-field="hi"]');
            if (field && document.activeElement !== field) field.value = node.args[1];
            this.graph.emit("display");
          }
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
            this.graph.emit("display");
            if (this.isMetroRunning(node.id)) this.startMetro(node);
          }
        } else {
          this.deliverMetroValue(node, inlet, value);
        }
        break;
      }

      case "oscillateNumbers": {
        const oscTokens = value.trim().split(/\s+/);
        if (inlet === 0 && oscTokens[0] === "freq") {
          const hz = parseFloat(oscTokens[1] ?? "1");
          if (!isNaN(hz)) {
            node.args[0] = String(Math.max(0.01, hz));
            this.graph.emit("display");
            if (this.isOscRunning(node.id)) this.startOsc(node);
          }
        } else {
          this.deliverOscValue(node, inlet, value);
        }
        break;
      }

      case "sequencer":
        // Any non-attr value on inlet 0 advances the playhead. The `rows` and
        // `cols` attribute-panel paths fall through to trySetArgByName below
        // and then into syncSequencerPorts via the generic arg hook.
        if (inlet === 0 && !/^\w+ /.test(value)) this.advanceSequencer(node);
        break;

      case "codebox":
        this.codeboxController?.executeValue(node, inlet, value);
        break;

      case "visualizer*":
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

      case "mediaVideo*":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          if (selector === "transport") {
            // Attribute panel sends "transport play|pause|stop" — route to the matching command
            const cmd = args[0] ?? "";
            if (cmd === "play" || cmd === "stop" || cmd === "pause") {
              this.visualizerGraph?.deliverMediaMessage(node.id, "mediaVideo*", cmd, []);
            }
          } else {
            this.visualizerGraph?.deliverMediaMessage(node.id, "mediaVideo*", selector, args);
          }
        }
        break;

      case "integer": {
        // Max-style: hot inlet 0 stores+outputs (or `set <n>` stores silently);
        // cold inlet 1 stores silently.
        if (inlet === 0) {
          const trimmed = value.trim();
          if (trimmed === "set" || trimmed.startsWith("set ")) {
            const payload = trimmed === "set" ? "" : trimmed.slice(4).trim();
            const parsed = parseFloat(payload);
            if (!isNaN(parsed)) {
              node.args[0] = String(Math.trunc(parsed));
              this.syncNumboxDisplay(node);
              this.graph.emit("display");
            }
          } else {
            const parsed = parseFloat(trimmed);
            if (!isNaN(parsed)) {
              const intVal = Math.trunc(parsed);
              node.args[0] = String(intVal);
              this.syncNumboxDisplay(node);
              this.graph.emit("display");
              this.dispatchValue(node.id, 0, String(intVal));
            }
          }
        } else if (inlet === 1) {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            node.args[0] = String(Math.trunc(parsed));
            this.syncNumboxDisplay(node);
            this.graph.emit("display");
          }
        }
        break;
      }

      case "float": {
        // Max-style: hot inlet 0 stores+outputs (or `set <n>` stores silently);
        // cold inlet 1 stores silently.
        if (inlet === 0) {
          const trimmed = value.trim();
          if (trimmed === "set" || trimmed.startsWith("set ")) {
            const payload = trimmed === "set" ? "" : trimmed.slice(4).trim();
            const parsed = parseFloat(payload);
            if (!isNaN(parsed)) {
              node.args[0] = String(parsed);
              this.syncNumboxDisplay(node);
              this.graph.emit("display");
            }
          } else {
            const parsed = parseFloat(trimmed);
            if (!isNaN(parsed)) {
              node.args[0] = String(parsed);
              this.syncNumboxDisplay(node);
              this.graph.emit("display");
              this.dispatchValue(node.id, 0, String(parsed));
            }
          }
        } else if (inlet === 1) {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            node.args[0] = String(parsed);
            this.syncNumboxDisplay(node);
            this.graph.emit("display");
          }
        }
        break;
      }

      case "f": {
        if (inlet === 0) {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            node.args[0] = String(parsed);
            this.syncFLabel(node);
            this.dispatchValue(node.id, 0, String(parsed));
          }
        } else if (inlet === 1) {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            node.args[0] = String(parsed);
            this.syncFLabel(node);
          }
        }
        break;
      }

      case "t": {
        if (inlet !== 0) break;
        const letters = node.args.length > 0 ? node.args : ["i", "i"];
        const numeric = parseFloat(value);
        const hasNumeric = !isNaN(numeric);
        for (let i = letters.length - 1; i >= 0; i--) {
          const letter = letters[i].toLowerCase();
          if (letter === "b") {
            this.dispatchBang(node.id, i);
          } else if (letter === "i") {
            this.dispatchValue(node.id, i, hasNumeric ? String(Math.trunc(numeric)) : "0");
          } else if (letter === "f") {
            this.dispatchValue(node.id, i, hasNumeric ? String(numeric) : "0");
          } else if (letter === "s") {
            this.dispatchValue(node.id, i, hasNumeric ? "" : value);
          } else if (letter === "l") {
            this.dispatchValue(node.id, i, value);
          } else {
            this.dispatchValue(node.id, i, value);
          }
        }
        break;
      }

      case "prepend":
      case "append": {
        if (inlet !== 0) break;
        const trimmed = value.trim();
        if (trimmed === "set" || trimmed.startsWith("set ")) {
          const payload = trimmed === "set" ? "" : trimmed.slice(4).trim();
          node.args = payload ? payload.split(/\s+/) : [];
          this.graph.emit("display");
          return;
        }
        this.dispatchValue(node.id, 0, this.composePrependAppend(node, trimmed, node.type as "prepend" | "append"));
        break;
      }

      case "pack": {
        const slots = this.getPackSlots(node);
        if (inlet < 0 || inlet >= slots.length) break;
        slots[inlet] = value;
        this.packSlots.set(node.id, slots);
        if (inlet === 0) {
          this.dispatchValue(node.id, 0, slots.join(" "));
        }
        break;
      }

      case "unpack": {
        if (inlet !== 0) break;
        const trimmed = value.trim();
        const slots = this.getUnpackSlots(node);
        const letters = node.args.length > 0 ? node.args : ["f", "f"];
        // `set <atoms>` updates stored values silently — same convention as pack/prepend.
        if (trimmed === "set" || trimmed.startsWith("set ")) {
          const payload = trimmed === "set" ? "" : trimmed.slice(4).trim();
          const atoms = payload ? payload.split(/\s+/) : [];
          for (let i = 0; i < slots.length && i < atoms.length; i++) slots[i] = atoms[i];
          this.unpackSlots.set(node.id, slots);
          break;
        }
        const atoms = trimmed ? trimmed.split(/\s+/) : [];
        const count = Math.min(slots.length, atoms.length);
        for (let i = 0; i < count; i++) slots[i] = atoms[i];
        this.unpackSlots.set(node.id, slots);
        // Fire only the outlets that received an atom, right-to-left (Max).
        for (let i = count - 1; i >= 0; i--) {
          this.dispatchValue(node.id, i, this.coerceUnpackOutput(letters[i] ?? "f", atoms[i]));
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
            const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");
            this.dispatchValue(node.id, 0, formatScaled(result, intMode));
          }
        } else if (inlet >= 1 && inlet <= 4) {
          // Preserve int/float form of incoming string so the int-mode rule is
          // controlled by however the cold-inlet source formatted the value.
          if (parseFloat(value) === parseFloat(value) /* not NaN */) {
            node.args[inlet - 1] = value.trim();
            this.graph.emit("display");
          }
        }
        break;
      }

      case "ezScale": {
        const f = (i: number, def: number) => { const n = parseFloat(node.args[i] ?? ""); return isNaN(n) ? def : n; };
        if (inlet === 0) {
          const input = parseFloat(value);
          const autoOn = (node.args[6] ?? "1") !== "0";
          if (autoOn && !isNaN(input)) this.applyEzScaleAutoInput(node, input);
          // All four bounds must be present and numeric — until the user fills
          // them in, the object stays silent (no NaN dispatches).
          const inMinRaw  = parseFloat(node.args[0] ?? "");
          const inMaxRaw  = parseFloat(node.args[1] ?? "");
          const outMinRaw = parseFloat(node.args[2] ?? "");
          const outMaxRaw = parseFloat(node.args[3] ?? "");
          if (!isNaN(input) && isFinite(inMinRaw) && isFinite(inMaxRaw)
              && isFinite(outMinRaw) && isFinite(outMaxRaw)) {
            const inMin = inMinRaw, inMax = inMaxRaw;
            const outMin = outMinRaw, outMax = outMaxRaw;
            // Active sub-range falls back to full bounds when outLo/outHi are blank.
            const outLo = f(4, outMin);
            const outHi = f(5, outMax);
            // Pre-scale multiplier — applied to the raw input before mapping.
            const multRaw = parseFloat(node.args[7] ?? "1");
            const mult = isFinite(multRaw) ? multRaw : 1;
            const scaledInput = input * mult;
            const t = inMax === inMin ? 0 : (scaledInput - inMin) / (inMax - inMin);
            const result = outLo + t * (outHi - outLo);
            const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");
            this.dispatchValue(node.id, 0, formatScaled(result, intMode));
          }
        } else if (inlet >= 1 && inlet <= 4) {
          if (parseFloat(value) === parseFloat(value) /* not NaN */) {
            node.args[inlet - 1] = value.trim();
            // Bounds changed → re-clamp/canonicalize active range and
            // reposition slider against the new bound span.
            if (inlet === 3 || inlet === 4) {
              const outMin = f(2, 0);
              const outMax = f(3, 127);
              const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");
              const lowSide  = Math.min(outMin, outMax);
              const highSide = Math.max(outMin, outMax);
              let lo = f(4, outMin);
              let hi = f(5, outMax);
              lo = Math.max(lowSide, Math.min(highSide, lo));
              hi = Math.max(lowSide, Math.min(highSide, hi));
              node.args[4] = intMode ? String(Math.round(lo)) : canonicalizeBound(String(lo), false);
              node.args[5] = intMode ? String(Math.round(hi)) : canonicalizeBound(String(hi), false);
              this.dispatchEzScaleRange(node);
              this.syncEzScaleSliderVisuals(node);
            }
            this.graph.emit("display");
          }
        } else if (inlet === 5 || inlet === 6) {
          // Inlets 5/6: drive the active sub-range slider handles directly
          // (lo and hi). Clamped to the bound extremes so a programmatic
          // value past the bounds snaps in rather than blowing the slider.
          const v = parseFloat(value);
          if (v === v /* not NaN */) {
            const outMin = f(2, 0);
            const outMax = f(3, 127);
            const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");
            const lowSide  = Math.min(outMin, outMax);
            const highSide = Math.max(outMin, outMax);
            const clamped  = Math.max(lowSide, Math.min(highSide, v));
            const argIdx   = inlet === 5 ? 4 : 5; // 5→outLo (args[4]), 6→outHi (args[5])
            node.args[argIdx] = intMode ? String(Math.round(clamped)) : canonicalizeBound(String(clamped), false);
            this.dispatchEzScaleRange(node);
            this.syncEzScaleSliderVisuals(node);
            this.graph.emit("display");
          }
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
        if (inlet === 0) broadcastSendReceive(node.args[0] ?? "", value);
        break;

      case "attribute":
        if (inlet >= 0 && node.inlets.some(p => p.index === inlet && p.side === "left")) {
          this.setAttrSideInlet(node, inlet, value);
        }
        break;

      case "mediaImage*":
        break;

      case "outlet":
        if (inlet === 0) {
          const idx = parseInt(node.args[0] ?? "0", 10);
          this.outletCallback?.(isNaN(idx) ? 0 : idx, value);
        }
        break;

      case "subPatch":
        if (inlet >= 0) this.subPatchManager?.deliver(node.id, inlet, value);
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

      case "imageFX*":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.visualizerGraph?.deliverImageFXMessage(node.id, selector, args);
          this.graph.emit("display");
        }
        break;

      case "vfxCRT*":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.visualizerGraph?.deliverVfxMessage(node.id, "vfxCRT*", selector, args);
          this.graph.emit("display");
        }
        break;

      case "vfxBlur*":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.visualizerGraph?.deliverVfxMessage(node.id, "vfxBlur*", selector, args);
          this.graph.emit("display");
        }
        break;

      case "shaderToy*":
        if (inlet === 0) {
          const raw      = value.trim();
          // `glsl <rest of line>` keeps spaces and symbols in the GLSL body intact.
          if (raw.startsWith("glsl ") || raw === "glsl") {
            this.visualizerGraph?.deliverShaderToyMessage(node.id, "glsl", [raw.slice(4).trimStart()]);
            break;
          }
          const tokens   = raw.split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.visualizerGraph?.deliverShaderToyMessage(node.id, selector, args);
        }
        break;

      case "dmx":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          this.deliverDmxMessage(node, selector, args);
        }
        break;

      case "layer*":
        if (inlet === 0) {
          const tokens   = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const args     = tokens.slice(1);
          if (selector === "priority") {
            const p = parseInt(args[0] ?? "0", 10);
            if (!isNaN(p)) {
              node.args[1] = String(Math.max(0, p));
              this.graph.emit("display");
            }
          } else if (selector === "context" && args[0]) {
            node.args[0] = args[0];
            this.graph.emit("display");
          } else {
            this.visualizerGraph?.deliverLayerMessage(node.id, selector, args);
          }
        }
        break;

      case "js~":
        if (inlet >= JS_EFFECT_SIDE_INLET_START) {
          const raw = value.trim().split(/\s+/).pop() ?? value; // tolerate "name value"
          this.jsEffectPanelController?.getPanel(node.id)?.applyInletValue(inlet, raw);
          return; // don't fall through to trySetArgByName — these are hidden args
        }
        break;

      case "reaperVideo*":
        if (inlet >= getReaperVideoSideInletStart(node.args[0])) {
          const raw = value.trim().split(/\s+/).pop() ?? value;
          this.reaperVideoPanelController?.getPanel(node.id)?.applyInletValue(inlet, raw);
          return;
        }
        break;

      case "wave~": {
        // Inlets 0 (freq CV) and 1 (morph CV) are signal inlets — those edges
        // are wired in AudioGraph and never deliver messages here. Inlet 0
        // also accepts attribute-style selectors (freq/morph/level/gate). Inlet
        // 2 is the dedicated gate control — accepts a bare float (1=on, 0=off)
        // or `gate <0|1>`.
        const wTokens = value.trim().split(/\s+/);
        const wHead   = wTokens[0] ?? "";
        const wRest   = wTokens.slice(1);
        const wn = this.audioGraph?.getWaveNode(node.id);

        const setGate = (on: boolean) => {
          // The gate isn't persisted into args — it's transient runtime state,
          // like metro's `running` (although that one IS in args). Wave~ comes
          // up gated off after every load; users open it explicitly.
          wn?.setGate(on);
        };

        if (inlet === 2) {
          if (wHead === "gate") {
            const g = parseFloat(wRest[0] ?? "");
            if (Number.isFinite(g)) setGate(g !== 0);
          } else {
            const f = parseFloat(wHead);
            if (Number.isFinite(f)) setGate(f !== 0);
          }
          break;
        }

        if (inlet !== 0) break;

        if (wHead === "freq") {
          const hz = parseFloat(wRest[0] ?? "");
          if (Number.isFinite(hz)) {
            node.args[0] = hz.toFixed(2);
            wn?.setFreq(hz);
            this.graph.emit("display");
          }
        } else if (wHead === "morph") {
          const p = parseFloat(wRest[0] ?? "");
          if (Number.isFinite(p)) {
            const c = Math.max(0, Math.min(1, p));
            node.args[1] = c.toFixed(4);
            wn?.setMorph(c);
            this.graph.emit("display");
          }
        } else if (wHead === "level") {
          const g = parseFloat(wRest[0] ?? "");
          if (Number.isFinite(g)) {
            const c = Math.max(0, Math.min(1, g));
            node.args[2] = c.toFixed(4);
            wn?.setLevel(c);
            this.graph.emit("display");
          }
        } else if (wHead === "gate") {
          const g = parseFloat(wRest[0] ?? "");
          if (Number.isFinite(g)) setGate(g !== 0);
        }
        break;
      }

      case "noise~": {
        // Continuous signal source. Inlet 0 accepts lightweight control
        // selectors (`color white|pink|brown`, `level <0..1>`), plus a bare
        // float as shorthand for level.
        if (inlet !== 0) break;
        const nTokens = value.trim().split(/\s+/);
        const nHead   = nTokens[0] ?? "";
        const nRest   = nTokens.slice(1);
        const nn = this.audioGraph?.getNoiseNode(node.id);

        const refreshFace = () => {
          const el = this.panGroup.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
          const colorEl = el?.querySelector<HTMLElement>('[data-noise-readout="color"]');
          const levelEl = el?.querySelector<HTMLElement>('[data-noise-readout="level"]');
          if (colorEl) colorEl.textContent = normalizeNoiseColor(node.args[0]);
          if (levelEl) {
            const lvl = parseFloat(node.args[1] ?? "0.25");
            levelEl.textContent = `L:${formatLevel(lvl)}`;
          }
        };

        if (nHead === "color" || nHead === "white" || nHead === "pink" || nHead === "brown") {
          const color = normalizeNoiseColor(nHead === "color" ? nRest[0] : nHead);
          node.args[0] = color;
          nn?.setColor(color);
          refreshFace();
          this.graph.emit("display");
          return;
        }

        if (nHead === "level" || Number.isFinite(parseFloat(nHead))) {
          const raw = parseFloat(nHead === "level" ? (nRest[0] ?? "") : nHead);
          if (Number.isFinite(raw)) {
            const level = Math.max(0, Math.min(1, raw));
            node.args[1] = level.toFixed(4);
            nn?.setLevel(level);
            refreshFace();
            this.graph.emit("display");
            return;
          }
        }
        break;
      }

      case "lfo~": {
        // Inlet 1 is rate CV (signal) — AudioGraph handles that, not messages.
        // Inlet 0 carries control selectors: rate <hz>, depth <v>, shape <0..1>.
        if (inlet !== 0) break;
        const lTokens = value.trim().split(/\s+/);
        const lHead   = lTokens[0] ?? "";
        const lRest   = lTokens.slice(1);
        const ln = this.audioGraph?.getLfoNode(node.id);

        if (lHead === "rate") {
          const hz = parseFloat(lRest[0] ?? "");
          if (Number.isFinite(hz)) {
            const clamped = Math.max(0.01, Math.min(20, hz));
            node.args[0] = clamped.toFixed(4);
            ln?.setRate(clamped);
            this.graph.emit("display");
          }
        } else if (lHead === "depth") {
          const d = parseFloat(lRest[0] ?? "");
          if (Number.isFinite(d)) {
            const clamped = Math.max(0, Math.min(1000, d));
            node.args[1] = clamped.toFixed(2);
            ln?.setDepth(clamped);
            this.graph.emit("display");
          }
        } else if (lHead === "shape") {
          const p = parseFloat(lRest[0] ?? "");
          if (Number.isFinite(p)) {
            const clamped = Math.max(0, Math.min(1, p));
            node.args[2] = clamped.toFixed(4);
            ln?.setShape(clamped);
            this.graph.emit("display");
          }
        }
        break;
      }

      case "transientFollower~": {
        // Inlets are both signal — AudioGraph handles audio wiring. Inlet 0
        // also accepts attribute-style selectors (attack/release/sensitivity/
        // floor <v>) so the attribute panel updates args + worklet + face
        // readouts live during drag, instead of only on commit.
        if (inlet !== 0) break;
        const tfTokens = value.trim().split(/\s+/);
        const tfHead   = tfTokens[0] ?? "";
        const tfRest   = tfTokens.slice(1);

        const APPLY: Record<string, { argIdx: number; clamp: (v: number) => number }> = {
          attack:      { argIdx: 0, clamp: (v) => Math.max(0.05, Math.min(10000, v)) },
          release:     { argIdx: 1, clamp: (v) => Math.max(0.05, Math.min(10000, v)) },
          sensitivity: { argIdx: 2, clamp: (v) => Math.max(0,    Math.min(64,    v)) },
          floor:       { argIdx: 3, clamp: (v) => Math.max(0,    Math.min(1,     v)) },
        };

        const spec = APPLY[tfHead];
        if (!spec) break;
        const raw = parseFloat(tfRest[0] ?? "");
        if (!Number.isFinite(raw)) break;

        const v = spec.clamp(raw);
        node.args[spec.argIdx] = v.toFixed(4);

        // Push live to the worklet so audio updates during drag, not only on
        // commit. setArgs reads all four args — pull them fresh from node.args
        // so prior partial edits also take effect.
        const tf = this.audioGraph?.getTransientFollowerNode(node.id);
        if (tf) {
          tf.setArgs(
            parseFloat(node.args[0] ?? "5"),
            parseFloat(node.args[1] ?? "80"),
            parseFloat(node.args[2] ?? "1"),
            parseFloat(node.args[3] ?? "0"),
          );
        }

        // Repaint just the readouts row in the face — no full re-render.
        const bodyEl = this.panGroup.querySelector<HTMLElement>(
          `[data-node-id="${node.id}"] .patch-object-body`,
        );
        if (bodyEl) refreshTransientFollowerReadouts(bodyEl, node);

        this.graph.emit("display");
        break;
      }

      case "adsr~": {
        // Inlet 0 is signal — no messages here.
        // Inlet 1 carries control: bare bang, bare float (1=gateOn, 0=gateOff),
        // or selectors `attack/decay/sustain/release <v>`.
        if (inlet !== 1) break;
        const aTokens = value.trim().split(/\s+/);
        const aHead   = aTokens[0] ?? "";
        const aRest   = aTokens.slice(1);

        const setArgAndApply = (argIdx: number, raw: number, kind: "ms" | "level") => {
          const v = kind === "level" ? Math.max(0, Math.min(1, raw)) : clampMs(raw);
          node.args[argIdx] = kind === "level" ? v.toFixed(4) : v.toFixed(2);
          const an = this.audioGraph?.getAdsrNode(node.id);
          if (an) {
            if (argIdx === 0) an.setAttack(v);
            if (argIdx === 1) an.setDecay(v);
            if (argIdx === 2) an.setSustain(v);
            if (argIdx === 3) an.setRelease(v);
            if (argIdx === 4) an.setSustainTime(v);
          }
          this.graph.emit("display");
        };

        if (aHead === "bang" || aHead === "") {
          this.audioGraph?.triggerAdsr(node.id);
        } else if (aHead === "attack") {
          const v = parseFloat(aRest[0] ?? "");
          if (Number.isFinite(v)) setArgAndApply(0, v, "ms");
        } else if (aHead === "decay") {
          const v = parseFloat(aRest[0] ?? "");
          if (Number.isFinite(v)) setArgAndApply(1, v, "ms");
        } else if (aHead === "sustain") {
          const v = parseFloat(aRest[0] ?? "");
          if (Number.isFinite(v)) setArgAndApply(2, v, "level");
        } else if (aHead === "release") {
          const v = parseFloat(aRest[0] ?? "");
          if (Number.isFinite(v)) setArgAndApply(3, v, "ms");
        } else if (aHead === "sustainTime") {
          const v = parseFloat(aRest[0] ?? "");
          if (Number.isFinite(v)) setArgAndApply(4, v, "ms");
        } else {
          const f = parseFloat(aHead);
          if (Number.isFinite(f)) {
            if (f !== 0) this.audioGraph?.gateOnAdsr(node.id);
            else         this.audioGraph?.gateOffAdsr(node.id);
          } else {
            // Unknown selector → treat as bang fallback (Max convention for
            // most one-shot triggers).
            this.audioGraph?.triggerAdsr(node.id);
          }
        }
        break;
      }

      case "buffer~": {
        const ctrlInlet = bufferControlInlet(node.args);
        const tokens    = value.trim().split(/\s+/);
        const head      = tokens[0] ?? "";
        const rest      = tokens.slice(1);
        // Parameter setters (rate / loop / maxLen / mode) accept messages on
        // any inlet, so the attribute object can wire to whichever inlet the
        // user prefers. Transport selectors stay on the control inlet only —
        // signal-rate audio on inlets 0/1 must not trigger record/play/stop.
        const PARAM_SELECTORS = new Set([
          "rate", "loop", "maxLen", "mode", "stereo", "mono", "range",
        ]);
        if (PARAM_SELECTORS.has(head)) {
          this.deliverBufferMessage(node, head, rest);
          return;
        }
        if (inlet !== ctrlInlet) return;
        // Bare float on control inlet → set rate.
        if (tokens.length === 1 && head !== "" && !isNaN(parseFloat(head))) {
          this.deliverBufferMessage(node, "float", [head]);
        } else {
          this.deliverBufferMessage(node, head, rest);
        }
        return;
      }

      case "vbuf*": {
        const VBUF_PARAMS = new Set(["rate", "loop", "maxLen", "range", "loopStart", "loopLen"]);
        const tokens = value.trim().split(/\s+/);
        const head   = tokens[0] ?? "";
        const rest   = tokens.slice(1);
        if (VBUF_PARAMS.has(head)) {
          this.deliverVideoBufferMessage(node, head, rest);
          return;
        }
        // Control inlet (1) handles transport selectors (record/play/...)
        if (inlet !== 1) return;
        if (tokens.length === 1 && head !== "" && !isNaN(parseFloat(head))) {
          this.deliverVideoBufferMessage(node, "float", [head]);
        } else {
          this.deliverVideoBufferMessage(node, head, rest);
        }
        return;
      }

      case "frame*":
        if (inlet === 0) {
          const selector = value.trim().split(/\s+/)[0] ?? "";
          const fn = this.visualizerGraph?.getFrameNode(node.id);
          if (fn) {
            // Note: 'capture' from a cable usually fails browser
            // user-activation gating — clicking the panel button is the
            // canonical path. We still try, in case the message arrived
            // synchronously from a button-click edge.
            if (selector === "release") fn.release();
            else if (selector === "capture") void fn.capture();
          }
          return;
        }
        break;

      case "cam*":
        if (inlet === 0) {
          const tokens = value.trim().split(/\s+/);
          const selector = tokens[0] ?? "";
          const wn = this.visualizerGraph?.getWebcamNode(node.id);
          if (wn) {
            if (selector === "stop") {
              wn.stop();
              if ((node.args[4] ?? "0") !== "0") { node.args[4] = "0"; this.graph.emit("change"); }
            } else if (selector === "start" || selector === "bang") {
              if (selector === "bang" && wn.isStarted) {
                wn.stop();
                if ((node.args[4] ?? "0") !== "0") { node.args[4] = "0"; this.graph.emit("change"); }
              } else {
                const deviceId = node.args[0] ?? "";
                const w = parseInt(node.args[2] ?? "0", 10) || 0;
                const h = parseInt(node.args[3] ?? "0", 10) || 0;
                void wn.start(deviceId, w, h).then(() => {
                  if (wn.isStarted && (node.args[4] ?? "0") !== "1") {
                    node.args[4] = "1"; this.graph.emit("change");
                  }
                });
              }
            } else if (selector === "device") {
              const id = tokens.slice(1).join(" ");
              if ((node.args[0] ?? "") !== id) { node.args[0] = id; this.graph.emit("change"); }
              void wn.setDevice(id);
            }
            // 'open' is a UI-only action — the panel owns the device picker.
          }
          return;
        }
        break;

      case "drunk": {
        if (inlet === 0) {
          const tokens = value.trim().split(/\s+/);
          if (tokens[0] === "set") {
            const v = Math.floor(Number(tokens[1] ?? "0"));
            if (!Number.isNaN(v)) {
              this.drunkPositions.set(node.id, v);
              node.args[2] = String(v);
              this.graph.emit("display");
            }
          } else {
            const v = Math.floor(Number(value));
            if (!Number.isNaN(v)) {
              this.drunkPositions.set(node.id, v);
              node.args[2] = String(v);
              this.dispatchValue(node.id, 0, String(v));
            }
          }
        } else if (inlet === 1) {
          const s = Math.max(1, Math.floor(Number(value)));
          if (!Number.isNaN(s)) {
            node.args[1] = String(s);
            this.graph.emit("display");
          }
        }
        break;
      }

      case "netsend":
        if (inlet === 0) {
          const topic = (node.args[0] ?? "").trim();
          this.peerRegistry?.sendFromNetSend(this.graph, topic, parseNetPayload(value));
        }
        break;

      case "netreceive":
      case "peer":
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
    this.dispatchValue(node.id, 0, msg);

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

    // Sequencer: rebuild outlets if rows changed. Cell matrix is clamped to
    // the new shape at read time, so shrinking cols truncates harmlessly.
    if (node.type === "sequencer" && (selector === "rows" || selector === "cols")) {
      this.syncSequencerPorts(node);
    }

    // During attribute drag/text-entry, emit "display" only so the text panel
    // stays in sync without triggering render(). render() destroys all DOM
    // including the currently-focused input, which loses focus and lets
    // subsequent keystrokes fall through to canvas shortcuts (Delete, letters).
    // handleAttrChange emits "change" on commit, so a full render always follows.
    this.graph.emit("display");
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

    // Dispatch live — cable-driven emits below are "display" only, so the full
    // render() isn't triggered and the slider DOM survives the drag.
    const msg = buildArgMessage(targetType, argIndex, val);
    this.dispatchValue(node.id, 0, msg);

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

  /**
   * Cable-driven toggle flip. Patches the rocker state in the DOM directly and
   * emits "display" instead of "change" so a fast upstream source (metro, fft
   * chain) doesn't cause a 60 Hz render storm. User-click path still goes
   * through `toggleNode` → "change" → render() so undo / persistence fire.
   */
  private toggleNodeFromCable(node: PatchNode): void {
    const isOn = node.args[0] !== "1";
    node.args[0] = isOn ? "1" : "0";
    this.syncToggleDisplay(node);
    this.graph.emit("display");
    this.dispatchValue(node.id, 0, isOn ? "1.0" : "0.0");
  }

  private setToggleFromValue(node: PatchNode, value: string): void {
    const parsed = Number.parseFloat(value);
    const isOn = Number.isNaN(parsed) ? value !== "0" : parsed !== 0;
    node.args[0] = isOn ? "1" : "0";
    this.syncToggleDisplay(node);
    this.graph.emit("display");
    this.dispatchValue(node.id, 0, isOn ? "1.0" : "0.0");
  }

  /** In-place DOM update for a toggle's on/off rocker without rebuilding the node. */
  private syncToggleDisplay(node: PatchNode): void {
    const isOn = node.args[0] === "1";
    for (const nodeEl of this.flashElements(node.id)) {
      const halfOn  = nodeEl.querySelector<HTMLElement>(".patch-object-toggle-half-on");
      const halfOff = nodeEl.querySelector<HTMLElement>(".patch-object-toggle-half-off");
      halfOn?.classList.toggle("patch-object-toggle-half--active", isOn);
      halfOff?.classList.toggle("patch-object-toggle-half--active", !isOn);
    }
  }

  /** Searches panGroup then each external panel for an element by nodeId. */
  private findNodeEl(nodeId: string): HTMLElement | null {
    const sel = `[data-node-id="${nodeId}"]`;
    const inPanel = this.panGroup.querySelector<HTMLElement>(sel);
    if (inPanel) return inPanel;
    for (const panel of this.externalPanels) {
      const found = panel.querySelector<HTMLElement>(sel);
      if (found) return found;
    }
    return null;
  }

  private flashButton(nodeId: string): void {
    this.activeFlashes.add(nodeId);
    this.applyFlashClass(nodeId);
    setTimeout(() => {
      this.activeFlashes.delete(nodeId);
      this.removeFlashClass(nodeId);
    }, 150);
  }

  private flashElements(nodeId: string): HTMLElement[] {
    const sel = `[data-node-id="${nodeId}"]`;
    return [
      ...this.panGroup.querySelectorAll<HTMLElement>(sel),
      ...this.externalPanels.flatMap(p => [...p.querySelectorAll<HTMLElement>(sel)]),
    ];
  }

  private applyFlashClass(nodeId: string): void {
    for (const el of this.flashElements(nodeId)) el.classList.add("patch-object--active");
  }

  private removeFlashClass(nodeId: string): void {
    for (const el of this.flashElements(nodeId)) el.classList.remove("patch-object--active");
  }

  /** Called after render() rebuilds the DOM so in-flight flash states survive. */
  reapplyTransientState(): void {
    for (const id of this.activeFlashes) this.applyFlashClass(id);
  }

  private updateSliderFromEvent(e: MouseEvent): void {
    if (!this.sliderDrag) return;
    const { node, trackEl, thumbEl } = this.sliderDrag;

    const rect = trackEl.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    node.args[0] = String(t);
    thumbEl.style.left = `${t * 100}%`;
  }

  private updateEzScaleFromEvent(e: MouseEvent): void {
    if (!this.ezScaleDrag) return;
    const { node, trackEl, which, startX, startLo, startHi } = this.ezScaleDrag;

    const outMin = parseFloat(node.args[2] ?? "0");
    const outMax = parseFloat(node.args[3] ?? "127");
    if (!isFinite(outMin) || !isFinite(outMax) || outMin === outMax) return;

    const rect = trackEl.getBoundingClientRect();
    const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");

    if (which === "range") {
      if (startX === undefined || startLo === undefined || startHi === undefined) return;
      const deltaT = (e.clientX - startX) / rect.width;
      const deltaVal = deltaT * (outMax - outMin);
      const lowBound  = Math.min(outMin, outMax);
      const highBound = Math.max(outMin, outMax);
      // Compute screen-order bounds to correctly clamp the shifted range.
      const screenLo  = Math.min(startLo, startHi);
      const screenHi  = Math.max(startLo, startHi);
      const rangeWidth = screenHi - screenLo;
      let newScreenLo = Math.max(lowBound, Math.min(highBound - rangeWidth, screenLo + deltaVal));
      const newScreenHi = newScreenLo + rangeWidth;
      let newLo = startLo <= startHi ? newScreenLo : newScreenHi;
      let newHi = startLo <= startHi ? newScreenHi : newScreenLo;
      if (intMode) { newLo = Math.round(newLo); newHi = Math.round(newHi); }
      node.args[4] = String(newLo);
      node.args[5] = String(newHi);

      const objectEl = trackEl.closest<HTMLElement>(".patch-object");
      const fillEl   = objectEl?.querySelector<HTMLElement>(".pn-ezscale__fill");
      const thumbLoEl = objectEl?.querySelector<HTMLElement>('.pn-ezscale__thumb[data-ezscale-thumb="lo"]');
      const thumbHiEl = objectEl?.querySelector<HTMLElement>('.pn-ezscale__thumb[data-ezscale-thumb="hi"]');
      const span = outMax - outMin;
      const pctOf = (v: number) => Math.max(0, Math.min(1, (v - outMin) / span)) * 100;
      const loPct = pctOf(newLo);
      const hiPct = pctOf(newHi);
      if (thumbLoEl) thumbLoEl.style.left = `${loPct}%`;
      if (thumbHiEl) thumbHiEl.style.left = `${hiPct}%`;
      if (fillEl) {
        fillEl.style.left  = `${Math.min(loPct, hiPct)}%`;
        fillEl.style.right = `${100 - Math.max(loPct, hiPct)}%`;
      }
      const edgeLo = objectEl?.querySelector<HTMLElement>(".pn-ezscale__edge-label--lo");
      const edgeHi = objectEl?.querySelector<HTMLElement>(".pn-ezscale__edge-label--hi");
      if (edgeLo) edgeLo.textContent = formatThumbValue(newLo, intMode);
      if (edgeHi) edgeHi.textContent = formatThumbValue(newHi, intMode);
      this.dispatchEzScaleRange(node);
      this.graph.emit("display");
      return;
    }

    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let raw = outMin + t * (outMax - outMin);

    if (intMode) raw = Math.round(raw);

    // Clamp lo ≤ hi (and respect min/max ordering: outMin may exceed outMax)
    const otherIdx = which === "lo" ? 5 : 4;
    const otherVal = parseFloat(node.args[otherIdx] ?? (which === "lo" ? String(outMax) : String(outMin)));
    const lowSide  = Math.min(outMin, outMax);
    const highSide = Math.max(outMin, outMax);
    const clampedToBounds = Math.max(lowSide, Math.min(highSide, raw));

    let next: number;
    if (which === "lo") {
      // outMin → outMax order: if outMin < outMax, lo handle stays ≤ hi handle
      if (outMin <= outMax) next = Math.min(clampedToBounds, otherVal);
      else                  next = Math.max(clampedToBounds, otherVal);
    } else {
      if (outMin <= outMax) next = Math.max(clampedToBounds, otherVal);
      else                  next = Math.min(clampedToBounds, otherVal);
    }

    const argIdx = which === "lo" ? 4 : 5;
    node.args[argIdx] = intMode ? String(Math.round(next)) : String(next);

    // Update DOM in-place for snappy drag (full re-render fires on mouseup via emit("change"))
    const objectEl = trackEl.closest<HTMLElement>(".patch-object");
    const fillEl   = objectEl?.querySelector<HTMLElement>(".pn-ezscale__fill");
    const thumbLo  = objectEl?.querySelector<HTMLElement>('.pn-ezscale__thumb[data-ezscale-thumb="lo"]');
    const thumbHi  = objectEl?.querySelector<HTMLElement>('.pn-ezscale__thumb[data-ezscale-thumb="hi"]');
    const span = outMax - outMin;
    const pctOf = (v: number) => Math.max(0, Math.min(1, (v - outMin) / span)) * 100;
    const loPct = pctOf(parseFloat(node.args[4] ?? String(outMin)));
    const hiPct = pctOf(parseFloat(node.args[5] ?? String(outMax)));
    if (thumbLo) thumbLo.style.left = `${loPct}%`;
    if (thumbHi) thumbHi.style.left = `${hiPct}%`;
    if (fillEl) {
      fillEl.style.left  = `${Math.min(loPct, hiPct)}%`;
      fillEl.style.right = `${100 - Math.max(loPct, hiPct)}%`;
    }
    const edgeLo = objectEl?.querySelector<HTMLElement>(".pn-ezscale__edge-label--lo");
    const edgeHi = objectEl?.querySelector<HTMLElement>(".pn-ezscale__edge-label--hi");
    if (edgeLo) edgeLo.textContent = formatThumbValue(parseFloat(node.args[4] ?? String(outMin)), intMode);
    if (edgeHi) edgeHi.textContent = formatThumbValue(parseFloat(node.args[5] ?? String(outMax)), intMode);
    this.dispatchEzScaleRange(node);
    this.graph.emit("display");
  }

  private updateEzSliderFromEvent(e: MouseEvent): void {
    if (!this.ezSliderDrag) return;
    const { node, trackEl } = this.ezSliderDrag;

    const rect = trackEl.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    node.args[2] = String(t);

    const thumbEl = trackEl.querySelector<HTMLElement>(".pn-ezslider__thumb");
    if (thumbEl) thumbEl.style.left = `${t * 100}%`;

    this.dispatchEzSliderOutput(node);
    this.graph.emit("display");
  }

  private dispatchEzSliderOutput(node: PatchNode): void {
    const lo = parseFloat(node.args[0] ?? "");
    const hi = parseFloat(node.args[1] ?? "");
    const t  = parseFloat(node.args[2] ?? "0.5");
    if (!isFinite(lo) || !isFinite(hi)) return;
    const intMode = isIntForm(node.args[0] ?? "") && isIntForm(node.args[1] ?? "");
    const result = lo + t * (hi - lo);
    this.dispatchValue(node.id, 0, formatScaled(result, intMode));
  }

  private dispatchEzScaleRange(node: PatchNode): void {
    const outMin = parseFloat(node.args[2] ?? "");
    const outMax = parseFloat(node.args[3] ?? "");
    if (!isFinite(outMin) || !isFinite(outMax)) return;
    const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");
    const f = (i: number, def: number) => { const n = parseFloat(node.args[i] ?? ""); return isNaN(n) ? def : n; };
    const lo = f(4, outMin);
    const hi = f(5, outMax);
    const fmt = (v: number) => intMode ? String(Math.round(v)) : String(v);
    this.dispatchValue(node.id, 1, `${fmt(lo)} ${fmt(hi)}`);
  }

  /** Reposition the ezScale active-range thumbs, fill, and edge labels from
   *  the node's current args[2..5] (outMin, outMax, outLo, outHi). Skips work
   *  if the object isn't in the DOM yet. Used by the drag handler and any
   *  cold-inlet path that mutates the active range without triggering a full
   *  re-render. */
  private syncEzScaleSliderVisuals(node: PatchNode): void {
    const outMin = parseFloat(node.args[2] ?? "");
    const outMax = parseFloat(node.args[3] ?? "");
    if (!isFinite(outMin) || !isFinite(outMax) || outMin === outMax) return;
    const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");
    const objectEl = this.panGroup.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
    if (!objectEl) return;
    const fillEl   = objectEl.querySelector<HTMLElement>(".pn-ezscale__fill");
    const thumbLo  = objectEl.querySelector<HTMLElement>('.pn-ezscale__thumb[data-ezscale-thumb="lo"]');
    const thumbHi  = objectEl.querySelector<HTMLElement>('.pn-ezscale__thumb[data-ezscale-thumb="hi"]');
    const span = outMax - outMin;
    const pctOf = (v: number) => Math.max(0, Math.min(1, (v - outMin) / span)) * 100;
    const lo = parseFloat(node.args[4] ?? String(outMin));
    const hi = parseFloat(node.args[5] ?? String(outMax));
    const loPct = pctOf(lo);
    const hiPct = pctOf(hi);
    if (thumbLo) thumbLo.style.left = `${loPct}%`;
    if (thumbHi) thumbHi.style.left = `${hiPct}%`;
    if (fillEl) {
      fillEl.style.left  = `${Math.min(loPct, hiPct)}%`;
      fillEl.style.right = `${100 - Math.max(loPct, hiPct)}%`;
    }
    const edgeLo = objectEl.querySelector<HTMLElement>(".pn-ezscale__edge-label--lo");
    const edgeHi = objectEl.querySelector<HTMLElement>(".pn-ezscale__edge-label--hi");
    if (edgeLo) edgeLo.textContent = formatThumbValue(lo, intMode);
    if (edgeHi) edgeHi.textContent = formatThumbValue(hi, intMode);
  }

  /** Auto-mode: expand inMin/inMax to include the latest observed input.
   *  Mutates args + the input fields in-place and emits "display" so the text
   *  panel stays in sync without paying for a full DOM rebuild on every value. */
  private applyEzScaleAutoInput(node: PatchNode, input: number): void {
    let changed = false;
    const curMin = parseFloat(node.args[0] ?? "");
    const curMax = parseFloat(node.args[1] ?? "");
    if (!isFinite(curMin) || input < curMin) { node.args[0] = String(input); changed = true; }
    if (!isFinite(curMax) || input > curMax) { node.args[1] = String(input); changed = true; }
    if (!changed) return;
    const objectEl = this.panGroup.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
    const minField = objectEl?.querySelector<HTMLInputElement>('input[data-ezscale-field="inMin"]');
    const maxField = objectEl?.querySelector<HTMLInputElement>('input[data-ezscale-field="inMax"]');
    if (minField && document.activeElement !== minField) minField.value = node.args[0];
    if (maxField && document.activeElement !== maxField) maxField.value = node.args[1];
    this.graph.emit("display");
  }

  /** Walk outgoing edges from (fromNodeId, fromOutlet), transparently hopping
   *  through `s`/`r` channels so output auto-range can see the real downstream
   *  targets even when the patch routes through wireless sends. Depth-limited
   *  and visited-tracked to avoid loops. */
  private walkToActualTargets(
    fromNodeId: string,
    fromOutlet: number,
    depth: number,
    visited: Set<string>,
  ): Array<{ node: PatchNode; toInlet: number }> {
    if (depth > 5) return [];
    const out: Array<{ node: PatchNode; toInlet: number }> = [];
    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId !== fromNodeId || edge.fromOutlet !== fromOutlet) continue;
      const target = this.graph.nodes.get(edge.toNodeId);
      if (!target) continue;
      if (target.type === "s") {
        const channel = target.args[0] ?? "";
        if (!channel) continue;
        for (const r of this.graph.getNodes()) {
          if (r.type !== "r" || (r.args[0] ?? "") !== channel) continue;
          if (visited.has(r.id)) continue;
          visited.add(r.id);
          out.push(...this.walkToActualTargets(r.id, 0, depth + 1, visited));
        }
      } else {
        out.push({ node: target, toInlet: edge.toInlet });
      }
    }
    return out;
  }

  /** Auto-mode: when an ezScale's outlet is connected, copy the target inlet's
   *  arg min/max into outMin/outMax (and reset the active sub-range to span the
   *  full bounds). Idempotent — safe to call from the graph "change" handler. */
  private syncEzScaleAutoOutput(): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "ezScale") continue;
      if ((node.args[6] ?? "1") === "0") continue;

      const targets = this.walkToActualTargets(node.id, 0, 0, new Set([node.id]));
      let resolved: { min: number; max: number; isFloat: boolean } | null = null;
      for (const { node: t, toInlet } of targets) {
        resolved = this.resolveTargetArgRange(t, toInlet);
        if (resolved) break;
      }
      if (!resolved) continue;
      const range = resolved;

      // Format in int-form ("0", "4") only when the target arg is int-typed.
      // Float args render as "0.0" / "4.0" so the int-mode rule doesn't round
      // float-domain outputs (e.g. vbuf* rate 0..4).
      const fmt = (n: number) => {
        if (range.isFloat) return Number.isInteger(n) ? `${n}.0` : String(n);
        return String(n);
      };
      // Honor the user's inverted flag so [auto] doesn't keep undoing manual inversion.
      const inverted = (node.args[10] ?? "0") === "1";
      const newMin = inverted ? fmt(range.max) : fmt(range.min);
      const newMax = inverted ? fmt(range.min) : fmt(range.max);
      if (node.args[2] === newMin && node.args[3] === newMax) continue;
      node.args[2] = newMin;
      node.args[3] = newMax;
      // Reset active sub-range to span the new full bounds.
      node.args[4] = newMin;
      node.args[5] = newMax;
    }
  }

  /** Auto-mode: when an ezScale's hot inlet has an upstream whose outlet
   *  exposes a known numeric range, copy those bounds into inMin/inMax.
   *  Symmetric to syncEzScaleAutoOutput. Skipped when no source advertises a
   *  range — the runtime learn-from-values path in applyEzScaleAutoInput
   *  takes over for those cases. */
  private syncEzScaleAutoInput(): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "ezScale") continue;
      if ((node.args[6] ?? "1") === "0") continue;

      const sources = this.walkFromActualSources(node.id, 0, 0, new Set([node.id]));
      let resolved: { min: number; max: number; isFloat: boolean } | null = null;
      for (const { node: s, fromOutlet } of sources) {
        resolved = this.resolveSourceOutletRange(s, fromOutlet);
        if (resolved) break;
      }
      if (!resolved) continue;
      const range = resolved;
      const fmt = (n: number) => {
        if (range.isFloat) return Number.isInteger(n) ? `${n}.0` : String(n);
        return String(n);
      };
      const newMin = fmt(range.min);
      const newMax = fmt(range.max);
      if (node.args[0] === newMin && node.args[1] === newMax) continue;
      node.args[0] = newMin;
      node.args[1] = newMax;
    }
  }

  /** Walk incoming edges into (toNodeId, toInlet), transparently hopping
   *  through `r` ← `s` channels so input auto-range can see the real upstream
   *  sources even when the patch routes through wireless sends. Mirror of
   *  walkToActualTargets. */
  private walkFromActualSources(
    toNodeId: string,
    toInlet: number,
    depth: number,
    visited: Set<string>,
  ): Array<{ node: PatchNode; fromOutlet: number }> {
    if (depth > 5) return [];
    const out: Array<{ node: PatchNode; fromOutlet: number }> = [];
    for (const edge of this.graph.getEdges()) {
      if (edge.toNodeId !== toNodeId || edge.toInlet !== toInlet) continue;
      const source = this.graph.nodes.get(edge.fromNodeId);
      if (!source) continue;
      if (source.type === "r") {
        const channel = source.args[0] ?? "";
        if (!channel) continue;
        for (const s of this.graph.getNodes()) {
          if (s.type !== "s" || (s.args[0] ?? "") !== channel) continue;
          if (visited.has(s.id)) continue;
          visited.add(s.id);
          out.push(...this.walkFromActualSources(s.id, 0, depth + 1, visited));
        }
      } else {
        out.push({ node: source, fromOutlet: edge.fromOutlet });
      }
    }
    return out;
  }

  /** Known numeric range of `source`'s outlet `fromOutlet`, or null if the
   *  source doesn't advertise one. Extension point for future bounded sources
   *  (e.g. counter, random) — add a case here. */
  private resolveSourceOutletRange(source: PatchNode, fromOutlet: number): { min: number; max: number; isFloat: boolean } | null {
    if (source.type === "drunk" && fromOutlet === 0) {
      const raw = source.args[0] ?? "";
      const fallback = OBJECT_DEFS["drunk"]?.args[0]?.default ?? "";
      const max = parseInt(raw !== "" ? raw : fallback, 10);
      if (!Number.isFinite(max) || max <= 0) return null;
      return { min: 0, max: max - 1, isFloat: false };
    }
    return null;
  }

  /** Find the min/max of the arg/slider/param controlled by `toInlet` on `target`.
   *  - `attribute` node → inlet i = visible arg i of its target type.
   *  - `js~` node → side-inlets (index ≥ JS_EFFECT_SIDE_INLET_START) map to JSFX sliders, which carry min/max.
   *  - `reaperVideo*` node → side-inlets map to @param declarations, which carry min/max.
   *  - Otherwise, look up the inlet's port via the target spec; fall back to the first non-hidden arg with min/max.
   *  `isFloat` lets the caller render bounds in float-form so the int-mode output rule doesn't kick in. */
  private resolveTargetArgRange(target: PatchNode, toInlet: number): { min: number; max: number; isFloat: boolean } | null {
    if (target.type === "attribute") {
      const targetType = target.args[0] ?? "";
      const def = OBJECT_DEFS[targetType];
      if (!def) return null;
      const visible = getVisibleArgs(def);
      const arg = visible[toInlet];
      if (arg && Number.isFinite(arg.min) && Number.isFinite(arg.max)) {
        return { min: arg.min as number, max: arg.max as number, isFloat: arg.type === "float" };
      }
      return null;
    }
    if (target.type === "js~") {
      const idx = toInlet - JS_EFFECT_SIDE_INLET_START;
      if (idx < 0) return null;
      const slider = extractJsEffectSliders(target.args[0] ?? "")[idx];
      if (slider && Number.isFinite(slider.min) && Number.isFinite(slider.max)) {
        // JSFX sliders are float-valued (step may be ≥1, but the runtime uses floats throughout).
        return { min: slider.min, max: slider.max, isFloat: true };
      }
      return null;
    }
    if (target.type === "reaperVideo*") {
      const port = target.inlets.find(p => p.index === toInlet);
      if (!port || port.side !== "left") return null;
      const params = extractReaperVideoParams(target.args[0] ?? "");
      const sideInlets = target.inlets.filter(p => p.side === "left").sort((a, b) => a.index - b.index);
      const sideIdx = sideInlets.findIndex(p => p.index === toInlet);
      const param = sideIdx >= 0 ? params[sideIdx] : undefined;
      if (param && Number.isFinite(param.min) && Number.isFinite(param.max)) {
        return { min: param.min, max: param.max, isFloat: true };
      }
      return null;
    }
    const def = OBJECT_DEFS[target.type];
    if (!def) return null;
    for (const arg of def.args) {
      if (arg.hidden) continue;
      if (Number.isFinite(arg.min) && Number.isFinite(arg.max)) {
        return { min: arg.min as number, max: arg.max as number, isFloat: arg.type === "float" };
      }
    }
    return null;
  }

  /** Commit an ezScale field edit (called from focusout / Enter). Validates the
   *  parsed value, writes it to args, and clamps the active range when bounds
   *  shrink or the int/float mode flips. */
  private commitEzSliderField(input: HTMLInputElement): void {
    const objectEl = input.closest<HTMLElement>(".patch-object");
    const node = objectEl ? this.getNode(objectEl) : null;
    if (!node || node.type !== "ezSlider") return;

    const fieldKey = input.dataset.ezsliderField ?? "";
    const argIdx = fieldKey === "lo" ? 0 : fieldKey === "hi" ? 1 : -1;
    if (argIdx < 0) return;

    const raw = input.value.trim();
    const parsed = parseFloat(raw);
    if (!isFinite(parsed)) {
      input.value = node.args[argIdx] ?? "";
      return;
    }

    if (node.args[argIdx] === raw) return;
    node.args[argIdx] = raw;

    const track = objectEl?.querySelector<HTMLElement>(".pn-ezslider__track");
    const thumb = objectEl?.querySelector<HTMLElement>(".pn-ezslider__thumb");
    const lo = parseFloat(node.args[0] ?? "");
    const hi = parseFloat(node.args[1] ?? "");
    const boundsReady = isFinite(lo) && isFinite(hi);
    if (track) track.classList.toggle("pn-ezslider__track--inert", !boundsReady);
    if (thumb) thumb.style.display = boundsReady ? "" : "none";

    this.graph.emit("change");
  }

  private commitEzScaleField(input: HTMLInputElement): void {
    const objectEl = input.closest<HTMLElement>(".patch-object");
    const node = objectEl ? this.getNode(objectEl) : null;
    if (!node || node.type !== "ezScale") return;

    const fieldKey = input.dataset.ezscaleField ?? "";
    const argIdx = ({ inMin: 0, inMax: 1, outMin: 2, outMax: 3, mult: 7 } as Record<string, number>)[fieldKey];
    if (argIdx === undefined) return;

    const raw = input.value.trim();
    const parsed = parseFloat(raw);
    if (!isFinite(parsed)) {
      // Invalid → revert to stored value
      input.value = node.args[argIdx] ?? "";
      return;
    }

    // Preserve int-form vs float-form: respect what the user typed.
    const newStr = raw;
    const prev = node.args[argIdx];
    if (prev === newStr) return;
    node.args[argIdx] = newStr;

    // If output bounds changed, re-canonicalize outLo/outHi to match the new
    // mode and clamp them back inside [outMin, outMax].
    if (argIdx === 2 || argIdx === 3) {
      const outMin = parseFloat(node.args[2] ?? "0");
      const outMax = parseFloat(node.args[3] ?? "127");
      const intMode = isIntForm(node.args[2] ?? "") && isIntForm(node.args[3] ?? "");
      const lowSide  = Math.min(outMin, outMax);
      const highSide = Math.max(outMin, outMax);
      const clampSide = (v: number) => Math.max(lowSide, Math.min(highSide, v));

      let lo = parseFloat(node.args[4] ?? String(outMin));
      let hi = parseFloat(node.args[5] ?? String(outMax));
      if (!isFinite(lo)) lo = outMin;
      if (!isFinite(hi)) hi = outMax;
      lo = clampSide(lo);
      hi = clampSide(hi);

      node.args[4] = intMode ? String(Math.round(lo)) : canonicalizeBound(String(lo), false);
      node.args[5] = intMode ? String(Math.round(hi)) : canonicalizeBound(String(hi), false);
    }

    this.graph.emit("change");
  }

  private handleSliderMove(e: MouseEvent): void {
    if (this.sliderDrag) {
      this.updateSliderFromEvent(e);
      this.dispatchValue(this.sliderDrag.node.id, 0, this.getSliderValue(this.sliderDrag.node));
    } else if (this.ezScaleDrag) {
      this.updateEzScaleFromEvent(e);
    } else if (this.ezSliderDrag) {
      this.updateEzSliderFromEvent(e);
    } else if (this.numboxDrag) {
      // Don't promote tiny pointer jitter into a value change. Without this
      // gate, a 1px wiggle during a click rebuilds the .pn-odo-col DOM and
      // kills the dblclick that opens inline numeric entry.
      if (!this.numboxDrag.moved && Math.abs(e.clientY - this.numboxDrag.startY) <= this.DRAG_THRESHOLD) return;
      this.numboxDrag.moved = true;
      this.updateNumboxFromEvent(e);
    } else if (this.bufWaveDrag) {
      this.updateBufWaveDragFromEvent(e);
    } else if (this.vbufStripDrag) {
      this.updateVbufStripDragFromEvent(e);
    } else if (this.waveKnobDrag) {
      this.updateWaveKnobFromEvent(e);
    } else if (this.lfoKnobDrag) {
      this.updateLfoKnobFromEvent(e);
    } else if (this.adsrHandleDrag) {
      this.updateAdsrHandleFromEvent(e);
    }
  }

  private handleSliderUp(e: MouseEvent): void {
    // Don't gate on `e.button !== 0`: a stuck slider drag (cursor glued to
    // a thumb, no change event ever fires, and so the new lo/hi values never
    // get persisted to localStorage) is much worse than ending a drag early
    // on a stray middle/right release. Drag-start paths are gated on button 0,
    // so any mouseup arriving mid-drag is from a real release.
    //
    // Listener teardown is handled by the dragSession that wrapped the
    // mousedown that started this drag — we just commit state here.
    if (this.sliderDrag) {
      const { node } = this.sliderDrag;
      this.updateSliderFromEvent(e);
      this.graph.emit("change");
      this.dispatchValue(node.id, 0, this.getSliderValue(node));
      this.sliderDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.ezScaleDrag) {
      this.updateEzScaleFromEvent(e);
      this.graph.emit("change");
      this.ezScaleDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.ezSliderDrag) {
      const { node } = this.ezSliderDrag;
      this.updateEzSliderFromEvent(e);
      this.graph.emit("change");
      this.dispatchEzSliderOutput(node);
      this.ezSliderDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.numboxDrag) {
      const { node, moved } = this.numboxDrag;
      // Sub-threshold release = click, not drag. Skip the value update (which
      // re-creates .pn-odo-col children) and the change-emit (which rebuilds
      // the object DOM). Either would replace the click target between the
      // two clicks of a double-click, suppressing dblclick — and dblclick is
      // how integer/float open inline numeric entry on the digits.
      if (moved) {
        this.updateNumboxFromEvent(e);
        this.graph.emit("change");
        this.dispatchValue(node.id, 0, node.args[0] ?? "0");
      }
      this.numboxDrag = null;
      document.body.classList.remove("pn-state-numbox-drag");
    } else if (this.bufWaveDrag) {
      this.completeBufWaveDrag(e);
    } else if (this.vbufStripDrag) {
      this.completeVbufStripDrag(e);
    } else if (this.waveKnobDrag) {
      this.updateWaveKnobFromEvent(e);
      this.graph.emit("change");
      this.waveKnobDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.lfoKnobDrag) {
      this.updateLfoKnobFromEvent(e);
      this.graph.emit("change");
      this.lfoKnobDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.adsrHandleDrag) {
      this.updateAdsrHandleFromEvent(e);
      this.graph.emit("change");
      this.adsrHandleDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    }
  }

  /**
   * Recovery commit when a drag ends without a real mouseup (window blur,
   * Escape pressed). Mirrors `handleSliderUp` but skips the
   * `update*FromEvent(e)` step — there is no fresh event, and the most
   * recent value is already reflected in the drag state from the last
   * mousemove. We still emit `change` and dispatch so localStorage persists
   * the value and downstream listeners observe the final state.
   */
  private cancelWidgetDrag(): void {
    if (this.sliderDrag) {
      const { node } = this.sliderDrag;
      this.graph.emit("change");
      this.dispatchValue(node.id, 0, this.getSliderValue(node));
      this.sliderDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.ezScaleDrag) {
      this.graph.emit("change");
      this.ezScaleDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.ezSliderDrag) {
      const { node } = this.ezSliderDrag;
      this.graph.emit("change");
      this.dispatchEzSliderOutput(node);
      this.ezSliderDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.numboxDrag) {
      const { node } = this.numboxDrag;
      this.graph.emit("change");
      this.dispatchValue(node.id, 0, node.args[0] ?? "0");
      this.numboxDrag = null;
      document.body.classList.remove("pn-state-numbox-drag");
    } else if (this.bufWaveDrag) {
      this.completeBufWaveDrag(new MouseEvent("mouseup"));
    } else if (this.vbufStripDrag) {
      this.completeVbufStripDrag(new MouseEvent("mouseup"));
    } else if (this.waveKnobDrag) {
      this.graph.emit("change");
      this.waveKnobDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.lfoKnobDrag) {
      this.graph.emit("change");
      this.lfoKnobDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    } else if (this.adsrHandleDrag) {
      this.graph.emit("change");
      this.adsrHandleDrag = null;
      document.body.classList.remove("pn-state-slider-drag");
    }
  }

  /**
   * Start the shared mousemove/mouseup session for the slider/numbox/buf/vbuf
   * widget-drag family. Replaces the older `document.addEventListener` pair —
   * always pairs with a `window.blur` and `Escape` recovery hook so a missed
   * mouseup can't strand the drag with the cursor glued to a thumb.
   */
  private startWidgetDragSession(): void {
    this.currentDragSession?.end();
    this.currentDragSession = startDragSession({
      onMove:   (e) => this.handleSliderMove(e),
      onUp:     (e) => { this.handleSliderUp(e); this.currentDragSession = null; },
      onCancel: ()  => { this.cancelWidgetDrag(); this.currentDragSession = null; },
    });
  }

  private updateWaveKnobFromEvent(e: MouseEvent): void {
    if (!this.waveKnobDrag) return;
    const { node, knob, knobEl, startY, startFrac } = this.waveKnobDrag;
    // Vertical drag: 240 px ≈ full 0..1 sweep. Shift = 5× finer.
    const sensitivity = e.shiftKey ? 1 / 1200 : 1 / 240;
    const dy = e.clientY - startY;
    const frac = Math.max(0, Math.min(1, startFrac - dy * sensitivity));
    const value = waveKnobValueFromFraction(knob, frac);

    const argIdx = knob === "freq" ? 0 : knob === "morph" ? 1 : 2;
    // Persist the raw float — args are strings on the wire. Trim freq to 2dp,
    // morph/level to 4dp so saved patches round-trip without trailing noise.
    node.args[argIdx] = knob === "freq"
      ? value.toFixed(2)
      : value.toFixed(4);

    const wn = this.audioGraph?.getWaveNode(node.id);
    if (wn) {
      if (knob === "freq")  wn.setFreq(value);
      if (knob === "morph") wn.setMorph(value);
      if (knob === "level") wn.setLevel(value);
    }

    this.refreshWaveKnobDom(knobEl, knob, value, frac);
  }

  private refreshWaveKnobDom(
    knobEl: HTMLElement,
    knob: "freq" | "morph" | "level",
    value: number,
    frac: number,
  ): void {
    knobEl.dataset.waveFrac  = frac.toFixed(4);
    knobEl.dataset.waveValue = String(value);
    const pointer = knobEl.querySelector<SVGElement>(".pn-wave-knob__pointer");
    if (pointer) {
      const angleDeg = -135 + frac * 270;
      pointer.setAttribute("transform", `rotate(${angleDeg.toFixed(2)} 16 16)`);
    }
    const readout = knobEl.querySelector<HTMLElement>(".pn-wave-knob__value");
    if (readout) {
      readout.textContent =
        knob === "freq"  ? formatFreq(value) :
        knob === "morph" ? formatMorph(value) :
                           formatLevel(value);
    }
  }

  private updateLfoKnobFromEvent(e: MouseEvent): void {
    if (!this.lfoKnobDrag) return;
    const { node, knob, knobEl, startY, startFrac } = this.lfoKnobDrag;
    const sensitivity = e.shiftKey ? 1 / 1200 : 1 / 240;
    const dy = e.clientY - startY;
    const frac = Math.max(0, Math.min(1, startFrac - dy * sensitivity));
    const value = lfoKnobValueFromFraction(knob, frac);

    const argIdx = knob === "rate" ? 0 : knob === "depth" ? 1 : 2;
    node.args[argIdx] = knob === "rate"
      ? value.toFixed(4)
      : knob === "depth"
      ? value.toFixed(2)
      : value.toFixed(4);

    const ln = this.audioGraph?.getLfoNode(node.id);
    if (ln) {
      if (knob === "rate")  ln.setRate(value);
      if (knob === "depth") ln.setDepth(value);
      if (knob === "shape") ln.setShape(value);
    }

    this.refreshLfoKnobDom(knobEl, knob, value, frac);
  }

  private refreshLfoKnobDom(
    knobEl: HTMLElement,
    knob: "rate" | "depth" | "shape",
    value: number,
    frac: number,
  ): void {
    knobEl.dataset.lfoFrac  = frac.toFixed(4);
    knobEl.dataset.lfoValue = String(value);
    const pointer = knobEl.querySelector<SVGElement>(".pn-lfo-knob__pointer");
    if (pointer) {
      const angleDeg = -135 + frac * 270;
      pointer.setAttribute("transform", `rotate(${angleDeg.toFixed(2)} 16 16)`);
    }
    const readout = knobEl.querySelector<HTMLElement>(".pn-lfo-knob__value");
    if (readout) {
      readout.textContent =
        knob === "rate"  ? formatRate(value) :
        knob === "depth" ? formatDepth(value) :
                           formatShape(value);
    }
  }

  private updateAdsrHandleFromEvent(e: MouseEvent): void {
    const drag = this.adsrHandleDrag;
    if (!drag) return;
    const dxCss = e.clientX - drag.startMouseX;
    const dyCss = e.clientY - drag.startMouseY;
    // Map CSS pixels → SVG units → ms / amplitude.
    const dxSvg = dxCss * drag.svgPxPerCssPx;
    const dyPxYRaw = (drag as unknown as { svgPxPerCssPxY?: number }).svgPxPerCssPxY;
    const svgPxPerCssPxY = dyPxYRaw ?? drag.svgPxPerCssPx;
    const dySvg = dyCss * svgPxPerCssPxY;
    const dMs = dxSvg * drag.msPerSvgPx;

    let a  = drag.startA;
    let d  = drag.startD;
    let s  = drag.startSustain;
    let r  = drag.startR;
    let sh = drag.startSustainTime;

    if (drag.handle === "attack") {
      a = clampMs(drag.startA + dMs);
    } else if (drag.handle === "decay") {
      d = clampMs(drag.startD + dMs);
    } else if (drag.handle === "sustainEnd") {
      sh = clampMs(drag.startSustainTime + dMs);
      const ySpan = ADSR_BOTTOM - ADSR_TOP;
      s = Math.max(0, Math.min(1, drag.startSustain - dySvg / ySpan));
    } else {
      r = clampMs(drag.startR + dMs);
    }

    drag.node.args[0] = a.toFixed(2);
    drag.node.args[1] = d.toFixed(2);
    drag.node.args[2] = s.toFixed(4);
    drag.node.args[3] = r.toFixed(2);
    drag.node.args[4] = sh.toFixed(2);

    const an = this.audioGraph?.getAdsrNode(drag.node.id);
    if (an) {
      if (drag.handle === "attack")     an.setAttack(a);
      if (drag.handle === "decay")      an.setDecay(d);
      if (drag.handle === "sustainEnd") { an.setSustainTime(sh); an.setSustain(s); }
      if (drag.handle === "release")    an.setRelease(r);
    }

    refreshAdsrEditorDom(drag.svgEl, drag.node);
  }

  private updateBufWaveDragFromEvent(e: MouseEvent): void {
    if (!this.bufWaveDrag) return;
    const { canvas } = this.bufWaveDrag;
    const rect = canvas.getBoundingClientRect();
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.bufWaveDrag.endNorm = norm;
    // Stash the live selection on the canvas dataset; drawBufferWaveform
    // reads it as an overlay until cleared on mouseup.
    const a = Math.min(this.bufWaveDrag.startNorm, norm);
    const b = Math.max(this.bufWaveDrag.startNorm, norm);
    canvas.dataset.bufSelection = `${a},${b}`;
    this.bufferRedraw?.(this.bufWaveDrag.node.id);
  }

  private completeBufWaveDrag(_e: MouseEvent): void {
    if (!this.bufWaveDrag) return;
    const { node, canvas, startNorm, endNorm, shift } = this.bufWaveDrag;
    this.bufWaveDrag = null;
    const a = Math.min(startNorm, endNorm);
    const b = Math.max(startNorm, endNorm);
    const span = b - a;
    delete canvas.dataset.bufSelection;

    const rs = parseFloat(node.args[10] ?? "");
    const re = parseFloat(node.args[11] ?? "");
    const hasRange = Number.isFinite(rs) && Number.isFinite(re) && re > rs;

    // Click (no real drag): if it lands inside the existing highlighted
    // range, play from there to range end (highlight stays). If it lands
    // outside, clear the highlight and play from there to end of buffer.
    if (span < 0.005) {
      if (hasRange && a >= rs && a < re) {
        this.deliverBufferMessage(node, "play", [String(a), String(re)]);
      } else {
        if (hasRange) this.deliverBufferMessage(node, "range", ["0", "0"]);
        this.deliverBufferMessage(node, "play", [String(a)]);
      }
      this.bufferRedraw?.(node.id);
      return;
    }

    // Drag (with or without shift): commit a persistent range so the
    // highlight survives stop / mode change. Plain drag also kicks off
    // playback within that range; shift-drag is range-only (no play).
    this.deliverBufferMessage(node, "range", [String(a), String(b)]);
    if (!shift) this.deliverBufferMessage(node, "play", [String(a), String(b)]);
  }

  private updateVbufStripDragFromEvent(e: MouseEvent): void {
    if (!this.vbufStripDrag) return;
    const { node, canvas } = this.vbufStripDrag;
    const rect = canvas.getBoundingClientRect();
    const norm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.vbufStripDrag.endNorm = norm;
    // Live overlay — drawVbufStrip's rAF loop reads from the controller-owned
    // map on every tick, so it survives DOM rebuilds caused by emit("change").
    const a = Math.min(this.vbufStripDrag.startNorm, norm);
    const b = Math.max(this.vbufStripDrag.startNorm, norm);
    this.vbufLiveSelection.set(node.id, [a, b]);
  }

  private completeVbufStripDrag(_e: MouseEvent): void {
    if (!this.vbufStripDrag) return;
    const { node, startNorm, endNorm, shift } = this.vbufStripDrag;
    this.vbufStripDrag = null;
    const a = Math.min(startNorm, endNorm);
    const b = Math.max(startNorm, endNorm);
    const span = b - a;
    this.vbufLiveSelection.delete(node.id);

    const rs = parseFloat(node.args[6] ?? "");
    const re = parseFloat(node.args[7] ?? "");
    const hasRange = Number.isFinite(rs) && Number.isFinite(re) && re > rs;

    // Click (no real drag): inside existing highlight → play from click to
    // range end (highlight stays); outside → clear highlight + play from click.
    if (span < 0.005) {
      if (hasRange && a >= rs && a < re) {
        this.deliverVideoBufferMessage(node, "play", [String(a), String(re)]);
      } else {
        if (hasRange) this.deliverVideoBufferMessage(node, "range", ["0", "0"]);
        this.deliverVideoBufferMessage(node, "play", [String(a)]);
      }
      return;
    }

    // Drag: commit persistent range. Plain drag also plays within the range;
    // shift-drag is range-only.
    this.deliverVideoBufferMessage(node, "range", [String(a), String(b)]);
    if (!shift) this.deliverVideoBufferMessage(node, "play", [String(a), String(b)]);
  }

  private updateNumboxFromEvent(e: MouseEvent): void {
    if (!this.numboxDrag) return;
    const { node, el, startY, startValue, increment, isFloat, activePlace } = this.numboxDrag;

    const deltaY = startY - e.clientY; // up = positive = increase
    const raw = startValue + deltaY * increment;
    const value = isFloat ? raw : Math.round(raw);

    node.args[0] = String(value);
    buildOdometerContent(el, value, isFloat, activePlace);
    // Live output during drag
    this.dispatchValue(node.id, 0, String(value));
  }

  private handleMessageClick(node: PatchNode): void {
    this.dispatchStoredMessage(node);
    this.flashButton(node.id);
  }

  private handleDblClick(e: MouseEvent): void {
    if (e.button !== 0) return;

    let objectEl = this.getObjectEl(e.target);
    if (!objectEl) return;

    // If a render fired during the click sequence the event target may be
    // detached. Look up the live element by node ID so edits always attach
    // to real DOM.
    if (!objectEl.isConnected) {
      const nodeId = objectEl.dataset.nodeId;
      if (!nodeId) return;
      const liveEl = this.findNodeEl(nodeId);
      if (!liveEl) return;
      objectEl = liveEl;
    }

    const node = this.getNode(objectEl);
    if (!node) return;

    if (node.type === "imageFX*") {
      e.preventDefault();
      e.stopPropagation();
      const fxNode = this.visualizerGraph?.getImageFXNode(node.id);
      if (!fxNode) return;
      new ImageFXPanel(fxNode, node, this.graph).open();
      return;
    }

    if (node.type === "adc~" || node.type === "dac~") {
      e.preventDefault();
      e.stopPropagation();
      if (this.audioGraph) new AudioConfigPanel(node, this.graph, this.audioGraph).open();
      return;
    }

    if (node.type === "subPatch") {
      e.preventDefault();
      e.stopPropagation();
      this.subPatchManager?.open(node.id);
      return;
    }

    if (node.type === "comment") {
      e.preventDefault();
      e.stopPropagation();
      this.beginCommentEdit(objectEl, node);
      return;
    }

    if (node.type === "integer" || node.type === "float") {
      e.preventDefault();
      e.stopPropagation();
      this.beginNumericEdit(objectEl, node);
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

  private beginEditBufferMaxLen(node: PatchNode, displayEl: HTMLElement): void {
    if (displayEl.querySelector("input")) return;
    const current = parseFloat(node.args[3] ?? "180");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "pn-buf-maxlen-input";
    input.value = String(Math.round(current));
    input.size = 4;
    input.title = "Seconds (1–3600). Accepts 90, 2m, 1m30s. Resetting clears the recording.";

    const prevText = displayEl.textContent ?? "";
    displayEl.textContent = "max:";
    displayEl.appendChild(input);
    input.focus();
    input.select();

    let settled = false;

    const commit = () => {
      if (settled) return;
      settled = true;
      input.remove();
      const raw = input.value.trim();
      const parsed = parseSecondsLoose(raw);
      if (parsed != null) {
        this.deliverBufferMessage(node, "maxLen", [String(parsed)]);
      } else {
        // Restore the original label so the row doesn't render as "max:".
        displayEl.textContent = prevText;
      }
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      input.remove();
      displayEl.textContent = prevText;
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter")  { ev.preventDefault(); commit(); }
      if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
      ev.stopPropagation();
    });
    input.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
    input.addEventListener("blur", commit);
  }

  private beginNumericEdit(objectEl: HTMLElement, node: PatchNode): void {
    const odoEl = objectEl.querySelector<HTMLElement>(".pn-odometer");
    if (!odoEl) return;

    const isFloat = node.type === "float";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "pn-odometer-input";
    input.value = node.args[0] ?? "0";
    odoEl.appendChild(input);
    input.focus();
    input.select();

    let settled = false;

    const commit = () => {
      if (settled) return;
      settled = true;
      input.remove();
      const raw = input.value.trim();
      const parsed = isFloat ? parseFloat(raw) : parseInt(raw, 10);
      if (!isNaN(parsed)) {
        const value = isFloat ? parsed : Math.trunc(parsed);
        node.args[0] = String(value);
        this.dispatchValue(node.id, 0, String(value));
      }
      this.graph.emit("change");
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      input.remove();
      this.graph.emit("change");
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter")  { ev.preventDefault(); commit(); }
      if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
      ev.stopPropagation();
    });
    input.addEventListener("blur", commit);
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

      const newType = canonicalizeType(tokens[0]);
      const newArgs = tokens.slice(1);

      if (newType !== node.type && OBJECT_DEFS[newType]) {
        // Type changed to a valid type — swap ports from the new def
        const newDef = getObjectDef(newType);
        node.type = newType;
        node.args = newArgs;
        node.inlets  = newDef.inlets.map(p => ({ ...p }));
        node.outlets = newDef.outlets.map(p => ({ ...p }));
        if (newType === "t") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveTriggerPorts(newArgs));
        }
        if (newType === "pack") {
          ({ inlets: node.inlets, outlets: node.outlets } = derivePackPorts(newArgs));
          this.packSlots.delete(node.id);
        }
        if (newType === "unpack") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveUnpackPorts(newArgs));
          this.unpackSlots.delete(node.id);
        }
        if (newType === "sequencer") {
          ensureSequencerArgs(node.args);
          this.syncSequencerPorts(node);
        }
        if (newType === "fft~") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveFftPorts(newArgs));
        }
        if (newType === "mixer~") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveMixerPorts(newArgs));
          node.width = mixerDefaultWidth(node.inlets.length);
        }
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
        if (node.type === "t") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveTriggerPorts(newArgs));
          for (const edge of this.graph.getEdges()) {
            if (edge.fromNodeId === node.id && edge.fromOutlet >= node.outlets.length) this.graph.removeEdge(edge.id);
          }
        }
        if (node.type === "pack") {
          ({ inlets: node.inlets, outlets: node.outlets } = derivePackPorts(newArgs));
          this.packSlots.delete(node.id);
          for (const edge of this.graph.getEdges()) {
            if (edge.toNodeId === node.id && edge.toInlet >= node.inlets.length) this.graph.removeEdge(edge.id);
          }
        }
        if (node.type === "unpack") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveUnpackPorts(newArgs));
          this.unpackSlots.delete(node.id);
          for (const edge of this.graph.getEdges()) {
            if (edge.fromNodeId === node.id && edge.fromOutlet >= node.outlets.length) this.graph.removeEdge(edge.id);
          }
        }
        if (node.type === "sequencer") {
          ensureSequencerArgs(node.args);
          this.syncSequencerPorts(node);
        }
        if (node.type === "fft~") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveFftPorts(newArgs));
          for (const edge of this.graph.getEdges()) {
            if (edge.fromNodeId === node.id && edge.fromOutlet >= node.outlets.length) this.graph.removeEdge(edge.id);
          }
        }
        if (node.type === "mixer~") {
          ({ inlets: node.inlets, outlets: node.outlets } = deriveMixerPorts(newArgs));
          node.width = mixerDefaultWidth(node.inlets.length);
          for (const edge of this.graph.getEdges()) {
            if (edge.toNodeId === node.id && edge.toInlet >= node.inlets.length) this.graph.removeEdge(edge.id);
          }
        }
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

  private beginCommentEdit(objectEl: HTMLElement, node: PatchNode): void {
    const textEl = objectEl.querySelector<HTMLElement>(".patch-object-comment-text");
    if (!textEl) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "patch-object-comment-input";
    input.value = node.args[0] ?? "";
    textEl.textContent = "";
    textEl.appendChild(input);
    // Make pointer events work while editing
    textEl.style.pointerEvents = "auto";
    input.focus();
    input.select();

    let settled = false;

    const commit = () => {
      if (settled) return;
      settled = true;
      node.args[0] = input.value || "comment";
      textEl.style.pointerEvents = "";
      this.graph.emit("change");
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      textEl.style.pointerEvents = "";
      this.graph.emit("change");
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { cancel(); }
      ev.stopPropagation();
    });
    input.addEventListener("blur", commit);
  }

  private beginMessageEdit(objectEl: HTMLElement, node: PatchNode): void {
    const contentEl = objectEl.querySelector<HTMLElement>(".patch-object-message-content");
    if (!contentEl) return;

    // If an edit is already in progress (e.g. rapid double-click), re-focus
    // the existing input rather than re-creating it. Creating a new input would
    // fire blur on the live input synchronously, which calls commit() and then
    // render(), detaching contentEl before the new input can be appended.
    const existing = contentEl.querySelector<HTMLInputElement>(".patch-object-message-input");
    if (existing) {
      existing.focus();
      existing.select();
      return;
    }

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
    if (inlet === 0) {
      // Selector messages on left inlet: modify stored content without output
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
      // Any other value at inlet 0: substitute $1–$9 into the stored template and output.
      // The template itself is never mutated — $n placeholders remain intact.
      const template = this.getStoredMessage(node);
      const values = value.trim().split(/\s+/).filter(Boolean);
      const resolved = applyDollarArgs(template, values);
      this.dispatchMessageContent(node, resolved);
      this.flashButton(node.id);
    } else {
      // Right inlet: store incoming value silently without output.
      // bang at right inlet is handled in deliverBang.
      this.setStoredMessage(node, value);
    }
  }

  /** Update the message box DOM without emitting a change event. */
  private updateMessageDom(nodeId: string, content: string): void {
    const nodeEl = this.findNodeEl(nodeId);
    const el = nodeEl?.querySelector<HTMLElement>(".patch-object-message-content");
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
    return node.args.join(" ");
  }

  private setStoredMessage(node: PatchNode, content: string): void {
    node.args = content ? [content] : [];
    this.updateMessageDom(node.id, content);
    this.graph.emit("display");
  }

  private joinSegments(left: string, right: string): string {
    if (!left) return right;
    if (!right) return left;
    return `${left} ${right}`;
  }

  /** Build prepend/append output by joining stored args with the incoming message, capped at 256 atoms. */
  private composePrependAppend(node: PatchNode, incoming: string, mode: "prepend" | "append"): string {
    const stored = node.args.join(" ").trim();
    const inc = incoming.trim();
    const joined = mode === "prepend"
      ? (stored && inc ? `${stored} ${inc}` : stored || inc)
      : (inc && stored ? `${inc} ${stored}` : inc || stored);
    const atoms = joined.split(/\s+/).filter(Boolean);
    if (atoms.length > 256) {
      console.warn(`[${node.type}] output truncated at 256 atoms`);
      return atoms.slice(0, 256).join(" ");
    }
    return atoms.join(" ");
  }

  /** Lazily initialize and return the runtime slot values for a `pack` node. */
  private getPackSlots(node: PatchNode): string[] {
    let slots = this.packSlots.get(node.id);
    if (!slots || slots.length !== node.inlets.length) {
      const argSource = node.args.length > 0 ? node.args : ["f", "f"];
      slots = node.inlets.map((_, i) => packSlotInit(argSource[i] ?? "f"));
      this.packSlots.set(node.id, slots);
    }
    return slots;
  }

  /** Lazily initialize and return the runtime slot values for an `unpack` node. */
  private getUnpackSlots(node: PatchNode): string[] {
    let slots = this.unpackSlots.get(node.id);
    if (!slots || slots.length !== node.outlets.length) {
      const argSource = node.args.length > 0 ? node.args : ["f", "f"];
      slots = node.outlets.map((_, i) => packSlotInit(argSource[i] ?? "f"));
      this.unpackSlots.set(node.id, slots);
    }
    return slots;
  }

  /** Format a stored atom for emission from an `unpack` outlet, per the slot's
   *  type letter (i → trunc to int, f → float, s/l/literal → passthrough). */
  private coerceUnpackOutput(letter: string, atom: string): string {
    const l = letter.toLowerCase();
    if (l === "i") {
      const n = parseFloat(atom);
      return isNaN(n) ? "0" : String(Math.trunc(n));
    }
    if (l === "f") {
      const n = parseFloat(atom);
      return isNaN(n) ? "0" : String(n);
    }
    return atom;
  }

  private getSliderValue(node: PatchNode): string {
    const val = Number.parseFloat(node.args[0] ?? "0");
    const clamped = Math.max(0, Math.min(1, isNaN(val) ? 0 : val));
    return clamped.toFixed(6);
  }

  private syncNumboxDisplay(node: PatchNode): void {
    const nodeEl = this.findNodeEl(node.id);
    const el = nodeEl?.querySelector<HTMLElement>(".pn-odometer");
    if (el) {
      buildOdometerContent(el, parseFloat(node.args[0] ?? "0"), node.type === "float", null);
    }
  }

  private syncFLabel(node: PatchNode): void {
    const nodeEl = this.findNodeEl(node.id);
    const titleEl = nodeEl?.querySelector<HTMLElement>(".patch-object-title");
    if (!titleEl) return;
    const val = parseFloat(node.args[0] ?? "0");
    titleEl.textContent = `f ${isNaN(val) ? "0" : String(parseFloat(val.toFixed(4)))}`;
  }

  private syncSliderThumb(nodeId: string, value: number, _node: PatchNode): void {
    const nodeEl = this.findNodeEl(nodeId);
    const thumbEl = nodeEl?.querySelector<HTMLElement>(".patch-object-slider-thumb");
    if (thumbEl) {
      thumbEl.style.left = `${Math.max(0, Math.min(100, value * 100))}%`;
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
      this.graph.emit("display");
      if (this.isMetroRunning(node.id)) {
        this.startMetro(node);
      }
    }
  }

  // ── buffer~ ────────────────────────────────────────────────────────

  /**
   * Route a buffer~ message (from cable, body button, or panel control) to
   * the runtime BufferNode. Persists transport / rate / loop / mode back into
   * node.args so a re-render reflects current state.
   */
  private deliverBufferMessage(node: PatchNode, selector: string, args: string[]): void {
    if (node.type !== "buffer~") return;
    const bn = this.audioGraph?.getBufferNode(node.id);

    switch (selector) {
      case "record":
        bn?.record();
        node.args[4] = "record";
        this.graph.emit("change");
        break;

      case "play": {
        const startArg = parseFloat(args[0] ?? "");
        const endArg   = parseFloat(args[1] ?? "");
        if (Number.isFinite(startArg)) {
          bn?.playFrom(startArg, Number.isFinite(endArg) ? endArg : undefined);
        } else {
          bn?.play();
        }
        node.args[4] = bn?.state ?? "play";
        this.graph.emit("change");
        break;
      }

      case "pause":
        bn?.pause();
        node.args[4] = "pause";
        this.graph.emit("change");
        break;

      case "stop": {
        bn?.stop();
        node.args[4] = "stop";
        node.args[5] = "0";
        // Drop any one-shot drag-selection overlay; persistent range stays.
        const wave = this.panGroup.querySelector<HTMLCanvasElement>(
          `.pn-buf-wave[data-buf-node-id="${node.id}"]`,
        );
        if (wave) delete wave.dataset.bufSelection;
        this.graph.emit("change");
        break;
      }

      case "rate":
      case "float": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        // Phase D1: streaming buffer~ supports forward playback only for now.
        // Map negative rates to |rate| so the user gets audio at the intended
        // speed instead of silence (true reverse playback lands in D2).
        const effective = Math.abs(v);
        bn?.setRate(effective);
        node.args[1] = String(effective);
        this.graph.emit("display");
        break;
      }

      case "loop": {
        const v = (args[0] ?? "1") !== "0";
        bn?.setLoop(v);
        node.args[2] = v ? "1" : "0";
        this.graph.emit("display");
        break;
      }

      case "maxLen": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        const clamped = Math.max(1, Math.min(3600, v));
        if (clamped === parseFloat(node.args[3] ?? "")) break;
        bn?.setMaxSeconds(clamped);
        // Reset transport + persisted PCM since the worklet wipes its buffers.
        node.args[3] = String(clamped);
        node.args[4] = "stop";
        node.args[5] = "0";
        node.args[6] = "";
        node.args[7] = "";
        node.args[8] = "";
        node.args[9] = "";
        this.graph.emit("change");
        break;
      }

      case "seek": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        bn?.seek(v);
        break;
      }

      case "range": {
        const s = parseFloat(args[0] ?? "");
        const e = parseFloat(args[1] ?? "");
        if (!Number.isFinite(s) || !Number.isFinite(e)) break;
        const cs = Math.max(0, Math.min(1, s));
        const ce = Math.max(0, Math.min(1, e));
        // Set args BEFORE setRange — setRange's internal emitState ➜
        // handleBufferStateChange reads node.args synchronously and would
        // miss the new range if we updated args after the call.
        node.args[10] = String(cs);
        node.args[11] = String(ce);
        bn?.setRange(cs, ce);
        // Repaint the overlay even when DSP is off (no BufferNode yet, so
        // setRange's emitState path didn't fire).
        if (!bn) this.bufferRedraw?.(node.id);
        this.graph.emit("display");
        break;
      }

      case "stereo":
      case "mono":
        this.setBufferMode(node, selector);
        break;

      case "clear":
        bn?.clear();
        node.args[4] = "stop";
        node.args[5] = "0";
        node.args[6] = "";
        node.args[7] = "";
        this.graph.emit("change");
        break;

      default:
        break;
    }
  }

  /**
   * Route a vbuf* message (from cable, body button, or attribute panel) to
   * the runtime VideoBufferNode. Args layout (vbuf*):
   *   args[0] rate, args[1] loop, args[2] maxLen,
   *   args[3] transport, args[4] position, args[5] thumb,
   *   args[6] rangeStart, args[7] rangeEnd, args[8] storageKey
   */
  private deliverVideoBufferMessage(node: PatchNode, selector: string, args: string[]): void {
    if (node.type !== "vbuf*") return;
    const vbn = this.visualizerGraph?.getVideoBufferNode(node.id);

    switch (selector) {
      case "record":
        void vbn?.record();
        node.args[3] = "record";
        this.graph.emit("change");
        break;

      case "play": {
        // Fire-and-forget — vbn.play() is async (it awaits OPFS open + the
        // <video> element's loadedmetadata). Do NOT eagerly mutate args[3]
        // or emit "change" here; that would rebuild the DOM mid-load and
        // re-parent the <video> element while it's still resolving src.
        // The runtime's emitState ➜ handleVideoBufferStateChange will drive
        // the UI update once playback is actually live.
        const startArg = parseFloat(args[0] ?? "");
        const endArg   = parseFloat(args[1] ?? "");
        if (Number.isFinite(startArg)) {
          void vbn?.playFrom(startArg, Number.isFinite(endArg) ? endArg : undefined);
        } else {
          void vbn?.play();
        }
        break;
      }

      case "pause":
        vbn?.pause();
        break;

      case "stop":
        vbn?.stop();
        break;

      case "rate":
      case "float": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        const effective = Math.abs(v);
        vbn?.setRate(effective);
        node.args[0] = String(effective);
        this.graph.emit("display");
        break;
      }

      case "loop": {
        const v = (args[0] ?? "1") !== "0";
        vbn?.setLoop(v);
        node.args[1] = v ? "1" : "0";
        // emit "change" so the loop-toggle button re-renders with the
        // correct active class + flips its data-vbuf-action target.
        this.graph.emit("change");
        break;
      }

      case "maxLen": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        const clamped = Math.max(1, Math.min(600, v));
        if (clamped === parseFloat(node.args[2] ?? "")) break;
        vbn?.setMaxSeconds(clamped);
        node.args[2] = String(clamped);
        node.args[3] = "stop";
        node.args[4] = "0";
        this.graph.emit("change");
        break;
      }

      case "seek": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        vbn?.seek(v);
        break;
      }

      case "range": {
        const s = parseFloat(args[0] ?? "");
        const e = parseFloat(args[1] ?? "");
        if (!Number.isFinite(s) || !Number.isFinite(e)) break;
        if (!vbn) break;
        vbn.setRange(s, e);
        // Persist the post-shift values setRange actually stored, not the raw
        // request — otherwise an overshooting `range` would re-clamp on reload.
        node.args[6] = String(vbn.rangeStartNorm);
        node.args[7] = String(vbn.rangeEndNorm);
        this.graph.emit("display");
        break;
      }

      case "loopStart": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        if (!vbn) break;
        vbn.setLoopStart(v);
        node.args[6] = String(vbn.rangeStartNorm);
        node.args[7] = String(vbn.rangeEndNorm);
        this.graph.emit("display");
        break;
      }

      case "loopLen": {
        const v = parseFloat(args[0] ?? "");
        if (!Number.isFinite(v)) break;
        if (!vbn) break;
        vbn.setLoopLenMs(v);
        node.args[6] = String(vbn.rangeStartNorm);
        node.args[7] = String(vbn.rangeEndNorm);
        this.graph.emit("display");
        break;
      }

      case "clear":
        void vbn?.clear();
        node.args[3] = "stop";
        node.args[4] = "0";
        node.args[8] = "";
        this.graph.emit("change");
        break;

      case "load": {
        if (!vbn) break;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "video/*";
        input.style.display = "none";
        input.addEventListener("change", () => {
          const f = input.files?.[0];
          input.remove();
          if (!f) return;
          void vbn.loadFile(f).then(() => {
            if (vbn.duration > 0) {
              node.args[2] = String(Math.max(1, Math.min(600, Math.ceil(vbn.duration))));
            }
            this.graph.emit("change");
          });
        });
        document.body.appendChild(input);
        input.click();
        break;
      }

      default:
        break;
    }
  }

  /** Switch buffer~ between mono and stereo. Rebuilds ports, drops orphaned
   *  edges, and emits "change" so the renderer + text panel re-paint. */
  private setBufferMode(node: PatchNode, mode: "stereo" | "mono"): void {
    const bn = this.audioGraph?.getBufferNode(node.id);
    bn?.setMode(mode);
    if (node.args[0] === mode) return;
    node.args[0] = mode;
    const next = deriveBufferPorts(node.args);
    node.inlets  = next.inlets;
    node.outlets = next.outlets;
    // Drop edges that now reference out-of-range ports.
    for (const edge of this.graph.getEdges()) {
      const isFromThis = edge.fromNodeId === node.id;
      const isToThis   = edge.toNodeId   === node.id;
      if (isFromThis && edge.fromOutlet >= node.outlets.length) this.graph.edges.delete(edge.id);
      if (isToThis   && edge.toInlet    >= node.inlets.length)  this.graph.edges.delete(edge.id);
    }
    this.graph.emit("change");
  }

  private deliverDmxMessage(node: PatchNode, selector: string, args: string[]): void {
    const dmx = this.dmxGraph?.getNode(node.id);
    if (!dmx) return;

    switch (selector) {
      case "connect": {
        const vid = parseInt(node.args[3] ?? "0", 10) || null;
        const pid = parseInt(node.args[4] ?? "0", 10) || null;
        void (async () => {
          if (!dmx.getInfo()) {
            const info = await dmx.reacquire(vid, pid);
            if (!info) {
              this.dispatchValue(node.id, 1, "error no-device-selected");
              return;
            }
            node.args[3] = String(info.usbVendorId ?? 0);
            node.args[4] = String(info.usbProductId ?? 0);
            node.args[5] = info.label;
            this.graph.emit("change");
          }
          await dmx.connect();
          if (dmx.getState() === "connected") {
            node.args[2] = "1";
            this.graph.emit("display");
            this.dispatchBang(node.id, 0);
            this.dispatchValue(node.id, 1, "connected");
          } else {
            this.dispatchValue(node.id, 1, "error connect-failed");
          }
        })();
        break;
      }

      case "disconnect": {
        void (async () => {
          await dmx.disconnect();
          node.args[2] = "0";
          this.graph.emit("display");
          this.dispatchBang(node.id, 0);
          this.dispatchValue(node.id, 1, "idle");
        })();
        break;
      }

      case "dmx": {
        if (args.length < 2) return;
        const addr = parseInt(args[0], 10);
        const values = args.slice(1).map((v) => parseFloat(v)).filter((v) => !isNaN(v));
        if (!isFinite(addr) || values.length === 0) return;
        if (values.length === 1) {
          dmx.writeChannel(addr, values[0]);
        } else {
          dmx.writeRange(addr, values);
        }
        break;
      }

      case "blackout": {
        if (args.length === 0) {
          dmx.blackout();
        } else {
          const err = dmx.blackoutFixture(args[0]);
          if (err) this.dispatchValue(node.id, 1, `error ${args[0]}-unknown`);
        }
        break;
      }

      case "defaults": {
        if (args.length === 0) {
          const n = dmx.allFixturesDefaults();
          this.dispatchValue(node.id, 1, `defaults ${n}`);
        } else {
          const err = dmx.fixtureDefaults(args[0]);
          if (err) this.dispatchValue(node.id, 1, `error ${args[0]}-unknown`);
        }
        break;
      }

      case "setall": {
        if (args.length < 2) {
          this.dispatchValue(node.id, 1, "error setall-usage: setall <attr> <value>");
          break;
        }
        const attr = args[0];
        const value = parseFloat(args[1]);
        if (isNaN(value)) {
          this.dispatchValue(node.id, 1, `error bad-value ${args[1]}`);
          break;
        }
        const n = dmx.writeAllFixtures(attr, value);
        this.dispatchValue(node.id, 1, `setall ${attr} ${n}`);
        break;
      }

      case "rate": {
        const hz = parseFloat(args[0] ?? "");
        if (!isNaN(hz)) {
          dmx.setRateHz(hz);
          node.args[0] = String(dmx.getRateHz());
          this.graph.emit("display");
        }
        break;
      }

      case "status": {
        const info = dmx.getInfo();
        const device = info?.label ?? "no-device";
        this.dispatchValue(node.id, 1, `${dmx.getState()} ${device} ${dmx.getRateHz()}hz`);
        break;
      }

      case "patch": {
        if (args.length < 3) {
          this.dispatchValue(node.id, 1, "error patch-usage: patch <name> <profileId> <addr>");
          break;
        }
        const addr = parseInt(args[2], 10);
        const err = dmx.patchFixture(args[0], args[1], addr);
        if (!err) this.persistDmxState(node, dmx);
        break;
      }

      case "unpatch": {
        if (args.length < 1) break;
        const err = dmx.unpatchFixture(args[0]);
        if (!err) this.persistDmxState(node, dmx);
        break;
      }

      case "rename": {
        if (args.length < 2) break;
        const err = dmx.renameFixture(args[0], args[1]);
        if (!err) this.persistDmxState(node, dmx);
        break;
      }

      case "repoint": {
        if (args.length < 2) break;
        const err = dmx.repointFixture(args[0], args[1]);
        if (!err) this.persistDmxState(node, dmx);
        break;
      }

      case "mute": {
        if (args.length < 2) break;
        const muted = args[1] !== "0";
        const err = dmx.setFixtureMuted(args[0], muted);
        if (!err) this.persistDmxState(node, dmx);
        break;
      }

      case "set": {
        // set <name> <attr> <value> [<attr> <value> ...]
        if (args.length < 3 || (args.length - 1) % 2 !== 0) {
          this.dispatchValue(node.id, 1, "error set-usage: set <name> <attr> <value> [<attr> <value> ...]");
          break;
        }
        const fixtureName = args[0];
        for (let i = 1; i < args.length; i += 2) {
          const attr = args[i];
          const value = parseFloat(args[i + 1]);
          if (isNaN(value)) {
            this.dispatchValue(node.id, 1, `error bad-value ${args[i + 1]}`);
            continue;
          }
          const err = dmx.writeFixtureAttr(fixtureName, attr, value);
          if (err) this.dispatchValue(node.id, 1, `error ${fixtureName}.${attr}`);
        }
        break;
      }

      case "profile": {
        if (args.length < 1) break;
        const sub = args[0];
        if (sub === "import" && args.length >= 2) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(decodeURIComponent(escape(atob(args[1]))));
          } catch {
            this.dispatchValue(node.id, 1, "error profile-import bad-base64-or-json");
            break;
          }
          const err = dmx.importProfile(parsed);
          if (err) this.dispatchValue(node.id, 1, `error profile-import ${err}`);
          else this.persistDmxState(node, dmx);
        } else if (sub === "remove" && args.length >= 2) {
          if (dmx.removeProfile(args[1])) this.persistDmxState(node, dmx);
        } else if (sub === "list") {
          for (const p of dmx.listProfiles()) {
            this.dispatchValue(node.id, 1, `profile ${p.id} ${p.channelCount}ch`);
          }
        } else {
          this.dispatchValue(node.id, 1, "error profile-subcommand: import|remove|list");
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Serialize the dmx node's profiles + instances back into the PatchNode
   * args as base64 JSON. Called after any patch/profile mutation so the
   * state round-trips through the text panel and .patchnet files.
   */
  private persistDmxState(node: PatchNode, dmx: { exportUserProfiles: () => unknown; exportInstances: () => unknown }): void {
    const profiles = dmx.exportUserProfiles();
    const instances = dmx.exportInstances();
    node.args[6] = encodeDmxBase64Json(profiles);
    node.args[7] = encodeDmxBase64Json(instances);
    // "change" so the autosave (graph.on("change", savePatch) in main.ts)
    // flushes the new profiles/instances to localStorage. "display" would
    // only sync the text panel — patches would not survive a reload.
    this.graph.emit("change");
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

  private deliverOscValue(node: PatchNode, inlet: number, value: string): void {
    if (inlet === 0) {
      const parsed = Number.parseFloat(value);
      if (Number.isNaN(parsed)) return;
      if (parsed === 0) this.stopOsc(node.id);
      else this.startOsc(node);
      return;
    }
    if (inlet === 1) {
      const parsed = Number.parseFloat(value);
      if (Number.isNaN(parsed)) return;
      node.args[0] = `${Math.max(0.01, parsed)}`;
      this.graph.emit("display");
      if (this.isOscRunning(node.id)) this.startOsc(node);
    }
  }

  private startOsc(node: PatchNode): void {
    this.stopOsc(node.id, false);
    const startT = performance.now() / 1000;
    const state: { rafId: number; startT: number } = { rafId: 0, startT };
    const tick = () => {
      const current = this.oscTimers.get(node.id);
      if (!current) return;
      const liveNode = this.graph.nodes.get(node.id);
      if (!liveNode) { this.stopOsc(node.id, false); return; }
      const freq = Math.max(0.01, Number.parseFloat(liveNode.args[0] ?? "1"));
      const t = performance.now() / 1000 - current.startT;
      const v = 0.5 + 0.5 * Math.sin(2 * Math.PI * freq * t);
      this.dispatchValue(node.id, 0, v.toFixed(4));
      current.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
    this.oscTimers.set(node.id, state);
    node.args[1] = "1";
    this.graph.emit("change");
  }

  private stopOsc(nodeId: string, persist = true): void {
    const current = this.oscTimers.get(nodeId);
    if (current !== undefined) {
      cancelAnimationFrame(current.rafId);
      this.oscTimers.delete(nodeId);
    }
    if (persist) {
      const node = this.graph.nodes.get(nodeId);
      if (node) {
        node.args[1] = "0";
        this.graph.emit("change");
      }
    }
  }

  private isOscRunning(nodeId: string): boolean {
    return this.oscTimers.has(nodeId);
  }

  private pruneOscTimers(): void {
    for (const nodeId of this.oscTimers.keys()) {
      if (!this.graph.nodes.has(nodeId)) this.stopOsc(nodeId, false);
    }
  }

  private restoreOscTimers(): void {
    for (const node of this.graph.getNodes()) {
      if (node.type === "oscillateNumbers" && node.args[1] === "1" && !this.isOscRunning(node.id)) {
        this.startOsc(node);
      }
    }
  }

  // ── Sequencer ──────────────────────────────────────────────────────

  /**
   * Rebuild outlets from the `rows` arg. Removes edges that point at outlets
   * that no longer exist. Caller is responsible for emitting.
   */
  private syncSequencerPorts(node: PatchNode): void {
    const rows = sequencerRows(node);
    if (node.outlets.length === rows) return;

    node.outlets = Array.from({ length: rows }, (_, i) => ({
      index: i,
      type: "any" as PortType,
      label: `row ${i}`,
    }));

    // Drop any edges whose source outlet on this node is now out of range.
    // Delete directly from the map: graph.removeEdge would emit "change",
    // re-entering render mid-update.
    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId === node.id && edge.fromOutlet >= rows) {
        this.graph.edges.delete(edge.id);
      }
    }
  }

  /**
   * Advance the playhead by one column (wrapping) and fire the active cell
   * value out of each row's outlet. Empty cells produce nothing; numeric
   * tokens fire as floats; everything else fires as a message. The DOM is
   * patched in place — a full re-render at bang cadence would thrash cells.
   */
  private advanceSequencer(node: PatchNode): void {
    ensureSequencerArgs(node.args);
    const rows = sequencerRows(node);
    const cols = sequencerCols(node);
    const prev = Math.trunc(Number.parseFloat(node.args[2] ?? "0")) || 0;
    const next = ((prev + 1) % cols + cols) % cols;
    node.args[2] = String(next);

    const cells = getSequencerCells(node);
    for (let r = 0; r < rows; r++) {
      const raw = (cells[r]?.[next] ?? "").trim();
      if (raw === "") continue;
      if (raw === "bang") {
        this.dispatchBang(node.id, r);
      } else {
        this.dispatchValue(node.id, r, raw);
      }
    }

    // In-place DOM update — move the .pn-seq-cell--active class to the new column.
    const nodeEl = this.findNodeEl(node.id);
    const grid = nodeEl?.querySelector<HTMLElement>(".pn-seq-grid");
    if (grid) {
      for (const active of grid.querySelectorAll<HTMLElement>(".pn-seq-cell--active")) {
        active.classList.remove("pn-seq-cell--active");
      }
      for (const cell of grid.querySelectorAll<HTMLElement>(".pn-seq-cell")) {
        if (Number(cell.dataset.seqCol) === next) cell.classList.add("pn-seq-cell--active");
      }
    }

    // "display" keeps the text panel in sync without destroying the grid DOM.
    this.graph.emit("display");
  }

  /** Commit a cell's text content back into the node's cells storage. */
  private commitSequencerCell(cellEl: HTMLElement): void {
    const objectEl = cellEl.closest<HTMLElement>(".patch-object");
    if (!objectEl) return;
    const node = this.getNode(objectEl);
    if (!node || node.type !== "sequencer") return;

    const r = Number(cellEl.dataset.seqRow);
    const c = Number(cellEl.dataset.seqCol);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;

    ensureSequencerArgs(node.args);
    const cells = getSequencerCells(node);
    if (!cells[r]) return;
    const next = (cellEl.textContent ?? "").trim();
    if (cells[r][c] === next) return;
    cells[r][c] = next;
    setSequencerCells(node, cells);
    this.graph.emit("change");
  }

  private handleCellFocusOut(e: FocusEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.classList.contains("pn-seq-cell")) {
      this.commitSequencerCell(target);
      return;
    }
    if (target instanceof HTMLInputElement && target.classList.contains("pn-ezscale__field")) {
      this.commitEzScaleField(target);
      return;
    }
    if (target instanceof HTMLInputElement && target.classList.contains("pn-ezslider__field")) {
      this.commitEzSliderField(target);
      return;
    }
  }

  private handleCellKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (target.classList.contains("pn-seq-cell")) {
      // Stop propagation so canvas shortcuts (Delete, `b`, `t`, etc.) don't fire
      // while the user is typing into a cell.
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        target.blur(); // triggers focusout → commitSequencerCell
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Revert to stored value and blur without committing a new one.
        const objectEl = target.closest<HTMLElement>(".patch-object");
        const node = objectEl ? this.getNode(objectEl) : null;
        if (node?.type === "sequencer") {
          const r = Number(target.dataset.seqRow);
          const c = Number(target.dataset.seqCol);
          const cells = getSequencerCells(node);
          target.textContent = cells[r]?.[c] ?? "";
        }
        target.blur();
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.classList.contains("pn-ezscale__field")) {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        target.blur(); // triggers focusout → commitEzScaleField
      } else if (e.key === "Escape") {
        e.preventDefault();
        const objectEl = target.closest<HTMLElement>(".patch-object");
        const node = objectEl ? this.getNode(objectEl) : null;
        const key = target.dataset.ezscaleField ?? "";
        const argIdx = ({ inMin: 0, inMax: 1, outMin: 2, outMax: 3 } as Record<string, number>)[key];
        if (node && argIdx !== undefined) target.value = node.args[argIdx] ?? "";
        target.blur();
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.classList.contains("pn-ezslider__field")) {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        target.blur(); // triggers focusout → commitEzSliderField
      } else if (e.key === "Escape") {
        e.preventDefault();
        const objectEl = target.closest<HTMLElement>(".patch-object");
        const node = objectEl ? this.getNode(objectEl) : null;
        const key = target.dataset.ezsliderField ?? "";
        const argIdx = key === "lo" ? 0 : key === "hi" ? 1 : -1;
        if (node && argIdx >= 0) target.value = node.args[argIdx] ?? "";
        target.blur();
      }
      return;
    }
  }
}

function clampMs(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 10000 ? 10000 : v;
}
