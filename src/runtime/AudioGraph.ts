import { AudioRuntime } from "./AudioRuntime";
import { ClickNode } from "./ClickNode";
import { DacNode } from "./DacNode";
import { AdcNode } from "./AdcNode";
import { BrowserNode } from "./BrowserNode";
import { FftAnalyzerNode } from "./FftAnalyzerNode";
import { JsEffectNode } from "./JsEffectNode";
import { fftBandCount } from "../graph/objectDefs";
import type { PatchGraph } from "../graph/PatchGraph";
import type { SubPatchManager } from "../canvas/SubPatchManager";

// Plain-JS worklet so Vite can ship it as an asset the browser loads
// directly via audioWorklet.addModule(). Under Vite's default 4 KB inline
// threshold, small worklet files get inlined as a data: URL — which is
// fine; Chromium/Safari/Firefox all accept data: URLs in addModule().
const JSFX_WORKLET_URL = new URL("./jsfx/jsfx-worklet.js", import.meta.url).href;

export interface MeterInfo {
  level: number;
  l?: number;
  r?: number;
}

export class AudioGraph {
  private readonly runtime: AudioRuntime;
  private readonly graph: PatchGraph;
  private subPatchManager: SubPatchManager | null = null;

  private clickNodes        = new Map<string, ClickNode>();
  private dacNodes          = new Map<string, DacNode>();
  private adcNodes          = new Map<string, AdcNode>();
  private browserNodes      = new Map<string, BrowserNode>();
  private fftNodes          = new Map<string, FftAnalyzerNode>();
  private jsEffectNodes     = new Map<string, JsEffectNode>();
  private jsEffectPending   = new Set<string>();
  private jsEffectReadyListeners = new Map<string, Set<(node: JsEffectNode) => void>>();
  private jsfxWorkletReady: Promise<void> | null = null;
  private clickTriggerTimes = new Map<string, number>();

  private unsubscribe: () => void;

  constructor(runtime: AudioRuntime, graph: PatchGraph, subPatchManager?: SubPatchManager) {
    this.runtime = runtime;
    this.graph   = graph;
    this.subPatchManager = subPatchManager ?? null;
    this.unsubscribe = this.graph.on("change", () => this.sync());
    this.sync();
  }

  private allGraphs(): PatchGraph[] {
    return [this.graph, ...(this.subPatchManager?.getSubPatchGraphs() ?? [])];
  }

  triggerClick(nodeId: string): void {
    if (this.clickNodes.has(nodeId)) {
      this.clickNodes.get(nodeId)!.trigger();
      this.clickTriggerTimes.set(nodeId, performance.now());
    }
  }

  getMeterLevels(): Map<string, MeterInfo> {
    const out = new Map<string, MeterInfo>();
    const now = performance.now();
    for (const [id, dac] of this.dacNodes) {
      out.set(id, { level: dac.level, l: dac.levelL, r: dac.levelR });
    }
    for (const [id, adc] of this.adcNodes) {
      out.set(id, { level: adc.level, l: adc.levelL, r: adc.levelR });
    }
    for (const [id, br] of this.browserNodes) {
      out.set(id, { level: br.level, l: br.levelL, r: br.levelR });
    }
    for (const id of this.clickNodes.keys()) {
      const t = this.clickTriggerTimes.get(id) ?? 0;
      out.set(id, { level: Math.max(0, Math.exp(-((now - t) / 80))) });
    }
    for (const id of this.fftNodes.keys()) {
      const bands = this.fftNodes.get(id)!.bandLevels;
      out.set(id, { level: Math.max(...bands) });
    }
    return out;
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.runtime.inputDeviceId = deviceId;
    for (const [id, adc] of this.adcNodes) {
      adc.destroy();
      const fresh = new AdcNode(this.runtime);
      await fresh.start(deviceId || undefined);
      this.adcNodes.set(id, fresh);
    }
    this.rewireConnections();
  }

  /** Re-parent each fft~ canvas into its mount slot after canvas render. */
  mountFftNodes(panGroup: HTMLElement): void {
    for (const [id, fft] of this.fftNodes) {
      const mount = panGroup.querySelector<HTMLElement>(`[data-fft-node-id="${id}"]`);
      if (mount && !mount.contains(fft.canvas)) {
        mount.innerHTML = "";
        mount.appendChild(fft.canvas);
      }
    }
  }

