import { AudioRuntime } from "./AudioRuntime";
import { ClickNode } from "./ClickNode";
import { DacNode } from "./DacNode";
import { AdcNode } from "./AdcNode";
import { BrowserNode } from "./BrowserNode";
import { YouTubeNode } from "./YouTubeNode";
import { parseYouTubeUrl } from "./youtube/parseUrl";
import { FftAnalyzerNode } from "./FftAnalyzerNode";
import { JsEffectNode } from "./JsEffectNode";
import { MixerNode } from "./MixerNode";
import { BufferNode } from "./BufferNode";
import { bufferStorage } from "./buffer/BufferStorage";
import { bufferMaxLen, bufferMode, fftBandCount, mixerChannelCount } from "../graph/objectDefs";
import type { PatchGraph } from "../graph/PatchGraph";
import type { SubPatchManager } from "../canvas/SubPatchManager";

// Plain-JS worklet so Vite can ship it as an asset the browser loads
// directly via audioWorklet.addModule(). Under Vite's default 4 KB inline
// threshold, small worklet files get inlined as a data: URL — which is
// fine; Chromium/Safari/Firefox all accept data: URLs in addModule().
const JSFX_WORKLET_URL = new URL("./jsfx/jsfx-worklet.js", import.meta.url).href;
const BUFFER_WORKLET_URL = new URL("./buffer/buffer-worklet.js", import.meta.url).href;

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
  private youtubeNodes      = new Map<string, YouTubeNode>();
  private fftNodes          = new Map<string, FftAnalyzerNode>();
  private jsEffectNodes     = new Map<string, JsEffectNode>();
  private mixerNodes        = new Map<string, MixerNode>();
  private bufferNodes       = new Map<string, BufferNode>();
  private bufferPending     = new Set<string>();
  private jsEffectPending   = new Set<string>();
  private jsEffectReadyListeners = new Map<string, Set<(node: JsEffectNode) => void>>();
  private jsfxWorkletReady: Promise<void> | null = null;
  private bufferWorkletReady: Promise<void> | null = null;
  private bufferStateListeners = new Map<string, () => void>();
  private bufferStateChangeCallback: ((nodeId: string) => void) | null = null;
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
    for (const [id, yt] of this.youtubeNodes) {
      out.set(id, { level: yt.level, l: yt.levelL, r: yt.levelR });
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

  getYouTubeNode(nodeId: string): YouTubeNode | null {
    return this.youtubeNodes.get(nodeId) ?? null;
  }

  getMixerNode(nodeId: string): MixerNode | null {
    return this.mixerNodes.get(nodeId) ?? null;
  }

  getBufferNode(nodeId: string): BufferNode | null {
    return this.bufferNodes.get(nodeId) ?? null;
  }

  /** Subscribe to transport / position changes on any buffer~ node so the UI
   *  layer can re-render or update the position outlet. Single global cb. */
  setBufferStateChangeCallback(cb: ((nodeId: string) => void) | null): void {
    this.bufferStateChangeCallback = cb;
  }

  /** Snapshot of normalized positions per buffer~ node — read by the rAF
   *  tick to push values out the position outlet. */
  getBufferPositions(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, bn] of this.bufferNodes) out.set(id, bn.position);
    return out;
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
    for (const yt of this.youtubeNodes.values()) yt.destroy();
    this.youtubeNodes.clear();
    for (const fft of this.fftNodes.values()) fft.destroy();
    this.fftNodes.clear();
    for (const js of this.jsEffectNodes.values()) js.destroy();
    this.jsEffectNodes.clear();
    this.jsEffectPending.clear();
    this.jsEffectReadyListeners.clear();
    for (const mx of this.mixerNodes.values()) mx.destroy();
    this.mixerNodes.clear();
    for (const bn of this.bufferNodes.values()) bn.destroy();
    this.bufferNodes.clear();
    this.bufferPending.clear();
    this.bufferStateListeners.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private ensureBufferWorklet(): Promise<void> {
    if (this.bufferWorkletReady) return this.bufferWorkletReady;
    this.bufferWorkletReady = this.runtime.context.audioWorklet
      .addModule(BUFFER_WORKLET_URL)
      .catch((err) => {
        console.warn("[AudioGraph] buffer worklet load failed:", err);
        this.bufferWorkletReady = null;
        throw err;
      });
    return this.bufferWorkletReady;
  }

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
    for (const id of this.youtubeNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.youtubeNodes.get(id)?.destroy(); this.youtubeNodes.delete(id); }
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
    for (const id of this.mixerNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.mixerNodes.get(id)?.destroy(); this.mixerNodes.delete(id); }
    }
    for (const id of this.bufferNodes.keys()) {
      if (!activeNodeIds.has(id)) {
        this.bufferStateListeners.get(id)?.();
        this.bufferStateListeners.delete(id);
        this.bufferNodes.get(id)?.destroy();
        this.bufferNodes.delete(id);
        // Drop the OPFS-stored PCM along with the node — patches don't keep
        // dangling files. Best-effort; failure is silent.
        void bufferStorage.delete(id);
      }
    }
    for (const id of Array.from(this.bufferPending)) {
      if (!activeNodeIds.has(id)) this.bufferPending.delete(id);
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
        if (node.type === "browser~*" && !this.browserNodes.has(node.id)) {
          // Capture is user-gesture-only, so do not auto-start — the panel
          // triggers BrowserNode.capture() when the user clicks the button.
          const br = new BrowserNode(this.runtime);
          br.setOnStateChange(() => this.rewireConnections());
          this.browserNodes.set(node.id, br);
        }
        if (node.type === "youtube~*") {
          let yt = this.youtubeNodes.get(node.id);
          if (!yt) {
            yt = new YouTubeNode(this.runtime);
            yt.setOnStateChange(() => this.rewireConnections());
            this.youtubeNodes.set(node.id, yt);
          }
          // Sync the YouTube-specific metadata from args every time so URL
          // edits in the panel propagate into the runtime state without
          // needing a recreate.
          const url = node.args[0] ?? "";
          const cachedVideoId = node.args[1] ?? "";
          const cachedStart   = parseInt(node.args[2] ?? "0", 10) || 0;
          if (url) {
            const parsed = parseYouTubeUrl(url);
            if (parsed.ok) {
              yt.setVideo(parsed.videoId, parsed.startSeconds);
            } else if (cachedVideoId) {
              yt.setVideo(cachedVideoId, cachedStart);
            }
          } else if (cachedVideoId) {
            yt.setVideo(cachedVideoId, cachedStart);
          } else {
            yt.setVideo("", 0);
          }
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
        if (node.type === "mixer~") {
          const channels = mixerChannelCount(node.args);
          const existing = this.mixerNodes.get(node.id);
          if (!existing) {
            const gains = parseMixerFloats(node.args[1] ?? "", channels, 0.75);
            const pans  = parseMixerFloats(node.args[2] ?? "", channels, 0.5);
            this.mixerNodes.set(node.id, new MixerNode(this.runtime, channels, gains, pans));
          } else if (existing.channelCount !== channels) {
            existing.destroy();
            const gains = parseMixerFloats(node.args[1] ?? "", channels, 0.75);
            const pans  = parseMixerFloats(node.args[2] ?? "", channels, 0.5);
            this.mixerNodes.set(node.id, new MixerNode(this.runtime, channels, gains, pans));
          }
        }
        if (node.type === "buffer~"
            && !this.bufferNodes.has(node.id)
            && !this.bufferPending.has(node.id)) {
          const nodeId = node.id;
          this.bufferPending.add(nodeId);
          const mode    = bufferMode(node.args);
          const maxLen  = bufferMaxLen(node.args);
          this.ensureBufferWorklet()
            .then(() => {
              this.bufferPending.delete(nodeId);
              const stillActive = this.allGraphs().some(g => g.nodes.has(nodeId));
              if (!stillActive) return;
              if (this.bufferNodes.has(nodeId)) return;
              const fresh = new BufferNode(this.runtime, { mode, maxSeconds: maxLen, nodeId });
              this.bufferNodes.set(nodeId, fresh);

              // Subscribe BEFORE adoptStorage/loadBuffers so the persisted-PCM
              // restore pings the main thread and triggers the initial draw.
              const unsub = fresh.onStateChange(() => {
                this.bufferStateChangeCallback?.(nodeId);
              });
              this.bufferStateListeners.set(nodeId, unsub);

              // Restore persisted PCM. New flow: read from OPFS (args[12] =
              // storageKey). Fallback path: legacy patches with base64 in
              // args[6..9] still load — restoreBufferState handles both and
              // migrates legacy data to OPFS so subsequent saves are small.
              const targetNode = this.allGraphs()
                .map(g => g.nodes.get(nodeId))
                .find(n => n != null);
              if (targetNode) {
                void restoreBufferState(fresh, targetNode.args, nodeId);
              }

              this.rewireConnections();
            })
            .catch(() => { this.bufferPending.delete(nodeId); });
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
    for (const yt of this.youtubeNodes.values()) yt.disconnect();
    for (const js of this.jsEffectNodes.values()) js.disconnect();
    for (const mx of this.mixerNodes.values()) mx.disconnect();
    for (const bn of this.bufferNodes.values()) bn.disconnect();

    for (const g of this.allGraphs()) {
    for (const edge of g.getEdges()) {
      const fromNode = g.nodes.get(edge.fromNodeId);
      const toNode   = g.nodes.get(edge.toNodeId);
      if (!fromNode || !toNode) continue;

      // mixer~ has per-channel inputs — route into the specific channel GainNode.
      if (toNode.type === "mixer~") {
        const mixerNode = this.mixerNodes.get(edge.toNodeId);
        if (!mixerNode) continue;
        const channelInput = mixerNode.getChannelInput(edge.toInlet);
        if (!channelInput) continue;
        if (fromNode.type === "click~") {
          this.clickNodes.get(edge.fromNodeId)?.connect(channelInput, 0);
        } else if (fromNode.type === "adc~") {
          this.adcNodes.get(edge.fromNodeId)?.connectChannel(channelInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "browser~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.browserNodes.get(edge.fromNodeId)?.connectChannel(channelInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "youtube~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.youtubeNodes.get(edge.fromNodeId)?.connectChannel(channelInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "js~") {
          this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(channelInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "mixer~") {
          this.mixerNodes.get(edge.fromNodeId)?.connectOutlet(channelInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "buffer~") {
          // Audio outlets are 0/1 in stereo, just 0 in mono. Mono mode mirrors
          // its single channel onto both splitter outputs, so reading channel 0
          // is always safe.
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.bufferNodes.get(edge.fromNodeId)?.connectOutlet(channelInput, edge.fromOutlet, 0);
          }
        }
        continue;
      }

      // buffer~ as destination — inlets 0/1 (stereo) or just 0 (mono) are
      // audio inputs into the recorder. The third (or second) inlet is a
      // control inlet handled by ObjectInteractionController, not audio.
      if (toNode.type === "buffer~") {
        const bn = this.bufferNodes.get(edge.toNodeId);
        if (!bn) continue;
        const stereo = bufferMode(toNode.args) === "stereo";
        const audioInletMax = stereo ? 1 : 0;
        if (edge.toInlet > audioInletMax) continue;  // control inlet — skip
        const destInput: AudioNode = bn.input;
        if (fromNode.type === "click~") {
          this.clickNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
        } else if (fromNode.type === "adc~") {
          this.adcNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
        } else if (fromNode.type === "browser~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.browserNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
          }
        } else if (fromNode.type === "youtube~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.youtubeNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
          }
        } else if (fromNode.type === "js~") {
          this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, edge.toInlet);
        } else if (fromNode.type === "mixer~") {
          this.mixerNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, edge.toInlet);
        } else if (fromNode.type === "buffer~") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.bufferNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, edge.toInlet);
          }
        }
        continue;
      }

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
      } else if (fromNode.type === "browser~*") {
        // Outlets 0/1 are audio L/R; outlet 2 is video (handled in VisualizerGraph).
        if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
          this.browserNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
        }
      } else if (fromNode.type === "youtube~*") {
        // Same shape as browser~ — outlets 0/1 audio, outlet 2 video.
        if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
          this.youtubeNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, edge.toInlet);
        }
      } else if (fromNode.type === "js~") {
        this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, edge.toInlet);
      } else if (fromNode.type === "mixer~") {
        this.mixerNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, edge.toInlet);
      } else if (fromNode.type === "buffer~") {
        // Outlets 0/1 carry audio (stereo); the last outlet is the position
        // float, which is dispatched by the rAF tick — not connected here.
        if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
          this.bufferNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, edge.toInlet);
        }
      }
    }
    }
  }
}

