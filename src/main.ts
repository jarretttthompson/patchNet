import "./fonts.css";
import "./tokens.css";
import "./shell.css";

import { isNative } from "./platform/index";
import { saveTextFile, openTextFile } from "./platform/fs";

import { initCrtOverlayScroll } from "./crtOverlaySync";
import { PatchGraph } from "./graph/PatchGraph";
import { renderObject, autoFitInlineArgsWidth, buildOdometerContent } from "./canvas/ObjectRenderer";
import { CableRenderer } from "./canvas/CableRenderer";
import { CanvasController } from "./canvas/CanvasController";
import { DragController } from "./canvas/DragController";
import { CableDrawController } from "./canvas/CableDrawController";
import { ResizeController } from "./canvas/ResizeController";
import { ObjectInteractionController } from "./canvas/ObjectInteractionController";
import {
  ActionRegistry,
  ActionKeymap,
  ActionDispatcher,
  ActionListDialog,
  BUILTIN_ACTIONS,
  generateObjectCreateActions,
  type ActionContext,
  type AppActionsAPI,
} from "./actions";
import { PortTooltip } from "./canvas/PortTooltip";
import { VisualizerObjectUI } from "./canvas/VisualizerObjectUI";
import { CodeboxController } from "./canvas/CodeboxController";
import { CANVAS_LEFT_GUTTER_PX, CANVAS_TOP_GUTTER_PX } from "./canvas/canvasSpace";
import { CanvasRulers } from "./canvas/CanvasRulers";
import { getZoom } from "./canvas/zoomState";
import { getPatchMode, setPatchModeState } from "./canvas/patchModeState";
import { getSnap, setSnap } from "./canvas/snapState";
import { getObjectDef, bufferRange } from "./graph/objectDefs";
import { mountLocalPlugins, pruneLocalPlugins, collectLocalPluginActions } from "./graph/localPlugins";
import { UndoManager } from "./graph/UndoManager";
import { AudioRuntime } from "./runtime/AudioRuntime";
import { AudioGraph } from "./runtime/AudioGraph";
import { VisualizerRuntime } from "./runtime/VisualizerRuntime";
import { VisualizerGraph } from "./runtime/VisualizerGraph";
import { DmxGraph } from "./runtime/DmxGraph";
import { DmxPanelController } from "./canvas/DmxPanelController";
import { JsEffectPanelController } from "./canvas/JsEffectPanelController";
import { ReaperVideoPanelController } from "./canvas/ReaperVideoPanelController";
import { BrowserPanelController } from "./canvas/BrowserPanelController";
import { YouTubePanelController } from "./canvas/YouTubePanelController";
import { MixerPanelController } from "./canvas/MixerPanelController";
import { FramePanelController } from "./canvas/FramePanelController";
import { CamPanelController } from "./canvas/CamPanelController";
import { PeerPanelController } from "./canvas/PeerPanelController";
import { PeerRegistry } from "./runtime/peer/PeerRegistry";
import { PhoneSensorRegistry } from "./runtime/phoneSensor/PhoneSensorRegistry";
import { PhoneTiltPanelController } from "./canvas/PhoneTiltPanel";
import { SubPatchManager } from "./canvas/SubPatchManager";
import { TabManager } from "./canvas/TabManager";
import { ScratchTabSession } from "./canvas/ScratchTabSession";
import { REFERENCE_PATCHES } from "./canvas/referencePatches";
import { registerSession } from "./canvas/patchSessionRegistry";
import { buildShareUrl, loadFromShareUrl } from "./share/shareUrl";
import { PatchTerminalController } from "./terminal/PatchTerminalController";

function requireElement<T extends Element>(
  selector: string,
  parent: ParentNode = document,
): T {
  const el = parent.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}

// ── DOM refs ────────────────────────────────────────────────────────────────

const canvasArea = requireElement<HTMLDivElement>("[data-canvas-root]");
initCrtOverlayScroll(canvasArea);
const textArea = requireElement<HTMLTextAreaElement>("[data-text-panel]");
const objectCount = requireElement<HTMLSpanElement>("[data-object-count]");
const statusMode = requireElement<HTMLSpanElement>("[data-status-mode]");
const audioStatus     = document.getElementById("audio-status") as HTMLSpanElement | null;
const audioToggleBtn  = document.getElementById("audio-toggle-btn") as HTMLButtonElement | null;
const audioDeviceSel  = document.getElementById("audio-device-select") as HTMLSelectElement | null;
const audioInputSel   = document.getElementById("audio-input-select") as HTMLSelectElement | null;
const masterVolSlider = document.getElementById("master-vol") as HTMLInputElement | null;
const masterVolReadout = document.getElementById("master-vol-readout") as HTMLSpanElement | null;
const patchNameInput  = document.getElementById("patch-name-input") as HTMLElement | null;

// ── Pan group (wrapper that moves during pan, stays inside canvasArea) ──────

const panGroup = document.createElement("div");
panGroup.className = "pn-pan-group";
panGroup.style.left = `${CANVAS_LEFT_GUTTER_PX}px`;
panGroup.style.top = `${CANVAS_TOP_GUTTER_PX}px`;
canvasArea.appendChild(panGroup);

// ── Graph ────────────────────────────────────────────────────────────────────

const graph = new PatchGraph();

// ── Controllers ──────────────────────────────────────────────────────────────

const cables = new CableRenderer(panGroup, graph);
const objectInteraction = new ObjectInteractionController(panGroup, graph);

// Register main as a top-level session so global send/receive routes to its
// receivers, and AudioGraph picks up its nodes via the registry.
registerSession({ id: "main", graph, oic: objectInteraction });
const codeboxController = new CodeboxController(
  graph,
  (fromNodeId, outlet) => {
    for (const edge of graph.getEdges()) {
      if (edge.fromNodeId !== fromNodeId || edge.fromOutlet !== outlet) continue;
      const target = graph.nodes.get(edge.toNodeId);
      if (!target) continue;
      objectInteraction.deliverBang(target, edge.toInlet);
    }
  },
  (fromNodeId, outlet, value) => {
    for (const edge of graph.getEdges()) {
      if (edge.fromNodeId !== fromNodeId || edge.fromOutlet !== outlet) continue;
      const target = graph.nodes.get(edge.toNodeId);
      if (!target) continue;
      objectInteraction.deliverMessageValue(target, edge.toInlet, value);
    }
  },
);
objectInteraction.setCodeboxController(codeboxController);

const canvas = new CanvasController(canvasArea, graph, (type, nodeId) => {
  // After any object is placed, start edit mode on message boxes immediately
  if (type === "message") {
    objectInteraction.startMessageEdit(nodeId);
    const el = panGroup.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
    if (el) {
      el.classList.add("patch-object--just-placed");
      const onEnd = (e: AnimationEvent) => {
        // Wait for the longer of the two animations (the glow) to finish.
        if (e.animationName !== "pn-object-just-placed-glow") return;
        el.classList.remove("patch-object--just-placed");
        el.removeEventListener("animationend", onEnd);
      };
      el.addEventListener("animationend", onEnd);
    }
  }
});
// Controllers self-register listeners on construction
new DragController(panGroup, graph, undefined, (nodeId, x, y) => {
  // Silently update node position during drag so CableRenderer can read it
  const node = graph.nodes.get(nodeId);
  if (node) { node.x = x; node.y = y; }
  cables.render();
  // Grow the pan-group live so drag isn't capped at drag-start extent
  canvas.updatePanGroupSize();
  syncTextPanel();
}, () => canvas.getSelectedNodeIds(), (newIds) => {
  // After Cmd+drag clone, select the new copies
  canvas.selectNodes(newIds);
}, (obstacleId, movingId) => {
  // No-overlap block — pulse both the obstacle and the moving object so
  // the user sees a soft, diffused flare radiating from the contact zone.
  // animationend cleans up the class; the in-flight guard prevents the
  // pulse from re-triggering every frame while the drag stays blocked.
  for (const id of [obstacleId, movingId]) {
    const el = panGroup.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
    if (!el || el.classList.contains("patch-object--collide-flash")) continue;
    el.classList.add("patch-object--collide-flash");
    el.addEventListener("animationend", () => {
      el.classList.remove("patch-object--collide-flash");
    }, { once: true });
  }
});
const cableDraw = new CableDrawController(panGroup, graph, cables);
canvas.setCableDrawController(cableDraw);
new ResizeController(panGroup, graph, (nodeId, w, h) => {
  const node = graph.nodes.get(nodeId);
  if (node) { node.width = w; node.height = h; }
  cables.render();
  syncTextPanel();
});