  /** Current band levels per fft~ node — used by main.ts to push outlet values. */
  getFftBandLevels(): Map<string, readonly number[]> {
    const out = new Map<string, readonly number[]>();
    for (const [id, fft] of this.fftNodes) out.set(id, fft.bandLevels);
    return out;
  }

  /** Draw all fft~ canvases and update band-value readouts in the DOM. */
  updateFftDisplay(panGroup: HTMLElement): void {
    for (const [id, fft] of this.fftNodes) {
      fft.draw();
      const el = panGroup.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
      if (!el) continue;
      const vals = el.querySelectorAll<HTMLElement>(".pn-fft-band-val");
      const bands = fft.bandLevels;
      vals.forEach((span, i) => {
        span.textContent = bands[i] !== undefined ? bands[i].toFixed(2) : "0.00";
      });
    }
  }

  /** Runtime node for a js~ patch node, once the worklet module has loaded.
   *  Returns null until the async worklet registration completes. */
  getJsEffectNode(nodeId: string): JsEffectNode | null {
    return this.jsEffectNodes.get(nodeId) ?? null;
  }

  getBrowserNode(nodeId: string): BrowserNode | null {
    return this.browserNodes.get(nodeId) ?? null;
  }

  /** Fires once the JsEffectNode for `nodeId` is ready (worklet loaded +
   *  AudioWorkletNode constructed). Useful for the panel to push initial
   *  code/slider state the first time. Fires immediately if already ready.
   *  Returns an unsubscribe function. */
  onJsEffectReady(nodeId: string, listener: (node: JsEffectNode) => void): () => void {
    const existing = this.jsEffectNodes.get(nodeId);
    if (existing) {
      listener(existing);
      return () => { /* no-op: fired synchronously, nothing to clean up */ };
    }
    if (!this.jsEffectReadyListeners.has(nodeId)) {
      this.jsEffectReadyListeners.set(nodeId, new Set());
    }
    const set = this.jsEffectReadyListeners.get(nodeId)!;
    set.add(listener);
    return () => { set.delete(listener); };
  }