/** Restore persisted PCM into the BufferNode. Two paths:
 *  1. args[12] = OPFS storage key → adopt directly (or rekey + adopt if mismatched).
 *  2. Legacy args[6..9] = base64 PCM → loadBuffers() writes PCM to OPFS, peaks computed.
 *  Either path leaves args[6..9] empty + args[12] = nodeId on success. */
async function restoreBufferState(bn: BufferNode, args: string[], nodeId: string): Promise<void> {
  const storageKey = args[12] ?? "";
  if (storageKey) {
    if (storageKey === nodeId) {
      const adopted = await bn.adoptStorage();
      if (adopted) { applyArgs(bn, args); return; }
    } else {
      // Mismatched key (e.g. patch copy/paste created a new node id pointing at
      // an old file). Read full PCM under the old key, write back under ours.
      const stored = await bufferStorage.readAll(storageKey);
      if (stored) {
        await bn.loadBuffers({
          L: stored.L, R: stored.R,
          LStereo: stored.LStereo, RStereo: stored.RStereo,
        });
        args[12] = nodeId;
        applyArgs(bn, args);
        return;
      }
    }
    // Storage key dangling → drop it so subsequent saves don't propagate.
    args[12] = "";
  }

  // Legacy patches with base64 PCM inline. loadBuffers writes to OPFS itself.
  const bufL  = decodePcm(args[6] ?? "");
  const bufR  = decodePcm(args[7] ?? "");
  const bufLs = decodePcm(args[8] ?? "");
  const bufRs = decodePcm(args[9] ?? "");
  const hasLegacyPcm = bufL.length || bufR.length || bufLs.length || bufRs.length;
  if (hasLegacyPcm) {
    await bn.loadBuffers({ L: bufL, R: bufR, LStereo: bufLs, RStereo: bufRs });
    args[12] = nodeId;
    args[6] = ""; args[7] = ""; args[8] = ""; args[9] = "";
  }

  applyArgs(bn, args);
}

/** Restore worklet-side runtime state from saved patch args. Mode is set in
 *  the BufferNode constructor; here we propagate rate, loop, and range. */
function applyArgs(bn: BufferNode, args: string[]): void {
  // Phase D1: streaming model is forward-only; save magnitude so reload
  // matches what the user hears (true reverse arrives in D2).
  const rateRaw = parseFloat(args[1] ?? "");
  if (Number.isFinite(rateRaw)) bn.setRate(Math.abs(rateRaw));
  bn.setLoop((args[2] ?? "0") !== "0");
  const rs = parseFloat(args[10] ?? "0");
  const re = parseFloat(args[11] ?? "0");
  if (Number.isFinite(rs) && Number.isFinite(re) && re > rs) {
    bn.setRange(rs, re);
  }
}

function decodePcm(b64: string): Float32Array {
  if (!b64 || b64 === "-") return new Float32Array(0);
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  } catch {
    return new Float32Array(0);
  }
}

function parseMixerFloats(raw: string, count: number, defaultVal: number): number[] {
  const parts = raw ? raw.split(",") : [];
  return Array.from({ length: count }, (_, i) => {
    const v = parseFloat(parts[i] ?? "");
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : defaultVal;
  });
}