const undoManager = new UndoManager(graph);
canvas.setUndoManager(undoManager);

canvas.setPanGroup(panGroup);
canvas.setCableRenderer(cables);
new PortTooltip(canvasArea);

// Coordinate rulers (top + left edges, glued to viewport corner).
// Shared across all sessions on this canvasArea — they redraw on
// scroll, resize, and zoom-state changes (subscribed in CanvasRulers).
new CanvasRulers(canvasArea);

// ── Visualizer runtime ────────────────────────────────────────────────────────

VisualizerRuntime.getInstance(); // initialise singleton
const vizGraph = new VisualizerGraph(graph);
objectInteraction.setVisualizerGraph(vizGraph);
vizGraph.setObjectInteraction(objectInteraction);
canvas.setVisualizerGraph(vizGraph);
new VisualizerObjectUI(panGroup, graph, vizGraph);

// ── DMX runtime ───────────────────────────────────────────────────────────────

const dmxGraph = new DmxGraph(graph);
objectInteraction.setDmxGraph(dmxGraph);
const dmxPanelController = new DmxPanelController(graph, dmxGraph);

// js~ panels — audio graph is wired in after start(), so the controller
// stores a null AudioGraph until then and resolves late via onJsEffectReady.
const jsEffectPanelController = new JsEffectPanelController(graph);
const browserPanelController = new BrowserPanelController(graph);
const youtubePanelController = new YouTubePanelController(graph);
const mixerPanelController = new MixerPanelController(graph);
const reaperVideoPanelController = new ReaperVideoPanelController(graph, vizGraph);
const framePanelController = new FramePanelController(graph);
framePanelController.setVisualizerGraph(vizGraph);
const camPanelController = new CamPanelController(graph);
camPanelController.setVisualizerGraph(vizGraph);

// ── Peer networking (Phase 7A — manual SDP) ───────────────────────────────
const peerRegistry = new PeerRegistry();
peerRegistry.setNetReceiveEmit((nodeId, payload) => {
  // Format the payload for the existing string-based outlet plumbing.
  // Bang → empty string handled by deliverBang; everything else fires through fireOutlet.
  if (payload === null) {
    // Bang: walk edges manually since fireOutlet only carries string values.
    for (const edge of graph.getEdges()) {
      if (edge.fromNodeId !== nodeId || edge.fromOutlet !== 0) continue;
      const target = graph.nodes.get(edge.toNodeId);
      if (!target) continue;
      objectInteraction.deliverBang(target, edge.toInlet);
    }
    return;
  }
  const value = formatPayload(payload);
  objectInteraction.fireOutlet(nodeId, 0, value);
});
function formatPayload(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(formatPayload).join(" ");
  return String(v);
}
const peerPanelController = new PeerPanelController(graph, peerRegistry);
objectInteraction.setPeerRegistry(peerRegistry);

// ── Phone-tilt sensor (dev-only) ─────────────────────────────────────────
const phoneSensorRegistry = new PhoneSensorRegistry();
phoneSensorRegistry.setEmit((nodeId, outlet, value) => {
  objectInteraction.fireOutlet(nodeId, outlet, value);
});
objectInteraction.setPhoneSensorRegistry(phoneSensorRegistry);
const phoneTiltPanelController = new PhoneTiltPanelController(graph, phoneSensorRegistry);

graph.on("change", () => {
  peerRegistry.sync(graph);
  peerRegistry.syncNetReceives(graph);
  phoneSensorRegistry.sync(graph);
});

objectInteraction.setJsEffectPanelController(jsEffectPanelController);
objectInteraction.setReaperVideoPanelController(reaperVideoPanelController);

// ── Audio runtime ─────────────────────────────────────────────────────────────

const audioRuntime = AudioRuntime.getInstance();
let audioGraph: AudioGraph | null = null;
let dspOn = false;

function setDspUi(on: boolean): void {
  dspOn = on;
  if (audioToggleBtn) {
    audioToggleBtn.setAttribute("aria-pressed", String(on));
    audioToggleBtn.classList.toggle("toolbar-audio-btn--on", on);
    audioToggleBtn.querySelector<HTMLSpanElement>(".toolbar-audio-icon")!.textContent = on ? "■" : "▶";
  }
  if (audioStatus) {
    audioStatus.textContent = on
      ? `audio: on  ${audioRuntime.sampleRate / 1000}kHz`
      : "audio: off";
    audioStatus.style.color = on ? "var(--pn-accent)" : "";
  }
}

async function populateDevices(): Promise<void> {
  if (audioDeviceSel) {
    const outputs = await audioRuntime.getOutputDevices();
    while (audioDeviceSel.options.length > 1) audioDeviceSel.remove(1);
    for (const d of outputs) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Output ${audioDeviceSel.options.length}`;
      audioDeviceSel.appendChild(opt);
    }
  }
  if (audioInputSel) {
    const inputs = await audioRuntime.getInputDevices();
    while (audioInputSel.options.length > 1) audioInputSel.remove(1);
    for (const d of inputs) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Input ${audioInputSel.options.length}`;
      audioInputSel.appendChild(opt);
    }
  }
}

let meterRafId = 0;

