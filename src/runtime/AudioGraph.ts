import { AudioRuntime } from "./AudioRuntime";
import { ClickNode } from "./ClickNode";
import { DacNode } from "./DacNode";
import { AdcNode } from "./AdcNode";
import { FftAnalyzerNode } from "./FftAnalyzerNode";
import type { PatchGraph } from "../graph/PatchGraph";

export interface MeterInfo {
  level: number;
  l?: number;
  r?: number;
}

export class AudioGraph {
  private readonly runtime: AudioRuntime;
  private readonly graph: PatchGraph;

  private clickNodes        = new Map<string, ClickNode>();
  private dacNodes          = new Map<string, DacNode>();
  private adcNodes          = new Map<string, AdcNode>();
  private fftNodes          = new Map<string, FftAnalyzerNode>();
  private clickTriggerTimes = new Map<string, number>();

  private unsubscribe: () => void;

  constructor(runtime: AudioRuntime, graph: PatchGraph) {
    this.runtime = runtime;
    this.graph   = graph;
    this.unsubscribe = this.graph.on("change", () => this.sync());
    this.sync();
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
  getFftBandLevels(): Map<string, readonly [number, number, number, number]> {
    const out = new Map<string, readonly [number, number, number, number]>();
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

  destroy(): void {
    this.unsubscribe();
    this.clickNodes.clear();
    this.dacNodes.clear();
    for (const adc of this.adcNodes.values()) adc.destroy();
    this.adcNodes.clear();
    for (const fft of this.fftNodes.values()) fft.destroy();
    this.fftNodes.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private sync(): void {
    const activeNodeIds = new Set(this.graph.getNodes().map(n => n.id));

    for (const id of this.clickNodes.keys()) {
      if (!activeNodeIds.has(id)) this.clickNodes.delete(id);
    }
    for (const id of this.dacNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.dacNodes.get(id)?.destroy(); this.dacNodes.delete(id); }
    }
    for (const id of this.adcNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.adcNodes.get(id)?.destroy(); this.adcNodes.delete(id); }
    }
    for (const id of this.fftNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.fftNodes.get(id)?.destroy(); this.fftNodes.delete(id); }
    }

    if (!this.runtime.isStarted) return;

    for (const node of this.graph.getNodes()) {
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
      if (node.type === "fft~" && !this.fftNodes.has(node.id)) {
        this.fftNodes.set(node.id, new FftAnalyzerNode(this.runtime));
      }
    }

    this.rewireConnections();
  }

  private rewireConnections(): void {
    for (const click of this.clickNodes.values()) click.disconnect();
    for (const adc of this.adcNodes.values()) adc.disconnect();

    for (const edge of this.graph.getEdges()) {
      const fromNode = this.graph.nodes.get(edge.fromNodeId);
      const toNode   = this.graph.nodes.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;

      // Resolve destination input node (dac~ or fft~ both expose inputNode)
      let destInput: AudioNode | null = null;
      if (toNode.type === "dac~") {
        destInput = this.dacNodes.get(edge.toNodeId)?.inputNode ?? null;
      } else if (toNode.type === "fft~") {
        destInput = this.fftNodes.get(edge.toNodeId)?.inputNode ?? null;
      }

      if (!destInput) continue;

      if (fromNode.type === "click~") {
        this.clickNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
      } else if (fromNode.type === "adc~") {
        this.adcNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
      }
    }
  }
}
