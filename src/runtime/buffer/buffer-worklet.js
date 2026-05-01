// buffer~ AudioWorkletProcessor — ring-buffer streaming.
//
// Phase 3b model: the worklet holds only a fixed-size ring (~2 sec @ 48kHz),
// not the full PCM. Main thread streams samples in via `playChunk` for
// playback and consumes flushed samples via `recordChunk` during record.
//
// Messages (main → worklet):
//   { type: "init",      mode, maxSamples }
//   { type: "setMode",   mode }                    // "stereo" | "mono"
//   { type: "setLength", value }                   // canonical recording length in samples
//   { type: "record" }                             // begin record at sample 0
//   { type: "play",      start?, end? }            // sample-index window; omit for full / persistent range
//   { type: "pause" }
//   { type: "stop" }                               // pos → rangeStart
//   { type: "rate",      value }
//   { type: "loop",      value }                   // boolean
//   { type: "seek",      position }                // sample index
//   { type: "setRange",  start, end }              // persistent playback window in samples
//   { type: "playChunk", offset, L, R }            // main supplying samples for absolute range [offset, offset+L.length)
//   { type: "clear" }
//
// Messages (worklet → main):
//   { type: "position",    value }                 // sample index, ~60 Hz (play/seek/stop)
//   { type: "recordChunk", offset, L, R, totalLen, final? } // record streaming
//   { type: "recordDone",  totalLen }              // end of record (PCM already streamed)
//   { type: "needSamples", from, count }           // "send me samples around the playhead"
//   { type: "playDone" }                           // non-looping reach end

const POSITION_TICK_SAMPLES = 1024;
// Ring size — bounded RAM. 2 sec @ 48kHz × 4 B × 2 ch = ~768 KB total.
const RING_SAMPLES = 96000;
// Trigger a refill when fewer than this many samples are buffered ahead of
// the playhead. ~0.5 sec gives main thread plenty of slack to respond.
const PREFETCH_THRESHOLD_SAMPLES = 24000;

class BufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state       = "stop";
    this.mode        = "stereo";
    this.maxSamples  = 0;
    this.bufferLen   = 0;          // canonical recording length (set by main + grows during record)
    this.position    = 0;          // play position (fractional sample index)
    this.rate        = 1.0;
    this.loop        = false;

    // Persistent range (sample indices). [0, -1] = no range.
    this.rangeStart  = 0;
    this.rangeEnd    = -1;
    // Transient play window (overrides range when explicitly set by `play`).
    this.playStart   = 0;
    this.playEnd     = -1;

    // Ring buffer — allocated lazily on first record/play; freed on clear.
    this.ringL       = null;
    this.ringR       = null;
    // Record bookkeeping.
    this.unflushedSamples = 0;
    // Play bookkeeping. validFrom/validUpTo are absolute sample indices; the
    // ring holds samples for positions in [validFrom, validUpTo). Slot for
    // absolute pos `p` = `p % RING_SAMPLES`. When validUpTo - validFrom >
    // RING_SAMPLES the oldest samples have been overwritten and become invalid.
    this.validFrom   = 0;
    this.validUpTo   = 0;
    this.fetchInFlight = false;
    // Bumped every time we invalidate the ring (seek, wrap, mode change).
    // needSamples carries the current token; playChunk replies that don't
    // match are stale and must be dropped before they corrupt ring slots.
    this.fetchToken  = 0;

    this.samplesSincePosition = 0;
    this.port.onmessage = (ev) => this.onMessage(ev);
  }

  ensureRing() {
    if (!this.ringL) {
      this.ringL = new Float32Array(RING_SAMPLES);
      this.ringR = new Float32Array(RING_SAMPLES);
    }
  }

  invalidateRing() {
    this.validFrom = 0;
    this.validUpTo = 0;
    this.fetchInFlight = false;
    this.fetchToken++;
  }

  /** Flush any record samples sitting in the ring out to main. */
  flushRecord(final) {
    if (this.unflushedSamples <= 0) {
      if (final) {
        this.port.postMessage({ type: "recordChunk", offset: this.bufferLen, L: new Float32Array(0), R: new Float32Array(0), totalLen: this.bufferLen, final: true });
      }
      return;
    }
    const n = this.unflushedSamples;
    const startAbs = this.bufferLen - n;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const slot = (startAbs + i) % RING_SAMPLES;
      L[i] = this.ringL[slot];
      R[i] = this.ringR[slot];
    }
    this.port.postMessage({
      type:     "recordChunk",
      offset:   startAbs,
      L, R,
      totalLen: this.bufferLen,
      final:    !!final,
    });
    this.unflushedSamples = 0;
  }

  /** Ask main to deliver samples around the playhead. Idempotent — at most
   *  one request in flight at a time. Clamped to the active play window so
   *  prefetch doesn't burn ring slots on samples past loop-end. */
  requestSamples() {
    if (this.fetchInFlight)   return;
    if (this.bufferLen === 0) return;
    if (this.state !== "play") return;
    const winStart = this.playEnd > this.playStart
      ? this.playStart
      : (this.rangeEnd > this.rangeStart ? this.rangeStart : 0);
    const winEnd = this.playEnd > this.playStart
      ? this.playEnd
      : (this.rangeEnd > this.rangeStart ? this.rangeEnd : this.bufferLen);
    const ip = Math.max(winStart, Math.floor(this.position));
    const from = Math.max(this.validUpTo, ip);
    const target = Math.min(winEnd, ip + RING_SAMPLES);
    if (target <= from) return;
    this.fetchInFlight = true;
    this.port.postMessage({
      type:  "needSamples",
      from,
      count: target - from,
      token: this.fetchToken,
    });
  }

  onMessage(ev) {
    const m = ev.data;
    if (!m) return;
    switch (m.type) {
      case "init": {
        this.mode = m.mode === "mono" ? "mono" : "stereo";
        this.maxSamples = m.maxSamples | 0;
        this.bufferLen = 0;
        this.position = 0;
        this.ringL = null;
        this.ringR = null;
        this.invalidateRing();
        this.unflushedSamples = 0;
        break;
      }
      case "setMode":
        this.mode = m.mode === "mono" ? "mono" : "stereo";
        break;
      case "setLength": {
        // Canonical length supplied by main on patch load. Doesn't change ring
        // contents — play will fetch as needed.
        this.bufferLen = Math.max(0, m.value | 0);
        if (this.position > this.bufferLen) this.position = 0;
        break;
      }
      case "record": {
        this.state = "record";
        this.position = 0;
        this.bufferLen = 0;
        this.unflushedSamples = 0;
        this.samplesSincePosition = 0;
        this.ensureRing();
        this.invalidateRing();
        break;
      }
      case "play": {
        if (this.bufferLen === 0) {
          this.state = "stop";
          this.position = 0;
          this.samplesSincePosition = 0;
          break;
        }
        const hasMsgStart = Number.isFinite(m.start);
        const hasMsgEnd   = Number.isFinite(m.end);
        const winStart = hasMsgStart
          ? Math.max(0, Math.min(this.bufferLen - 1, m.start | 0))
          : (this.rangeEnd > this.rangeStart ? this.rangeStart : 0);
        const winEnd = hasMsgEnd
          ? Math.max(winStart + 1, Math.min(this.bufferLen, m.end | 0))
          : (this.rangeEnd > this.rangeStart ? this.rangeEnd : this.bufferLen);
        this.playStart = winStart;
        this.playEnd   = winEnd;
        if (hasMsgStart || this.position < winStart || this.position >= winEnd) {
          this.position = this.rate >= 0 ? winStart : winEnd - 1;
        }
        this.ensureRing();
        this.invalidateRing();
        this.state = "play";
        this.samplesSincePosition = 0;
        // Pre-request a ring-full so the first audio block has data.
        this.requestSamples();
        break;
      }
      case "pause":
        this.state = "pause";
        break;
      case "stop": {
        if (this.state === "record") {
          this.flushRecord(true);
          this.port.postMessage({ type: "recordDone", totalLen: this.bufferLen });
        }
        this.state = "stop";
        const restart = this.rangeEnd > this.rangeStart ? this.rangeStart : 0;
        this.position = restart;
        this.playStart = restart;
        this.playEnd   = -1;
        this.invalidateRing();
        this.port.postMessage({ type: "position", value: this.position });
        break;
      }
      case "rate":
        this.rate = +m.value || 0;
        break;
      case "loop":
        this.loop = !!m.value;
        break;
      case "seek": {
        const n = Math.max(0, Math.min(Math.max(0, this.bufferLen - 1), m.position | 0));
        this.position = n;
        this.invalidateRing();
        if (this.state === "play") this.requestSamples();
        this.port.postMessage({ type: "position", value: n });
        break;
      }
      case "setRange": {
        const start = Math.max(0, m.start | 0);
        const end   = Math.max(start, Math.min(this.bufferLen, m.end | 0));
        if (end <= start) {
          this.rangeStart = 0;
          this.rangeEnd   = -1;
        } else {
          this.rangeStart = start;
          this.rangeEnd   = end;
        }
        if (this.state === "play" && this.rangeEnd > this.rangeStart) {
          this.playStart = this.rangeStart;
          this.playEnd   = this.rangeEnd;
          if (this.position < this.playStart || this.position >= this.playEnd) {
            this.position = this.rate >= 0 ? this.playStart : this.playEnd - 1;
            this.invalidateRing();
            this.requestSamples();
          }
        }
        break;
      }
      case "playChunk": {
        const L = m.L instanceof Float32Array ? m.L : null;
        const R = m.R instanceof Float32Array ? m.R : null;
        const start = m.offset | 0;
        // Drop chunks from before the most recent invalidate (seek / wrap /
        // mode change). Their ring slots would collide with what we just
        // re-fetched and corrupt playback at the new position.
        if (m.token !== undefined && m.token !== this.fetchToken) {
          this.fetchInFlight = false;
          break;
        }
        if (!L || !R || L.length === 0) {
          this.fetchInFlight = false;
          break;
        }
        this.ensureRing();
        const n = L.length;
        for (let i = 0; i < n; i++) {
          const slot = (start + i) % RING_SAMPLES;
          this.ringL[slot] = L[i];
          this.ringR[slot] = R[i];
        }
        // Update validity. If start jumps far ahead/back of existing window,
        // reset; otherwise extend.
        const newEnd = start + n;
        if (start > this.validUpTo || start + n < this.validFrom) {
          this.validFrom = start;
          this.validUpTo = newEnd;
        } else {
          if (start < this.validFrom) this.validFrom = start;
          if (newEnd > this.validUpTo) this.validUpTo = newEnd;
        }
        // Cap validFrom so the window doesn't claim more than the ring can hold.
        const cap = this.validUpTo - RING_SAMPLES;
        if (this.validFrom < cap) this.validFrom = cap;
        this.fetchInFlight = false;
        // If still low, kick off another fetch.
        if (this.validUpTo - Math.floor(this.position) < PREFETCH_THRESHOLD_SAMPLES) {
          this.requestSamples();
        }
        break;
      }
      case "clear":
        this.bufferLen = 0;
        this.position = 0;
        this.state = "stop";
        this.ringL = null;
        this.ringR = null;
        this.invalidateRing();
        this.unflushedSamples = 0;
        this.port.postMessage({ type: "position", value: 0 });
        break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : null;
    const blockLen = outL ? outL.length : 128;

    if (this.state === "record") {
      const in0      = inputs[0] && inputs[0][0] ? inputs[0][0] : null;
      const in1Source = inputs[0] && inputs[0][1] ? inputs[0][1] : in0;
      const room = this.maxSamples - this.bufferLen;
      const n = Math.min(blockLen, room);
      this.ensureRing();
      for (let i = 0; i < n; i++) {
        const slot = (this.bufferLen + i) % RING_SAMPLES;
        this.ringL[slot] = in0 ? in0[i] : 0;
        this.ringR[slot] = (this.mode === "mono")
          ? (in0 ? in0[i] : 0)
          : (in1Source ? in1Source[i] : 0);
      }
      this.bufferLen        += n;
      this.position          = this.bufferLen;
      this.unflushedSamples += n;
      this.samplesSincePosition += n;

      // Force a flush before the ring overwrites itself, even if we haven't
      // hit the position-tick threshold yet.
      if (this.unflushedSamples >= POSITION_TICK_SAMPLES
          || this.unflushedSamples >= RING_SAMPLES - 4096) {
        this.flushRecord(false);
        this.samplesSincePosition = 0;
      }

      if (outL) outL.fill(0);
      if (outR) outR.fill(0);

      if (this.bufferLen >= this.maxSamples) {
        this.flushRecord(true);
        this.state = "stop";
        this.position = 0;
        this.port.postMessage({ type: "recordDone", totalLen: this.bufferLen });
      }
      return true;
    }

    if (this.state === "play" && this.bufferLen > 0) {
      const len = this.bufferLen;
      const winStart = this.playEnd > this.playStart
        ? this.playStart
        : (this.rangeEnd > this.rangeStart ? this.rangeStart : 0);
      const winEnd = this.playEnd > this.playStart
        ? this.playEnd
        : (this.rangeEnd > this.rangeStart ? this.rangeEnd : len);
      const winLen = Math.max(1, winEnd - winStart);
      let pos = this.position;
      let stoppedAtEnd = false;

      // Top up the ring if running low.
      if (this.validUpTo - Math.floor(pos) < PREFETCH_THRESHOLD_SAMPLES
          && Math.floor(pos) < this.bufferLen) {
        this.requestSamples();
      }

      this.ensureRing();
      for (let i = 0; i < blockLen; i++) {
        const i0 = Math.floor(pos);
        if (i0 < this.validFrom || i0 >= this.validUpTo) {
          // Ring underrun — emit silence; main is hopefully topping up.
          if (outL) outL[i] = 0;
          if (outR) outR[i] = 0;
        } else {
          const i1abs = i0 + 1 < winEnd ? i0 + 1 : winStart;
          const slot0 = i0 % RING_SAMPLES;
          const slot1 = (i1abs >= this.validFrom && i1abs < this.validUpTo)
            ? (i1abs % RING_SAMPLES)
            : slot0;
          const frac = pos - i0;
          const sL = this.ringL[slot0] * (1 - frac) + this.ringL[slot1] * frac;
          const sR = (this.mode === "mono")
            ? sL
            : this.ringR[slot0] * (1 - frac) + this.ringR[slot1] * frac;
          if (outL) outL[i] = sL;
          if (outR) outR[i] = sR;
        }

        pos += this.rate;

        if (pos >= winEnd) {
          if (this.loop) {
            pos -= winLen;
            // After wrap, the ring is full of samples PAST winEnd that won't
            // come around again. Invalidate so requestSamples re-anchors at
            // the wrapped-back playhead instead of continuing forward.
            this.position = pos;
            this.invalidateRing();
            this.requestSamples();
            break;
          } else {
            stoppedAtEnd = true;
            pos = winEnd - 1;
            break;
          }
        } else if (pos < winStart) {
          if (this.loop) {
            pos += winLen;
            this.position = pos;
            this.invalidateRing();
            this.requestSamples();
            break;
          } else {
            stoppedAtEnd = true;
            pos = winStart;
            break;
          }
        }
      }
      this.position = pos;
      this.samplesSincePosition += blockLen;
      if (this.samplesSincePosition >= POSITION_TICK_SAMPLES) {
        this.samplesSincePosition = 0;
        this.port.postMessage({ type: "position", value: pos });
      }
      if (stoppedAtEnd) {
        this.state = "stop";
        this.port.postMessage({ type: "playDone" });
        this.port.postMessage({ type: "position", value: pos });
      }
      return true;
    }

    if (outL) outL.fill(0);
    if (outR) outR.fill(0);
    return true;
  }
}

registerProcessor("buffer-processor", BufferProcessor);
