import type { AudioRuntime } from "./AudioRuntime";
import {
  bufferStorage,
  PEAKS_DEFAULT_BUCKETS,
  type BufferMode,
  type PcmReadHandle,
  type PcmWriteHandle,
} from "./buffer/BufferStorage";

export type BufferTransport = "stop" | "record" | "play" | "pause";
export type { BufferMode };

interface BufferConfig {
  mode: BufferMode;
  maxSeconds: number;
  /** Storage key for OPFS-backed PCM. Use the patch node's id. */
  nodeId: string;
}

/**
 * Per-object runtime for buffer~. Owns the AudioWorkletNode plus a stereo
 * input merger and stereo splitter so it plugs into the AudioGraph the same
 * way as JsEffectNode.
 *
 * Phase 3b model: full PCM lives in an OPFS file, not in RAM. The worklet
 * holds only a small ring (~2 sec). Recording streams chunks from the worklet
 * to OPFS. Playback streams chunks from OPFS into the worklet on demand.
 * Drawing reads a peaks summary that's a fraction of full-PCM size.
 *
 * Signal topology (stereo mode):
 *   inputMerger (2-in) → worklet (stereo in/out) → outputSplitter (2-out)
 *
 * Mono mode collapses both input channels into channel 0 and produces
 * identical content on both outputs (the splitter still carries two
 * channels — the patch graph just exposes one outlet).
 */
export class BufferNode {
  private readonly worklet: AudioWorkletNode;
  private readonly inputMerger: ChannelMergerNode;
  private readonly outputSplitter: ChannelSplitterNode;

  private _state: BufferTransport = "stop";
  private _rate = 1.0;
  private _loop = false;
  private _mode: BufferMode = "stereo";
  private _positionSamples = 0;
  private _bufferLen = 0;
  private _maxSamples: number;
  private readonly _sampleRate: number;
  private readonly _nodeId: string;

  /** Min/max waveform summary. Two entries per chunk during record (min, max
   *  of L). Read by drawBufferWaveform. */
  private _peaks: Float32Array = new Float32Array(0);
  /** Number of valid (min,max) pairs in _peaks. */
  private _peaksLen = 0;
  private _peaksSamplesPerBucket = 1024;

  /** OPFS write stream — open while recording, null otherwise. */
  private _writeHandle: PcmWriteHandle | null = null;
  /** OPFS read stream — open while playing back, null otherwise. */
  private _readHandle: PcmReadHandle | null = null;
  /** A monotonically-increasing token used to discard stale needSamples
   *  responses if the user seeked / re-played mid-fetch. */
  private _readEpoch = 0;

  private readonly _stateListeners = new Set<() => void>();

  constructor(runtime: AudioRuntime, config: BufferConfig) {
    this._mode       = config.mode;
    this._sampleRate = runtime.sampleRate;
    this._maxSamples = Math.max(1, Math.round(config.maxSeconds * runtime.sampleRate));
    this._nodeId     = config.nodeId;

    const ctx = runtime.context;
    this.inputMerger    = ctx.createChannelMerger(2);
    this.outputSplitter = ctx.createChannelSplitter(2);
    this.worklet = new AudioWorkletNode(ctx, "buffer-processor", {
      numberOfInputs:  1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });

    this.inputMerger.connect(this.worklet);
    this.worklet.connect(this.outputSplitter);

    this.worklet.port.onmessage = (ev) => this.onWorkletMessage(ev);
    this.worklet.port.postMessage({
      type: "init",
      mode: this._mode,
      maxSamples: this._maxSamples,
    });
  }

  // ── Public API ──────────────────────────────────────────────────────

  get state(): BufferTransport { return this._state; }
  get rate(): number  { return this._rate; }
  get loop(): boolean { return this._loop; }
  get mode(): BufferMode { return this._mode; }
  get maxSamples(): number { return this._maxSamples; }
  get maxSeconds(): number { return this._maxSamples / this._sampleRate; }
  get bufferLength(): number { return this._bufferLen; }
  get nodeId(): string { return this._nodeId; }

  /** Normalized 0..1 position; 0 when buffer empty. */
  get position(): number {
    if (this._bufferLen === 0) return 0;
    return Math.max(0, Math.min(1, this._positionSamples / this._bufferLen));
  }

  /** Resize the recording window. Wipes the OPFS file + transport state. */
  setMaxSeconds(seconds: number): void {
    const next = Math.max(1, Math.round(seconds * this._sampleRate));
    if (next === this._maxSamples) return;
    this._maxSamples = next;
    this._bufferLen = 0;
    this._positionSamples = 0;
    this._state = "stop";
    this._peaks = new Float32Array(0);
    this._peaksLen = 0;
    void this.closeWriteHandle();
    void this.closeReadHandle();
    void bufferStorage.delete(this._nodeId);
    this.worklet.port.postMessage({
      type: "init",
      mode: this._mode,
      maxSamples: this._maxSamples,
    });
    this.emitState();
  }