function startMeterLoop(): void {
  panGroup.querySelectorAll<HTMLElement>('[data-node-type="fft~"]').forEach(
    el => el.setAttribute("data-dsp-active", "true"),
  );
  const tick = () => {
    meterRafId = requestAnimationFrame(tick);
    if (!audioGraph) return;
    audioGraph.mountFftNodes(panGroup);
    audioGraph.updateFftDisplay(panGroup);
    audioGraph.updateWaveDisplay(panGroup);
    audioGraph.updateNoiseDisplay(panGroup);
    audioGraph.updateLfoDisplay(panGroup);
    audioGraph.updateTransientFollowerDisplay(panGroup);
    audioGraph.flushAdsrCompletions(performance.now());

    // Push fft~ band values: update the directly-connected node's display,
    // then fire its outlet so the full downstream chain propagates.
    // Avoids graph.emit (no 60fps re-render) and avoids template contamination
    // in message boxes (deliverMessageValue would lock node.args to first value).
    const fftBands = audioGraph.getFftBandLevels();
    for (const [nodeId, bands] of fftBands) {
      for (const edge of graph.getEdges()) {
        if (edge.fromNodeId !== nodeId) continue;
        const val = bands[edge.fromOutlet];
        if (val === undefined) continue;
        const formatted = val.toFixed(4);
        const targetNode = graph.nodes.get(edge.toNodeId);
        if (!targetNode) continue;

        const targetEl = panGroup.querySelector<HTMLElement>(
          `[data-node-id="${edge.toNodeId}"]`,
        );

        if (targetNode.type === "float" || targetNode.type === "integer") {
          const isFloat = targetNode.type === "float";
          const stored = isFloat ? formatted : String(Math.trunc(val));
          targetNode.args[0] = stored;
          const odo = targetEl?.querySelector<HTMLElement>(".pn-odometer");
          if (odo) buildOdometerContent(odo, isFloat ? val : Math.trunc(val), isFloat, null);
          // Hot inlet 0 stores + fires; cold inlet 1 stores silently.
          if (edge.toInlet === 0) {
            objectInteraction.fireOutlet(edge.toNodeId, 0, stored);
          }
        } else if (targetNode.type === "message") {
          targetNode.args[0] = formatted;
          const contentEl = targetEl?.querySelector(".patch-object-message-content");
          if (contentEl) contentEl.textContent = formatted;
          objectInteraction.fireOutlet(edge.toNodeId, 0, formatted);
        } else {
          // Processor targets (scale, math ops, s/send, …) must run their own
          // inlet handler so the value is transformed before being forwarded.
          objectInteraction.deliverMessageValue(targetNode, edge.toInlet, formatted);
        }
      }
    }
    // Push buffer~ position values out the position outlet (last outlet) and
    // repaint each body waveform with the current cursor.
    // Stereo mode → outlet index 2; mono mode → outlet index 1.
    const bufferPositions = audioGraph.getBufferPositions();
    for (const [nodeId, pos] of bufferPositions) {
      const sourceNode = graph.nodes.get(nodeId);
      if (!sourceNode) continue;
      const bn = audioGraph.getBufferNode(nodeId);
      if (bn) drawBufferWaveform(nodeId, bn.getPeaks(), bn.bufferLength, pos, bn.state, bufferRange(sourceNode.args));
      const posOutlet = sourceNode.outlets.length - 1;
      const formatted = pos.toFixed(4);
      for (const edge of graph.getEdges()) {
        if (edge.fromNodeId !== nodeId) continue;
        if (edge.fromOutlet !== posOutlet) continue;
        const targetNode = graph.nodes.get(edge.toNodeId);
        if (!targetNode) continue;
        const targetEl = panGroup.querySelector<HTMLElement>(
          `[data-node-id="${edge.toNodeId}"]`,
        );
        if (targetNode.type === "float" || targetNode.type === "integer") {
          const isFloat = targetNode.type === "float";
          const stored  = isFloat ? formatted : String(Math.trunc(pos));
          targetNode.args[0] = stored;
          const odo = targetEl?.querySelector<HTMLElement>(".pn-odometer");
          if (odo) buildOdometerContent(odo, isFloat ? pos : Math.trunc(pos), isFloat, null);
          if (edge.toInlet === 0) {
            objectInteraction.fireOutlet(edge.toNodeId, 0, stored);
          }
        } else if (targetNode.type === "message") {
          targetNode.args[0] = formatted;
          const contentEl = targetEl?.querySelector(".patch-object-message-content");
          if (contentEl) contentEl.textContent = formatted;
          objectInteraction.fireOutlet(edge.toNodeId, 0, formatted);
        } else {
          objectInteraction.deliverMessageValue(targetNode, edge.toInlet, formatted);
        }
      }
    }

    const levels = audioGraph.getMeterLevels();
    for (const [nodeId, info] of levels) {
      const el = panGroup.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
      if (!el) continue;
      const combined = Math.min(info.level * 4, 1);
      el.style.setProperty("--pn-meter", String(combined));
      if (info.l !== undefined) {
        const lv = Math.min(info.l * 4, 1);
        const fillL = el.querySelector<HTMLElement>(".pn-meter-l .pn-meter-fill");
        if (fillL) fillL.style.height = `${lv * 100}%`;
      }
      if (info.r !== undefined) {
        const lv = Math.min(info.r * 4, 1);
        const fillR = el.querySelector<HTMLElement>(".pn-meter-r .pn-meter-fill");
        if (fillR) fillR.style.height = `${lv * 100}%`;
      }
    }
  };
  meterRafId = requestAnimationFrame(tick);
}

function stopMeterLoop(): void {
  cancelAnimationFrame(meterRafId);
  meterRafId = 0;
  panGroup.querySelectorAll<HTMLElement>('[data-node-type="fft~"]').forEach(
    el => el.removeAttribute("data-dsp-active"),
  );
  panGroup.querySelectorAll<HTMLElement>('[data-node-type$="~"]').forEach(el => {
    el.style.setProperty("--pn-meter", "0");
    el.querySelectorAll<HTMLElement>(".pn-meter-fill").forEach(f => { f.style.height = "0%"; });
  });
}

/**
 * Persist buffer~ runtime state back into the patch node's args + repaint
 * the body waveform. Called every time the BufferNode pings the AudioGraph
 * (transport change, position tick, record-end, mode switch).
 *
 * Phase 3b: PCM is streamed to OPFS by BufferNode itself during recording, so
 * main.ts no longer writes PCM. We just sync transport state and ensure the
 * storage-key arg matches reality whenever the buffer length crosses 0.
 */
const lastPersistedBufferLengths = new Map<string, number>();

const lastVbufState = new Map<string, string>();

function handleVideoBufferStateChange(nodeId: string): void {
  const vbn = vizGraph.getVideoBufferNode(nodeId);
  if (!vbn) return;
  const node = graph.nodes.get(nodeId)
    ?? subPatchManager.getSubPatchGraphs().flatMap(g => g.getNodes()).find(n => n.id === nodeId);
  if (!node || node.type !== "vbuf*") return;

  // args layout (vbuf*):
  //   0 rate, 1 loop, 2 maxLen, 3 transport, 4 position,
  //   5 thumb, 6 rangeStart, 7 rangeEnd, 8 storageKey
  const prevState = lastVbufState.get(nodeId) ?? "";
  const prevStorage = node.args[8] ?? "";
  node.args[3] = vbn.state;
  node.args[4] = vbn.position.toFixed(6);
  const has = vbn.hasRecording ? nodeId : "";
  node.args[8] = has;

  // Rebuild DOM whenever state OR storage transitions, so the transport-button
  // highlight follows the runtime. Position-only ticks emit display only.
  if (prevState !== vbn.state || prevStorage !== has) {
    lastVbufState.set(nodeId, vbn.state);
    graph.emit("change");
  } else {
    graph.emit("display");
  }
  drawVbufStrip(nodeId);
}

