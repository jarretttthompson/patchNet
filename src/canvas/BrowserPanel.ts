import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { AudioGraph } from "../runtime/AudioGraph";
import type { BrowserNode } from "../runtime/BrowserNode";

/**
 * Inline expanded panel for a `browser~` object.
 *
 * Layout:
 *   [ live mirror of captured tab (or placeholder)         ]
 *   [ [open & mirror] [stop]  status: …                   ]
 *
 * Click "open & mirror" → opens a blank browser tab AND triggers
 * getDisplayMedia so the user picks that freshly opened tab. Both calls
 * happen in the same click handler so Chrome's user-activation token
 * covers both the popup and the screen-share prompt. Whatever the user
 * navigates to inside that tab streams live into the mirror.
 */
export class BrowserPanel {
  private readonly root: HTMLDivElement;
  private readonly mirror: HTMLVideoElement;
  private readonly placeholder: HTMLDivElement;
  private readonly openBtn: HTMLButtonElement;
  private readonly releaseBtn: HTMLButtonElement;
  private readonly statusLine: HTMLDivElement;

  private currentHost: HTMLElement | null = null;
  private browserNode: BrowserNode | null = null;

  constructor(
    private readonly patchNode: PatchNode,
    _graph: PatchGraph,
    private audioGraph: AudioGraph | null,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pn-browser-panel";
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());

    // Top controls — single primary action + stop + status.
    const controls = document.createElement("div");
    controls.className = "pn-browser-controls pn-browser-controls--top";
    this.openBtn = document.createElement("button");
    this.openBtn.className = "pn-browser-btn pn-browser-btn-primary";
    this.openBtn.textContent = "mirror a tab";
    this.openBtn.title = "Pick any browser tab from the system prompt. To mirror a fresh/blank tab, open it in your browser first, then click this button.";
    this.openBtn.addEventListener("click", () => this.onOpenClick());
    this.releaseBtn = document.createElement("button");
    this.releaseBtn.className = "pn-browser-btn";
    this.releaseBtn.textContent = "stop";
    this.releaseBtn.addEventListener("click", () => this.onReleaseClick());
    this.statusLine = document.createElement("div");
    this.statusLine.className = "pn-browser-status";
    controls.append(this.openBtn, this.releaseBtn, this.statusLine);
    this.root.appendChild(controls);

    // Preview area — live mirror video + placeholder.
    const preview = document.createElement("div");
    preview.className = "pn-browser-preview";
    this.mirror = document.createElement("video");
    this.mirror.className = "pn-browser-mirror";
    this.mirror.muted = true;
    this.mirror.autoplay = true;
    this.mirror.playsInline = true;
    this.mirror.style.display = "none";
    this.placeholder = document.createElement("div");
    this.placeholder.className = "pn-browser-placeholder";
    this.placeholder.innerHTML = [
      "<ol class='pn-browser-help-steps'>",
      "<li>Start DSP (▶ top bar).</li>",
      "<li>Open the page you want to mirror in another browser tab.</li>",
      "<li>Click <b>mirror a tab</b> above, then pick that tab in the native prompt.</li>",
      "<li>Wire outlets: <b>L / R</b> → <code>dac~</code> for audio, <b>video</b> → <code>layer</code> for visuals.</li>",
      "</ol>",
      "<div class='pn-browser-help-rules'>",
      "<div>• <b>No cable to <code>dac~</code> = no sound.</b> Audio only plays when you explicitly patch it.</div>",
      "<div>• In the native prompt pick <b>a Tab</b> (not Entire Screen or Window) — tab-capture is what silences the source so you control playback through patchNet.</div>",
      "<div>• Chromium-only enforcement (Chrome / Edge / Arc / Brave). Firefox and Safari can't suppress tab audio at the OS level — the source tab keeps playing through speakers.</div>",
      "</div>",
    ].join("");
    preview.append(this.mirror, this.placeholder);
    this.root.appendChild(preview);

