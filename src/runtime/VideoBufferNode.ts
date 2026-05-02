import { videoBufferStorage, type VideoReadHandle, type VideoWriteHandle } from "./vbuf/VideoBufferStorage";

export type VideoBufferTransport = "stop" | "record" | "play" | "pause";

interface VideoBufferConfig {
  maxSeconds: number;
  /** Storage key for OPFS-backed WebM. Use the patch node's id. */
  nodeId: string;
}

/**
 * Per-object runtime for vbuf*.
 *
 * Recording: source <video> → captureStream() → MediaRecorder, with each
 * `dataavailable` chunk appended to an OPFS WebM file. We auto-stop at
 * `maxSeconds` based on the recorder's elapsed wall-clock time.
 *
 * Playback: an internal HTMLVideoElement loads the OPFS file via a Blob URL.
 * Native engine handles seeking, playbackRate, loop, decoding. We layer a
 * range-window enforcement loop on top via requestVideoFrameCallback (with
 * timeupdate fallback) so the [rangeStart, rangeEnd] window is respected
 * even when there's no native API for it.
 *
 * Outlet 0 (media) exposes `this.video` — VisualizerGraph.rewireMedia hands
 * it to downstream consumers (vfxCRT, reaperVideo, etc) just like it does
 * for browser~/youtube~/frame~.
 */
export class VideoBufferNode {
  private _state: VideoBufferTransport = "stop";
  private _rate     = 1.0;
  private _loop     = false;
  private _maxSec:  number;
  private readonly _nodeId: string;

  /** Currently-connected upstream video source. Set via setSource() during
   *  VisualizerGraph.rewireMedia. We snapshot this when record() fires. */
  private _source: HTMLVideoElement | null = null;

  /** Recording state. */
  private _recorder:    MediaRecorder | null = null;
  private _writeHandle: VideoWriteHandle | null = null;
  private _recordTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock timestamp (performance.now ms) when recorder.start() fired.
   *  Used to compute the recording's actual duration without relying on the
   *  WebM container's missing Duration element. */
  private _recordStartedAt: number = 0;

  /** Playback state. */
  private _playEl:     HTMLVideoElement;
  private _readHandle: VideoReadHandle | null = null;
  private _blobUrl:    string | null = null;
  private _rangeStartNorm = 0;
  private _rangeEndNorm   = 0;  // <= start ⇒ no range
  /** rVFC handle used to drive range-enforcement loop. */
  private _rvfcHandle = 0;

  /** Duration of the loaded recording in seconds, or 0. */
  private _duration = 0;

  /** Filmstrip frames — one snapshot pushed per MediaRecorder `dataavailable`
   *  event during record(). Mirrors buffer~'s peaks model: chunk-driven, not
   *  timer-driven. main.ts distributes them across the strip canvas width. */
  private static readonly STRIP_FRAME_W = 48;
  private static readonly STRIP_FRAME_H = 27;
  private static readonly MAX_STRIP_FRAMES = 512;
  private _stripFrames: HTMLCanvasElement[] = [];

  /** Resolves when the in-flight finishRecord() finishes. play() awaits this
   *  so it doesn't race past the OPFS file close. */
  private _finishRecordPromise: Promise<void> | null = null;


  private readonly _stateListeners = new Set<() => void>();
  private readonly _rangeEndListeners = new Set<() => void>();
  private readonly _rangeChangeListeners = new Set<() => void>();
  private readonly _rateChangeListeners = new Set<() => void>();
  /** Latched when checkRange has fired the end-of-range bang for the current
   *  approach to tEnd, cleared once the playhead has wrapped or stepped well
   *  back inside the window. Prevents one bang per rVFC tick while currentTime
   *  is still settling after the seek-back. */
  private _endFired = false;