function drawVbufStrip(nodeId: string): void {
  const canvas = panGroup.querySelector<HTMLCanvasElement>(
    `.pn-vbuf-strip[data-vbuf-node-id="${nodeId}"]`,
  );
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const vbn = vizGraph.getVideoBufferNode(nodeId);
  if (!vbn) return;
  const node = graph.nodes.get(nodeId)
    ?? subPatchManager.getSubPatchGraphs().flatMap(g => g.getNodes()).find(n => n.id === nodeId);
  if (!node) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const computed = getComputedStyle(canvas);
  const accent = computed.getPropertyValue("--pn-accent").trim() || "#00ff00";
  const dim    = computed.getPropertyValue("--pn-muted-deep").trim() || "rgba(0,255,0,0.3)";

  // Compute selection band first (live drag overrides persisted range).
  const live = objectInteraction.getVbufLiveSelection(nodeId);
  let overlayStart = NaN, overlayEnd = NaN;
  let isLive = false;
  if (live && live[1] > live[0]) {
    overlayStart = live[0]; overlayEnd = live[1]; isLive = true;
  } else {
    const rs = parseFloat(node.args[6] ?? "0");
    const re = parseFloat(node.args[7] ?? "0");
    if (Number.isFinite(rs) && Number.isFinite(re) && re > rs) { overlayStart = rs; overlayEnd = re; }
  }

  // 1) Thumbnails go down first. They're opaque rectangles, so anything
  //    drawn UNDER them is invisible — the selection band has to ride on top.
  const { frames } = vbn.getStrip();
  if (frames.length > 0) {
    const slotW = w / frames.length;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const x = i * slotW;
      ctx.drawImage(f, 0, 0, f.width, f.height,
                       Math.floor(x), 0, Math.ceil(slotW) + 1, h);
    }
  } else {
    ctx.strokeStyle = dim;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  // 2) Selection band on top of the thumbnails. Translucent fill + bright
  //    edges so the band reads as a discrete region without hiding content.
  if (Number.isFinite(overlayStart) && Number.isFinite(overlayEnd)) {
    const ox = overlayStart * w;
    const ow = (overlayEnd - overlayStart) * w;
    ctx.fillStyle = accent;
    ctx.globalAlpha = isLive ? 0.45 : 0.32;
    ctx.fillRect(ox, 0, ow, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox + 0.5, 0);          ctx.lineTo(ox + 0.5, h);
    ctx.moveTo(ox + ow - 0.5, 0);     ctx.lineTo(ox + ow - 0.5, h);
    ctx.stroke();
  }

  // 3) Position / progress cursor on top of everything.
  if (vbn.state === "record") {
    const recProgress = frames.length / vbn.getStrip().max;
    const cx = Math.min(1, recProgress) * w;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
  } else if (vbn.state === "play" || vbn.state === "pause") {
    const cx = vbn.position * w;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// Lightweight rAF that polls every vbuf* and redraws its strip every frame.
// We always redraw — DOM rebuilds during state transitions wipe the canvas, so
// the previous "only redraw on record/play" filter caused frames to vanish on
// stop/pause. Cost is trivial since each strip is just blitting cached frame
// canvases.
function vbufStripLoop(): void {
  requestAnimationFrame(vbufStripLoop);
  for (const node of graph.getNodes()) {
    if (node.type !== "vbuf*") continue;
    const vbn = vizGraph.getVideoBufferNode(node.id);
    if (!vbn) continue;
    drawVbufStrip(node.id);
  }
}
requestAnimationFrame(vbufStripLoop);

function handleBufferStateChange(nodeId: string): void {
  if (!audioGraph) return;
  const bn = audioGraph.getBufferNode(nodeId);
  if (!bn) return;
  const node = graph.nodes.get(nodeId)
    ?? subPatchManager.getSubPatchGraphs().flatMap(g => g.getNodes()).find(n => n.id === nodeId);
  if (!node || node.type !== "buffer~") return;

  const len = bn.bufferLength;
  const prevLen = lastPersistedBufferLengths.get(nodeId) ?? -1;
  const lenChanged = len !== prevLen;

  node.args[4] = bn.state;
  node.args[5] = bn.position.toFixed(6);

  if (lenChanged) {
    lastPersistedBufferLengths.set(nodeId, len);
    // Patch text never carries inline base64 anymore; storage key points to
    // the OPFS file. args[6..9] stay empty.
    node.args[6] = "";
    node.args[7] = "";
    node.args[8] = "";
    node.args[9] = "";
    node.args[12] = len > 0 ? nodeId : "";
    graph.emit("change");
  } else {
    graph.emit("display");
  }
  // Draw AFTER emit — "change" rebuilds the canvas DOM, so any draw before
  // emit would land on an element that's about to be replaced.
  drawBufferWaveform(nodeId, bn.getPeaks(), len, bn.position, bn.state, bufferRange(node.args));
}

function drawBufferWaveform(
  nodeId: string,
  peaks: { values: Float32Array; bucketCount: number },
  bufferLen: number,
  cursor: number,
  state?: string,
  range?: [number, number] | null,
): void {
  const canvas = panGroup.querySelector<HTMLCanvasElement>(`.pn-buf-wave[data-buf-node-id="${nodeId}"]`);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const computed = getComputedStyle(canvas);
  const accent = computed.getPropertyValue("--pn-accent").trim() || "#00ff00";
  const dim    = computed.getPropertyValue("--pn-muted-deep").trim() || "rgba(0,255,0,0.3)";

  // Range overlay — drawn before the waveform so the PCM strokes paint on top.
  // Also covers a transient drag-selection (signaled via dataset.bufSelection).
  const sel = canvas.dataset.bufSelection;
  let overlay: [number, number] | null = range ?? null;
  if (sel) {
    const parts = sel.split(",").map(Number);
    if (parts.length === 2 && parts[0] < parts[1]) overlay = [parts[0], parts[1]];
  }
  if (overlay) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(overlay[0] * w, 0, (overlay[1] - overlay[0]) * w, h);
    ctx.globalAlpha = 1;
  }

  if (bufferLen === 0 || peaks.bucketCount === 0) {
    ctx.strokeStyle = dim;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    return;
  }

  // Peaks are interleaved (min,max) per bucket. Map each canvas column to a
  // span of buckets and aggregate min/max across them.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  const buckets = peaks.bucketCount;
  const v = peaks.values;
  for (let x = 0; x < w; x++) {
    const lo = Math.floor((x       * buckets) / w);
    const hi = Math.max(lo + 1, Math.floor(((x + 1) * buckets) / w));
    let mn =  Infinity, mx = -Infinity;
    for (let b = lo; b < hi && b < buckets; b++) {
      const bmn = v[b * 2];
      const bmx = v[b * 2 + 1];
      if (bmn < mn) mn = bmn;
      if (bmx > mx) mx = bmx;
    }
    if (!isFinite(mn) || mn > mx) continue;
    const y1 = h / 2 - mx * (h / 2);
    const y2 = h / 2 - mn * (h / 2);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y1);
    ctx.lineTo(x + 0.5, y2);
    ctx.stroke();
  }

  // While recording, the growing waveform itself is the indicator — drawing
  // a playhead at pos=0 (the position outlet's record-state value) would
  // park a misleading cursor at the left edge.
  if (state === "record") return;

  // Cursor — vertical line at the current normalized position.
  const cx = Math.max(0, Math.min(1, cursor)) * w;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

async function startAudio(): Promise<void> {
  await audioRuntime.start();
  audioGraph = new AudioGraph(audioRuntime, graph, subPatchManager);
  objectInteraction.setAudioGraph(audioGraph);
  canvas.setAudioGraph(audioGraph);
  subPatchManager.setAudioGraph(audioGraph);
  for (const s of scratchTabs.values()) s.interaction.setAudioGraph(audioGraph);
  jsEffectPanelController.setAudioGraph(audioGraph);
  browserPanelController.setAudioGraph(audioGraph);
  youtubePanelController.setAudioGraph(audioGraph);
  mixerPanelController.setAudioGraph(audioGraph);
  audioGraph.setBufferStateChangeCallback((nodeId) => {
    handleBufferStateChange(nodeId);
  });
  audioGraph.setAdsrDoneCallback((nodeId) => {
    objectInteraction.fireBang(nodeId, 1);
  });
  vizGraph.setVideoBufferStateChangeCallback((nodeId) => {
    handleVideoBufferStateChange(nodeId);
  });
  vizGraph.setBrowserNodeLookup((id) => audioGraph?.getBrowserNode(id) ?? null);
  vizGraph.setYouTubeNodeLookup((id) => audioGraph?.getYouTubeNode(id) ?? null);
  // Re-mount so any already-placed js~ panels can bind to their
  // freshly-constructed JsEffectNodes.
  jsEffectPanelController.mount(panGroup);
  browserPanelController.mount(panGroup);
  youtubePanelController.mount(panGroup);
  mixerPanelController.mount(panGroup);
  // Always start with the OS-default device on DSP enable. In Chrome that's
  // the entry with deviceId="default" (labeled "Default - <device name>",
  // e.g. "Default - MacBook Pro Microphone").
  try { await audioRuntime.setOutputDevice("default"); } catch { /* ignore */ }
  await audioGraph.setInputDevice("default");
  // Populate AFTER setInputDevice — getUserMedia in AdcNode.start unlocks
  // labels for input devices, so the dropdown can show "Default - MacBook Pro
  // Microphone" instead of an unnamed placeholder.
  await populateDevices();
  if (audioDeviceSel) audioDeviceSel.value = "default";
  if (audioInputSel)  audioInputSel.value  = "default";
  audioGraph.mountFftNodes(panGroup);
  startMeterLoop();
  setDspUi(true);
}

async function stopAudio(): Promise<void> {
  stopMeterLoop();
  audioGraph?.destroy();
  audioGraph = null;
  objectInteraction.setAudioGraph(undefined);
  subPatchManager.setAudioGraph(undefined);
  for (const s of scratchTabs.values()) s.interaction.setAudioGraph(undefined);
  jsEffectPanelController.setAudioGraph(null);
  browserPanelController.setAudioGraph(null);
  youtubePanelController.setAudioGraph(null);
  mixerPanelController.setAudioGraph(null);
  vizGraph.setBrowserNodeLookup(null);
  vizGraph.setYouTubeNodeLookup(null);
  await audioRuntime.stop();
  setDspUi(false);
}

// DSP toggle button
audioToggleBtn?.addEventListener("click", () => {
  if (!dspOn) startAudio(); else stopAudio();
});

// ── Patch mode (cable drawing/interaction) ────────────────────────────────
const patchModeBtn = document.getElementById("patch-mode-btn") as HTMLButtonElement | null;

function setPatchModeUi(on: boolean): void {
  setPatchModeState(on);
  if (patchModeBtn) patchModeBtn.setAttribute("aria-pressed", String(on));
  canvasArea.classList.toggle("is-patch-locked", !on);
  flashStatus(on ? "patch: on" : "patch: off");
}

patchModeBtn?.addEventListener("click", () => setPatchModeUi(!getPatchMode()));

// ── Snap to grid ──────────────────────────────────────────────────────────
const snapBtn = document.getElementById("snap-btn") as HTMLButtonElement | null;

function setSnapUi(on: boolean): void {
  setSnap(on);
  if (snapBtn) {
    snapBtn.setAttribute("aria-pressed", String(on));
    snapBtn.title = `Snap to grid (${on ? "on" : "off"})`;
  }
  flashStatus(on ? "snap: on" : "snap: off");
}

snapBtn?.addEventListener("click", () => setSnapUi(!getSnap()));

// Output device selector
audioDeviceSel?.addEventListener("change", () => {
  audioRuntime.setOutputDevice(audioDeviceSel.value);
});

// Input device selector
audioInputSel?.addEventListener("change", () => {
  audioGraph?.setInputDevice(audioInputSel.value);
});

// Master volume slider
masterVolSlider?.addEventListener("input", () => {
  const v = parseFloat(masterVolSlider.value);
  audioRuntime.masterVolume = v;
  if (masterVolReadout) masterVolReadout.textContent = String(Math.round(v * 100));
});

// ── SubPatch / Tab system ─────────────────────────────────────────────────────

const tabBarEl = document.getElementById("pn-tab-bar") as HTMLDivElement;
const tabManager = new TabManager(tabBarEl, panGroup, canvas);

const subPatchManager = new SubPatchManager(graph, objectInteraction, canvasArea);

subPatchManager.onTabOpen = (nodeId, label, session) => {
  tabManager.openSubPatch(nodeId, label, session);
};
subPatchManager.onTabRegister = (nodeId, label, session) => {
  tabManager.registerSubPatch(nodeId, label, session);
};
subPatchManager.onTabClose = (nodeId) => {
  tabManager.closeTab(nodeId);
};
tabManager.onLabelChange = (nodeId, label) => {
  subPatchManager.setLabel(nodeId, label);
};
// Scratch tabs: independent top-level patches. The "+" / cmd+t path opens
// a fresh blank canvas. Each scratch tab has its own graph + canvas + undo
// stack and is registered with patchSessionRegistry for global s/r and audio.
const scratchTabs = new Map<string, ScratchTabSession>();
let scratchSeq = 0;
function nextScratchId(): string { scratchSeq += 1; return `scratch-${scratchSeq}`; }

function addNewScratchTab(initialContent = "", explicitId?: string, label?: string): ScratchTabSession {
  const id = explicitId ?? nextScratchId();
  const session = new ScratchTabSession(id, canvasArea, initialContent);
  scratchTabs.set(id, session);
  tabManager.registerScratchTab(id, label ?? `scratch ${id.replace(/^scratch-/, "")}`, session, true);
  // Autosave whenever this scratch tab's graph changes so all tabs land in
  // localStorage together.
  session.graph.on("change", saveAllTabs);
  // If audio is running, plumb the live AudioGraph into this scratch's OIC so
  // its s~/r~/dac~/etc. work immediately.
  if (audioGraph) session.interaction.setAudioGraph(audioGraph);
  // Right-click → "Open <type> reference" works from any tab.
  session.canvasController.onOpenReferencePatch = openReferencePatch;
  saveAllTabs();
  return session;
}

function openReferencePatch(objectType: string): void {
  const ref = REFERENCE_PATCHES[objectType];
  if (!ref) return;
  const existing = scratchTabs.get(ref.tabId);
  if (existing) {
    // Reset to pristine state on every open so user edits never persist
    // into a "reference" tab.
    existing.graph.deserialize(ref.text);
    tabManager.switchTo(ref.tabId);
    return;
  }
  addNewScratchTab(ref.text, ref.tabId, ref.label);
}
canvas.onOpenReferencePatch = openReferencePatch;

tabManager.onAddTab = () => { addNewScratchTab(); };
tabManager.onScratchClose = (id) => {
  const session = scratchTabs.get(id);
  if (session) {
    session.destroy();
    scratchTabs.delete(id);
  }
  saveAllTabs();
};
tabManager.onMainActivate = () => {
  // Flush any render that was skipped while the main panGroup was hidden.
  // Also runs when no change was missed — render() is cheap and idempotent.
  if (deferredByHidden) {
    deferredByHidden = false;
    render();
    // render() recreates all .patch-object DOM nodes, so we must re-mount
    // presentation panels into the fresh [data-panel-for] divs. Normally
    // this runs via the graph.on("change") chain, but here render() is
    // called directly (not from a change event), so we do it explicitly.
    subPatchManager.mountPresentationPanels(panGroup);
  } else {
    cables.render();
  }
};

objectInteraction.setSubPatchManager(subPatchManager);
objectInteraction.setBufferRedrawCallback((nodeId) => {
  const bn = audioGraph?.getBufferNode(nodeId);
  const node = graph.nodes.get(nodeId)
    ?? subPatchManager.getSubPatchGraphs().flatMap(g => g.getNodes()).find(n => n.id === nodeId);
  if (!node || node.type !== "buffer~") return;
  // bn may be missing pre-DSP; render with empty peaks so the range +
  // selection overlays still draw on the resting waveform canvas.
  const peaks  = bn ? bn.getPeaks() : { values: new Float32Array(0), bucketCount: 0 };
  const len    = bn ? bn.bufferLength : 0;
  const cursor = bn ? bn.position     : 0;
  const state  = bn ? bn.state        : "stop";
  drawBufferWaveform(nodeId, peaks, len, cursor, state, bufferRange(node.args));
});

// ── Render ───────────────────────────────────────────────────────────────────

// Guard: true while a canvas change is propagating to the text panel, so the
// textarea input handler doesn't re-parse the text we just wrote.
let renderingToTextPanel = false;

function syncTextPanel(): void {
  const next = graph.serializeForDisplay();
  if (textArea.value === next) return;
  renderingToTextPanel = true;
  const hasFocus    = document.activeElement === textArea;
  const selStart    = hasFocus ? textArea.selectionStart : 0;
  const selEnd      = hasFocus ? textArea.selectionEnd   : 0;
  const scrollTop   = textArea.scrollTop;
  textArea.value = next;
  textArea.classList.remove("text-panel--error");
  if (hasFocus) textArea.setSelectionRange(selStart, selEnd);
  textArea.scrollTop = scrollTop;
  renderingToTextPanel = false;
}

let isRendering = false;
let needsRender = false;
let deferredByHidden = false;

function render(): void {
  // Skip while the main panGroup is hidden (a subPatch tab is active).
  // getBoundingClientRect returns zeros inside a display:none subtree, which
  // corrupts cable endpoints that read live DOM positions. Sync the text
  // panel so users still see graph edits in the side panel, then defer the
  // visual render until the main tab becomes active again.
  if (panGroup.style.display === "none") {
    deferredByHidden = true;
    syncTextPanel();
    return;
  }
  if (isRendering) { needsRender = true; return; }
  isRendering = true;

  try {
  // Remove only direct-child objects — do not descend into subPatch presentation panels
  panGroup.querySelectorAll<HTMLElement>(":scope > .patch-object").forEach(el => el.remove());

  // Re-render objects from graph
  for (const node of graph.getNodes()) {
    panGroup.appendChild(renderObject(node));
  }

  // Grow boxes whose inline args (route, select, t, pack/unpack, math ops, …)
  // would otherwise be ellipsized. Args on these objects carry semantic
  // weight (outlet order, match selectors), so clipping breaks the patch.
  panGroup.querySelectorAll<HTMLElement>(":scope > .patch-object").forEach(autoFitInlineArgsWidth);

  for (const node of graph.getNodes()) {
    if (node.type !== "codebox") continue;
    const host = panGroup.querySelector<HTMLElement>(
      `[data-node-id="${node.id}"] [data-codebox-node-id="${node.id}"]`,
    );
    if (host) {
      codeboxController.mountEditor(node, host);
    }
  }
  codeboxController.pruneEditors(new Set(graph.getNodes().map((node) => node.id)));

  // Mount patchViz live canvases into their DOM slots
  vizGraph.mountPatchViz(panGroup);

  // Mount vbuf* playback <video>s into their preview slots
  vizGraph.mountVideoBufferPreviews(panGroup);

  // Mount fft~ canvases into their screen slots
  audioGraph?.mountFftNodes(panGroup);

  // Mount inline dmx panels into their object bodies
  dmxPanelController.mount(panGroup);
  dmxPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline js~ panels
  jsEffectPanelController.mount(panGroup);
  jsEffectPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline reaperVideo panels
  reaperVideoPanelController.mount(panGroup);
  reaperVideoPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline browser~ panels
  browserPanelController.mount(panGroup);
  browserPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline youtube~ panels
  youtubePanelController.mount(panGroup);
  youtubePanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline mixer~ panels
  mixerPanelController.mount(panGroup);
  mixerPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline frame~ panels
  framePanelController.mount(panGroup);
  framePanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline cam* panels
  camPanelController.mount(panGroup);
  camPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline peer panels
  peerPanelController.mount(panGroup);
  peerPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount inline phoneTilt panels
  phoneTiltPanelController.mount(panGroup);
  phoneTiltPanelController.prune(new Set(graph.getNodes().map(n => n.id)));

  // Mount any private/local plugin objects (src/graph/localObjects/)
  mountLocalPlugins(panGroup, { graph, vizGraph });
  pruneLocalPlugins(new Set(graph.getNodes().map(n => n.id)));

  // Restore selection visual on re-render
  for (const id of canvas.getSelectedNodeIds()) {
    panGroup
      .querySelector(`[data-node-id="${id}"]`)
      ?.classList.add("patch-object--selected");
  }

  // Redraw cables
  cables.render();

  // Sync text panel — use compact display serialization (no raw base64 data URLs)
  syncTextPanel();

  // Sync status bar
  const n = graph.getNodes().length;
  objectCount.textContent = `${n} object${n === 1 ? "" : "s"}`;
  statusMode.textContent = "EDIT";

  // Expand scrollable canvas boundary to fit all nodes + margin
  canvas.updatePanGroupSize();

  } finally {
    isRendering = false;
  }

  if (needsRender) {
    needsRender = false;
    render();
  }
}

graph.on("change", render);
graph.on("change", () => subPatchManager.mountPresentationPanels(panGroup));
graph.on("change", () => subPatchManager.syncTabs());
graph.on("change", () => objectInteraction.reapplyTransientState());
graph.on("display", syncTextPanel);

// ── Text panel → canvas (bidirectional sync) ─────────────────────────────────

let textPanelDebounce: ReturnType<typeof setTimeout> | null = null;

textArea.addEventListener("input", () => {
  if (renderingToTextPanel) return;
  if (textPanelDebounce) clearTimeout(textPanelDebounce);

  textPanelDebounce = setTimeout(() => {
    textPanelDebounce = null;
    try {
      graph.deserialize(textArea.value);
      textArea.classList.remove("text-panel--error");
    } catch {
      textArea.classList.add("text-panel--error");
    }
  }, 350);
});

// ── Action list (replaces shortcuts panel) ───────────────────────────────────
// The action system is constructed below once flashStatus, savePatchToFile,
// and the other app fns are defined. This anchor just keeps the toolbar
// button wiring discoverable here next to the other toolbar wiring.
const shortcutsBtn = document.getElementById("shortcuts-btn");

// ── Console collapse ──────────────────────────────────────────────────────────

const consolePanel = document.getElementById("console-panel");
const consoleCollapseBtn = document.getElementById("console-collapse-btn");

function toggleConsole(): void {
  if (!consolePanel) return;
  const collapsed = consolePanel.classList.toggle("text-panel--collapsed");
  if (consoleCollapseBtn) {
    consoleCollapseBtn.title = collapsed ? "Expand console" : "Collapse console";
    consoleCollapseBtn.setAttribute("aria-label", collapsed ? "Expand console" : "Collapse console");
  }
  // Redraw cables — their endpoints depend on canvas width which just changed
  requestAnimationFrame(() => {
    cables.render();
    canvas.updatePanGroupSize();
  });
}

consoleCollapseBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleConsole();
});

