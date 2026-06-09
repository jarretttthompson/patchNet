import { AudioRuntime } from "./AudioRuntime";
import { ClickNode } from "./ClickNode";
import { DacNode } from "./DacNode";
import { AdcNode } from "./AdcNode";
import { BrowserNode } from "./BrowserNode";
import { YouTubeNode } from "./YouTubeNode";
import { parseYouTubeUrl } from "./youtube/parseUrl";
import { FftAnalyzerNode } from "./FftAnalyzerNode";
import { SpectralAnalyzerNode } from "./SpectralAnalyzerNode";
import { EnvFollowerNode } from "./EnvFollowerNode";
import { PitchDetectorNode, freqToNoteName } from "./PitchDetectorNode";
import { ChromaAnalyzerNode } from "./ChromaAnalyzerNode";
import { BeatTrackerNode } from "./BeatTrackerNode";
import { JsEffectNode } from "./JsEffectNode";
import { MixerNode } from "./MixerNode";
import { WaveNode } from "./WaveNode";
import { NoiseNode } from "./NoiseNode";
import { AdsrNode } from "./AdsrNode";
import { LfoNode } from "./LfoNode";
import { TransientFollowerNode } from "./TransientFollowerNode";
import { BufferNode } from "./BufferNode";
import { bufferStorage } from "./buffer/BufferStorage";
import { adcChannelCount, bufferMaxLen, bufferMode, dacChannelCount, fftBandCount, mixerChannelCount } from "../graph/objectDefs";
import type { PatchGraph } from "../graph/PatchGraph";
import type { SubPatchManager } from "../canvas/SubPatchManager";
import { getSessions, onSessionsChanged } from "../canvas/patchSessionRegistry";