  constructor(config: VideoBufferConfig) {
    this._maxSec = Math.max(1, config.maxSeconds);
    this._nodeId = config.nodeId;

    this._playEl = document.createElement("video");
    this._playEl.muted = true;
    this._playEl.playsInline = true;
    this._playEl.preload = "auto";
    // Mute is required for autoplay-without-user-gesture in modern browsers.
    // Audio playback for recordings is out of scope for v1 anyway.
    this._playEl.addEventListener("loadedmetadata", () => {
      // Only trust loadedmetadata's duration when it's a finite real number.
      // MediaRecorder WebM lacks a Duration element ⇒ duration is Infinity;
      // we'll set _duration from wall-clock in finishRecord, or via the
      // seek-trick on patch reload (adoptStorage). Don't overwrite a valid
      // wall-clock duration with the Infinity sentinel.
      const d = this._playEl.duration;
      if (isFinite(d) && d > 0) {
        this._duration = d;
        this.emitState();
      }
    });
    this._playEl.addEventListener("ended", () => {
      // Native ended fires only when there's no range. With a range, our
      // rVFC loop wraps before this fires.
      if (!this._loop) {
        this._state = "stop";
        this.emitState();
      }
    });
  }

  // ── Public API ──────────────────────────────────────────────────────

  get state(): VideoBufferTransport { return this._state; }
  get rate():  number  { return this._rate; }
  get loop():  boolean { return this._loop; }
  get nodeId(): string { return this._nodeId; }
  get duration(): number { return this._duration; }
  /** Total media length in milliseconds — independent of playback rate.
   *  Changes only when a new recording loads or finishes recording. */
  get effectiveDurMs(): number { return this._duration * 1000; }
  /** Length of the active loop window in ms (loopEnd − loopStart) × duration. */
  get loopLenMs(): number { return (this.loopEnd - this.loopStart) * this._duration * 1000; }
  get video(): HTMLVideoElement { return this._playEl; }
  get hasRecording(): boolean { return this._duration > 0 || this._readHandle != null; }

  /** Effective playback window in normalized 0..1. When no range is set
   *  (rangeEnd ≤ rangeStart), the active window is the whole buffer [0, 1].
   *  These are what outlets 3/4 (loopstart/loopend) emit. */
  get loopStart(): number {
    return this._rangeEndNorm > this._rangeStartNorm ? this._rangeStartNorm : 0;
  }
  get loopEnd(): number {
    return this._rangeEndNorm > this._rangeStartNorm ? this._rangeEndNorm : 1;
  }
  /** Raw stored range (0,0 ⇒ cleared). For persistence — `loopStart`/`loopEnd`
   *  fold the cleared state into [0,1], which is wrong to write back into args. */
  get rangeStartNorm(): number { return this._rangeStartNorm; }
  get rangeEndNorm():   number { return this._rangeEndNorm; }

  // ── MediaVideoSource conformance (LayerNode.setMediaVideo / VFX) ────
  get isReady(): boolean { return this._duration > 0 && this._playEl.readyState >= 2; }
  get hasError(): boolean { return this._playEl.error != null; }

  /** Normalized 0..1 position; 0 when no recording. */
  get position(): number {
    if (this._duration <= 0) return 0;
    return Math.max(0, Math.min(1, this._playEl.currentTime / this._duration));
  }

  /** Set or clear the upstream video source. Called by VisualizerGraph
   *  during rewireMedia. Recording uses whatever source was set last when
   *  the user fires record(). */
  setSource(video: HTMLVideoElement | null): void {
    this._source = video;
  }

  setMaxSeconds(seconds: number): void {
    const next = Math.max(1, Math.min(600, seconds));
    if (next === this._maxSec) return;
    this._maxSec = next;
    if (this._state === "record") this.stop();
  }

  setRate(r: number): void {
    if (!Number.isFinite(r)) return;
    // D1: forward only. Browser playbackRate floor is 0.0625; below that
    // is unreliable, so we clamp incoming values rather than supporting
    // rate=0 as a pause shortcut (use pause()/stop() for that).
    this._rate = Math.max(0.0625, Math.min(16, Math.abs(r)));
    this._playEl.playbackRate = this._rate;
    this.emitRateChange();
  }