// Clicking the header while collapsed re-expands
consolePanel?.querySelector(".text-panel-header")?.addEventListener("click", () => {
  if (consolePanel.classList.contains("text-panel--collapsed")) toggleConsole();
});

// ── Toolbar (controls row) collapse ──────────────────────────────────────────

const toolbarControls = document.getElementById("toolbar-controls");
const toolbarCollapseBtn = document.getElementById("toolbar-collapse-btn");

function toggleToolbarCollapse(): void {
  if (!toolbarControls || !toolbarCollapseBtn) return;
  const collapsed = toolbarControls.classList.toggle("toolbar--collapsed");
  toolbarCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
  toolbarCollapseBtn.title = collapsed ? "Expand toolbar" : "Collapse toolbar";
  toolbarCollapseBtn.setAttribute("aria-label", collapsed ? "Expand toolbar" : "Collapse toolbar");
  // Canvas height shifts when the controls row appears/disappears — redraw
  // cables (their endpoints read live DOM positions).
  requestAnimationFrame(() => {
    cables.render();
    canvas.updatePanGroupSize();
  });
}

toolbarCollapseBtn?.addEventListener("click", toggleToolbarCollapse);

// ── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "patchnet-patch";

interface SavedScratchTab { id: string; label: string; content: string; }
interface SavedTabsV1 { v: 1; main: string; scratchTabs: SavedScratchTab[]; }

