import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { AudioGraph } from "../runtime/AudioGraph";
import type { YouTubeNode } from "../runtime/YouTubeNode";
import { parseYouTubeUrl } from "../runtime/youtube/parseUrl";

/**
 * Inline expanded panel for a `youtube~` object.
 *
 * Layout (top → bottom):
 *   [ url input | load button ]
 *   [ youtube embed iframe (or placeholder) ]
 *   [ open in tab | mirror tab | status pills ]
 *
 * The iframe is preview-only — its audio is muted (?mute=1) so the user
 * doesn't get double-playback when capture is active. To route audio + video
 * through the patch, the user clicks "open in tab" (which opens the watch
 * page in a fresh tab) and then "mirror tab" (which fires getDisplayMedia
 * and the user picks that tab). This mirrors the BrowserPanel design — the
 * comment in BrowserPanel.onOpenClick documents why we don't bundle the two
 * actions into one click (window.open steals focus, breaking
 * getDisplayMedia).
 */
export class YouTubePanel {
  private readonly root: HTMLDivElement;
  private readonly urlInput: HTMLInputElement;
  private readonly loadBtn: HTMLButtonElement;
  private readonly errorPill: HTMLDivElement;
  private readonly iframe: HTMLIFrameElement;
  private readonly placeholder: HTMLDivElement;
  private readonly autoMirrorBtn: HTMLButtonElement;
  private readonly openTabBtn: HTMLButtonElement;
  private readonly captureBtn: HTMLButtonElement;
  private readonly statusLine: HTMLDivElement;

  private currentHost: HTMLElement | null = null;
  private ytNode: YouTubeNode | null = null;