  record(): void {
    this._state = "record";
    this._bufferLen = 0;
    this._positionSamples = 0;
    this._peaks = new Float32Array(0);
    this._peaksLen = 0;
    void this.closeReadHandle();
    void this.openWriteHandleForRecord();
    this.worklet.port.postMessage({ type: "record" });
    this.emitState();
  }

  play(): void {
    if (this._bufferLen === 0) {
      this._state = "stop";
      this.emitState();
      return;
    }
    this._state = "play";
    void this.ensureReadHandle();
    this.worklet.port.postMessage({ type: "play" });
    this.emitState();
  }

  /** Start playback within a specific window. Both args normalized 0..1. */
  playFrom(normStart: number, normEnd?: number): void {
    if (this._bufferLen === 0) {
      this._state = "stop";
      this.emitState();
      return;
    }
    const s = Math.max(0, Math.min(1, Number.isFinite(normStart) ? normStart : 0));
    const e = Number.isFinite(normEnd as number)
      ? Math.max(s, Math.min(1, normEnd as number))
      : 1;
    const startSample = Math.floor(s * this._bufferLen);
    const endSample   = Math.max(startSample + 1, Math.floor(e * this._bufferLen));
    this._state = "play";
    void this.ensureReadHandle();
    this.worklet.port.postMessage({
      type: "play",
      start: startSample,
      end:   endSample,
    });
    this.emitState();
  }

  /** Persistent playback window. `end <= start` clears the range. */
  setRange(normStart: number, normEnd: number): void {
    const s = Math.max(0, Math.min(1, Number.isFinite(normStart) ? normStart : 0));
    const e = Math.max(0, Math.min(1, Number.isFinite(normEnd) ? normEnd : 1));
    const startSample = Math.floor(s * Math.max(1, this._bufferLen));
    const endSample   = Math.floor(e * Math.max(1, this._bufferLen));
    this.worklet.port.postMessage({
      type: "setRange",
      start: startSample,
      end:   endSample,
    });
    this.emitState();
  }

  pause(): void {
    this._state = "pause";
    this.worklet.port.postMessage({ type: "pause" });
    this.emitState();
  }

  stop(): void {
    this._state = "stop";
    this._positionSamples = 0;
    void this.closeReadHandle();
    this.worklet.port.postMessage({ type: "stop" });
    this.emitState();
  }

  setRate(r: number): void {
    if (!Number.isFinite(r)) return;
    this._rate = r;
    this.worklet.port.postMessage({ type: "rate", value: r });
  }

  setLoop(v: boolean): void {
    this._loop = !!v;
    this.worklet.port.postMessage({ type: "loop", value: this._loop });
  }

  seek(norm: number): void {
    if (!Number.isFinite(norm) || this._bufferLen === 0) return;
    const clamped = Math.max(0, Math.min(1, norm));
    const sample = Math.floor(clamped * this._bufferLen);
    this._positionSamples = sample;
    this.worklet.port.postMessage({ type: "seek", position: sample });
  }

  /**
   * Switch channel mode. Async — reads OPFS, transforms, writes back.
   * Stereo→mono sums and preserves originals; mono→stereo restores originals
   * when present, else duplicates mono.
   */
  async setMode(mode: BufferMode): Promise<boolean> {
    if (mode === this._mode) return false;
    if (this._bufferLen === 0) {
      this._mode = mode;
      this.worklet.port.postMessage({ type: "setMode", mode });
      this.emitState();
      return false;
    }
    // Halt play during the transform — read handle would be stale anyway.
    if (this._state === "play") {
      this._state = "stop";
      void this.closeReadHandle();
      this.worklet.port.postMessage({ type: "stop" });
    }
    const stored = await bufferStorage.readAll(this._nodeId);
    if (!stored) {
      this._mode = mode;
      this.worklet.port.postMessage({ type: "setMode", mode });
      this.emitState();
      return false;
    }
    let newL: Float32Array;
    let newR: Float32Array;
    let newLStereo: Float32Array;
    let newRStereo: Float32Array;
    if (mode === "mono" && this._mode === "stereo") {
      const len = stored.L.length;
      newLStereo = stored.L.slice();
      newRStereo = stored.R.slice();
      const summed = new Float32Array(len);
      for (let i = 0; i < len; i++) summed[i] = (stored.L[i] + stored.R[i]) * 0.5;
      newL = summed;
      newR = new Float32Array(len);
    } else if (mode === "stereo" && this._mode === "mono"
               && stored.LStereo.length > 0 && stored.RStereo.length > 0) {
      newL = stored.LStereo.slice();
      newR = stored.RStereo.slice();
      newLStereo = new Float32Array(0);
      newRStereo = new Float32Array(0);
    } else {
      // mono → stereo without backup: duplicate.
      newL = stored.L.slice();
      newR = stored.L.slice();
      newLStereo = new Float32Array(0);
      newRStereo = new Float32Array(0);
    }
    await bufferStorage.writeAll(this._nodeId, {
      mode, L: newL, R: newR,
      LStereo: newLStereo, RStereo: newRStereo,
    });
    this.recomputePeaks(newL);
    void this.persistPeaks();
    this._mode = mode;
    this.worklet.port.postMessage({ type: "setMode", mode });
    this.worklet.port.postMessage({ type: "setLength", value: newL.length });
    this._bufferLen = newL.length;
    this.emitState();
    return true;
  }

