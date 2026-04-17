import "./fonts.css";
import "./tokens.css";
import "./shell.css";

import { initCrtOverlayScroll } from "./crtOverlaySync";
import { PatchGraph } from "./graph/PatchGraph";
import { renderObject } from "./canvas/ObjectRenderer";
import { CableRenderer } from "./canvas/CableRenderer";
import { CanvasController } from "./canvas/CanvasController";
import { DragController } from "./canvas/DragController";
import { CableDrawController } from "./canvas/CableDrawController";
import { ResizeController } from "./canvas/ResizeController";
import { ObjectInteractionController } from "./canvas/ObjectInteractionController";
import { ShortcutsPanel } from "./canvas/ShortcutsPanel";
import { PortTooltip } from "./canvas/PortTooltip";
import { VisualizerObjectUI } from "./canvas/VisualizerObjectUI";
import { CodeboxController } from "./canvas/CodeboxController";
import { CANVAS_LEFT_GUTTER_PX, CANVAS_TOP_GUTTER_PX } from "./canvas/canvasSpace";
import { getObjectDef } from "./graph/objectDefs";
import { UndoManager } from "./graph/UndoManager";
import { AudioRuntime } from "./runtime/AudioRuntime";
import { AudioGraph } from "./runtime/AudioGraph";
import { VisualizerRuntime } from "./runtime/VisualizerRuntime";
import { VisualizerGraph } from "./runtime/VisualizerGraph";

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
const masterVolSlider = document.getElementById("master-vol") as HTMLInputElement | null;
const masterVolReadout = document.getElementById("master-vol-readout") as HTMLSpanElement | null;

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
  }
});
// Controllers self-register listeners on construction
new DragController(panGroup, graph, undefined, (nodeId, x, y) => {
  // Silently update node position during drag so CableRenderer can read it
  const node = graph.nodes.get(nodeId);
  if (node) { node.x = x; node.y = y; }
  cables.render();
  syncTextPanel();
}, () => canvas.getSelectedNodeIds(), (newIds) => {
  // After Cmd+drag clone, select the new copies
  canvas.selectNodes(newIds);
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

// ── Visualizer runtime ────────────────────────────────────────────────────────

VisualizerRuntime.getInstance(); // initialise singleton
const vizGraph = new VisualizerGraph(graph);
objectInteraction.setVisualizerGraph(vizGraph);
vizGraph.setObjectInteraction(objectInteraction);
canvas.setVisualizerGraph(vizGraph);
new VisualizerObjectUI(panGroup, graph, vizGraph);

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
  if (!audioDeviceSel) return;
  const devices = await audioRuntime.getOutputDevices();
  // Clear existing options beyond the default
  while (audioDeviceSel.options.length > 1) audioDeviceSel.remove(1);
  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Output ${audioDeviceSel.options.length}`;
    audioDeviceSel.appendChild(opt);
  }
}

async function startAudio(): Promise<void> {
  await audioRuntime.start();
  audioGraph = new AudioGraph(audioRuntime, graph);
  objectInteraction.setAudioGraph(audioGraph);
  await populateDevices();
  setDspUi(true);
}

async function stopAudio(): Promise<void> {
  audioGraph?.destroy();
  audioGraph = null;
  objectInteraction.setAudioGraph(undefined);
  await audioRuntime.stop();
  setDspUi(false);
}

// DSP toggle button
audioToggleBtn?.addEventListener("click", () => {
  if (!dspOn) startAudio(); else stopAudio();
});

// Device selector
audioDeviceSel?.addEventListener("change", () => {
  audioRuntime.setOutputDevice(audioDeviceSel.value);
});

// Master volume slider
masterVolSlider?.addEventListener("input", () => {
  const v = parseFloat(masterVolSlider.value);
  audioRuntime.masterVolume = v;
  if (masterVolReadout) masterVolReadout.textContent = String(Math.round(v * 100));
});

// ── Render ───────────────────────────────────────────────────────────────────

// Guard: true while a canvas change is propagating to the text panel, so the
// textarea input handler doesn't re-parse the text we just wrote.
let renderingToTextPanel = false;

function syncTextPanel(): void {
  const next = graph.serialize();
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

function render(): void {
  // Remove all object elements (not the SVG)
  const existingObjects = panGroup.querySelectorAll<HTMLElement>(".patch-object");
  existingObjects.forEach((el) => el.remove());

  // Re-render objects from graph
  for (const node of graph.getNodes()) {
    panGroup.appendChild(renderObject(node));
  }

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
}

graph.on("change", render);
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

// ── Shortcuts panel ──────────────────────────────────────────────────────────

const shortcuts = new ShortcutsPanel();
const shortcutsBtn = document.getElementById("shortcuts-btn");
shortcutsBtn?.addEventListener("click", () => shortcuts.toggle());

// ── Persistence ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "patchnet-patch";

function savePatch(): void {
  try {
    localStorage.setItem(STORAGE_KEY, graph.serialize());
  } catch {
    // localStorage unavailable (private browsing quota, etc.) — silently ignore
  }
}

function loadPatch(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return false;
    graph.deserialize(saved);
    return true;
  } catch {
    return false;
  }
}

graph.on("change", savePatch);

// Restore saved patch, or seed with a starter object on first load
if (!loadPatch()) {
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

// ── Scroll bounds ────────────────────────────────────────────────────────────
// Prevent the user from scrolling more than SCROLL_PAD pixels away from the
// patch bounding box in any direction.

const SCROLL_PAD = 400;

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

  // Convert patch bbox to scroll-space and add padding
  const lo_x = minX + CANVAS_LEFT_GUTTER_PX - SCROLL_PAD;
  const hi_x = maxX + CANVAS_LEFT_GUTTER_PX + SCROLL_PAD - canvasArea.clientWidth;
  const lo_y = minY + CANVAS_TOP_GUTTER_PX  - SCROLL_PAD;
  const hi_y = maxY + CANVAS_TOP_GUTTER_PX  + SCROLL_PAD - canvasArea.clientHeight;

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
  codeboxController.destroy();
  vizGraph.destroy();
  undoManager.destroy();
});

// Block cursor appearance is handled natively via caret-shape: block + caret-color
// on all input/textarea elements in shell.css — no JS cursor div needed.