  constructor(
    private readonly patchNode: PatchNode,
    private readonly graph: PatchGraph,
    private audioGraph: AudioGraph | null,
  ) {
    this.root = document.createElement("div");
    this.root.className = "pn-youtube-panel";
    this.root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    // Note: NOT stopping propagation on mousedown — tests showed it can
    // interact poorly with native input focus + paste. DragController already
    // excludes INPUT/BUTTON targets and the .pn-youtube-panel-host container,
    // so canvas drag won't accidentally fire from inside the panel.

    // ── URL row ─────────────────────────────────────────────────────────
    const urlRow = document.createElement("div");
    urlRow.className = "pn-youtube-url-row";

    this.urlInput = document.createElement("input");
    this.urlInput.type = "url";
    this.urlInput.className = "pn-youtube-url-input";
    this.urlInput.placeholder = "paste a youtube url (watch / share / shorts / embed)";
    this.urlInput.spellcheck = false;
    this.urlInput.value = patchNode.args[0] ?? "";
    this.urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.commitUrl();
    });
    this.urlInput.addEventListener("input", () => {
      // Clear the error pill on any keystroke so the user gets a clean retry.
      if (this.errorPill.textContent) this.errorPill.textContent = "";
    });
    // Auto-commit on paste. We try to read clipboardData synchronously so
    // commitUrl() runs inside the paste event's transient user activation —
    // that gesture is what `getDisplayMedia` needs for the auto-mirror call
    // chained off commitUrl. If the clipboard payload isn't in a format we
    // recognise, fall back to letting native paste fill the field and commit
    // on the next tick (no auto-mirror in that branch — gesture is gone).
    this.urlInput.addEventListener("paste", (e) => {
      const synced =
        e.clipboardData?.getData("text/plain") ||
        e.clipboardData?.getData("text/uri-list") ||
        "";
      if (synced.trim()) {
        e.preventDefault();
        this.urlInput.value = synced;
        this.commitUrl();
        return;
      }
      setTimeout(() => {
        if (this.urlInput.value.trim()) this.commitUrl();
      }, 0);
    });

    this.loadBtn = document.createElement("button");
    this.loadBtn.className = "pn-youtube-btn pn-youtube-btn-primary";
    this.loadBtn.textContent = "load";
    this.loadBtn.addEventListener("click", () => this.commitUrl());

    urlRow.append(this.urlInput, this.loadBtn);
    this.root.appendChild(urlRow);

    this.errorPill = document.createElement("div");
    this.errorPill.className = "pn-youtube-error";
    this.root.appendChild(this.errorPill);

    // ── Preview area ────────────────────────────────────────────────────
    const preview = document.createElement("div");
    preview.className = "pn-youtube-preview";

    this.iframe = document.createElement("iframe");
    this.iframe.className = "pn-youtube-iframe";
    this.iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    this.iframe.allowFullscreen = true;
    this.iframe.referrerPolicy = "strict-origin-when-cross-origin";
    this.iframe.style.display = "none";

    this.placeholder = document.createElement("div");
    this.placeholder.className = "pn-youtube-placeholder";
    this.placeholder.textContent = "paste a youtube url above to load a video";

    preview.append(this.iframe, this.placeholder);
    this.root.appendChild(preview);

    // ── Action row ──────────────────────────────────────────────────────
    const controls = document.createElement("div");
    controls.className = "pn-youtube-controls";

    this.autoMirrorBtn = document.createElement("button");
    this.autoMirrorBtn.className = "pn-youtube-btn pn-youtube-btn-primary";
    this.autoMirrorBtn.textContent = "auto mirror";
    this.autoMirrorBtn.title = "Capture the iframe pixels directly from this tab via Region Capture. One Chrome share-prompt; video flows to outlet 2. (No audio routing — see 'mirror tab' below for audio + video. Chrome / Edge only.)";
    this.autoMirrorBtn.addEventListener("click", () => this.onAutoMirrorClick());

    this.openTabBtn = document.createElement("button");
    this.openTabBtn.className = "pn-youtube-btn";
    this.openTabBtn.textContent = "open in tab";
    this.openTabBtn.title = "Open the watch URL in a new browser tab. Required step before 'mirror tab' — getDisplayMedia needs an existing tab to capture.";
    this.openTabBtn.addEventListener("click", () => this.onOpenTabClick());

    this.captureBtn = document.createElement("button");
    this.captureBtn.className = "pn-youtube-btn";
    this.captureBtn.textContent = "mirror tab";
    this.captureBtn.title = "Open the system tab picker; choose the YouTube tab you opened above. The captured stream feeds L/R audio + video outlets (audio routing only available via this flow).";
    this.captureBtn.addEventListener("click", () => this.onCaptureClick());

    this.statusLine = document.createElement("div");
    this.statusLine.className = "pn-youtube-status";

    controls.append(this.autoMirrorBtn, this.openTabBtn, this.captureBtn, this.statusLine);
    this.root.appendChild(controls);

    // Initial render.
    this.applyVideoIdToIframe(
      patchNode.args[1] ?? "",
      parseInt(patchNode.args[2] ?? "0", 10) || 0,
    );
    this.renderStatus();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  attach(host: HTMLElement): void {
    if (this.currentHost === host) return;
    host.appendChild(this.root);
    this.currentHost = host;
    const wasBound = !!this.ytNode;
    this.bindNode();
    // Patch loaded with DSP already running: the panel mounts with a URL in
    // args and an AudioGraph already wired, so bindNode() succeeds first try.
    // Kick auto-mirror in that case (skip if we were already bound — that's
    // a reattach across re-renders, not a fresh bind).
    if (!wasBound && this.ytNode) this.maybeAutoMirror();
  }

  setAudioGraph(audioGraph: AudioGraph | null): void {
    if (this.audioGraph === audioGraph) return;
    if (this.ytNode) {
      this.ytNode.setOnStateChange(undefined);
      this.ytNode.setOnVideoChange(undefined);
    }
    this.ytNode = null;
    this.audioGraph = audioGraph;
    this.bindNode();
    this.renderStatus();
    // DSP just came up (or a fresh AudioGraph was swapped in) and we have a
    // URL already loaded → kick the auto-mirror flow now while we're still
    // inside the user's DSP-button transient activation. If the activation
    // already expired (slow audio init), getDisplayMedia will throw and the
    // user can fall back to clicking the auto-mirror button.
    if (audioGraph) this.maybeAutoMirror();
  }

  private bindNode(): void {
    if (!this.audioGraph) return;
    const yt = this.audioGraph.getYouTubeNode(this.patchNode.id);
    if (!yt) return;
    this.ytNode = yt;
    yt.setOnStateChange(() => this.renderStatus());
    yt.setOnVideoChange(() => this.renderStatus());
  }

  detach(): void {
    this.root.remove();
    this.currentHost = null;
  }

  destroy(): void {
    if (this.ytNode) {
      this.ytNode.setOnStateChange(undefined);
      this.ytNode.setOnVideoChange(undefined);
    }
    this.ytNode = null;
    this.iframe.src = "about:blank";
    this.root.remove();
    this.currentHost = null;
  }

  /** Re-read args (URL / videoId / startSeconds) from the patch node and push
   *  to the iframe. Called by the controller when the graph re-renders. */
  syncFromArgs(): void {
    const url = this.patchNode.args[0] ?? "";
    if (this.urlInput.value !== url) this.urlInput.value = url;
    const videoId = this.patchNode.args[1] ?? "";
    const startSeconds = parseInt(this.patchNode.args[2] ?? "0", 10) || 0;
    this.applyVideoIdToIframe(videoId, startSeconds);
  }

  // ── Actions ───────────────────────────────────────────────────────────

  private commitUrl(): void {
    const raw = this.urlInput.value.trim();
    if (!raw) {
      this.errorPill.textContent = "";
      this.patchNode.args[0] = "";
      this.patchNode.args[1] = "";
      this.patchNode.args[2] = "0";
      this.applyVideoIdToIframe("", 0);
      this.ytNode?.setVideo("", 0);
      this.graph.emit("change");
      return;
    }
    const parsed = parseYouTubeUrl(raw);
    if (!parsed.ok) {
      this.errorPill.textContent = parsed.reason;
      return;
    }
    this.errorPill.textContent = "";
    this.patchNode.args[0] = raw;
    this.patchNode.args[1] = parsed.videoId;
    this.patchNode.args[2] = String(parsed.startSeconds);
    this.applyVideoIdToIframe(parsed.videoId, parsed.startSeconds);
    this.ytNode?.setVideo(parsed.videoId, parsed.startSeconds);
    this.graph.emit("change");
    // Loading a URL is a user gesture (Enter / load click / sync paste), so
    // we can chain straight into auto-mirror — saves the user a second click
    // for the common "drop a youtube~, paste, route to vFX" flow. Silent
    // no-op if audio isn't started or we're already mirroring.
    this.maybeAutoMirror();
  }

  private maybeAutoMirror(): void {
    if (!this.audioGraph || !this.ytNode) return;
    if (this.ytNode.isCapturing) return;
    if (!(this.patchNode.args[1] ?? "")) return;
    this.statusLine.textContent = "approve the share prompt to mirror this iframe…";
    delete this.statusLine.dataset.state;
    void this.ytNode.autoMirror(this.iframe);
  }

  private onOpenTabClick(): void {
    const videoId = this.patchNode.args[1] ?? "";
    if (!videoId) return;
    const start = parseInt(this.patchNode.args[2] ?? "0", 10) || 0;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}` + (start > 0 ? `&t=${start}` : "");
    window.open(watchUrl, "_blank", "noopener,noreferrer");
  }

  private async onAutoMirrorClick(): Promise<void> {
    if (!this.audioGraph || !this.ytNode) {
      this.statusLine.textContent = "start audio first (enable DSP)";
      this.statusLine.dataset.state = "err";
      return;
    }
    if (this.ytNode.isCapturing) {
      this.ytNode.release();
      return;
    }
    if (!(this.patchNode.args[1] ?? "")) {
      this.statusLine.textContent = "load a youtube url first";
      this.statusLine.dataset.state = "err";
      return;
    }
    this.statusLine.textContent = "approve the share prompt to mirror this iframe…";
    delete this.statusLine.dataset.state;
    try {
      await this.ytNode.autoMirror(this.iframe);
    } catch {
      // Error state already surfaced via setOnStateChange → renderStatus.
    }
  }

  private async onCaptureClick(): Promise<void> {
    if (!this.audioGraph || !this.ytNode) {
      this.statusLine.textContent = "start audio first (enable DSP)";
      this.statusLine.dataset.state = "err";
      return;
    }
    if (this.ytNode.isCapturing) {
      this.ytNode.release();
      return;
    }
    this.statusLine.textContent = "waiting for you to pick a tab…";
    delete this.statusLine.dataset.state;
    await this.ytNode.capture();
  }

  // ── UI ────────────────────────────────────────────────────────────────

  private applyVideoIdToIframe(videoId: string, startSeconds: number): void {
    if (!videoId) {
      // Drop the iframe src so YouTube isn't rendering a phantom load.
      this.iframe.src = "about:blank";
      this.iframe.style.display = "none";
      this.placeholder.style.display = "flex";
      return;
    }
    // mute=1: the iframe is preview-only — audio routing is via tab capture.
    // autoplay=1: muted autoplay is browser-allowed, and 'auto mirror' captures
    //   nothing if the iframe is paused, so we play eagerly.
    // enablejsapi=1 + origin: forward-compat for Phase B's IFrame Player API
    // (no-ops in Phase A but cheap to set now to avoid remounting the iframe
    // when we wire postMessage later).
    const params = new URLSearchParams({
      mute: "1",
      autoplay: "1",
      enablejsapi: "1",
      origin: window.location.origin,
      rel: "0",
      modestbranding: "1",
    });
    if (startSeconds > 0) params.set("start", String(startSeconds));
    const next = `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
    if (this.iframe.src !== next) this.iframe.src = next;
    this.iframe.style.display = "block";
    this.placeholder.style.display = "none";
  }

  private renderStatus(): void {
    const audioReady = !!this.audioGraph && !!this.ytNode;
    const hasVideo = !!(this.patchNode.args[1] ?? "");

    this.openTabBtn.disabled = !hasVideo;

    if (!audioReady) {
      this.autoMirrorBtn.disabled = true;
      this.captureBtn.disabled = true;
      this.autoMirrorBtn.textContent = "auto mirror";
      this.captureBtn.textContent = "mirror tab";
      this.statusLine.textContent = "(start audio to enable mirroring)";
      delete this.statusLine.dataset.state;
      return;
    }

    const mode = this.ytNode?.captureMode ?? "none";
    // While capturing, only the active mode's button shows "stop"; the other
    // stays disabled so the user can't accidentally re-prompt mid-stream.
    if (mode === "auto") {
      this.autoMirrorBtn.disabled = false;
      this.autoMirrorBtn.textContent = "stop";
      this.captureBtn.disabled = true;
      this.captureBtn.textContent = "mirror tab";
    } else if (mode === "tab") {
      this.autoMirrorBtn.disabled = true;
      this.autoMirrorBtn.textContent = "auto mirror";
      this.captureBtn.disabled = false;
      this.captureBtn.textContent = "stop";
    } else {
      this.autoMirrorBtn.disabled = !hasVideo;
      this.autoMirrorBtn.textContent = "auto mirror";
      this.captureBtn.disabled = !hasVideo;
      this.captureBtn.textContent = "mirror tab";
    }
    if (mode !== "none") {
      const label = this.ytNode?.tabLabel || "tab";
      const tag = mode === "auto" ? "iframe" : "tab";
      this.statusLine.textContent = `● mirroring ${tag}: ${label}`;
      this.statusLine.dataset.state = "on";
    } else if (this.ytNode?.hasError) {
      this.statusLine.textContent = this.ytNode.errorMessage || "capture failed";
      this.statusLine.dataset.state = "err";
    } else if (!hasVideo) {
      this.statusLine.textContent = "load a url to begin";
      delete this.statusLine.dataset.state;
    } else {
      this.statusLine.textContent = "preview only — 'auto mirror' for video to fx, or 'mirror tab' for audio + video";
      delete this.statusLine.dataset.state;
    }
  }
}