  clear(): void {
    this._bufferLen = 0;
    this._positionSamples = 0;
    this._state = "stop";
    this._peaks = new Float32Array(0);
    this._peaksLen = 0;
    void this.closeWriteHandle();
    void this.closeReadHandle();
    void bufferStorage.delete(this._nodeId);
    this.worklet.port.postMessage({ type: "clear" });
    this.emitState();
  }

  /** Legacy migration path — write fully-formed PCM to OPFS, recompute peaks,
   *  tell the worklet the canonical length. After this call the BufferNode
   *  holds only peaks; PCM lives only in OPFS. */
  async loadBuffers(opts: {
    L: Float32Array;
    R: Float32Array;
    LStereo?: Float32Array;
    RStereo?: Float32Array;
  }): Promise<void> {
    const len = Math.min(this._maxSamples, Math.max(opts.L.length, opts.R.length));
    const L = clipTo(opts.L, len);
    const R = clipTo(opts.R, len);
    const LStereo = opts.LStereo ? opts.LStereo.slice() : new Float32Array(0);
    const RStereo = opts.RStereo ? opts.RStereo.slice() : new Float32Array(0);
    await bufferStorage.writeAll(this._nodeId, {
      mode: this._mode, L, R, LStereo, RStereo,
    });
    this._bufferLen = len;
    this._positionSamples = 0;
    this.recomputePeaks(L);
    void this.persistPeaks();
    this.worklet.port.postMessage({ type: "setLength", value: len });
    this.emitState();
  }

  /** Adopt an existing OPFS recording (e.g. on patch reload).
   *  Reads peaks from sidecar; computes them from PCM if missing. */
  async adoptStorage(): Promise<boolean> {
    const handle = await bufferStorage.openRead(this._nodeId);
    if (!handle) return false;
    this._bufferLen = handle.frameCount;
    this._mode = handle.mode;
    await handle.close();

    const peaks = await bufferStorage.readPeaks(this._nodeId);
    if (peaks) {
      this._peaks = peaks.values;
      this._peaksLen = peaks.bucketCount;
      this._peaksSamplesPerBucket = peaks.samplesPerBucket;
    } else {
      // Compute from OPFS once. For very long recordings this is slow but
      // a one-shot cost — subsequent loads use the persisted sidecar.
      await this.computePeaksFromStorage();
      void this.persistPeaks();
    }
    this.worklet.port.postMessage({ type: "setLength", value: this._bufferLen });
    this.emitState();
    return true;
  }

  /** Peaks summary (interleaved min,max) for waveform drawing. */
  getPeaks(): { values: Float32Array; bucketCount: number } {
    return { values: this._peaks, bucketCount: this._peaksLen };
  }

  // ── Connection plumbing ────────────────────────────────────────────

  get input(): AudioNode { return this.inputMerger; }

  connectOutlet(dest: AudioNode, outputChannel: number, inputIndex: number): void {
    this.outputSplitter.connect(dest, outputChannel, inputIndex);
  }

  disconnect(): void {
    try { this.outputSplitter.disconnect(); } catch { /* ok */ }
  }

  destroy(): void {
    try { this.worklet.port.onmessage = null; } catch { /* noop */ }
    try { this.worklet.disconnect(); } catch { /* noop */ }
    try { this.inputMerger.disconnect(); } catch { /* noop */ }
    try { this.outputSplitter.disconnect(); } catch { /* noop */ }
    void this.closeWriteHandle();
    void this.closeReadHandle();
    this._stateListeners.clear();
  }