function saveAllTabs(): void {
  try {
    const payload: SavedTabsV1 = {
      v: 1,
      main: graph.serialize(),
      scratchTabs: tabManager.getScratchTabs().map(t => ({
        id: t.id,
        label: t.label,
        content: t.session.serialize(),
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage unavailable (private browsing quota, etc.) — silently ignore
  }
}

function loadAllTabs(): boolean {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return false;
  // V1 format: JSON with {v, main, scratchTabs}.  Legacy format: bare patch
  // text. Detect by attempting a JSON.parse — if it fails or v is missing,
  // treat the value as legacy main-only content.
  let payload: SavedTabsV1 | null = null;
  try {
    const parsed = JSON.parse(saved);
    if (parsed && parsed.v === 1 && typeof parsed.main === "string") payload = parsed as SavedTabsV1;
  } catch { /* legacy plaintext */ }

  try {
    if (payload) {
      graph.deserialize(payload.main);
      for (const t of payload.scratchTabs) {
        // Track the highest seen scratch index so future nextScratchId() doesn't
        // collide with restored ids like "scratch-3" after a reload.
        const m = /^scratch-(\d+)$/.exec(t.id);
        if (m) scratchSeq = Math.max(scratchSeq, parseInt(m[1], 10));
        addNewScratchTab(t.content, t.id, t.label);
      }
      // Each addNewScratchTab call switched to the new tab; land on main.
      if (payload.scratchTabs.length > 0) tabManager.switchTo("main");
      // Restored scratch tabs each fired addNewScratchTab → saveAllTabs;
      // that's harmless (same payload re-written).
    } else {
      graph.deserialize(saved);
    }
    return true;
  } catch {
    return false;
  }
}

graph.on("change", saveAllTabs);

// Disk autosave (in addition to the localStorage autosave above). Active only
// once the user has set up an autosave handle via savePatchToFile(); writes are
// debounced so a flurry of changes results in a single overwrite.
let autosaveDebounceTimer: number | null = null;
graph.on("change", () => {
  if (!autosaveFileHandle) return;
  if (autosaveDebounceTimer != null) window.clearTimeout(autosaveDebounceTimer);
  autosaveDebounceTimer = window.setTimeout(async () => {
    if (!autosaveFileHandle) return;
    try {
      await writeHandle(autosaveFileHandle, graph.serialize());
    } catch {
      /* file may have been moved/deleted; drop the handle so the next
         manual save can re-prompt for a new one. */
      autosaveFileHandle = null;
    }
  }, 1500);
});

// ── Autosave to disk (dev only) ──────────────────────────────────────────────
// Posts the current patch to a Vite dev-server endpoint every 10 minutes, and
// also on demand when the dev server pushes a `patchnet:force-autosave` event.
// Lets Claude inspect the live patch without copy-paste from the browser.

if (import.meta.env.DEV) {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const autosaveFilename = (): string => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const weekday = WEEKDAYS[now.getDay()];
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `patch-${date}-${weekday}-${time}.patchnet`;
  };

  const autosaveToDisk = async (): Promise<void> => {
    try {
      await fetch("/__autosave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: autosaveFilename(),
          content: graph.serialize(),
        }),
      });
    } catch {
      // dev server gone — ignore
    }
  };

  setInterval(autosaveToDisk, 10 * 60 * 1000);

  if (import.meta.hot) {
    import.meta.hot.on("patchnet:force-autosave", autosaveToDisk);
  }
}