  setLoop(v: boolean): void {
    this._loop = !!v;
    // Native loop only when no range; with a range, our rVFC handler wraps.
    this._playEl.loop = this._loop && this._rangeEndNorm <= this._rangeStartNorm;
  }

  /** Persistent playback window. `end <= start` clears the range. */
  setRange(normStart: number, normEnd: number): void {
    let s = Number.isFinite(normStart) ? normStart : 0;
    let e = Number.isFinite(normEnd)   ? normEnd   : 0;
    // Clear sentinel must be detected on raw inputs — once we shift/clip below,
    // a request like `range 1.2 1.5` (length 0.3, fits in [0,1]) would no
    // longer look like a clear and would correctly become [0.7, 1.0].
    const clearing = e <= s;
    if (!clearing) {
      const len = e - s;
      if (len <= 1) {
        // Window fits in [0,1]. Shift to fit instead of clamping each end —
        // independent clamping silently shrinks the window on overshoot
        // (e.g. `range 0.8 1.3` → [0.8, 1.0], length 0.5 instead of 0.5),
        // which ratchets the loop shorter on every random-walk bang.
        if      (s < 0) { s = 0;        e = len;     }
        else if (e > 1) { e = 1;        s = 1 - len; }
      } else {
        // Window can't fit — clip both ends (length intentionally not preserved).
        s = Math.max(0, Math.min(1, s));
        e = Math.max(0, Math.min(1, e));
      }
    }
    const prevStart = this._rangeStartNorm;
    const prevEnd   = this._rangeEndNorm;
    if (clearing || e <= s) {
      this._rangeStartNorm = 0;
      this._rangeEndNorm   = 0;
    } else {
      this._rangeStartNorm = s;
      this._rangeEndNorm   = e;
    }
    // Re-evaluate native loop vs. range loop.
    this._playEl.loop = this._loop && this._rangeEndNorm <= this._rangeStartNorm;
    // If looping and playing, immediately restart from the new range start so
    // every range update begins a fresh loop cycle rather than waiting for the
    // playhead to drift out of the old window.
    // Only seek when the new range is valid (non-cleared) — a cleared range
    // (e ≤ s above) produces rangeStartNorm=0, and seeking to 0 here would
    // erroneously jump to the start when a programmatic source sends lo/hi as
    // two separate messages and the first message temporarily has lo > old-hi.
    if (this._loop && this._state === "play" && this._duration > 0
        && this._rangeEndNorm > this._rangeStartNorm
        && (this._rangeStartNorm !== prevStart || this._rangeEndNorm !== prevEnd)) {
      this._endFired = false;
      this.precisionSeek(this._rangeStartNorm * this._duration);
    }
    this.emitState();
    if (this._rangeStartNorm !== prevStart || this._rangeEndNorm !== prevEnd) {
      this.emitRangeChange();
    }
  }

  /** Move the loop window to start at `normStart`, preserving its current length.
   *  Length is taken from the active window (loopEnd − loopStart) — for an
   *  unranged buffer this is 1.0, so the call is effectively a no-op. */
  setLoopStart(normStart: number): void {
    const len = this.loopEnd - this.loopStart;
    this.setRange(normStart, normStart + len);
  }

  /** Resize the loop window in milliseconds, preserving its current start.
   *  No-op when duration is unknown (would divide by zero). */
  setLoopLenMs(ms: number): void {
    if (this._duration <= 0) return;
    const len = ms / (this._duration * 1000);
    this.setRange(this.loopStart, this.loopStart + len);
  }