// Plain-JS worklet so Vite can ship it as an asset the browser loads
// directly via audioWorklet.addModule(). Under Vite's default 4 KB inline
// threshold, small worklet files get inlined as a data: URL — which is
// fine; Chromium/Safari/Firefox all accept data: URLs in addModule().
const JSFX_WORKLET_URL = new URL("./jsfx/jsfx-worklet.js", import.meta.url).href;
const BUFFER_WORKLET_URL = new URL("./buffer/buffer-worklet.js", import.meta.url).href;
const TRANSIENT_FOLLOWER_WORKLET_URL = new URL("./transientFollower/transient-follower-worklet.js", import.meta.url).href;

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
  private spectralNodes     = new Map<string, SpectralAnalyzerNode>();
  private envNodes          = new Map<string, EnvFollowerNode>();
  private pitchNodes        = new Map<string, PitchDetectorNode>();
  private chromaNodes       = new Map<string, ChromaAnalyzerNode>();
  private beatNodes         = new Map<string, BeatTrackerNode>();
  private jsEffectNodes     = new Map<string, JsEffectNode>();
  private mixerNodes        = new Map<string, MixerNode>();
  private waveNodes         = new Map<string, WaveNode>();
  private noiseNodes        = new Map<string, NoiseNode>();
  private adsrNodes         = new Map<string, AdsrNode>();
  private lfoNodes          = new Map<string, LfoNode>();
  private transientFollowerNodes = new Map<string, TransientFollowerNode>();
  private transientFollowerPending = new Set<string>();
  private transientFollowerWorkletReady: Promise<void> | null = null;
  /** Pending one-shot envelope completions: [nodeId, performance.now() deadline].
   *  Drained by flushAdsrCompletions() each rAF, which fires the outlet-1 done bang. */
  private adsrPendingCompletions: Array<{ nodeId: string; deadlineMs: number }> = [];
  private adsrDoneCallback: ((nodeId: string) => void) | null = null;
  private bufferNodes       = new Map<string, BufferNode>();
  private bufferPending     = new Set<string>();
  private jsEffectPending   = new Set<string>();
  private jsEffectReadyListeners = new Map<string, Set<(node: JsEffectNode) => void>>();
  private jsfxWorkletReady: Promise<void> | null = null;
  private bufferWorkletReady: Promise<void> | null = null;
  private bufferStateListeners = new Map<string, () => void>();
  private bufferStateChangeCallback: ((nodeId: string) => void) | null = null;
  private clickTriggerTimes = new Map<string, number>();

  // selector → resolved element cache for the per-tick mount/update display
  // scans. render() rebuilds the patch DOM on each "change", so a cached
  // element that fails isConnected was replaced and is re-queried. Collapses
  // the per-node full-DOM querySelector scans (one per analysis node, ~125 Hz)
  // into Map hits while the patch runs unchanged.
  private readonly elCache = new Map<string, HTMLElement>();

  // Persistent scratch Maps reused by the per-tick analysis getters so the
  // control tick doesn't allocate (and later GC) a fresh Map every ~8ms. Each
  // is cleared + refilled on access and consumed synchronously by the caller.
  private readonly fftBandScratch    = new Map<string, readonly number[]>();
  private readonly spectralScratch   = new Map<string, readonly number[]>();
  private readonly envScratch        = new Map<string, readonly number[]>();
  private readonly pitchScratch      = new Map<string, readonly number[]>();
  private readonly chromaScratch     = new Map<string, readonly number[]>();
  private readonly beatScratch       = new Map<string, readonly number[]>();
  private readonly bufferPosScratch  = new Map<string, number>();

  private cachedEl<T extends HTMLElement = HTMLElement>(panGroup: HTMLElement, selector: string): T | null {
    const cached = this.elCache.get(selector);
    if (cached && cached.isConnected) return cached as T;
    const el = panGroup.querySelector<T>(selector);
    if (el) this.elCache.set(selector, el);
    else this.elCache.delete(selector);
    return el;
  }

  private unsubscribe: () => void;

  private unsubscribeRegistry: () => void;
  private graphSubs = new Map<string, () => void>();

  constructor(runtime: AudioRuntime, graph: PatchGraph, subPatchManager?: SubPatchManager) {
    this.runtime = runtime;
    this.graph   = graph;
    this.subPatchManager = subPatchManager ?? null;
    this.unsubscribe = this.graph.on("change", () => this.sync());
    // Subscribe to every session's graph so scratch-tab edits trigger sync().
    // SubPatch sessions also get registered, but they bubble changes up to
    // main via onPortsChanged → parentGraph.emit, so a duplicate subscription
    // is fine (sync is idempotent).
    const refreshSubs = () => {
      const live = new Set(getSessions().map(s => s.id));
      for (const [id, unsub] of this.graphSubs) {
        if (!live.has(id)) { unsub(); this.graphSubs.delete(id); }
      }
      for (const s of getSessions()) {
        if (!this.graphSubs.has(s.id) && s.graph !== this.graph) {
          this.graphSubs.set(s.id, s.graph.on("change", () => this.sync()));
        }
      }
    };
    this.unsubscribeRegistry = onSessionsChanged(() => { refreshSubs(); this.sync(); });
    refreshSubs();
    this.sync();
  }

  private allGraphs(): PatchGraph[] {
    // Source of truth = registry (main + scratch tabs + subpatch sessions).
    // Falls back to the constructor-passed graph if the registry is somehow
    // empty (e.g., AudioGraph constructed before main registers itself).
    const fromRegistry = getSessions().map(s => s.graph);
    if (fromRegistry.length > 0) return fromRegistry;
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
    for (const [id, sp] of this.spectralNodes) {
      out.set(id, { level: sp.values()[0] ?? 0 });
    }
    return out;
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.runtime.inputDeviceId = deviceId;
    const graphs = this.allGraphs();
    const channelsById = new Map<string, number>();
    for (const g of graphs) {
      for (const node of g.getNodes()) {
        if (node.type === "adc~") channelsById.set(node.id, adcChannelCount(node.args));
      }
    }
    for (const [id, adc] of this.adcNodes) {
      adc.destroy();
      const channels = channelsById.get(id) ?? adc.channelCount;
      const fresh = new AdcNode(this.runtime, channels);
      await fresh.start(deviceId || undefined);
      this.adcNodes.set(id, fresh);
    }
    this.rewireConnections();
  }

  /** Highest channel count reached by an attached adc~ MediaStreamTrack. */
  getMaxAdcDetectedChannels(): number {
    let max = 0;
    for (const adc of this.adcNodes.values()) {
      if (adc.detectedChannelCount > max) max = adc.detectedChannelCount;
    }
    return max;
  }

  /** Hardware ceiling reported by the AudioContext destination. */
  getMaxOutputChannels(): number {
    if (!this.runtime.isStarted) return 2;
    return this.runtime.context.destination.maxChannelCount;
  }

  getAdcNode(id: string): AdcNode | null { return this.adcNodes.get(id) ?? null; }
  getDacNode(id: string): DacNode | null { return this.dacNodes.get(id) ?? null; }
  getRuntime(): AudioRuntime { return this.runtime; }

  /** Re-parent each fft~ canvas into its mount slot after canvas render. */
  mountFftNodes(panGroup: HTMLElement): void {
    for (const [id, fft] of this.fftNodes) {
      const mount = this.cachedEl(panGroup, `[data-fft-node-id="${id}"]`);
      if (mount && !mount.contains(fft.canvas)) {
        mount.innerHTML = "";
        mount.appendChild(fft.canvas);
      }
    }
  }

  /** Current band levels per fft~ node — used by main.ts to push outlet values. */
  getFftBandLevels(): Map<string, readonly number[]> {
    const out = this.fftBandScratch;
    out.clear();
    for (const [id, fft] of this.fftNodes) out.set(id, fft.bandLevels);
    return out;
  }

  /** Draw all fft~ canvases and update band-value readouts in the DOM. */
  updateFftDisplay(panGroup: HTMLElement): void {
    for (const [id, fft] of this.fftNodes) {
      fft.draw();
      const el = this.cachedEl(panGroup, `[data-node-id="${id}"]`);
      if (!el) continue;
      const vals = el.querySelectorAll<HTMLElement>(".pn-fft-band-val");
      const bands = fft.bandLevels;
      vals.forEach((span, i) => {
        span.textContent = bands[i] !== undefined ? bands[i].toFixed(2) : "0.00";
      });
    }
  }

  /** Re-parent each spectral~ scope canvas into its mount slot after render. */
  mountSpectralNodes(panGroup: HTMLElement): void {
    for (const [id, sp] of this.spectralNodes) {
      const mount = this.cachedEl(panGroup, `[data-spectral-node-id="${id}"]`);
      if (mount && !mount.contains(sp.canvas)) {
        mount.innerHTML = "";
        mount.appendChild(sp.canvas);
      }
    }
  }

  /** Per-node descriptor values — used by main.ts to push outlet values. */
  getSpectralValues(): Map<string, readonly number[]> {
    const out = this.spectralScratch;
    out.clear();
    for (const [id, sp] of this.spectralNodes) out.set(id, sp.values());
    return out;
  }

  /** Update (recompute + redraw) every spectral~ node and refresh its readouts. */
  updateSpectralDisplay(panGroup: HTMLElement): void {
    for (const [id, sp] of this.spectralNodes) {
      sp.update();
      const el = this.cachedEl(panGroup, `[data-node-id="${id}"]`);
      if (!el) continue;
      const vals = el.querySelectorAll<HTMLElement>(".pn-spectral-val");
      const values = sp.values();
      vals.forEach((span) => {
        const idx = parseInt(span.dataset.spectralIdx ?? "", 10);
        const v = values[idx];
        span.textContent = v !== undefined ? v.toFixed(2) : "—";
      });
    }
  }

  /** Per-node envelope values (outlet 0) — used by main.ts to push outlets. */
  getEnvValues(): Map<string, readonly number[]> {
    const out = this.envScratch;
    out.clear();
    for (const [id, ev] of this.envNodes) out.set(id, [ev.value]);
    return out;
  }

  /** Recompute every env~ follower and refresh its body readout/meter bar. */
  updateEnvDisplay(panGroup: HTMLElement): void {
    for (const [id, ev] of this.envNodes) {
      ev.update();
      const el = this.cachedEl(panGroup, `[data-node-id="${id}"]`);
      if (!el) continue;
      const v = ev.value;
      const val = el.querySelector<HTMLElement>(".pn-env-val");
      if (val) val.textContent = v.toFixed(2);
      const fill = el.querySelector<HTMLElement>(".pn-env-bar-fill");
      if (fill) fill.style.width = `${Math.min(100, v * 100)}%`;
    }
  }

  /** Per-node pitch values [frequencyHz, confidence] — used for outlet push. */
  getPitchValues(): Map<string, readonly number[]> {
    const out = this.pitchScratch;
    out.clear();
    for (const [id, pt] of this.pitchNodes) out.set(id, pt.values());
    return out;
  }

  /** Recompute every pitch~ detector and refresh its Hz / note / conf readout. */
  updatePitchDisplay(panGroup: HTMLElement): void {
    for (const [id, pt] of this.pitchNodes) {
      pt.update();
      const el = this.cachedEl(panGroup, `[data-node-id="${id}"]`);
      if (!el) continue;
      const voiced = pt.confidence > 0.5;
      const freqEl = el.querySelector<HTMLElement>(".pn-pitch-freq");
      if (freqEl) freqEl.textContent = voiced ? `${Math.round(pt.frequency)}Hz` : "—";
      const noteEl = el.querySelector<HTMLElement>(".pn-pitch-note");
      if (noteEl) noteEl.textContent = voiced ? freqToNoteName(pt.frequency) : "";
      const fill = el.querySelector<HTMLElement>(".pn-pitch-conf-fill");
      if (fill) fill.style.width = `${Math.min(100, pt.confidence * 100)}%`;
    }
  }

  /** Re-parent each chroma~ chromagram canvas into its mount slot. */
  mountChromaNodes(panGroup: HTMLElement): void {
    for (const [id, ch] of this.chromaNodes) {
      const mount = this.cachedEl(panGroup, `[data-chroma-node-id="${id}"]`);
      if (mount && !mount.contains(ch.canvas)) {
        mount.innerHTML = "";
        mount.appendChild(ch.canvas);
      }
    }
  }

  /** Per-node chroma vector + dominant index — used for outlet push. */
  getChromaValues(): Map<string, readonly number[]> {
    const out = this.chromaScratch;
    out.clear();
    for (const [id, ch] of this.chromaNodes) out.set(id, ch.values());
    return out;
  }

  /** Recompute + redraw every chroma~ chromagram. */
  updateChromaDisplay(): void {
    for (const ch of this.chromaNodes.values()) ch.update();
  }

  /** Per-node [bpm, phase] — used for outlet push (outlets 0 and 1). */
  getBeatValues(): Map<string, readonly number[]> {
    const out = this.beatScratch;
    out.clear();
    for (const [id, bt] of this.beatNodes) out.set(id, bt.values());
    return out;
  }

  /** Recompute every beat~ tracker and refresh its BPM / phase-bar readout. */
  updateBeatDisplay(panGroup: HTMLElement): void {
    for (const [id, bt] of this.beatNodes) {
      bt.update();
      const el = this.cachedEl(panGroup, `[data-node-id="${id}"]`);
      if (!el) continue;
      const bpmEl = el.querySelector<HTMLElement>(".pn-beat-bpm");
      if (bpmEl) bpmEl.textContent = bt.bpm > 0 ? `${Math.round(bt.bpm)}` : "—";
      const fill = el.querySelector<HTMLElement>(".pn-beat-phase-fill");
      if (fill) fill.style.width = `${Math.min(100, bt.phase * 100)}%`;
      // Confidence bar + "uncertain" dimming so the user can see when the
      // tracker isn't sure of the tempo.
      const conf = bt.confidence;
      const confFill = el.querySelector<HTMLElement>(".pn-beat-conf-fill");
      if (confFill) confFill.style.width = `${Math.min(100, conf * 100)}%`;
      const device = el.querySelector<HTMLElement>(".pn-beat-device");
      if (device) device.classList.toggle("pn-beat-uncertain", conf < 0.25);
    }
  }

  /** Node ids whose beat fired this tick (consumes the flag). main.ts fires a
   *  bang on each one's outlet 2. */
  consumeBeatTriggers(): string[] {
    const fired: string[] = [];
    for (const [id, bt] of this.beatNodes) {
      if (bt.consumeBeat()) fired.push(id);
    }
    return fired;
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

  getWaveNode(nodeId: string): WaveNode | null {
    return this.waveNodes.get(nodeId) ?? null;
  }

  getNoiseNode(nodeId: string): NoiseNode | null {
    return this.noiseNodes.get(nodeId) ?? null;
  }

  getAdsrNode(nodeId: string): AdsrNode | null {
    return this.adsrNodes.get(nodeId) ?? null;
  }

  getLfoNode(nodeId: string): LfoNode | null {
    return this.lfoNodes.get(nodeId) ?? null;
  }

  getTransientFollowerNode(nodeId: string): TransientFollowerNode | null {
    return this.transientFollowerNodes.get(nodeId) ?? null;
  }

  /** Redraw all transientFollower~ live envelope traces. Called once per rAF
   *  from main.ts. Cheap when no nodes exist. */
  updateTransientFollowerDisplay(panGroup: HTMLElement): void {
    if (this.transientFollowerNodes.size === 0) return;
    for (const [id, tf] of this.transientFollowerNodes) {
      const liveCanvas = this.cachedEl<HTMLCanvasElement>(
        panGroup,
        `canvas.pn-tf-scope-live[data-tf-node-id="${id}"]`,
      );
      if (liveCanvas) tf.drawLiveScope(liveCanvas);
    }
  }

  /** Redraw all lfo~ scope canvases (analytic preview + live oscilloscope).
   *  Called once per rAF from main.ts. */
  updateLfoDisplay(panGroup: HTMLElement): void {
    if (this.lfoNodes.size === 0) return;
    for (const [id, ln] of this.lfoNodes) {
      const canvas = this.cachedEl<HTMLCanvasElement>(panGroup, `canvas.pn-lfo-scope[data-lfo-node-id="${id}"]`);
      if (canvas) ln.drawScope(canvas);
      const liveCanvas = this.cachedEl<HTMLCanvasElement>(panGroup, `canvas.pn-lfo-scope-live[data-lfo-node-id="${id}"]`);
      if (liveCanvas) ln.drawLiveScope(liveCanvas);
    }
  }

  /** Trigger an adsr~ one-shot. Stashes the completion deadline so the rAF
   *  loop can fire the outlet-1 done bang at the right time. No-op if the node
   *  doesn't exist (e.g. audio not started yet). */
  triggerAdsr(nodeId: string): void {
    const an = this.adsrNodes.get(nodeId);
    if (!an) return;
    const deadlineMs = an.trigger();
    this.adsrPendingCompletions.push({ nodeId, deadlineMs });
  }

  gateOnAdsr(nodeId: string): void {
    this.adsrNodes.get(nodeId)?.gateOn();
  }

  gateOffAdsr(nodeId: string): void {
    this.adsrNodes.get(nodeId)?.gateOff();
  }

  /** Register the callback the rAF loop uses to dispatch outlet-1 done bangs. */
  setAdsrDoneCallback(cb: ((nodeId: string) => void) | null): void {
    this.adsrDoneCallback = cb;
  }

  /** Drain any envelope completions whose deadline has elapsed. Called once per rAF
   *  from main.ts. Cheap when no envelopes are in flight. */
  flushAdsrCompletions(nowMs: number): void {
    if (this.adsrPendingCompletions.length === 0) return;
    const cb = this.adsrDoneCallback;
    const remaining: Array<{ nodeId: string; deadlineMs: number }> = [];
    for (const entry of this.adsrPendingCompletions) {
      if (entry.deadlineMs <= nowMs) {
        cb?.(entry.nodeId);
      } else {
        remaining.push(entry);
      }
    }
    this.adsrPendingCompletions = remaining;
  }

  /** Tick all wave~ scopes — called once per rAF from main.ts. Samples the
   *  morph CV analyser to apply crossfade weights, redraws the analytic
   *  preview, and traces the live oscilloscope. Knobs are NOT animated —
   *  they show the user-set base value at all times. Cheap if no wave~ exist. */
  updateWaveDisplay(panGroup: HTMLElement): void {
    if (this.waveNodes.size === 0) return;
    for (const [id, wn] of this.waveNodes) {
      wn.tickMorph();
      const canvas = this.cachedEl<HTMLCanvasElement>(panGroup, `canvas.pn-wave-scope[data-wave-node-id="${id}"]`);
      if (canvas) wn.drawScope(canvas);
      const liveCanvas = this.cachedEl<HTMLCanvasElement>(panGroup, `canvas.pn-wave-scope-live[data-wave-node-id="${id}"]`);
      if (liveCanvas) wn.drawLiveScope(liveCanvas);
    }
  }

  /** Redraw all noise~ live oscilloscope traces. Called once per rAF. */
  updateNoiseDisplay(panGroup: HTMLElement): void {
    if (this.noiseNodes.size === 0) return;
    for (const [id, nn] of this.noiseNodes) {
      const liveCanvas = this.cachedEl<HTMLCanvasElement>(
        panGroup,
        `canvas.pn-noise-scope-live[data-noise-node-id="${id}"]`,
      );
      if (liveCanvas) nn.drawLiveScope(liveCanvas);
    }
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
    const out = this.bufferPosScratch;
    out.clear();
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
    this.unsubscribeRegistry();
    for (const unsub of this.graphSubs.values()) unsub();
    this.graphSubs.clear();
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
    for (const sp of this.spectralNodes.values()) sp.destroy();
    this.spectralNodes.clear();
    for (const ev of this.envNodes.values()) ev.destroy();
    this.envNodes.clear();
    for (const pt of this.pitchNodes.values()) pt.destroy();
    this.pitchNodes.clear();
    for (const ch of this.chromaNodes.values()) ch.destroy();
    this.chromaNodes.clear();
    for (const bt of this.beatNodes.values()) bt.destroy();
    this.beatNodes.clear();
    for (const js of this.jsEffectNodes.values()) js.destroy();
    this.jsEffectNodes.clear();
    this.jsEffectPending.clear();
    this.jsEffectReadyListeners.clear();
    for (const mx of this.mixerNodes.values()) mx.destroy();
    this.mixerNodes.clear();
    for (const wn of this.waveNodes.values()) wn.destroy();
    this.waveNodes.clear();
    for (const nn of this.noiseNodes.values()) nn.destroy();
    this.noiseNodes.clear();
    for (const an of this.adsrNodes.values()) an.destroy();
    this.adsrNodes.clear();
    this.adsrPendingCompletions = [];
    this.adsrDoneCallback = null;
    for (const ln of this.lfoNodes.values()) ln.destroy();
    this.lfoNodes.clear();
    for (const tf of this.transientFollowerNodes.values()) tf.destroy();
    this.transientFollowerNodes.clear();
    this.transientFollowerPending.clear();
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

  private ensureTransientFollowerWorklet(): Promise<void> {
    if (this.transientFollowerWorkletReady) return this.transientFollowerWorkletReady;
    this.transientFollowerWorkletReady = this.runtime.context.audioWorklet
      .addModule(TRANSIENT_FOLLOWER_WORKLET_URL)
      .catch((err) => {
        console.warn("[AudioGraph] transientFollower worklet load failed:", err);
        this.transientFollowerWorkletReady = null;
        throw err;
      });
    return this.transientFollowerWorkletReady;
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
    for (const id of this.spectralNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.spectralNodes.get(id)?.destroy(); this.spectralNodes.delete(id); }
    }
    for (const id of this.envNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.envNodes.get(id)?.destroy(); this.envNodes.delete(id); }
    }
    for (const id of this.pitchNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.pitchNodes.get(id)?.destroy(); this.pitchNodes.delete(id); }
    }
    for (const id of this.chromaNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.chromaNodes.get(id)?.destroy(); this.chromaNodes.delete(id); }
    }
    for (const id of this.beatNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.beatNodes.get(id)?.destroy(); this.beatNodes.delete(id); }
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
    for (const id of this.waveNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.waveNodes.get(id)?.destroy(); this.waveNodes.delete(id); }
    }
    for (const id of this.noiseNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.noiseNodes.get(id)?.destroy(); this.noiseNodes.delete(id); }
    }
    for (const id of this.adsrNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.adsrNodes.get(id)?.destroy(); this.adsrNodes.delete(id); }
    }
    if (this.adsrPendingCompletions.length > 0) {
      this.adsrPendingCompletions = this.adsrPendingCompletions.filter(e => activeNodeIds.has(e.nodeId));
    }
    for (const id of this.lfoNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.lfoNodes.get(id)?.destroy(); this.lfoNodes.delete(id); }
    }
    for (const id of this.transientFollowerNodes.keys()) {
      if (!activeNodeIds.has(id)) { this.transientFollowerNodes.get(id)?.destroy(); this.transientFollowerNodes.delete(id); }
    }
    for (const id of Array.from(this.transientFollowerPending)) {
      if (!activeNodeIds.has(id)) this.transientFollowerPending.delete(id);
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
        if (node.type === "dac~") {
          const channels = dacChannelCount(node.args);
          const existing = this.dacNodes.get(node.id);
          if (!existing) {
            this.dacNodes.set(node.id, new DacNode(this.runtime, channels));
          } else if (existing.channelCount !== channels) {
            existing.destroy();
            this.dacNodes.set(node.id, new DacNode(this.runtime, channels));
          }
        }
        if (node.type === "adc~") {
          const channels = adcChannelCount(node.args);
          const existing = this.adcNodes.get(node.id);
          if (!existing) {
            const adc = new AdcNode(this.runtime, channels);
            this.adcNodes.set(node.id, adc);
            adc.start(this.runtime.inputDeviceId || undefined)
              .then(() => this.rewireConnections())
              .catch(() => {});
          } else if (existing.channelCount !== channels) {
            existing.destroy();
            const adc = new AdcNode(this.runtime, channels);
            this.adcNodes.set(node.id, adc);
            adc.start(this.runtime.inputDeviceId || undefined)
              .then(() => this.rewireConnections())
              .catch(() => {});
          }
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
        if (node.type === "spectral~") {
          if (!this.spectralNodes.has(node.id)) {
            this.spectralNodes.set(node.id, new SpectralAnalyzerNode(this.runtime));
          }
        }
        if (node.type === "env~") {
          let env = this.envNodes.get(node.id);
          if (!env) {
            env = new EnvFollowerNode(this.runtime);
            this.envNodes.set(node.id, env);
          }
          const attack = parseFloat(node.args[0] ?? "10");
          const release = parseFloat(node.args[1] ?? "200");
          env.setAttack(isNaN(attack) ? 10 : attack);
          env.setRelease(isNaN(release) ? 200 : release);
        }
        if (node.type === "pitch~") {
          if (!this.pitchNodes.has(node.id)) {
            this.pitchNodes.set(node.id, new PitchDetectorNode(this.runtime));
          }
        }
        if (node.type === "chroma~") {
          if (!this.chromaNodes.has(node.id)) {
            this.chromaNodes.set(node.id, new ChromaAnalyzerNode(this.runtime));
          }
        }
        if (node.type === "beat~") {
          let bt = this.beatNodes.get(node.id);
          if (!bt) {
            bt = new BeatTrackerNode(this.runtime);
            this.beatNodes.set(node.id, bt);
          }
          const tightness = parseFloat(node.args[0] ?? "1");
          bt.setTightness(isNaN(tightness) ? 1 : tightness);
          const division = parseInt(node.args[1] ?? "2", 10);
          bt.setDivision(isNaN(division) ? 2 : division);
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
        if (node.type === "wave~") {
          const freq  = parseFloat(node.args[0] ?? "220");
          const morph = parseFloat(node.args[1] ?? "0");
          const level = parseFloat(node.args[2] ?? "0.5");
          let wn = this.waveNodes.get(node.id);
          if (!wn) {
            wn = new WaveNode(this.runtime);
            wn.start(Number.isFinite(freq) ? freq : 220);
            this.waveNodes.set(node.id, wn);
          } else if (Number.isFinite(freq)) {
            wn.setFreq(freq);
          }
          // Always re-apply morph/level so text-panel edits propagate. No-op
          // when the value hasn't changed (gain.setTargetAtTime is cheap).
          wn.setMorph(Number.isFinite(morph) ? morph : 0);
          wn.setLevel(Number.isFinite(level) ? level : 0.5);
        }
        if (node.type === "noise~") {
          const color = node.args[0] ?? "white";
          const level = parseFloat(node.args[1] ?? "0.25");
          let nn = this.noiseNodes.get(node.id);
          if (!nn) {
            nn = new NoiseNode(this.runtime);
            this.noiseNodes.set(node.id, nn);
          }
          nn.setColor(color);
          nn.setLevel(Number.isFinite(level) ? level : 0.25);
        }
        if (node.type === "adsr~") {
          const a  = parseFloat(node.args[0] ?? "50");
          const d  = parseFloat(node.args[1] ?? "100");
          const s  = parseFloat(node.args[2] ?? "0.7");
          const r  = parseFloat(node.args[3] ?? "200");
          const sh = parseFloat(node.args[4] ?? "200");
          let an = this.adsrNodes.get(node.id);
          if (!an) {
            an = new AdsrNode(this.runtime);
            this.adsrNodes.set(node.id, an);
          }
          an.setAttack(a);
          an.setDecay(d);
          an.setSustain(s);
          an.setRelease(r);
          an.setSustainTime(sh);
        }
        if (node.type === "lfo~") {
          const rate  = parseFloat(node.args[0] ?? "1");
          const depth = parseFloat(node.args[1] ?? "100");
          const shape = parseFloat(node.args[2] ?? "0");
          let ln = this.lfoNodes.get(node.id);
          if (!ln) {
            ln = new LfoNode(this.runtime);
            ln.start(Number.isFinite(rate) ? rate : 1);
            this.lfoNodes.set(node.id, ln);
          } else if (Number.isFinite(rate)) {
            ln.setRate(rate);
          }
          ln.setDepth(Number.isFinite(depth) ? depth : 100);
          ln.setShape(Number.isFinite(shape) ? shape : 0);
        }
        if (node.type === "transientFollower~") {
          const a    = parseFloat(node.args[0] ?? "5");
          const r    = parseFloat(node.args[1] ?? "80");
          const sens = parseFloat(node.args[2] ?? "1");
          const flr  = parseFloat(node.args[3] ?? "0");
          const existing = this.transientFollowerNodes.get(node.id);
          if (existing) {
            existing.setArgs(a, r, sens, flr);
          } else if (!this.transientFollowerPending.has(node.id)) {
            const nodeId = node.id;
            this.transientFollowerPending.add(nodeId);
            this.ensureTransientFollowerWorklet()
              .then(() => {
                this.transientFollowerPending.delete(nodeId);
                const stillActive = this.allGraphs().some(g => g.nodes.has(nodeId));
                if (!stillActive) return;
                if (this.transientFollowerNodes.has(nodeId)) return;
                const fresh = new TransientFollowerNode(this.runtime);
                this.transientFollowerNodes.set(nodeId, fresh);
                // Re-read args at completion time — the user may have edited
                // them while the worklet module was loading.
                const targetNode = this.allGraphs()
                  .map(g => g.nodes.get(nodeId))
                  .find(n => n != null);
                if (targetNode) {
                  fresh.setArgs(
                    parseFloat(targetNode.args[0] ?? "5"),
                    parseFloat(targetNode.args[1] ?? "80"),
                    parseFloat(targetNode.args[2] ?? "1"),
                    parseFloat(targetNode.args[3] ?? "0"),
                  );
                }
                this.rewireConnections();
              })
              .catch(() => { this.transientFollowerPending.delete(nodeId); });
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

    this.applyDestinationChannelCount();
    this.rewireConnections();
  }

  /**
   * Configure the AudioContext destination to carry as many discrete channels
   * as the widest dac~ requests, capped by the hardware ceiling
   * (`maxChannelCount`). With `channelInterpretation = "discrete"` Web Audio
   * stops upmix/downmix and routes channel N straight through.
   */
  private applyDestinationChannelCount(): void {
    if (!this.runtime.isStarted) return;
    let widest = 2;
    for (const dac of this.dacNodes.values()) {
      if (dac.channelCount > widest) widest = dac.channelCount;
    }
    const dest = this.runtime.context.destination;
    const target = Math.min(widest, dest.maxChannelCount || 2);
    try {
      if (dest.channelCount !== target) dest.channelCount = target;
      dest.channelCountMode        = "explicit";
      dest.channelInterpretation   = "discrete";
    } catch (err) {
      console.warn("[AudioGraph] destination.channelCount", target, "rejected:", err);
    }
  }

  private rewireConnections(): void {
    for (const click of this.clickNodes.values()) click.disconnect();
    for (const adc of this.adcNodes.values()) adc.disconnect();
    for (const br of this.browserNodes.values()) br.disconnect();
    for (const yt of this.youtubeNodes.values()) yt.disconnect();
    for (const js of this.jsEffectNodes.values()) js.disconnect();
    for (const mx of this.mixerNodes.values()) mx.disconnect();
    for (const wn of this.waveNodes.values()) wn.disconnect();
    for (const nn of this.noiseNodes.values()) nn.disconnect();
    for (const an of this.adsrNodes.values()) an.disconnect();
    for (const ln of this.lfoNodes.values()) ln.disconnect();
    for (const tf of this.transientFollowerNodes.values()) tf.disconnect();
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
        } else if (fromNode.type === "wave~") {
          this.waveNodes.get(edge.fromNodeId)?.connect(channelInput, 0);
        } else if (fromNode.type === "noise~") {
          this.noiseNodes.get(edge.fromNodeId)?.connect(channelInput, 0);
        } else if (fromNode.type === "adsr~") {
          this.adsrNodes.get(edge.fromNodeId)?.connect(channelInput, 0);
        } else if (fromNode.type === "lfo~") {
          this.lfoNodes.get(edge.fromNodeId)?.connect(channelInput, 0);
        } else if (fromNode.type === "transientFollower~") {
          this.transientFollowerNodes.get(edge.fromNodeId)?.connect(channelInput, edge.fromOutlet, 0);
        }
        continue;
      }

      // wave~ as destination — inlet 0 = freq CV (Hz, summed onto base),
      // inlet 1 = morph CV (added to morph, clamped 0..1). Both are plain
      // GainNodes with a single input channel, so toInlet always maps to 0.
      if (toNode.type === "wave~") {
        const wn = this.waveNodes.get(edge.toNodeId);
        if (!wn) continue;
        const destInput: GainNode | null =
          edge.toInlet === 0 ? wn.freqInput :
          edge.toInlet === 1 ? wn.morphInput :
          null;
        if (!destInput) continue;
        if (fromNode.type === "click~") {
          this.clickNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adc~") {
          this.adcNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "browser~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.browserNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "youtube~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.youtubeNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "js~") {
          this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "mixer~") {
          this.mixerNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "buffer~") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.bufferNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "wave~") {
          this.waveNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "noise~") {
          this.noiseNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adsr~") {
          this.adsrNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "lfo~") {
          this.lfoNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "transientFollower~") {
          this.transientFollowerNodes.get(edge.fromNodeId)?.connect(destInput, edge.fromOutlet, 0);
        }
        continue;
      }

      // adsr~ as destination — inlet 0 = audio in (signal that gets multiplied
      // by the envelope). Inlet 1 is the control inlet (bang/float/messages),
      // handled by ObjectInteractionController, not audio.
      if (toNode.type === "adsr~") {
        const an = this.adsrNodes.get(edge.toNodeId);
        if (!an) continue;
        if (edge.toInlet !== 0) continue;
        const destInput: GainNode = an.input;
        if (fromNode.type === "click~") {
          this.clickNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adc~") {
          this.adcNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "browser~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.browserNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "youtube~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.youtubeNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "js~") {
          this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "mixer~") {
          this.mixerNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "buffer~") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.bufferNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "wave~") {
          this.waveNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "noise~") {
          this.noiseNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adsr~") {
          this.adsrNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "lfo~") {
          this.lfoNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "transientFollower~") {
          this.transientFollowerNodes.get(edge.fromNodeId)?.connect(destInput, edge.fromOutlet, 0);
        }
        continue;
      }

      // lfo~ as destination — inlet 1 = rate CV (Hz, summed onto base rate).
      // Inlet 0 is the control inlet (rate/depth/shape selectors), handled by
      // ObjectInteractionController, not audio wiring.
      if (toNode.type === "lfo~") {
        const ln = this.lfoNodes.get(edge.toNodeId);
        if (!ln) continue;
        if (edge.toInlet !== 1) continue;
        const destInput: GainNode = ln.rateInput;
        if (fromNode.type === "click~") {
          this.clickNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adc~") {
          this.adcNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "browser~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.browserNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "youtube~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.youtubeNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "js~") {
          this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "mixer~") {
          this.mixerNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "buffer~") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.bufferNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "wave~") {
          this.waveNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "noise~") {
          this.noiseNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adsr~") {
          this.adsrNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "lfo~") {
          this.lfoNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "transientFollower~") {
          this.transientFollowerNodes.get(edge.fromNodeId)?.connect(destInput, edge.fromOutlet, 0);
        }
        continue;
      }

      // transientFollower~ as destination — inlet 0 = source signal (carrier),
      // inlet 1 = shape source (envelope detection). Both audio-rate.
      if (toNode.type === "transientFollower~") {
        const tf = this.transientFollowerNodes.get(edge.toNodeId);
        if (!tf) continue;
        const destInput: GainNode | null =
          edge.toInlet === 0 ? tf.sourceInput :
          edge.toInlet === 1 ? tf.shapeInput :
          null;
        if (!destInput) continue;
        if (fromNode.type === "click~") {
          this.clickNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adc~") {
          this.adcNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "browser~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.browserNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "youtube~*") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.youtubeNodes.get(edge.fromNodeId)?.connectChannel(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "js~") {
          this.jsEffectNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "mixer~") {
          this.mixerNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
        } else if (fromNode.type === "buffer~") {
          if (edge.fromOutlet === 0 || edge.fromOutlet === 1) {
            this.bufferNodes.get(edge.fromNodeId)?.connectOutlet(destInput, edge.fromOutlet, 0);
          }
        } else if (fromNode.type === "wave~") {
          this.waveNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "noise~") {
          this.noiseNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "adsr~") {
          this.adsrNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "lfo~") {
          this.lfoNodes.get(edge.fromNodeId)?.connect(destInput, 0);
        } else if (fromNode.type === "transientFollower~") {
          this.transientFollowerNodes.get(edge.fromNodeId)?.connect(destInput, edge.fromOutlet, 0);
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
        } else if (fromNode.type === "wave~") {
          this.waveNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
        } else if (fromNode.type === "noise~") {
          this.noiseNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
        } else if (fromNode.type === "adsr~") {
          this.adsrNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
        } else if (fromNode.type === "lfo~") {
          this.lfoNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
        } else if (fromNode.type === "transientFollower~") {
          this.transientFollowerNodes.get(edge.fromNodeId)?.connect(destInput, edge.fromOutlet, edge.toInlet);
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
      } else if (toNode.type === "spectral~") {
        destInput = this.spectralNodes.get(edge.toNodeId)?.inputNode ?? null;
      } else if (toNode.type === "env~") {
        destInput = this.envNodes.get(edge.toNodeId)?.inputNode ?? null;
      } else if (toNode.type === "pitch~") {
        destInput = this.pitchNodes.get(edge.toNodeId)?.inputNode ?? null;
      } else if (toNode.type === "chroma~") {
        destInput = this.chromaNodes.get(edge.toNodeId)?.inputNode ?? null;
      } else if (toNode.type === "beat~") {
        destInput = this.beatNodes.get(edge.toNodeId)?.inputNode ?? null;
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
      } else if (fromNode.type === "wave~") {
        this.waveNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
      } else if (fromNode.type === "noise~") {
        this.noiseNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
      } else if (fromNode.type === "adsr~") {
        this.adsrNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
      } else if (fromNode.type === "lfo~") {
        this.lfoNodes.get(edge.fromNodeId)?.connect(destInput, edge.toInlet);
      } else if (fromNode.type === "transientFollower~") {
        this.transientFollowerNodes.get(edge.fromNodeId)?.connect(destInput, edge.fromOutlet, edge.toInlet);
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