  destroy(): void {
    this.unsubscribe();
    this.clickNodes.clear();
    this.dacNodes.clear();
    for (const adc of this.adcNodes.values()) adc.destroy();
    this.adcNodes.clear();
    for (const br of this.browserNodes.values()) br.destroy();
    this.browserNodes.clear();
    for (const fft of this.fftNodes.values()) fft.destroy();
    this.fftNodes.clear();
    for (const js of this.jsEffectNodes.values()) js.destroy();
    this.jsEffectNodes.clear();
    this.jsEffectPending.clear();
    this.jsEffectReadyListeners.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private ensureJsfxWorklet(): Promise<void> {
    if (this.jsfxWorkletReady) return this.jsfxWorkletReady;
    this.jsfxWorkletReady = this.runtime.context.audioWorklet
      .addModule(JSFX_WORKLET_URL)
      .catch((err) => {
        // Reset on failure so a later sync() retries rather than being
        // permanently stuck. This path is hit in dev if Vite hasn't emitted
        // the worklet chunk yet; a second sync() after the module is ready
        // succeeds.
        console.warn("[AudioGraph] jsfx worklet load failed:", err);
        this.jsfxWorkletReady = null;
        throw err;
      });
    return this.jsfxWorkletReady;
  }

  private sync(): void {
    const graphs = this.allGraphs();
    const activeNodeIds = new Set(graphs.flatMap(g => g.getNodes().map(n => n.id)));

    for (const id of this.clickNodes.keys()) {
      if (!activeNodeIds.has(id)) this.clickNodes.delete(id);
    }
    for (const id of this.dacNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.dacNodes.get(id)?.destroy(); this.dacNodes.delete(id); }
    }
    for (const id of this.adcNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.adcNodes.get(id)?.destroy(); this.adcNodes.delete(id); }
    }
    for (const id of this.browserNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.browserNodes.get(id)?.destroy(); this.browserNodes.delete(id); }
    }
    for (const id of this.fftNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.fftNodes.get(id)?.destroy(); this.fftNodes.delete(id); }
    }
    for (const id of this.jsEffectNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.jsEffectNodes.get(id)?.destroy(); this.jsEffectNodes.delete(id); }
    }
    for (const id of Array.from(this.jsEffectPending)) {
      if (!activeNodeIds.has(id)) this.jsEffectPending.delete(id);
    }
    for (const id of Array.from(this.jsEffectReadyListeners.keys())) {
      if (!activeNodeIds.has(id)) this.jsEffectReadyListeners.delete(id);
    }

    if (!this.runtime.isStarted) return;

    for (const g of graphs) {
      for (const node of g.getNodes()) {
        if (node.type === "click~" && !this.clickNodes.has(node.id)) {
          this.clickNodes.set(node.id, new ClickNode(this.runtime));
        }
        if (node.type === "dac~" && !this.dacNodes.has(node.id)) {
          this.dacNodes.set(node.id, new DacNode(this.runtime));
        }
        if (node.type === "adc~" && !this.adcNodes.has(node.id)) {
          const adc = new AdcNode(this.runtime);
          this.adcNodes.set(node.id, adc);
          adc.start(this.runtime.inputDeviceId || undefined)
            .then(() => this.rewireConnections())
            .catch(() => {});
        }
        if (node.type === "browser~" && !this.browserNodes.has(node.id)) {
          // Capture is user-gesture-only, so do not auto-start — the panel
          // triggers BrowserNode.capture() when the user clicks the button.
          const br = new BrowserNode(this.runtime);
          br.setOnStateChange(() => this.rewireConnections());
          this.browserNodes.set(node.id, br);
        }
        if (node.type === "fft~") {
          const bands = fftBandCount(node.args);
          const existing = this.fftNodes.get(node.id);
          if (!existing) {
            this.fftNodes.set(node.id, new FftAnalyzerNode(this.runtime, bands));
          } else if (existing.bandCount !== bands) {
            existing.setBandCount(bands);
          }
        }
        if (node.type === "js~"
            && !this.jsEffectNodes.has(node.id)
            && !this.jsEffectPending.has(node.id)) {
          const nodeId = node.id;
          this.jsEffectPending.add(nodeId);
          this.ensureJsfxWorklet()
            .then(() => {
              this.jsEffectPending.delete(nodeId);
              // If the node was deleted while we were awaiting, bail.
              const stillActive = this.allGraphs()
                .some(g => g.nodes.has(nodeId));
              if (!stillActive) return;
              if (this.jsEffectNodes.has(nodeId)) return;
              const fresh = new JsEffectNode(this.runtime);
              this.jsEffectNodes.set(nodeId, fresh);
              const listeners = this.jsEffectReadyListeners.get(nodeId);
              if (listeners) {
                for (const l of Array.from(listeners)) l(fresh);
              }
              this.rewireConnections();
            })
            .catch(() => { this.jsEffectPending.delete(nodeId); });
        }
      }
    }

    this.rewireConnections();
  }

  private rewireConnections(): void {
    for (const click of this.clickNodes.values()) click.disconnect();
    for (const adc of this.adcNodes.values()) adc.disconnect();
    for (const br of this.browserNodes.values()) br.disconnect();
    for (const js of this.jsEffectNodes.values()) js.disconnect();

    for (const g of this.allGraphs()) {
    for (const edge of g.getEdges()) {
      const fromNode = g.nodes.get(edge.fromNodeId);
      const toNode   = g.nodes.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;

      // Resolve destination input node. dac~, fft~ expose `inputNode`; js~
      // exposes `input` (stereo merger) and acts as both a sink and a source.
      let destInput: AudioNode | null = null;
      if (toNode.type === "dac~") {
        destInput = this.dacNodes.get(edge.toNodeId)?.inputNode ?? null;
      } else if (toNode.type === "fft~") {
        destInput = this.fftNodes.get(edge.toNodeId)?.inputNode ?? null;
      } else if (toNode.type === "js~") {
        destInput = this.jsEffectNodes.get(edge.toNodeId)?.input ?? null;
      }

      if (!destInput) continue;

      if (fromNode.type === "click~") {
        this.clickNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
      } else if (fromNode.type === "adc~") {
        this.adcNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
      } else if (fromNode.type === "browser~") {
        // Outlets 0/1 are audio L/R; outlet 2 is video (handled in VisualizerGraph).
        if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
          this.browserNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
        }
      } else if (fromNode.type === "js~") {
        this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, edge.toInlet);
      }
    }
    }
  }
}
