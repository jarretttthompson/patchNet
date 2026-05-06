// transientFollower~ AudioWorkletProcessor — asymmetric envelope follower.
//
// One audio input (the "shape" source), one audio output (the detected
// envelope as an audio-rate signal). Per sample:
//
//   1. x = |input|                                     — full-wave rectify
//   2. target = x * sensitivity                        — pre-detection gain
//   3. if (target < floor) target = 0                  — noise gate
//   4. asymmetric one-pole:
//        coef = (target > env) ? attackCoef : releaseCoef
//        env += (target - env) * coef
//      where coef = 1 - exp(-1 / (timeMs * 0.001 * sampleRate))
//   5. output env
//
// AudioParams are k-rate (one value per render quantum, 128 samples).
// Recomputing the time-constant coefficients per quantum is cheap and
// keeps the per-sample loop a single multiply/add.

const MIN_TIME_MS = 0.05;
const MAX_TIME_MS = 10000;
// Snap env to 0 once it decays below this absolute threshold so the VCA
// reaches true silence instead of asymptotically approaching it. ~ -80 dB
// — far below the noise floor of any consumer audio chain. Click amplitude
// at the snap is bounded by this value, so inaudible in practice.
const RESIDUAL_KILL = 1e-4;

function timeMsToCoef(timeMs, sampleRate) {
  const t = timeMs < MIN_TIME_MS ? MIN_TIME_MS : timeMs > MAX_TIME_MS ? MAX_TIME_MS : timeMs;
  return 1 - Math.exp(-1 / (t * 0.001 * sampleRate));
}

class TransientFollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "attackMs",    defaultValue: 5,    minValue: MIN_TIME_MS, maxValue: MAX_TIME_MS, automationRate: "k-rate" },
      { name: "releaseMs",   defaultValue: 80,   minValue: MIN_TIME_MS, maxValue: MAX_TIME_MS, automationRate: "k-rate" },
      { name: "sensitivity", defaultValue: 1.0,  minValue: 0,           maxValue: 64,          automationRate: "k-rate" },
      { name: "floor",       defaultValue: 0.0,  minValue: 0,           maxValue: 1,           automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.env = 0;
  }

  process(inputs, outputs, params) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const attackMs    = params.attackMs[0];
    const releaseMs   = params.releaseMs[0];
    const sensitivity = params.sensitivity[0];
    const floor       = params.floor[0];

    const attackCoef  = timeMsToCoef(attackMs,  sampleRate);
    const releaseCoef = timeMsToCoef(releaseMs, sampleRate);

    const outCh = output[0];
    const n = outCh.length;

    // No input connected → envelope releases toward 0 with the user's
    // release time, then snaps once it decays below the residual-kill
    // threshold so the VCA reaches true silence.
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      let env = this.env;
      for (let i = 0; i < n; i++) {
        env += (0 - env) * releaseCoef;
        if (env < RESIDUAL_KILL) env = 0;
        outCh[i] = env;
      }
      // Mirror to additional output channels if the host upmixed.
      for (let c = 1; c < output.length; c++) output[c].set(outCh);
      this.env = env;
      return true;
    }

    // Sum input channels to mono — stereo mics drive a single envelope.
    const inChCount = input.length;
    let env = this.env;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < inChCount; c++) sum += input[c][i];
      const x = Math.abs(sum / inChCount);
      let target = x * sensitivity;
      // Below floor → input is forced to 0; env decays via the user's
      // release time-constant. Smooth close (no clicks). Slamming env=0
      // here causes per-sample gate chatter at the threshold and turns
      // sustained signals into chopped granulation.
      if (target < floor) target = 0;
      const coef = target > env ? attackCoef : releaseCoef;
      env += (target - env) * coef;
      // Kill the asymptotic one-pole tail once env has decayed below an
      // inaudible absolute threshold (≈ -80 dB). Without this, env never
      // truly reaches 0 and the carrier leaks through faintly forever.
      // Click amplitude bounded by RESIDUAL_KILL — inaudible.
      if (env < RESIDUAL_KILL) env = 0;
      outCh[i] = env;
    }
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    this.env = env;
    return true;
  }
}

registerProcessor("transient-follower", TransientFollowerProcessor);