  async record(): Promise<void> {
    if (!this._source) {
      console.warn(`[vbuf* ${this._nodeId}] record: no upstream source connected`);
      return;
    }
    // Tear down any prior playback / recording first.
    this.stop();

    let stream: MediaStream | null = null;
    try {
      // captureStream() works on HTMLVideoElement regardless of whether the
      // source is a <video src=…> or backed by srcObject = MediaStream.
      // Audio tracks tag along; we don't write them in v1 but they'll end up
      // in the WebM container if present.
      const cap = (this._source as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
      stream = cap ? cap.call(this._source) : null;
    } catch (err) {
      console.warn(`[vbuf* ${this._nodeId}] captureStream failed:`, err);
      return;
    }
    if (!stream || stream.getTracks().length === 0) {
      console.warn(`[vbuf* ${this._nodeId}] captureStream returned no tracks`);
      return;
    }

    // Pick the best supported codec; vp9 → vp8 → default.
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const supported = candidates.find(t => MediaRecorder.isTypeSupported(t)) ?? "";
    let recorder: MediaRecorder;
    try {
      recorder = supported
        ? new MediaRecorder(stream, { mimeType: supported })
        : new MediaRecorder(stream);
    } catch (err) {
      console.warn(`[vbuf* ${this._nodeId}] MediaRecorder ctor failed:`, err);
      return;
    }

    try {
      this._writeHandle = await videoBufferStorage.openWrite(this._nodeId);
    } catch (err) {
      console.warn(`[vbuf* ${this._nodeId}] openWrite failed:`, err);
      return;
    }

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0 && this._writeHandle) {
        this._writeHandle.appendBlob(ev.data).catch(err => {
          console.warn(`[vbuf* ${this._nodeId}] OPFS append failed:`, err);
        });
      }
      // One filmstrip frame per chunk — same model as buffer~ peaks.
      this.sampleStripFrame();
    };
    recorder.onstop = () => {
      this._finishRecordPromise = this.finishRecord().finally(() => {
        this._finishRecordPromise = null;
      });
    };
    recorder.onerror = (ev) => {
      console.warn(`[vbuf* ${this._nodeId}] recorder error:`, ev);
      this.stop();
    };

    this._recorder = recorder;
    this._state = "record";
    this._stripFrames = [];
    this._recordStartedAt = performance.now();
    recorder.start(250);

    // Live preview: pipe the same stream into the playback element so the
    // panel shows what's being captured. srcObject + captureStream is the
    // standard way to get a hot mirror in a <video> tag without buffering.
    this._playEl.removeAttribute("src");
    this._playEl.srcObject = stream;
    void this._playEl.play().catch(() => { /* autoplay rejection is ok */ });

    // Auto-stop at maxSec.
    this._recordTimeoutId = setTimeout(() => {
      if (this._state === "record") this.stop();
    }, this._maxSec * 1000);