  /** Subscribe to transport / position / record-done events. */
  onStateChange(fn: () => void): () => void {
    this._stateListeners.add(fn);
    return () => { this._stateListeners.delete(fn); };
  }

  // ── Internal — worklet message handling ────────────────────────────

  private onWorkletMessage(ev: MessageEvent): void {
    const m = ev.data as {
      type?:     string;
      value?:    number;
      offset?:   number;
      totalLen?: number;
      from?:     number;
      count?:    number;
      L?:        Float32Array;
      R?:        Float32Array;
      final?:    boolean;
    };
    if (!m?.type) return;

    switch (m.type) {
      case "position":
        // Silent — main.ts's rAF tick polls position.
        this._positionSamples = m.value ?? 0;
        break;

      case "recordChunk": {
        const L = m.L instanceof Float32Array ? m.L : null;
        const R = m.R instanceof Float32Array ? m.R : null;
        if (L && R && L.length > 0 && this._writeHandle) {
          // Write to OPFS asynchronously. recordChunk arrives ~46 Hz; OPFS
          // writes are usually faster than that, so backpressure is rare.
          this._writeHandle.appendFrames(L, R).catch(err => {
            console.warn(`[buffer~ ${this._nodeId}] OPFS append failed:`, err);
          });
          this.appendPeaks(L);
        }
        this._bufferLen = m.totalLen ?? this._bufferLen;
        break;
      }

      case "recordDone": {
        this._bufferLen = m.totalLen ?? this._bufferLen;
        this._state = "stop";
        this._positionSamples = 0;
        void this.closeWriteHandle();
        void this.persistPeaks();
        this.emitState();
        break;
      }

      case "needSamples": {
        const from  = m.from  ?? 0;
        const count = m.count ?? 0;
        const token = (m as { token?: number }).token;
        const epoch = this._readEpoch;
        if (count <= 0) break;
        void this.serveSamples(from, count, epoch, token);
        break;
      }

      case "playDone":
        this._state = "stop";
        void this.closeReadHandle();
        this.emitState();
        break;
    }
  }

  // ── Internal — OPFS handle lifecycles ──────────────────────────────

  private async openWriteHandleForRecord(): Promise<void> {
    await this.closeWriteHandle();
    try {
      this._writeHandle = await bufferStorage.openWrite(this._nodeId, this._mode, false);
    } catch (err) {
      console.warn(`[buffer~ ${this._nodeId}] openWrite failed:`, err);
      this._writeHandle = null;
    }
  }

  private async closeWriteHandle(): Promise<void> {
    const h = this._writeHandle;
    this._writeHandle = null;
    if (h) {
      try { await h.close(); } catch { /* ignore */ }
    }
  }

  private async ensureReadHandle(): Promise<void> {
    if (this._readHandle) return;
    this._readEpoch++;
    try {
      this._readHandle = await bufferStorage.openRead(this._nodeId);
    } catch (err) {
      console.warn(`[buffer~ ${this._nodeId}] openRead failed:`, err);
      this._readHandle = null;
    }
  }

  private async closeReadHandle(): Promise<void> {
    this._readEpoch++;
    const h = this._readHandle;
    this._readHandle = null;
    if (h) {
      try { await h.close(); } catch { /* ignore */ }
    }
  }

  private async serveSamples(
    from: number, count: number, epoch: number, token: number | undefined,
  ): Promise<void> {
    // Critical invariant: every needSamples request must produce exactly one
    // playChunk reply (even empty). The worklet's fetchInFlight gate is only
    // released by an arriving playChunk — silently dropping a reply
    // (read error, stale epoch, missing handle) wedges the worklet's prefetch
    // pump permanently. The token tags stale chunks so the worklet drops them
    // without corrupting ring state, but the message itself must still arrive.
    const replyEmpty = () => this.worklet.port.postMessage({
      type:   "playChunk",
      offset: from,
      L:      new Float32Array(0),
      R:      new Float32Array(0),
      token,
    });
    if (!this._readHandle) await this.ensureReadHandle();
    if (!this._readHandle) { replyEmpty(); return; }
    if (epoch !== this._readEpoch) { replyEmpty(); return; }
    const lo = Math.max(0, from);
    const hi = Math.min(this._readHandle.frameCount, from + count);
    if (hi <= lo) { replyEmpty(); return; }
    try {
      const frames = await this._readHandle.readFrames(lo, hi - lo);
      if (epoch !== this._readEpoch) { replyEmpty(); return; }
      this.worklet.port.postMessage({
        type:   "playChunk",
        offset: lo,
        L:      frames.L,
        R:      frames.R,
        token,
      });
    } catch (err) {
      console.warn(`[buffer~ ${this._nodeId}] read failed:`, err);
      replyEmpty();
    }
  }

