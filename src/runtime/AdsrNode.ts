import { AudioRuntime } from "./AudioRuntime";

interface Connection {
  dest: AudioNode;
  inputIndex: number;
}

/**
 * AdsrNode — attack/decay/sustain/release envelope generator + VCA.
 *
 * Internal graph:
 *
 *   input (GainNode) ─► envelopeGain (GainNode) ─► output (= envelopeGain)
 *                              │
 *                              └─ .gain AudioParam carries the envelope curve
 *                                 via cancelScheduledValues / setValueAtTime /
 *                                 linearRampToValueAtTime
 *
 * The audio signal arriving on `input` is multiplied by the envelope. The
 * envelope is silent (gain = 0) at rest — no signal escapes until trigger()
 * or gateOn() is called.
 *
 * Trigger modes:
 *   - trigger():  one-shot — A → D → R (no held sustain). Resolves with a
 *                 deadline (`performance.now()` ms) at which AudioGraph
 *                 should fire the outlet-1 done bang.
 *   - gateOn():   sustained — A → D → hold at sustain. No release scheduled.
 *   - gateOff():  release from current value to 0 over R.
 *
 * Re-triggering is click-free: each new schedule starts with cancelScheduledValues
 * + setValueAtTime(currentRealtimeGain, now), which captures the in-flight
 * value and ramps from there instead of jumping back to 0.
 */
export class AdsrNode {
  private readonly ctx: AudioContext;
  private readonly envelopeGain: GainNode;
  readonly input: GainNode;

  private connections: Connection[] = [];

  // Envelope params (seconds — converted from incoming ms in the setters).
  private attack      = 0.050;
  private decay       = 0.100;
  private sustain     = 0.7;
  private release     = 0.200;
  /** One-shot sustain plateau hold time. Ignored by gateOn (which holds until
   *  gateOff). Default 200ms keeps short percussive triggers audible. */
  private sustainTime = 0.200;

  constructor(runtime: AudioRuntime) {
    this.ctx = runtime.context;
    this.input = this.ctx.createGain();
    this.envelopeGain = this.ctx.createGain();
    this.envelopeGain.gain.value = 0;        // silent at rest
    this.input.connect(this.envelopeGain);
  }

  /** Add a downstream connection. Mirrors ClickNode.connect / WaveNode.connect. */
  connect(dest: AudioNode, inputIndex = 0): void {
    this.connections.push({ dest, inputIndex });
    try { this.envelopeGain.connect(dest, 0, inputIndex); } catch { /* already connected */ }
  }

  /** Drop downstream connections. Called by AudioGraph.rewireConnections() before rewire. */
  disconnect(): void {
    try { this.envelopeGain.disconnect(); } catch { /* ok */ }
    this.connections = [];
  }

  /** Set attack time. Takes ms (matches the user-facing arg unit). Applies to NEXT trigger. */
  setAttack(ms: number): void {
    this.attack = clampTimeMs(ms) / 1000;
  }
  setDecay(ms: number): void {
    this.decay = clampTimeMs(ms) / 1000;
  }
  setSustain(level: number): void {
    this.sustain = clamp01(level);
  }
  setRelease(ms: number): void {
    this.release = clampTimeMs(ms) / 1000;
  }
  setSustainTime(ms: number): void {
    this.sustainTime = clampTimeMs(ms) / 1000;
  }

  /** One-shot trigger: A → D → hold sustain for sustainTime → R.
   *  Returns the performance.now() millisecond deadline at which the envelope completes —
   *  AudioGraph uses this to schedule the outlet-1 done bang. */
  trigger(): number {
    const now = this.ctx.currentTime;
    this.scheduleFromCurrent(now);
    const a  = Math.max(MIN_RAMP, this.attack);
    const d  = Math.max(MIN_RAMP, this.decay);
    const r  = Math.max(MIN_RAMP, this.release);
    // Sustain hold uses the raw param — 0 ms is a legitimate "skip the hold,
    // go straight to release" so we don't apply MIN_RAMP here.
    const sh = Math.max(0, this.sustainTime);
    this.envelopeGain.gain.linearRampToValueAtTime(1.0,          now + a);
    this.envelopeGain.gain.linearRampToValueAtTime(this.sustain, now + a + d);
    if (sh > 0) {
      this.envelopeGain.gain.setValueAtTime(this.sustain, now + a + d + sh);
    }
    this.envelopeGain.gain.linearRampToValueAtTime(0.0,          now + a + d + sh + r);
    const totalMs = (a + d + sh + r) * 1000;
    return performance.now() + totalMs;
  }

  /** Gate-on: A → D → sustain held (no release scheduled). */
  gateOn(): void {
    const now = this.ctx.currentTime;
    this.scheduleFromCurrent(now);
    const a = Math.max(MIN_RAMP, this.attack);
    const d = Math.max(MIN_RAMP, this.decay);
    this.envelopeGain.gain.linearRampToValueAtTime(1.0,          now + a);
    this.envelopeGain.gain.linearRampToValueAtTime(this.sustain, now + a + d);
  }

  /** Gate-off: release from current value to 0 over R. */
  gateOff(): void {
    const now = this.ctx.currentTime;
    this.scheduleFromCurrent(now);
    const r = Math.max(MIN_RAMP, this.release);
    this.envelopeGain.gain.linearRampToValueAtTime(0.0, now + r);
  }

  destroy(): void {
    this.disconnect();
    try { this.input.disconnect(); } catch { /* ok */ }
    try { this.envelopeGain.disconnect(); } catch { /* ok */ }
  }

  /** Anchor the schedule at the current real-time gain so re-triggers don't pop.
   *  Web Audio's `gain.value` returns the most recent scheduled value, which is
   *  what `setValueAtTime(gain.value, now)` captures and pins. */
  private scheduleFromCurrent(now: number): void {
    const gain = this.envelopeGain.gain;
    const current = gain.value;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(current, now);
  }
}

/** Smallest ramp duration we'll schedule. Web Audio allows a duration of 0
 *  in linearRampToValueAtTime, but giving it a literal 0 (when attack=0)
 *  produces an instantaneous step — fine, but if multiple ramps land at the
 *  same exact timestamp, the order can be ambiguous. Forcing a sub-millisecond
 *  minimum keeps the schedule monotonic and inaudibly fast. */
const MIN_RAMP = 0.0005;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampTimeMs(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 10000 ? 10000 : v;
}
