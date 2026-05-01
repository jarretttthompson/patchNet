import { AudioRuntime } from "./AudioRuntime";

const SMOOTH_TC = 0.01; // seconds — click-free gain ramp

function equalPowerL(pan: number): number {
  return Math.cos(pan * Math.PI * 0.5);
}

function equalPowerR(pan: number): number {
  return Math.sin(pan * Math.PI * 0.5);
}

/**
 * N-channel mono→stereo mixer using native Web Audio nodes.
 *
 * Signal path per channel i:
 *   source → gainNode[i] (volume) → analyser[i] (level tap)
 *                                 → panL[i] (L weight) → busL → outlet L
 *                                 → panR[i] (R weight) → busR → outlet R
 */
export class MixerNode {
  private readonly ctx: AudioContext;
  private gainNodes: GainNode[];
  private panLNodes: GainNode[];
  private panRNodes: GainNode[];
  private analysers: AnalyserNode[];
  private analyserData: Float32Array<ArrayBuffer>;
  private readonly busL: GainNode;
  private readonly busR: GainNode;

  private _channelCount: number;
  private readonly gains: number[];
  private readonly pans: number[];

  constructor(
    runtime: AudioRuntime,
    channels: number,
    gains: number[],
    pans: number[],
  ) {
    this.ctx = runtime.context;
    this._channelCount = channels;
    this.gains = gains.slice();
    this.pans  = pans.slice();

    this.busL = this.ctx.createGain();
    this.busR = this.ctx.createGain();

    this.gainNodes = [];
    this.panLNodes = [];
    this.panRNodes = [];
    this.analysers = [];
    this.analyserData = new Float32Array(256) as Float32Array<ArrayBuffer>;

    for (let i = 0; i < channels; i++) {
      this._buildStrip(i);
    }
  }

  get channelCount(): number { return this._channelCount; }

  /** The GainNode that acts as inlet i — sources connect here. */
  getChannelInput(ch: number): GainNode | null {
    return this.gainNodes[ch] ?? null;
  }

  /** Connect outlet (0=L, 1=R) into destInput at destChannel. */
  connectOutlet(dest: AudioNode, outletIndex: number, destChannel: number): void {
    const bus = outletIndex === 0 ? this.busL : this.busR;
    try { bus.connect(dest, 0, destChannel); } catch { /* already connected */ }
  }

  /** RMS signal level for channel ch (post-fader, pre-pan). */
  getChannelLevel(ch: number): number {
    const analyser = this.analysers[ch];
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.analyserData);
    let sum = 0;
    const len = analyser.fftSize;
    for (let i = 0; i < len; i++) sum += this.analyserData[i] * this.analyserData[i];
    return Math.sqrt(sum / len);
  }

  disconnect(): void {
    try { this.busL.disconnect(); } catch { /**/ }
    try { this.busR.disconnect(); } catch { /**/ }
  }

  destroy(): void {
    this.disconnect();
    for (const g of this.gainNodes)  { try { g.disconnect(); } catch { /**/ } }
    for (const g of this.panLNodes)  { try { g.disconnect(); } catch { /**/ } }
    for (const g of this.panRNodes)  { try { g.disconnect(); } catch { /**/ } }
    for (const a of this.analysers)  { try { a.disconnect(); } catch { /**/ } }
  }

  setGain(ch: number, v: number): void {
    if (ch < 0 || ch >= this._channelCount) return;
    this.gains[ch] = v;
    const now = this.ctx.currentTime;
    this.gainNodes[ch]?.gain.setTargetAtTime(v, now, SMOOTH_TC);
  }

  setPan(ch: number, v: number): void {
    if (ch < 0 || ch >= this._channelCount) return;
    this.pans[ch] = v;
    const now = this.ctx.currentTime;
    this.panLNodes[ch]?.gain.setTargetAtTime(equalPowerL(v), now, SMOOTH_TC);
    this.panRNodes[ch]?.gain.setTargetAtTime(equalPowerR(v), now, SMOOTH_TC);
  }

  private _buildStrip(i: number): void {
    const gain = this.gains[i] ?? 0.75;
    const pan  = this.pans[i]  ?? 0.5;

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = gain;

    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;

    const panL = this.ctx.createGain();
    panL.gain.value = equalPowerL(pan);

    const panR = this.ctx.createGain();
    panR.gain.value = equalPowerR(pan);

    gainNode.connect(analyser);
    gainNode.connect(panL);
    gainNode.connect(panR);
    panL.connect(this.busL);
    panR.connect(this.busR);

    this.gainNodes[i] = gainNode;
    this.analysers[i] = analyser;
    this.panLNodes[i] = panL;
    this.panRNodes[i] = panR;
  }
}
