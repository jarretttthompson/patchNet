import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import { WebcamNode } from "../runtime/WebcamNode";

/**
 * Inline panel for a `cam*` object — live preview of the selected
 * videoinput device on the canvas itself.
 *
 * Layout:
 *   [ live mirror of webcam (or placeholder)    ]
 *   [ [start] [device ▾]  status: …             ]
 *
 * The mirror <video> shares the same MediaStream as the underlying
 * WebcamNode's hidden source <video> — assigning the same `srcObject` to a
 * second element doesn't fork the stream, it just renders an extra view.
 *
 * Why we don't reuse the runtime <video> directly: that element is what
 * downstream sinks (LayerNode.draw, vfxCRT input, etc.) read pixels from.
 * Moving it into the DOM tree of an inline panel risks display/layout
 * fighting with rAF readers and complicates lifecycle when the panel
 * re-mounts. A separate mirror element is cheap and keeps the runtime
 * source untouched.
 */
export class CamPanel {
  private readonly root: HTMLDivElement;
  private readonly mirror: HTMLVideoElement;
  private readonly placeholder: HTMLDivElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly deviceSel: HTMLSelectElement;
  private readonly statusLine: HTMLDivElement;

  private currentHost: HTMLElement | null = null;
  private webcamNode: WebcamNode | null = null;
  private deviceList: MediaDeviceInfo[] = [];

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    private vizGraph: VisualizerGraph | null,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pn-cam-panel";
    // Block canvas pan/zoom over the panel and prevent dropdowns from starting drags.
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    this.root.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, select")) e.stopPropagation();
    });

    // Preview area
    const preview = document.createElement("div");
    preview.className = "pn-cam-preview";
    this.mirror = document.createElement("video");
    this.mirror.className = "pn-cam-mirror";
    this.mirror.muted        = true;
    this.mirror.autoplay     = true;
    this.mirror.playsInline  = true;
    this.mirror.style.display = "none";
    this.placeholder = document.createElement("div");
    this.placeholder.className = "pn-cam-placeholder";
    this.placeholder.textContent = "click start to mirror a camera";
    preview.append(this.mirror, this.placeholder);
    this.root.appendChild(preview);

    // Bottom toolbar — two rows so a long device label never pushes the
    // start/stop button off-screen. Row 1: device picker (full width).
    // Row 2: [start/stop] [status].
    const controls = document.createElement("div");
    controls.className = "pn-cam-controls";

    this.deviceSel = document.createElement("select");
    this.deviceSel.className = "pn-cam-device";
    this.deviceSel.title = "Pick a videoinput device. Labels appear after the first capture grants permission.";
    this.deviceSel.addEventListener("change", () => this.onDeviceChange());

    const row2 = document.createElement("div");
    row2.className = "pn-cam-controls-row";

    this.toggleBtn = document.createElement("button");
    this.toggleBtn.className = "pn-cam-btn pn-cam-btn-primary";
    this.toggleBtn.textContent = "start";
    this.toggleBtn.title = "Start / stop camera capture. The OS prompts for camera permission once per origin.";
    this.toggleBtn.addEventListener("click", () => this.onToggleClick());

    this.statusLine = document.createElement("div");
    this.statusLine.className = "pn-cam-status";

    row2.append(this.toggleBtn, this.statusLine);
    controls.append(this.deviceSel, row2);
    this.root.appendChild(controls);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  attach(host: HTMLElement): void {
    if (this.currentHost === host) return;
    host.appendChild(this.root);
    this.currentHost = host;
    this.bindNode();
    void this.refreshDeviceList();
  }

  setVisualizerGraph(vg: VisualizerGraph | null): void {
    if (this.vizGraph === vg) return;
    if (this.webcamNode) this.webcamNode.setOnStateChange(undefined);
    this.webcamNode = null;
    this.vizGraph = vg;
    this.bindNode();
    this.renderStatus();
  }

  private bindNode(): void {
    if (!this.vizGraph) return;
    const wn = this.vizGraph.getWebcamNode(this.patchNode.id);
    if (!wn) return;
    this.webcamNode = wn;
    wn.setOnStateChange(() => this.renderStatus());
    this.renderStatus();
  }

  /** Re-read deviceLabel/width/height in case the attribute panel or text
   *  panel changed them. WebcamNode's currentDeviceId stays authoritative
   *  while running; on next start the new args are picked up. */
  syncFromArgs(): void { /* intentionally empty for now */ }

  destroy(): void {
    if (this.webcamNode) {
      this.webcamNode.setOnStateChange(undefined);
      this.webcamNode.stop();
    }
    this.webcamNode = null;
    this.mirror.srcObject = null;
    this.root.remove();
    this.currentHost = null;
  }

  // ── Actions ───────────────────────────────────────────────────────────

  private async onToggleClick(): Promise<void> {
    if (!this.webcamNode) {
      this.statusLine.textContent = "cam runtime not ready";
      this.statusLine.dataset.state = "err";
      return;
    }
    if (this.webcamNode.isStarted) {
      this.webcamNode.stop();
      this.writeArg(4, "0");
      return;
    }
    const deviceId = this.patchNode.args[0] ?? "";
    const w = parseInt(this.patchNode.args[2] ?? "0", 10) || 0;
    const h = parseInt(this.patchNode.args[3] ?? "0", 10) || 0;
    this.statusLine.textContent = "requesting camera…";
    delete this.statusLine.dataset.state;
    await this.webcamNode.start(deviceId, w, h);
    if (this.webcamNode.isStarted) {
      this.writeArg(4, "1");
      void this.refreshDeviceList();
    }
  }

  private async onDeviceChange(): Promise<void> {
    if (!this.webcamNode) return;
    const id = this.deviceSel.value;
    const info = this.deviceList.find(d => d.deviceId === id);
    this.writeArg(0, id);
    if (info) this.writeArg(1, info.label || "");
    await this.webcamNode.setDevice(id);
  }

  private async refreshDeviceList(): Promise<void> {
    try {
      this.deviceList = await WebcamNode.enumerate();
    } catch {
      this.deviceList = [];
    }
    this.populateDeviceSelect();
  }

  private populateDeviceSelect(): void {
    const currentId = this.patchNode.args[0] ?? "";
    const currentLabel = this.patchNode.args[1] ?? "";
    this.deviceSel.replaceChildren();

    if (this.deviceList.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no devices — click start to grant permission)";
      this.deviceSel.appendChild(opt);
      this.deviceSel.disabled = true;
      return;
    }

    this.deviceSel.disabled = false;

    // "default" option = let the browser decide.
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "default device";
    this.deviceSel.appendChild(def);

    let resolvedId = currentId;
    if (resolvedId && !this.deviceList.some(d => d.deviceId === resolvedId)) {
      // Stored id is gone — fall back to label match.
      const match = this.deviceList.find(d => d.label && d.label === currentLabel);
      resolvedId = match?.deviceId ?? "";
    }

    for (const d of this.deviceList) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `camera ${d.deviceId.slice(0, 6)}…`;
      this.deviceSel.appendChild(opt);
    }
    this.deviceSel.value = resolvedId;
  }

  private writeArg(index: number, value: string): void {
    if ((this.patchNode.args[index] ?? "") === value) return;
    this.patchNode.args[index] = value;
    this.graph.emit("change");
  }

  private renderStatus(): void {
    const preview = this.mirror.parentElement as HTMLElement | null;

    if (!this.webcamNode) {
      this.toggleBtn.disabled = true;
      this.toggleBtn.textContent = "start";
      this.statusLine.textContent = "cam runtime not ready";
      this.statusLine.dataset.state = "err";
      this.placeholder.style.display = "flex";
      this.mirror.style.display = "none";
      this.mirror.srcObject = null;
      preview?.removeAttribute("data-state");
      return;
    }

    const stream = this.webcamNode.videoStream;
    const live = this.webcamNode.isStarted && !!stream;

    this.toggleBtn.disabled = false;
    this.toggleBtn.textContent = live ? "stop" : (this.webcamNode.isStarting ? "…" : "start");

    if (live && stream) {
      if (this.mirror.srcObject !== stream) {
        this.mirror.srcObject = stream;
        this.mirror.play().catch(() => { /* autoplay policy — resumes on next gesture */ });
      }
      this.mirror.style.display = "block";
      this.placeholder.style.display = "none";
      preview?.setAttribute("data-state", "on");
      // While running, the dropdown already names the device and the
      // start→stop button conveys state; suppress the redundant text pill.
      this.statusLine.textContent = "";
      delete this.statusLine.dataset.state;
    } else {
      this.mirror.srcObject = null;
      this.mirror.style.display = "none";
      this.placeholder.style.display = "flex";
      preview?.removeAttribute("data-state");
      if (this.webcamNode.hasError) {
        this.statusLine.textContent = this.webcamNode.errorMessage || "capture failed";
        this.statusLine.dataset.state = "err";
      } else if (this.webcamNode.isStarting) {
        this.statusLine.textContent = "starting…";
        this.statusLine.dataset.state = "starting";
      } else {
        this.statusLine.textContent = "";
        delete this.statusLine.dataset.state;
      }
    }
  }
}