// ── Status flash ─────────────────────────────────────────────────────────────

let statusFlashTimer: ReturnType<typeof setTimeout> | null = null;

function flashStatus(msg: string): void {
  if (statusFlashTimer !== null) clearTimeout(statusFlashTimer);
  statusMode.textContent = msg;
  statusFlashTimer = setTimeout(() => {
    statusMode.textContent = "EDIT";
    statusFlashTimer = null;
  }, 3000);
}

// ── Share ─────────────────────────────────────────────────────────────────────

const shareBtn = document.getElementById("share-btn") as HTMLButtonElement | null;

async function sharePatch(): Promise<void> {
  const result = await buildShareUrl(graph);
  if ("error" in result) {
    flashStatus(result.error);
    return;
  }
  try {
    await navigator.clipboard.writeText(result.url);
    flashStatus("LINK COPIED");
  } catch {
    // Clipboard blocked (non-HTTPS / permissions) — show URL for manual copy
    flashStatus("COPY FAILED — check console");
    console.info("[patchNet] Share URL:", result.url);
  }
}

shareBtn?.addEventListener("click", sharePatch);

// ── File save / load ─────────────────────────────────────────────────────────

const PATCH_NAME_KEY = "patchnet-patch-name";

function getPatchName(): string {
  return (patchNameInput?.textContent ?? "").trim();
}

function sanitizeFilename(s: string): string {
  // Strip filesystem-hostile chars; collapse whitespace to dashes.
  return s.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 80);
}

function syncPatchTitle(): void {
  const name = getPatchName();
  document.title = name ? `${name} — patchNet` : "patchNet";
}

patchNameInput?.addEventListener("input", () => {
  try { localStorage.setItem(PATCH_NAME_KEY, getPatchName()); } catch { /* ignore */ }
  syncPatchTitle();
});
// contenteditable lets users press Enter to insert a newline — block that so
// the patch name stays single-line.
patchNameInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    patchNameInput.blur();
  }
});

try {
  const savedName = localStorage.getItem(PATCH_NAME_KEY);
  if (savedName && patchNameInput) patchNameInput.textContent = savedName;
} catch { /* ignore */ }
syncPatchTitle();

function makeStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// File System Access API state. The first manual save establishes a handle
// to the user's chosen file; every subsequent manual save (Cmd+S or button)
// writes to that same handle so it overwrites in place. We also try to set
// up a sibling "autosave" handle in the same user gesture so the on-change
// disk autosave can overwrite a single .patchnet-autosave file repeatedly.
type FSAFileHandle = {
  createWritable: () => Promise<FileSystemWritableFileStream>;
};
let manualFileHandle: FSAFileHandle | null = null;
let autosaveFileHandle: FSAFileHandle | null = null;