    this.renderStatus();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  attach(host: HTMLElement): void {
    if (this.currentHost === host) return;
    host.appendChild(this.root);
    this.currentHost = host;
    this.bindBrowserNode();
  }

  setAudioGraph(audioGraph: AudioGraph | null): void {
    if (this.audioGraph === audioGraph) return;
    if (this.browserNode) this.browserNode.setOnStateChange(undefined);
    this.browserNode = null;
    this.audioGraph = audioGraph;
    this.bindBrowserNode();
    this.renderStatus();
  }

  private bindBrowserNode(): void {
    if (!this.audioGraph) return;
    const bn = this.audioGraph.getBrowserNode(this.patchNode.id);
    if (!bn) return;
    this.browserNode = bn;
    bn.setOnStateChange(() => this.renderStatus());
  }

  detach(): void {
    this.root.remove();
    this.currentHost = null;
  }

  destroy(): void {
    if (this.browserNode) this.browserNode.setOnStateChange(undefined);
    this.browserNode = null;
    this.root.remove();
    this.currentHost = null;
  }

  /** No-op: panel no longer has an editable URL. Kept so the controller's
   *  unified syncFromArgs call compiles across all panel types. */
  syncFromArgs(): void { /* intentionally empty */ }

  // ── Actions ───────────────────────────────────────────────────────────

  private async onOpenClick(): Promise<void> {
    if (!this.audioGraph || !this.browserNode) {
      this.statusLine.textContent = "start audio first (enable DSP)";
      this.statusLine.dataset.state = "err";
      return;
    }
    // Trigger capture directly from the user gesture. We intentionally do
    // NOT call window.open() here — opening a new tab steals focus from the
    // patchNet document, which makes getDisplayMedia reject with
    // InvalidStateError ("the document is not the active document").
    this.statusLine.textContent = "waiting for you to pick a tab…";
    delete this.statusLine.dataset.state;
    await this.browserNode.capture();
  }

  private onReleaseClick(): void {
    this.browserNode?.release();
    this.renderStatus();
  }

  // ── UI ────────────────────────────────────────────────────────────────

  private renderStatus(): void {
    const audioReady = !!this.audioGraph && !!this.browserNode;

    if (!audioReady) {
      this.openBtn.disabled  = true;
      this.releaseBtn.disabled = true;
      this.statusLine.textContent = "(start audio to enable mirroring)";
      delete this.statusLine.dataset.state;
      this.placeholder.style.display = "flex";
      this.mirror.style.display = "none";
      this.mirror.srcObject = null;
      return;
    }

    const capturing = !!this.browserNode?.isCapturing;
    this.openBtn.disabled  = capturing;
    this.releaseBtn.disabled = !capturing;

    // Swap preview between placeholder (default) and live-mirror video.
    // Use the VIDEO-ONLY stream so the <video> element literally has no
    // audio tracks to play — captured-tab audio only reaches the speakers
    // if the user patches an outlet to dac~.
    const stream = this.browserNode?.videoStream ?? null;
    if (capturing && stream) {
      if (this.mirror.srcObject !== stream) {
        this.mirror.srcObject = stream;
        this.mirror.play().catch(() => { /* autoplay policy — resumes on user gesture */ });
      }
      this.mirror.style.display = "block";
      this.placeholder.style.display = "none";
    } else {
      this.mirror.srcObject = null;
      this.mirror.style.display = "none";
      this.placeholder.style.display = "flex";
    }

    if (capturing) {
      const label = this.browserNode?.tabLabel || "tab";
      this.statusLine.textContent = `● mirroring: ${label}`;
      this.statusLine.dataset.state = "on";
    } else if (this.browserNode?.hasError) {
      const detail = this.browserNode.errorMessage || "capture failed";
      this.statusLine.textContent = detail;
      this.statusLine.dataset.state = "err";
    } else {
      this.statusLine.textContent = "not mirroring";
      delete this.statusLine.dataset.state;
    }
  }
}

