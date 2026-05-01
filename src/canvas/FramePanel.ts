import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";
import type { FrameNode } from "../runtime/FrameNode";

/**
 * Inline panel for a `frame~` object.
 *
 * The panel renders a transparent capture rectangle (the element used as
 * the Region Capture crop target) plus a small toolbar at the top with a
 * capture / release button and status pill. The transparent rect has
 * `pointer-events: none` so cables and objects beneath the frame stay
 * interactive — only the toolbar and the resize handles owned by the
 * generic object body intercept input.
 *
 * Output is the underlying FrameNode's <video> element, which downstream
 * vFX / reaperVideo / layer wiring picks up via VisualizerGraph.
 */
export class FramePanel {
  private readonly root: HTMLDivElement;
  private readonly captureRect: HTMLDivElement;
  private readonly captureBtn: HTMLButtonElement;
  private readonly statusLine: HTMLDivElement;

  private currentHost: HTMLElement | null = null;
  private frameNode: FrameNode | null = null;

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    private vizGraph: VisualizerGraph | null,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pn-frame-panel";
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

    // Capture rectangle = full body interior. Transparent + pointer-events:
    // none so the browser paints nothing here (preserving the canvas content
    // below for Region Capture) and so clicks fall through to the underlying
    // .patch-object body element for DragController to pick up.
    this.captureRect = document.createElement("div");
    this.captureRect.className = "pn-frame-capture-rect";
    this.root.appendChild(this.captureRect);

    // Toolbar floats *above* the frame body — positioned absolutely with
    // negative top, so it sits outside the captureRect and is therefore not
    // included in the captured pixels. Pointer-events: auto so the button
    // and status pill remain interactive.
    const toolbar = document.createElement("div");
    toolbar.className = "pn-frame-toolbar";

    this.captureBtn = document.createElement("button");
    this.captureBtn.className = "pn-frame-btn pn-frame-btn-primary";
    this.captureBtn.textContent = "capture";
    this.captureBtn.title =
      "Approve the share prompt to start streaming the pixels inside this frame as video. " +
      "One prompt per frame~ — Chrome / Edge only.";
    this.captureBtn.addEventListener("click", () => this.onCaptureClick());

    this.statusLine = document.createElement("div");
    this.statusLine.className = "pn-frame-status";
    this.statusLine.textContent = "click capture to start";

    toolbar.append(this.captureBtn, this.statusLine);
    this.root.appendChild(toolbar);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  attach(host: HTMLElement): void {
    if (this.currentHost === host) return;
    host.appendChild(this.root);
    this.currentHost = host;
    this.bindNode();
    // Re-bind crop target after re-mount so the runtime tracks the fresh
    // DOM element (its bounds may have changed during a re-render).
    this.frameNode?.bindElement(this.captureRect);
  }

  setVisualizerGraph(vg: VisualizerGraph | null): void {
    if (this.vizGraph === vg) return;
    if (this.frameNode) this.frameNode.setOnStateChange(undefined);
    this.frameNode = null;
    this.vizGraph = vg;
    this.bindNode();
    if (this.frameNode) (this.frameNode as FrameNode).bindElement(this.captureRect);
    this.renderStatus();
  }

  private bindNode(): void {
    if (!this.vizGraph) return;
    const fn = this.vizGraph.getFrameNode(this.patchNode.id);
    if (!fn) return;
    this.frameNode = fn;
    fn.setOnStateChange(() => this.renderStatus());
    this.renderStatus();
  }

  /** Re-read args (none currently meaningful for frame~) — kept for parity
   *  with other panels in case attributes get added later. */
  syncFromArgs(): void {
    /* no args to sync today */
  }

  destroy(): void {
    if (this.frameNode) {
      this.frameNode.setOnStateChange(undefined);
      this.frameNode.release();
    }
    this.frameNode = null;
    this.root.remove();
    this.currentHost = null;
  }

  // ── Actions ───────────────────────────────────────────────────────────

  private async onCaptureClick(): Promise<void> {
    if (!this.frameNode) {
      this.statusLine.textContent = "frame runtime not ready";
      this.statusLine.dataset.state = "err";
      return;
    }
    if (!this.frameNode.isSupported()) {
      this.statusLine.textContent = "Region Capture unsupported (Chrome/Edge only)";
      this.statusLine.dataset.state = "err";
      return;
    }
    if (this.frameNode.isCapturing) {
      this.frameNode.release();
      return;
    }
    this.statusLine.textContent = "approve the share prompt to start streaming…";
    delete this.statusLine.dataset.state;
    // Re-bind right before capture so cropTo lands on the live element.
    this.frameNode.bindElement(this.captureRect);
    await this.frameNode.capture();
  }

  private renderStatus(): void {
    if (!this.frameNode) {
      this.captureBtn.disabled = true;
      this.captureBtn.textContent = "capture";
      this.statusLine.textContent = "frame runtime not ready";
      delete this.statusLine.dataset.state;
      return;
    }
    if (this.frameNode.isCapturing) {
      this.captureBtn.disabled = false;
      this.captureBtn.textContent = "stop";
      this.statusLine.textContent = "● streaming pixels";
      this.statusLine.dataset.state = "on";
    } else if (this.frameNode.hasError) {
      this.captureBtn.disabled = false;
      this.captureBtn.textContent = "capture";
      this.statusLine.textContent = this.frameNode.errorMessage || "capture failed";
      this.statusLine.dataset.state = "err";
    } else {
      this.captureBtn.disabled = false;
      this.captureBtn.textContent = "capture";
      this.statusLine.textContent = "click capture to start";
      delete this.statusLine.dataset.state;
    }
    // Touch the graph variable so eslint-no-unused doesn't trip; keeps the
    // future option of args-driven UI cheap.
    void this.graph;
  }
}
