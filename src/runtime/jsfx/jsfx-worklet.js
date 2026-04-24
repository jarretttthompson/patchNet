// JSFX AudioWorkletProcessor. Plain JS so it loads directly via
// `audioWorklet.addModule()` without Vite needing to compile it.
// Self-contained: AudioWorkletGlobalScope has no module graph — do not
// import from outside this file.
//
// Phase D protocol (main → worklet):
//   { type: "code",
//     init:   string,       // translated @init   body
//     slider: string,       // translated @slider body
//     block:  string,       // translated @block  body
//     sample: string,       // translated @sample body
//     userVars: string[] }  // union of user vars across sections
//   { type: "slider", index: number, value: number }
//   { type: "reset" }
// Messages (worklet → main):
//   { type: "compiled" }
//   { type: "compile-error", message }
//   { type: "runtime-error", message, where: "init"|"slider"|"block"|"sample" }

const MAX_SLIDERS = 64;
// mem[] buffer size — EEL2 effects can reference arbitrarily high indices
// (avocado's `r_offset * 2` at 48 kHz = ~6M). 8M slots × 8 bytes = 64 MB
// per js~ instance. Expensive but matches REAPER's behaviour; most users
// won't have more than a handful of js~ objects at once.
const MEM_SIZE = 8 * 1024 * 1024;

class JsfxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleFn = null;
    this.sliderFn = null;
    this.blockFn  = null;
    this.initFn   = null;
    this.state    = null;
    this.mem      = null;  // Float64Array — allocated lazily on first install
    this.sliders  = new Float32Array(MAX_SLIDERS);
    this.runtimeErrorSent = false;
    this.port.onmessage = (ev) => this.onMessage(ev);
  }

  onMessage(ev) {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "code") {
      this.installCode(msg);
    } else if (msg.type === "slider") {
      const i = msg.index | 0;
      if (i >= 0 && i < MAX_SLIDERS) {
        this.sliders[i] = +msg.value || 0;
        this.runSliderFn();
      }
    } else if (msg.type === "reset") {
      this.sampleFn = this.sliderFn = this.blockFn = this.initFn = null;
      this.state = null;
      this.runtimeErrorSent = false;
    }
  }

  installCode(msg) {
    try {
      const userVars   = Array.isArray(msg.userVars) ? msg.userVars : [];
      const initBody   = msg.init   || "";
      const sliderBody = msg.slider || "";
      const blockBody  = msg.block  || "";
      const sampleBody = msg.sample || "";

      // eslint-disable-next-line no-new-func
      const sampleFn = new Function(
        "L", "R", "state", "sliders", "srate", "mem",
        sampleBody + "\nreturn [L, R];"
      );
      // eslint-disable-next-line no-new-func
      const initFn = initBody.trim()
        ? new Function("state", "sliders", "srate", "mem", initBody)
        : null;
      // eslint-disable-next-line no-new-func
      const sliderFn = sliderBody.trim()
        ? new Function("state", "sliders", "srate", "mem", sliderBody)
        : null;
      // eslint-disable-next-line no-new-func
      const blockFn = blockBody.trim()
        ? new Function("state", "sliders", "srate", "mem", blockBody)
        : null;

      // Fresh state + zeroed memory for each install. A code edit is a
      // full reset — EEL2 doesn't preserve state across code changes.
      const state = {};
      for (const v of userVars) state["u_" + v] = 0;
      const mem = new Float64Array(MEM_SIZE);

      if (initFn)   initFn(state, this.sliders, sampleRate, mem);
      if (sliderFn) sliderFn(state, this.sliders, sampleRate, mem);
      if (blockFn)  blockFn(state, this.sliders, sampleRate, mem);

      this.sampleFn = sampleFn;
      this.sliderFn = sliderFn;
      this.blockFn  = blockFn;
      this.initFn   = initFn;
      this.state    = state;
      this.mem      = mem;
      this.runtimeErrorSent = false;
      this.port.postMessage({ type: "compiled" });
    } catch (err) {
      this.sampleFn = this.sliderFn = this.blockFn = this.initFn = null;
      this.state = null;
      const message = err && err.message ? err.message : String(err);
      this.port.postMessage({ type: "compile-error", message });
    }
  }

  runSliderFn() {
    if (!this.sliderFn || !this.state || !this.mem) return;
    try {
      this.sliderFn(this.state, this.sliders, sampleRate, this.mem);
    } catch (err) {
      if (!this.runtimeErrorSent) {
        this.runtimeErrorSent = true;
        const message = err && err.message ? err.message : String(err);
        this.port.postMessage({ type: "runtime-error", message, where: "slider" });
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output[1] || output[0];
    const inL = input && input[0];
    const inR = (input && input[1]) || inL;
    const frames = outL.length;

    const fn = this.sampleFn;
    const state = this.state;
    const mem = this.mem;
    if (!fn || !state || !mem) {
      for (let i = 0; i < frames; i++) {
        outL[i] = inL ? inL[i] : 0;
        outR[i] = inR ? inR[i] : 0;
      }
      return true;
    }

    // @block runs once per render quantum — matches REAPER's semantics
    // (once per audio block). Wrapped in a try/catch so a @block exception
    // doesn't take out @sample for the frame.
    if (this.blockFn) {
      try {
        this.blockFn(state, this.sliders, sampleRate, mem);
      } catch (err) {
        this.blockFn = null;
        if (!this.runtimeErrorSent) {
          this.runtimeErrorSent = true;
          const message = err && err.message ? err.message : String(err);
          this.port.postMessage({ type: "runtime-error", message, where: "block" });
        }
      }
    }

    const sliders = this.sliders;
    const sr = sampleRate;

    for (let i = 0; i < frames; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      try {
        const pair = fn(l, r, state, sliders, sr, mem);
        const ol = pair[0], or = pair[1];
        outL[i] = Number.isFinite(ol) ? ol : 0;
        outR[i] = Number.isFinite(or) ? or : 0;
      } catch (err) {
        this.sampleFn = null;
        if (!this.runtimeErrorSent) {
          this.runtimeErrorSent = true;
          const message = err && err.message ? err.message : String(err);
          this.port.postMessage({ type: "runtime-error", message, where: "sample" });
        }
        outL[i] = l;
        outR[i] = r;
      }
    }

    return true;
  }
}

registerProcessor("jsfx-processor", JsfxProcessor);