    this.emitState();
  }

  async play(): Promise<void> {
    if (this._state === "record") this.stop();
    // Wait for any in-flight finishRecord() — OPFS file may not be closed yet.
    if (this._finishRecordPromise) {
      try { await this._finishRecordPromise; } catch { /* ignore */ }
    }
    await this.ensurePlaybackLoaded();
    if (this._duration <= 0) return;
    this._playEl.playbackRate = Math.max(0.0625, Math.min(16, this._rate || 0.0625));
    void this._playEl.play().catch(() => { /* autoplay rejection ok */ });
    this._state = "play";
    this._endFired = false;
    this.startRangeWatchdog();
    this.emitState();
  }

  /** Start playback within a specific window (one-shot — does NOT change
   *  the persistent range). normStart/normEnd are 0..1. */
  async playFrom(normStart: number, normEnd?: number): Promise<void> {
    if (this._state === "record") this.stop();
    if (this._finishRecordPromise) {
      try { await this._finishRecordPromise; } catch { /* ignore */ }
    }
    await this.ensurePlaybackLoaded();
    const dur = this._duration || 0;
    if (dur <= 0) return;
    const s = Math.max(0, Math.min(1, Number.isFinite(normStart) ? normStart : 0));
    const e = Number.isFinite(normEnd as number)
      ? Math.max(s, Math.min(1, normEnd as number))
      : 1;
    this._playEl.currentTime = s * dur;
    this._oneShotEnd = e;
    this._playEl.playbackRate = Math.max(0.0625, Math.min(16, this._rate || 0.0625));
    void this._playEl.play().catch(() => { /* autoplay rejection ok */ });
    this._state = "play";
    this._endFired = false;
    this.startRangeWatchdog();
    this.emitState();
  }

  pause(): void {
    this._playEl.pause();
    this._state = "pause";
    this.emitState();
  }

  stop(): void {
    // Recording stop is async (recorder.onstop → finishRecord). We set the
    // state to stop optimistically; finishRecord re-emits when done.
    if (this._recorder && this._recorder.state !== "inactive") {
      try { this._recorder.stop(); } catch { /* ignore */ }
    }
    if (this._recordTimeoutId != null) {
      clearTimeout(this._recordTimeoutId);
      this._recordTimeoutId = null;
    }
    this._playEl.pause();
    this._playEl.currentTime = 0;
    this._oneShotEnd = -1;
    this.stopRangeWatchdog();
    this._state = "stop";
    this.emitState();
  }

  seek(norm: number): void {
    if (!this.hasRecording || this._duration <= 0) return;
    const t = Math.max(0, Math.min(1, norm)) * this._duration;
    this._playEl.currentTime = t;
    this.emitState();
  }

  async clear(): Promise<void> {
    this.stop();
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
    if (this._readHandle) {
      await this._readHandle.close();
      this._readHandle = null;
    }
    this._duration = 0;
    this._stripFrames = [];
    this._playEl.removeAttribute("src");
    this._playEl.load();
    await videoBufferStorage.delete(this._nodeId);
    this.emitState();
  }

  /** Load a local video file into the buffer. The file is written to the same
   *  OPFS slot used by recordings, so playback / seek / range / loop / rate all
   *  work identically. Filmstrip thumbnails are sampled by seeking through the
   *  playback element after the file lands. */
  async loadFile(file: File): Promise<void> {
    if (!file || file.size === 0) return;
    // Tear down any prior recording / playback.
    this.stop();
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    if (this._readHandle) { try { await this._readHandle.close(); } catch { /* ignore */ } this._readHandle = null; }
    this._duration = 0;
    this._stripFrames = [];
    this.emitState();

    // Write the file straight into OPFS at this node's key.
    try {
      const w = await videoBufferStorage.openWrite(this._nodeId);
      await w.appendBlob(file);
      await w.close();
    } catch (err) {
      console.warn(`[vbuf* ${this._nodeId}] loadFile: write failed`, err);
      return;
    }

    await this.ensurePlaybackLoaded();
    // Some containers (notably WebM without a Cues element) report duration
    // as Infinity until a full scan completes — same trick we use on reload.
    if (!isFinite(this._duration) || this._duration <= 0) {
      try { await this.resolveDuration(); } catch { /* ignore */ }
    }

    await this.generateStripFrames();
    this._state = "stop";
    this.emitState();
  }

  /** Sample frames across the loaded recording for the filmstrip canvas.
   *  Recording fills the strip chunk-by-chunk; loaded files have no chunk
   *  stream, so we seek through the playback element instead. */
  private async generateStripFrames(): Promise<void> {
    const dur = this._duration;
    if (!isFinite(dur) || dur <= 0) return;
    const v = this._playEl;
    if (v.readyState < 1) return;

    const w = VideoBufferNode.STRIP_FRAME_W;
    const h = VideoBufferNode.STRIP_FRAME_H;
    const N = Math.min(VideoBufferNode.MAX_STRIP_FRAMES, 48);

    for (let i = 0; i < N; i++) {
      const t = ((i + 0.5) / N) * dur;
      await this.seekAndWait(v, t);
      const c = document.createElement("canvas");
      c.width  = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      try {
        ctx.drawImage(v, 0, 0, w, h);
      } catch {
        continue;
      }
      this._stripFrames.push(c);
      this.emitState();
    }
    try { v.currentTime = 0; } catch { /* ignore */ }
  }

  private seekAndWait(v: HTMLVideoElement, t: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const cleanup = () => {
        if (done) return; done = true;
        v.removeEventListener("seeked", onSeek);
        v.removeEventListener("error", onErr);
        resolve();
      };
      const onSeek = () => cleanup();
      const onErr  = () => cleanup();
      v.addEventListener("seeked", onSeek);
      v.addEventListener("error", onErr);
      try { v.currentTime = Math.max(0, t); } catch { cleanup(); return; }
      // Defensive timeout — a stuck seek would leave the loop hanging.
      setTimeout(cleanup, 1500);
    });
  }

  /** Open the OPFS recording on patch reload — duration is read from the
   *  HTMLVideoElement once metadata loads. Returns true if a recording was
   *  found. Also regenerates filmstrip thumbnails since those live in memory
   *  only (the strip canvas is empty after reload until we re-sample). */
  async adoptStorage(): Promise<boolean> {
    const exists = await videoBufferStorage.exists(this._nodeId);
    if (!exists) return false;
    await this.ensurePlaybackLoaded();
    // On patch reload there's no wall-clock recording duration to fall back
    // on, so resolve duration via the seek-past-end trick.
    if (this._duration <= 0) {
      try { await this.resolveDuration(); } catch { /* ignore */ }
    }
    if (this._duration > 0) {
      this._stripFrames = [];
      try { await this.generateStripFrames(); } catch { /* ignore */ }
      this.emitState();
    }
    return this._duration > 0;
  }

  onStateChange(fn: () => void): () => void {
    this._stateListeners.add(fn);
    return () => { this._stateListeners.delete(fn); };
  }

  /** Fires when playback hits the end of the active window — either the loop
   *  wrap point or the one-shot stop point. Outlet 2 (bang) hangs off this. */
  onRangeEnd(fn: () => void): () => void {
    this._rangeEndListeners.add(fn);
    return () => { this._rangeEndListeners.delete(fn); };
  }

  /** Fires when the persistent playback window (loopStart / loopEnd) changes.
   *  Outlets 3 and 4 (loopstart / loopend floats) hang off this. */
  onRangeChange(fn: () => void): () => void {
    this._rangeChangeListeners.add(fn);
    return () => { this._rangeChangeListeners.delete(fn); };
  }

  onRateChange(fn: () => void): () => void {
    this._rateChangeListeners.add(fn);
    return () => { this._rateChangeListeners.delete(fn); };
  }

  /** Filmstrip frames for the panel to draw — one canvas per recorded chunk.
   *  main.ts distributes these horizontally across the strip canvas. */
  getStrip(): { frames: ReadonlyArray<HTMLCanvasElement>; max: number } {
    return { frames: this._stripFrames, max: VideoBufferNode.MAX_STRIP_FRAMES };
  }

  destroy(): void {
    this.stop();
    if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
    this._blobUrl = null;
    this._stateListeners.clear();
    this._rangeEndListeners.clear();
    this._rangeChangeListeners.clear();
    this._rateChangeListeners.clear();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private _oneShotEnd = -1;

  private sampleStripFrame(): void {
    if (!this._source) return;
    if (this._stripFrames.length >= VideoBufferNode.MAX_STRIP_FRAMES) return;
    const w = VideoBufferNode.STRIP_FRAME_W;
    const h = VideoBufferNode.STRIP_FRAME_H;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    try {
      ctx.drawImage(this._source, 0, 0, w, h);
    } catch {
      // drawImage can throw if the source video isn't ready yet — skip and
      // wait for the next chunk.
      return;
    }
    this._stripFrames.push(c);
    this.emitState();
  }

  private async finishRecord(): Promise<void> {
    if (this._writeHandle) {
      try { await this._writeHandle.close(); } catch { /* ignore */ }
      this._writeHandle = null;
    }
    if (this._recordTimeoutId != null) {
      clearTimeout(this._recordTimeoutId);
      this._recordTimeoutId = null;
    }
    this._recorder = null;
    // Capture the recording's actual duration from wall-clock — MediaRecorder
    // WebM has no Duration element in its container, so videoEl.duration
    // reports Infinity until a full file scan completes. The wall-clock
    // measurement is accurate to within one chunk timeslice (~250ms).
    const wallClockDur = this._recordStartedAt > 0
      ? (performance.now() - this._recordStartedAt) / 1000
      : 0;
    // Detach the live-preview MediaStream and reset cached playback state so
    // ensurePlaybackLoaded re-opens the freshly-written OPFS file.
    this._playEl.pause();
    this._playEl.srcObject = null;
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    if (this._readHandle) { await this._readHandle.close(); this._readHandle = null; }
    this._duration = 0;
    // Eagerly load the OPFS recording so the preview shows the first frame
    // immediately after stop instead of going black until the user hits play.
    try { await this.ensurePlaybackLoaded(); } catch { /* ignore */ }
    // Wall-clock takes precedence over whatever loadedmetadata wrote (which
    // is 0 for MediaRecorder WebM). Without this, play() bails on _duration<=0.
    if (wallClockDur > 0) this._duration = wallClockDur;
    this._state = "stop";
    this.emitState();
  }

  private async ensurePlaybackLoaded(): Promise<void> {
    // Already loaded and the video element is bound to the blob — fast path.
    if (this._readHandle && this._blobUrl && this._duration > 0
        && this._playEl.src === this._blobUrl) return;

    // Tear down any prior playback handle / blob URL so we always re-open
    // from OPFS — the file may have been rewritten by a fresh recording.
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    if (this._readHandle) { try { await this._readHandle.close(); } catch { /* ignore */ } this._readHandle = null; }
    this._duration = 0;

    const handle = await videoBufferStorage.openRead(this._nodeId);
    if (!handle) return;
    this._readHandle = handle;
    this._blobUrl = URL.createObjectURL(handle.file);

    // Detach any leftover live-preview MediaStream binding before rebinding
    // src — the spec is fuzzy on src-after-srcObject ordering, so be explicit.
    // Detach any prior MediaStream binding before src — assigning src while
    // srcObject is still set is undefined behavior per spec.
    this._playEl.srcObject = null;
    // Single src assignment + load(). Wait for loadedmetadata of THIS load
    // (not relying on readyState — which may be stale from a previous src).
    this._playEl.src = this._blobUrl;
    this._playEl.load();

    await new Promise<void>((resolve) => {
      const onMeta = () => {
        this._playEl.removeEventListener("loadedmetadata", onMeta);
        this._playEl.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = () => {
        this._playEl.removeEventListener("loadedmetadata", onMeta);
        this._playEl.removeEventListener("error", onErr);
        resolve();
      };
      this._playEl.addEventListener("loadedmetadata", onMeta);
      this._playEl.addEventListener("error", onErr);
    });
  }

  private startRangeWatchdog(): void {
    this.stopRangeWatchdog();
    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    const v = this._playEl as RvfcVideo;
    if (typeof v.requestVideoFrameCallback === "function") {
      const tick = () => {
        this.checkRange();
        if (this._state === "play") {
          this._rvfcHandle = (v.requestVideoFrameCallback as (cb: () => void) => number)(tick);
        }
      };
      this._rvfcHandle = v.requestVideoFrameCallback(tick);
    } else {
      const onTimeUpdate = () => this.checkRange();
      this._playEl.addEventListener("timeupdate", onTimeUpdate);
      this._fallbackTimeUpdate = onTimeUpdate;
    }
  }

  private _fallbackTimeUpdate: (() => void) | null = null;

  private stopRangeWatchdog(): void {
    type RvfcVideo = HTMLVideoElement & {
      cancelVideoFrameCallback?: (h: number) => void;
    };
    const v = this._playEl as RvfcVideo;
    if (this._rvfcHandle && typeof v.cancelVideoFrameCallback === "function") {
      v.cancelVideoFrameCallback(this._rvfcHandle);
    }
    this._rvfcHandle = 0;
    if (this._fallbackTimeUpdate) {
      this._playEl.removeEventListener("timeupdate", this._fallbackTimeUpdate);
      this._fallbackTimeUpdate = null;
    }
  }

  /** Per-frame check: if currentTime is outside the active window, wrap or
   *  stop. Active window is the intersection of the persistent range and
   *  the one-shot play window (if any).
   *
   *  Loop wrap fires slightly *before* tEnd to absorb decode latency — by the
   *  time the seek-back actually paints a frame, the playhead has typically
   *  advanced ~1 frame past where we initiated the seek. Without preroll,
   *  short loops drift forward each cycle. */
  private static readonly LOOP_PREROLL_S = 1 / 30;  // ~one 30fps frame

  private checkRange(): void {
    if (this._state !== "play" || this._duration <= 0) return;
    const dur = this._duration;

    // Compose active window in normalized space.
    const s = this._rangeEndNorm > this._rangeStartNorm ? this._rangeStartNorm : 0;
    let e = this._rangeEndNorm > this._rangeStartNorm ? this._rangeEndNorm : 1;
    if (this._oneShotEnd > 0 && this._oneShotEnd <= 1 && this._oneShotEnd > s) {
      e = Math.min(e, this._oneShotEnd);
    }

    const t    = this._playEl.currentTime;
    const tEnd = e * dur;
    const tStart = s * dur;
    const preroll = VideoBufferNode.LOOP_PREROLL_S;

    // Reset the end-of-range latch once the playhead has comfortably moved
    // back inside the window (post-wrap or post-seek).
    if (t < tEnd - preroll * 2) this._endFired = false;

    if (t >= tEnd - preroll) {
      if (this._loop) {
        this.precisionSeek(tStart);
        if (!this._endFired) {
          this._endFired = true;
          this.emitRangeEnd();
        }
      } else if (t >= tEnd - 1e-3) {
        this._playEl.pause();
        this._playEl.currentTime = tEnd;
        this._oneShotEnd = -1;
        this._state = "stop";
        this.stopRangeWatchdog();
        this.emitState();
        if (!this._endFired) {
          this._endFired = true;
          this.emitRangeEnd();
        }
      }
    } else if (t < tStart - 1e-3) {
      this.precisionSeek(tStart);
    }
  }

  /** WebM-from-MediaRecorder reports duration=Infinity (no Cues element to
   *  derive duration from at metadata time). Standard workaround: seek past
   *  the end of the file — the browser clamps currentTime to the actual end,
   *  and the resulting `seeked` event hands us a real duration to read. We
   *  then seek back to 0 so playback starts from the beginning. */
  private resolveDuration(): Promise<void> {
    return new Promise<void>((resolve) => {
      const v = this._playEl;
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        v.removeEventListener("seeked", onSeeked);
        v.removeEventListener("error", onErr);
        const t = v.currentTime;
        if (isFinite(t) && t > 0) {
          this._duration = t;
        }
        // Snap back to 0 so subsequent play() starts at the beginning. Use
        // a try/catch — currentTime assignment can throw if src is gone.
        try { v.currentTime = 0; } catch { /* ignore */ }
        this.emitState();
        resolve();
      };
      const onSeeked = () => finish();
      const onErr = () => { this._duration = 0; finish(); };
      v.addEventListener("seeked", onSeeked);
      v.addEventListener("error", onErr);
      try {
        v.currentTime = 1e9;  // anything past the end; browser clamps to real end
      } catch {
        finish();
      }
      // Defensive timeout in case neither event fires (shouldn't happen on a
      // valid file, but leaving a stuck Promise would freeze play() forever).
      setTimeout(finish, 3000);
    });
  }

  private precisionSeek(t: number): void {
    this._playEl.currentTime = Math.max(0, t);
  }

  private emitState(): void {
    for (const fn of this._stateListeners) fn();
  }

  private emitRangeEnd(): void {
    for (const fn of this._rangeEndListeners) fn();
  }

  private emitRangeChange(): void {
    for (const fn of this._rangeChangeListeners) fn();
  }

  private emitRateChange(): void {
    for (const fn of this._rateChangeListeners) fn();
  }
}