  // ── Peaks accumulation ─────────────────────────────────────────────

  /** Append peaks for a freshly-arrived chunk. One (min, max) pair per chunk. */
  private appendPeaks(L: Float32Array): void {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < L.length; i++) {
      const v = L[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn)) { mn = 0; mx = 0; }
    if (this._peaksLen * 2 + 2 > this._peaks.length) {
      // Grow by doubling.
      const cap = Math.max(64, this._peaks.length * 2);
      const next = new Float32Array(cap);
      next.set(this._peaks);
      this._peaks = next;
    }
    const i = this._peaksLen * 2;
    this._peaks[i]     = mn;
    this._peaks[i + 1] = mx;
    this._peaksLen++;
    this._peaksSamplesPerBucket = L.length; // assume uniform chunk size
  }

  /** Recompute peaks from a known-length buffer (legacy migration / mode switch). */
  private recomputePeaks(L: Float32Array): void {
    const buckets = Math.min(PEAKS_DEFAULT_BUCKETS, Math.max(1, L.length));
    const samplesPerBucket = Math.max(1, Math.ceil(L.length / buckets));
    const out = new Float32Array(buckets * 2);
    for (let b = 0; b < buckets; b++) {
      const lo = b * samplesPerBucket;
      const hi = Math.min(L.length, lo + samplesPerBucket);
      let mn = Infinity, mx = -Infinity;
      for (let i = lo; i < hi; i++) {
        const v = L[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!isFinite(mn)) { mn = 0; mx = 0; }
      out[b * 2]     = mn;
      out[b * 2 + 1] = mx;
    }
    this._peaks = out;
    this._peaksLen = buckets;
    this._peaksSamplesPerBucket = samplesPerBucket;
  }

  /** Compute peaks by streaming the OPFS file in chunks. Used on patch
   *  reload when the sidecar is missing. */
  private async computePeaksFromStorage(): Promise<void> {
    const handle = await bufferStorage.openRead(this._nodeId);
    if (!handle) return;
    try {
      const totalFrames = handle.frameCount;
      const buckets = Math.min(PEAKS_DEFAULT_BUCKETS, Math.max(1, totalFrames));
      const samplesPerBucket = Math.max(1, Math.ceil(totalFrames / buckets));
      const out = new Float32Array(buckets * 2);
      // Read in 1-MB chunks (~125k frames stereo). One bucket spans ~ceil/buckets.
      const READ_BLOCK = 65536;
      let frameIndex = 0;
      let bucketIndex = 0;
      let mn = Infinity, mx = -Infinity;
      let inBucket = 0;
      while (frameIndex < totalFrames && bucketIndex < buckets) {
        const want = Math.min(READ_BLOCK, totalFrames - frameIndex);
        const block = await handle.readFrames(frameIndex, want);
        for (let i = 0; i < block.L.length; i++) {
          const v = block.L[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          inBucket++;
          if (inBucket >= samplesPerBucket) {
            out[bucketIndex * 2]     = isFinite(mn) ? mn : 0;
            out[bucketIndex * 2 + 1] = isFinite(mx) ? mx : 0;
            bucketIndex++;
            mn = Infinity; mx = -Infinity; inBucket = 0;
            if (bucketIndex >= buckets) break;
          }
        }
        frameIndex += block.L.length;
      }
      if (bucketIndex < buckets && inBucket > 0) {
        out[bucketIndex * 2]     = isFinite(mn) ? mn : 0;
        out[bucketIndex * 2 + 1] = isFinite(mx) ? mx : 0;
      }
      this._peaks = out;
      this._peaksLen = buckets;
      this._peaksSamplesPerBucket = samplesPerBucket;
    } finally {
      await handle.close();
    }
  }

  private async persistPeaks(): Promise<void> {
    if (this._peaksLen <= 0) return;
    try {
      await bufferStorage.writePeaks(this._nodeId, {
        bucketCount:      this._peaksLen,
        samplesPerBucket: this._peaksSamplesPerBucket,
        values:           this._peaks.subarray(0, this._peaksLen * 2),
      });
    } catch (err) {
      console.warn(`[buffer~ ${this._nodeId}] writePeaks failed:`, err);
    }
  }

  private emitState(): void {
    for (const fn of this._stateListeners) fn();
  }
}

function clipTo(src: Float32Array, len: number): Float32Array {
  if (src.length === len) return src.slice();
  const out = new Float32Array(len);
  out.set(src.subarray(0, Math.min(src.length, len)), 0);
  return out;
}
