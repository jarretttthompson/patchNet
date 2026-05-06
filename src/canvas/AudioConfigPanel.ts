import type { PatchNode }   from "../graph/PatchNode";
import type { PatchGraph }  from "../graph/PatchGraph";
import type { AudioGraph }  from "../runtime/AudioGraph";
import { adcChannelCount, audioPortDefaultWidth, dacChannelCount, deriveAdcPorts, deriveDacPorts } from "../graph/objectDefs";

/**
 * AudioConfigPanel — modal "Audio Status" window for adc~ / dac~ objects.
 *
 * Mirrors Max/MSP's Audio Status: pick input + output device, show sample
 * rate, show requested vs detected channel count for the clicked object,
 * apply a new channel count to this node.
 *
 * Reuses the pn-imgfx-* modal styles for visual consistency.
 */
export class AudioConfigPanel {
  private readonly overlay: HTMLDivElement;
  private inputSel!:  HTMLSelectElement;
  private outputSel!: HTMLSelectElement;
  private channelInput!: HTMLInputElement;
  private detectedReadout!: HTMLSpanElement;
  private maxOutputReadout!: HTMLSpanElement;
  private sampleRateReadout!: HTMLSpanElement;
  private statusEl!: HTMLDivElement;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    private readonly audioGraph: AudioGraph,
  ) {
    this.overlay = this.buildOverlay();
  }

  open(): void {
    document.body.appendChild(this.overlay);
    document.addEventListener("keydown", this.onKeyDown);
    void this.populateDevices();
  }

  close(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    this.overlay.remove();
  }

  private buildOverlay(): HTMLDivElement {
    const overlay = document.createElement("div");
    overlay.className = "pn-imgfx-overlay";
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.close();
    });

    const modal = document.createElement("div");
    modal.className = "pn-imgfx-modal";
    modal.style.width = "520px";
    modal.addEventListener("mousedown", (e) => e.stopPropagation());

    modal.appendChild(this.buildHeader());
    modal.appendChild(this.buildContent());
    modal.appendChild(this.buildFooter());

    overlay.appendChild(modal);
    return overlay;
  }

  private buildHeader(): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "pn-imgfx-header";

    const title = document.createElement("span");
    title.textContent = `audio status — ${this.patchNode.type}`;

    const closeBtn = document.createElement("button");
    closeBtn.className = "pn-imgfx-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());

    header.append(title, closeBtn);
    return header;
  }

  private buildContent(): HTMLDivElement {
    const content = document.createElement("div");
    content.className = "pn-imgfx-controls-col";
    content.style.padding = "16px 18px";

    // ── Devices section ──
    content.appendChild(this.sectionTitle("Devices"));

    this.inputSel  = document.createElement("select");
    this.outputSel = document.createElement("select");
    this.inputSel.className  = "pn-audiocfg-select";
    this.outputSel.className = "pn-audiocfg-select";

    content.appendChild(this.row("input",  this.inputSel));
    content.appendChild(this.row("output", this.outputSel));

    this.inputSel.addEventListener("change", () => {
      void this.audioGraph.setInputDevice(this.inputSel.value);
      this.scheduleStatusRefresh();
    });
    this.outputSel.addEventListener("change", () => {
      void this.audioGraph.getRuntime().setOutputDevice(this.outputSel.value);
    });

    // ── Engine section ──
    content.appendChild(this.sectionTitle("Engine"));

    this.sampleRateReadout  = this.readout();
    this.maxOutputReadout   = this.readout();
    content.appendChild(this.row("sample rate",     this.sampleRateReadout));
    content.appendChild(this.row("max output ch",   this.maxOutputReadout));

    // ── This object section ──
    content.appendChild(this.sectionTitle(`${this.patchNode.type} channels`));

    const isInput = this.patchNode.type === "adc~";
    const currentChannels = isInput
      ? adcChannelCount(this.patchNode.args)
      : dacChannelCount(this.patchNode.args);

    this.channelInput = document.createElement("input");
    this.channelInput.type = "number";
    this.channelInput.min  = "1";
    this.channelInput.max  = "32";
    this.channelInput.step = "1";
    this.channelInput.value = String(currentChannels);
    this.channelInput.className = "pn-audiocfg-num";

    this.detectedReadout = this.readout();

    content.appendChild(this.row("channels",  this.channelInput));
    content.appendChild(this.row(isInput ? "detected (input)" : "destination cap", this.detectedReadout));

    this.statusEl = document.createElement("div");
    this.statusEl.className = "pn-imgfx-bg-status";
    this.statusEl.style.marginTop = "10px";
    content.appendChild(this.statusEl);

    this.refreshEngineReadouts();
    return content;
  }

  private buildFooter(): HTMLDivElement {
    const footer = document.createElement("div");
    footer.className = "pn-imgfx-footer";

    const rebuildBtn = document.createElement("button");
    rebuildBtn.className = "pn-imgfx-btn";
    rebuildBtn.textContent = "match device";
    rebuildBtn.title = "Set channels to what the device actually delivers";
    rebuildBtn.addEventListener("click", () => {
      const detected = this.detectedChannels();
      if (detected > 0) this.channelInput.value = String(detected);
    });

    const applyBtn = document.createElement("button");
    applyBtn.className = "pn-imgfx-btn pn-imgfx-btn--accent";
    applyBtn.textContent = "apply";
    applyBtn.addEventListener("click", () => this.apply());

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "pn-imgfx-btn";
    cancelBtn.textContent = "close";
    cancelBtn.addEventListener("click", () => this.close());

    footer.append(rebuildBtn, applyBtn, cancelBtn);
    return footer;
  }

  // ── Behaviour ──────────────────────────────────────────────────────

  private async populateDevices(): Promise<void> {
    const runtime = this.audioGraph.getRuntime();
    const [inputs, outputs] = await Promise.all([
      runtime.getInputDevices(),
      runtime.getOutputDevices(),
    ]);
    fillSelect(this.inputSel,  inputs,  runtime.inputDeviceId || "default");
    fillSelect(this.outputSel, outputs, "default");
    this.refreshEngineReadouts();
  }

  private apply(): void {
    const n = clamp(parseInt(this.channelInput.value, 10) || 2, 1, 32);
    const node = this.patchNode;

    node.args[0] = String(n);

    const derived = node.type === "adc~" ? deriveAdcPorts(node.args) : deriveDacPorts(node.args);
    node.inlets  = derived.inlets;
    node.outlets = derived.outlets;
    node.width   = audioPortDefaultWidth(Math.max(node.inlets.length, node.outlets.length));

    const tooHighOutlet = node.outlets.length;
    const tooHighInlet  = node.inlets.length;
    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId === node.id && edge.fromOutlet >= tooHighOutlet) this.graph.removeEdge(edge.id);
      if (edge.toNodeId   === node.id && edge.toInlet    >= tooHighInlet)  this.graph.removeEdge(edge.id);
    }

    this.graph.emit("change");
    this.statusEl.textContent = `applied: ${node.type} now has ${n} channel${n === 1 ? "" : "s"}`;
    this.scheduleStatusRefresh();
  }

  private detectedChannels(): number {
    if (this.patchNode.type === "adc~") {
      const adc = this.audioGraph.getAdcNode(this.patchNode.id);
      return adc?.detectedChannelCount ?? 0;
    }
    return this.audioGraph.getMaxOutputChannels();
  }

  private refreshEngineReadouts(): void {
    const runtime = this.audioGraph.getRuntime();
    if (runtime.isStarted) {
      this.sampleRateReadout.textContent = `${runtime.sampleRate} Hz`;
      this.maxOutputReadout.textContent  = `${this.audioGraph.getMaxOutputChannels()} ch`;
    } else {
      this.sampleRateReadout.textContent = "(audio not started)";
      this.maxOutputReadout.textContent  = "—";
    }
    const detected = this.detectedChannels();
    this.detectedReadout.textContent = detected > 0 ? `${detected} ch` : "—";
  }

  /** After a device change the new MediaStreamTrack settings land async —
   *  poll a few times so the readouts catch up. */
  private scheduleStatusRefresh(): void {
    let i = 0;
    const tick = (): void => {
      this.refreshEngineReadouts();
      if (++i < 6) setTimeout(tick, 200);
    };
    tick();
  }

  // ── DOM helpers ────────────────────────────────────────────────────

  private sectionTitle(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "pn-imgfx-section-title";
    el.textContent = text;
    return el;
  }

  private row(label: string, control: HTMLElement): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-imgfx-row";

    const lab = document.createElement("div");
    lab.className = "pn-imgfx-label";
    lab.textContent = label;
    lab.style.flex = "0 0 110px";

    row.append(lab, control);
    return row;
  }

  private readout(): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = "pn-imgfx-readout";
    el.style.flex = "1";
    el.style.textAlign = "left";
    el.textContent = "—";
    return el;
  }
}

function fillSelect(sel: HTMLSelectElement, devices: MediaDeviceInfo[], selectedId: string): void {
  sel.innerHTML = "";
  if (!devices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no devices — grant mic permission)";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${d.kind} ${d.deviceId.slice(0, 6)}`;
    sel.appendChild(opt);
  }
  sel.value = selectedId;
  if (sel.value !== selectedId && devices[0]) sel.value = devices[0].deviceId;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