function fsaSupported(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

async function pickSaveFile(suggestedName: string, startIn?: FSAFileHandle): Promise<FSAFileHandle> {
  const opts: Record<string, unknown> = {
    suggestedName,
    types: [{ description: "patchNet patch", accept: { "application/octet-stream": [".patchnet"] } }],
  };
  if (startIn) opts.startIn = startIn;
  return await (window as unknown as { showSaveFilePicker: (o: typeof opts) => Promise<FSAFileHandle> })
    .showSaveFilePicker(opts);
}

async function writeHandle(handle: FSAFileHandle, text: string): Promise<void> {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

function downloadAsFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function savePatchToFile(): Promise<void> {
  const text = graph.serialize();
  const stamp = makeStamp();
  const base = sanitizeFilename(getPatchName()) || "patch";
  const fallbackName = `${base}-${stamp}.patchnet`;

  // ── Native (Tauri): use native Save As dialog ──────────────────────
  if (isNative) {
    const savedPath = await saveTextFile(text, fallbackName);
    if (savedPath) flashStatus("SAVED");
    return;
  }

  // ── Browser: File System Access API with download fallback ───────────
  if (!fsaSupported()) {
    downloadAsFile(text, fallbackName);
    return;
  }

  try {
    if (!manualFileHandle) {
      manualFileHandle = await pickSaveFile(fallbackName);
    }
    await writeHandle(manualFileHandle, text);
    flashStatus("SAVED");

    // Try to claim an autosave handle in the same user gesture so on-change
    // autosave can write silently. If the activation budget is gone or the
    // user dismisses, autosave just stays disk-disabled (localStorage still
    // works as before).
    if (!autosaveFileHandle) {
      try {
        autosaveFileHandle = await pickSaveFile(`${base}-autosave-${stamp}.patchnet`, manualFileHandle);
        flashStatus("AUTOSAVE ENABLED");
      } catch {
        /* user skipped or activation expired — fine */
      }
    }
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return; // user canceled
    // Picker not allowed (e.g. cross-origin iframe) — fall back to download.
    downloadAsFile(text, fallbackName);
  }
}

async function loadPatchFromFile(file: File): Promise<void> {
  const text = await file.text();
  if (dspOn) await stopAudio();
  try {
    graph.deserialize(text);
    textArea.classList.remove("text-panel--error");
  } catch {
    textArea.classList.add("text-panel--error");
    statusMode.textContent = "PARSE ERR";
  }
}

const saveBtn = document.getElementById("save-btn") as HTMLButtonElement | null;
const loadBtn = document.getElementById("load-btn") as HTMLButtonElement | null;
const loadFileInput = document.getElementById("load-file-input") as HTMLInputElement | null;

saveBtn?.addEventListener("click", savePatchToFile);

loadBtn?.addEventListener("click", async () => {
  if (isNative) {
    // Native: Tauri file picker — no <input> needed
    const result = await openTextFile();
    if (result) {
      if (dspOn) await stopAudio();
      try {
        graph.deserialize(result.content);
        textArea.classList.remove("text-panel--error");
        // Set patch name from filename (strip extension)
        const name = result.name.replace(/\.patchnet$/i, "");
        if (patchNameInput && name) patchNameInput.textContent = name;
        flashStatus("LOADED");
      } catch {
        textArea.classList.add("text-panel--error");
        statusMode.textContent = "PARSE ERR";
      }
    }
    return;
  }
  // Browser: hidden file input
  if (loadFileInput) {
    loadFileInput.value = "";
    loadFileInput.click();
  }
});

loadFileInput?.addEventListener("change", () => {
  const file = loadFileInput?.files?.[0];
  if (file) loadPatchFromFile(file);
});

// ── Action system ────────────────────────────────────────────────────────────
// Single registry+keymap+dispatcher pair. Active session (main / scratch /
// subpatch) is resolved through TabManager on every dispatch, so a chord
// pressed while a scratch tab is focused targets that scratch's graph.

const actionRegistry = new ActionRegistry();
actionRegistry.registerAll(BUILTIN_ACTIONS);
// Generated rows: one canvas.object.create.<type> per OBJECT_DEFS key
// (which already includes local-plugin object specs). B/T/S/A/M default
// keybindings are baked into the generated set.
actionRegistry.registerAll(generateObjectCreateActions());
// Local plugin contributions — last so plugins can shadow generated rows
// only by using a different id (registry rejects duplicates).
for (const a of collectLocalPluginActions()) {
  try { actionRegistry.register(a); }
  catch (err) { console.warn("[actions] plugin action skipped", err); }
}

const actionKeymap = new ActionKeymap(actionRegistry);
actionKeymap.loadUserOverrides();

let patchTerminal: PatchTerminalController | null = null;

const appActions: AppActionsAPI = {
  saveToFile: () => savePatchToFile(),
  openLoadPicker: () => {
    if (loadFileInput) {
      loadFileInput.value = "";
      loadFileInput.click();
    }
  },
  share: () => sharePatch(),
  toggleDsp: () => { if (!dspOn) startAudio(); else stopAudio(); },
  isDspOn: () => dspOn,
  togglePatchMode: () => setPatchModeUi(!getPatchMode()),
  isPatchMode: () => getPatchMode(),
  toggleToolbar: toggleToolbarCollapse,
  toggleConsole,
  togglePatchTerminal: () => patchTerminal?.toggle(),
  newScratchTab: () => { addNewScratchTab(); },
};

function buildActionContext(): ActionContext {
  const session = tabManager.getActiveSession();
  const activeGraph = session?.graph ?? graph;
  const activeCanvas = session?.canvasController ?? canvas;
  const activeInteraction = session?.interaction ?? objectInteraction;
  const activeUndo = session?.undo ?? undoManager;
  return {
    graph: activeGraph,
    canvas: activeCanvas,
    interaction: activeInteraction,
    undo: activeUndo,
    app: appActions,
    openActionList: () => actionListDialog.toggle(),
    flashStatus,
    registry: actionRegistry,
    keymap: actionKeymap,
  };
}

const actionDispatcher = new ActionDispatcher(actionRegistry, actionKeymap, buildActionContext);
patchTerminal = new PatchTerminalController(buildActionContext);
// Restore user-defined macros into the action registry now that ctx is wired
// up. Persistence is best-effort — silent on localStorage failures.
patchTerminal.loadMacros(buildActionContext());

const actionListDialog = new ActionListDialog(
  actionRegistry,
  actionKeymap,
  buildActionContext,
  (id) => actionDispatcher.run(id),
  // "New action…" form posts straight into the macro engine.
  (spec) => patchTerminal.createMacro(spec),
);

actionDispatcher.attachToDocument();
shortcutsBtn?.addEventListener("click", () => actionListDialog.toggle());

// Restore saved patch — prefer a shared URL, then localStorage, then blank slate.
(async () => {
  const sharedText = await loadFromShareUrl();
  if (sharedText) {
    history.replaceState({}, "", window.location.pathname);
    try {
      graph.deserialize(sharedText);
      flashStatus("PATCH LOADED FROM LINK");
    } catch {
      flashStatus("SHARED PATCH FAILED TO LOAD");
    }
  } else if (!loadAllTabs()) {
    graph.addNode("button", 96, 88);
  }

  requestAnimationFrame(() => {
    const nodes = graph.getNodes();
    let centerX = 0;
    let centerY = 0;

    if (nodes.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of nodes) {
        const def = getObjectDef(node.type);
        const w   = node.width  ?? def.defaultWidth  ?? 100;
        const h   = node.height ?? def.defaultHeight ?? 30;
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + w);
        maxY = Math.max(maxY, node.y + h);
      }
      centerX = (minX + maxX) / 2;
      centerY = (minY + maxY) / 2;
    }

    canvasArea.scrollLeft = Math.max(0, Math.round(centerX + CANVAS_LEFT_GUTTER_PX - canvasArea.clientWidth  / 2));
    canvasArea.scrollTop  = Math.max(0, Math.round(centerY + CANVAS_TOP_GUTTER_PX  - canvasArea.clientHeight / 2));
  });
})();

// ── Scroll bounds ────────────────────────────────────────────────────────────
// Prevent the user from scrolling more than SCROLL_PAD pixels (screen-space)
// away from the patch bounding box in any direction. Patch bbox is in
// intrinsic world coords; scrollLeft/Top are in zoomed content space, so we
// scale by the current zoom before clamping.

const SCROLL_PAD = 600;

function patchScrollBounds() {
  const nodes = graph.getNodes();
  if (nodes.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    const def = getObjectDef(node.type);
    const w   = node.width  ?? def.defaultWidth  ?? 100;
    const h   = node.height ?? def.defaultHeight ?? 30;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + w);
    maxY = Math.max(maxY, node.y + h);
  }

  const z = getZoom();
  const lo_x = minX * z + CANVAS_LEFT_GUTTER_PX - SCROLL_PAD;
  const hi_x = maxX * z + CANVAS_LEFT_GUTTER_PX + SCROLL_PAD - canvasArea.clientWidth;
  const lo_y = minY * z + CANVAS_TOP_GUTTER_PX  - SCROLL_PAD;
  const hi_y = maxY * z + CANVAS_TOP_GUTTER_PX  + SCROLL_PAD - canvasArea.clientHeight;

  return {
    minX: Math.max(0, lo_x),
    maxX: Math.max(Math.max(0, lo_x), hi_x),
    minY: Math.max(0, lo_y),
    maxY: Math.max(Math.max(0, lo_y), hi_y),
  };
}

let clampingScroll = false;
canvasArea.addEventListener("scroll", () => {
  if (clampingScroll) return;
  const b = patchScrollBounds();
  if (!b) return;

  const clampedLeft = Math.max(b.minX, Math.min(b.maxX, canvasArea.scrollLeft));
  const clampedTop  = Math.max(b.minY, Math.min(b.maxY, canvasArea.scrollTop));

  if (clampedLeft !== canvasArea.scrollLeft || clampedTop !== canvasArea.scrollTop) {
    clampingScroll = true;
    canvasArea.scrollLeft = clampedLeft;
    canvasArea.scrollTop  = clampedTop;
    clampingScroll = false;
  }
});

window.addEventListener("beforeunload", () => {
  subPatchManager.destroy();
  codeboxController.destroy();
  vizGraph.destroy();
  dmxPanelController.destroy();
  jsEffectPanelController.destroy();
  reaperVideoPanelController.destroy();
  mixerPanelController.destroy();
  browserPanelController.destroy();
  youtubePanelController.destroy();
  framePanelController.destroy();
  camPanelController.destroy();
  peerPanelController.destroy();
  peerRegistry.destroyAll();
  phoneTiltPanelController.destroy();
  phoneSensorRegistry.destroyAll();
  dmxGraph.destroy();
  undoManager.destroy();
});

// ── Dev debug handle ──────────────────────────────────────────────────────────
// Exposes live runtime state on window so MCP-driven evaluation tools (Chrome
// DevTools / Playwright) can inspect the graph without us writing one-shot
// helpers per session. Audio graph is wrapped in a getter because it's created
// on DSP start and nulled on stop.
if (import.meta.env.DEV) {
  Object.defineProperty(window, "__patchnet", {
    value: {
      graph,
      vizGraph,
      dmxGraph,
      cables,
      canvas,
      objectInteraction,
      subPatchManager,
      undoManager,
      get audioGraph() { return audioGraph; },
      get dspOn() { return dspOn; },
    },
    configurable: false,
    writable: false,
  });
}

// Block cursor appearance is handled natively via caret-shape: block + caret-color

// on all input/textarea elements in shell.css — no JS cursor div needed.
