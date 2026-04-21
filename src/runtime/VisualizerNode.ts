import type { LayerNode } from "./LayerNode";
import type { IRenderContext } from "./IRenderContext";
import type { IRenderer } from "../control/IRenderer";
import type { DownstreamMessage, UpstreamMessage } from "../control/ControlMessage";

/**
 * VisualizerNode — manages one named popup render window.
 *
 * Opened by the visualizer patchNet object on bang.
 * Runs its own requestAnimationFrame loop that composites
 * registered LayerNodes sorted by priority each frame.
 *
 * Priority semantics: lower number = drawn first (background).
 *                     Higher number = drawn last (foreground / on top).
 *
 * Implements IRenderer (Phase 1 of control/render split) as a forwarder
 * over its existing methods. Phase 2 migrates this to a dedicated
 * `PopupRenderer` class with a pure ControlMessage surface.
 */
export class VisualizerNode implements IRenderContext, IRenderer {
  private popup: Window | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private layers: LayerNode[] = [];

  private positionPollId: number | null = null;
  private _lastScreenX = 0;
  private _lastScreenY = 0;

  /** Fired when the popup successfully opens. */
  onOpen?: () => void;
  /** Fired when the popup is closed. */
  onClose?: () => void;
  /** Fired when the popup is resized — args are new inner width/height. */
  onResize?: (w: number, h: number) => void;
  /** Fired when the popup is moved — args are new screen x/y. */
  onMove?: (x: number, y: number) => void;

  /**
   * When true, the popup is brought to the front each time the main
   * patchNet window gains focus — the closest a browser can get to
   * an always-on-top / floating window within OS window management.
   */
  private _floating = false;
  private _focusHandler: (() => void) | null = null;

  /**
   * Pre-fullscreen geometry, captured when `fullscreen(true)` is called. Non-null
   * while the popup is in message-driven "fake fullscreen" (moved to 0,0 and
   * resized to `screen.availWidth × availHeight`). Cleared on `fullscreen(false)`.
   * While set, `onMove`/`onResize` skip notifying the patch so the full-screen
   * geometry doesn't overwrite the user's intended window size/position.
   */
  private _preFullscreen: { x: number; y: number; w: number; h: number } | null = null;


  constructor(
    public readonly name: string,
    private width = 640,
    private height = 480,
  ) {}

  get rendererId(): string { return this.name; }

  // ── IRenderer ─────────────────────────────────────────────────────

  onUpstream?: (msg: UpstreamMessage) => void;

  /**
   * Apply a downstream ControlMessage. Phase 1 supports the subset that
   * the current patch-side delivery methods already invoke on this class.
   * The `open` / `bang` flows that depend on `openAndRestore()` (which
   * reads patch-side args) remain on the old code path until Phase 2.
   */
  apply(msg: DownstreamMessage): void {
    switch (msg.t) {
      case "Command":
        switch (msg.cmd) {
          case "close":
            this.close();
            break;
          case "size": {
            const w = Number(msg.args?.[0] ?? this.width);
            const h = Number(msg.args?.[1] ?? this.height);
            if (!isNaN(w) && !isNaN(h)) this.resizeTo(w, h);
            break;
          }
          case "move": {
            const x = Number(msg.args?.[0] ?? 0);
            const y = Number(msg.args?.[1] ?? 0);
            if (!isNaN(x) && !isNaN(y)) this.moveTo(x, y);
            break;
          }
          case "setFloat":
            this.setFloat(Boolean(msg.args?.[0]));
            break;
          case "fullscreen":
            this.fullscreen(Boolean(msg.args?.[0]));
            break;
        }
        break;
      default:
        // Scene* / ParamUpdate / Trigger / Tick / ScenePreset — Phase 2+
        break;
    }
  }

  /** Open the popup window and start the render loop. */
  open(): void {
    if (this.popup && !this.popup.closed) {
      this.popup.focus();
      return;
    }

    const features = [
      `width=${this.width}`,
      `height=${this.height}`,
      "resizable=yes",
      "scrollbars=no",
      "toolbar=no",
      "menubar=no",
      "location=no",
      "status=no",
    ].join(",");

    this.popup = window.open("", `patchNet_${this.name}`, features);
    if (!this.popup) {
      console.warn(
        `[VisualizerNode] Popup blocked for context "${this.name}". ` +
        `Trigger bang directly from a user gesture (button click), not from metro.`
      );
      return;
    }
    this.popup.focus();

    const doc = this.popup.document;
    // Reset the document so any canvas/content from a previous session is gone.
    // This handles the case where window.open() returns an existing popup without
    // navigating it, leaving stale DOM that would stack on top of our new canvas.
    doc.open();
    doc.close();
    doc.title = `patchNet — ${this.name}`;
    doc.documentElement.style.cssText = "height:100%;background:#000;";
    doc.body.style.cssText = "margin:0;width:100%;height:100%;background:#000;overflow:hidden;";

    // Fullscreen styling — when the canvas is the :fullscreen element, browsers
    // size it to its intrinsic bitmap dimensions centered on black. Override so
    // the canvas box fills the viewport; object-fit:contain preserves aspect
    // ratio with letterboxing like YouTube. Change to `fill` to stretch, `cover`
    // to crop-fill.
    const fsStyle = doc.createElement("style");
    fsStyle.textContent = `
      canvas:fullscreen, canvas:-webkit-full-screen {
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw;
        max-height: 100vh;
        object-fit: contain;
        background: #000;
      }
    `;
    doc.head.appendChild(fsStyle);

    this.canvas = doc.createElement("canvas");
    this.canvas.width  = this.width;
    this.canvas.height = this.height;
    this.canvas.style.cssText = "display:block;width:100%;height:100%;";
    doc.body.appendChild(this.canvas);

    // Click-gate overlay — shown when `fullscreen 1` is received from the main
    // window. Cross-window requestFullscreen() is blocked by browsers (no user
    // gesture in the popup's context), so we show a transparent full-cover div.
    // The user's first click on it IS a popup-context gesture; that click handler
    // calls requestFullscreen() and removes the overlay.
    const gate = doc.createElement("div");
    gate.style.cssText = [
      "position:fixed;inset:0;z-index:9999",
      "display:none",
      "align-items:center;justify-content:center",
      "background:transparent",
      "cursor:none",
    ].join(";");
    const gateHint = doc.createElement("div");
    gateHint.style.cssText = [
      "color:rgba(255,255,255,0.65)",
      "font:bold 20px/1 monospace",
      "letter-spacing:0.12em",
      "text-transform:uppercase",
      "pointer-events:none",
      "transition:opacity 1.5s ease",
    ].join(";");
    gateHint.textContent = "click to enter fullscreen";
    gate.appendChild(gateHint);
    doc.body.appendChild(gate);
    gate.addEventListener("click", () => {
      gate.style.display = "none";
      this.canvas!.requestFullscreen().catch(err => {
        console.warn("[VisualizerNode] Fullscreen gate click failed:", err);
      });
    });

    // Receive fullscreen commands from the main window via postMessage.
    this.popup.addEventListener("message", (e: MessageEvent) => {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "patchnet:fullscreen") {
        if (e.data.enable) {
          gate.style.display = "flex";
          // Fade the hint text out after one frame so the transition fires.
          this.popup!.requestAnimationFrame(() => { gateHint.style.opacity = "0"; });
        } else {
          gate.style.display = "none";
          gateHint.style.opacity = "1";
        }
      }
    });

    this.ctx = this.canvas.getContext("2d");

    this.popup.addEventListener("resize", () => {
      if (!this.popup || !this.canvas) return;
      // Keep the canvas at its configured resolution whenever the popup covers
      // (most of) the screen — fullscreen via ANY mechanism: Fullscreen API,
      // macOS green-button window fullscreen, OS-level window maximize, or
      // our message-driven fake fullscreen. Rendering at screen resolution
      // (e.g. 3840×2160) stalls video playback; CSS `width:100%;height:100%`
      // on the canvas scales visually with zero cost.
      const scr = this.popup.screen;
      const screenFullsize =
        !!this._preFullscreen ||
        (this.popup.innerWidth  >= scr.width  * 0.95 &&
         this.popup.innerHeight >= scr.height * 0.85) ||
        !!this.popup.document.fullscreenElement;
      if (screenFullsize) return;
      this.width  = this.popup.innerWidth;
      this.height = this.popup.innerHeight;
      this.canvas.width  = this.width;
      this.canvas.height = this.height;
      this.onResize?.(this.width, this.height);
    });

    // Fullscreen entry paths inside the popup — both are native gestures
    // in the popup's own browsing context, so browsers always allow them.
    // (The `fullscreen` message from the main canvas is best-effort; Chrome
    // often blocks cross-window requestFullscreen even with a user gesture.)
    const toggleFullscreen = () => {
      const d = this.popup!.document;
      if (d.fullscreenElement) {
        d.exitFullscreen().catch(() => {});
      } else {
        this.canvas!.requestFullscreen().catch(err => {
          console.warn("[VisualizerNode] Fullscreen failed:", err);
        });
      }
    };
    this.canvas.addEventListener("dblclick", toggleFullscreen);
    this.popup.addEventListener("keydown", (e) => {
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "Escape" && this.popup!.document.fullscreenElement) {
        this.popup!.document.exitFullscreen().catch(() => {});
      }
    });

    this.popup.addEventListener("beforeunload", () => {
      this.stopPositionPoll();
      // Capture final position before the popup reference goes stale
      if (this.popup) this.onMove?.(this.popup.screenX, this.popup.screenY);
      this.stopLoop();
      this.popup   = null;
      this.canvas  = null;
      this.ctx     = null;

      this.onClose?.();
    });

    this.startLoop();
    this._lastScreenX = this.popup.screenX;
    this._lastScreenY = this.popup.screenY;
    this.startPositionPoll();
    this.onOpen?.();
  }

  /** Hide (close) the popup window. */
  close(): void {
    this.stopPositionPoll();
    if (this.popup && !this.popup.closed) this.onMove?.(this.popup.screenX, this.popup.screenY);
    this.onClose?.();
    this.stopLoop();
    this.popup?.close();
    this.popup  = null;
    this.canvas = null;
    this.ctx    = null;
    // Keep float setting intact so re-opening re-applies it,
    // but the focus handler stays registered — no popup to focus is harmless.
  }

  moveTo(x: number, y: number): void { this.popup?.moveTo(x, y); }

  /**
   * Enter or exit "fullscreen" on the popup.
   *
   * Cross-window `requestFullscreen()` is gesture-restricted and blocked by
   * all modern browsers, so `enable=true` primarily uses **fake fullscreen**:
   * moves the popup to the screen origin and resizes it to fill
   * `screen.availWidth × availHeight`. A real `requestFullscreen()` is
   * attempted alongside as a best effort; failure is silent.
   *
   * `enable=false` exits real fullscreen if active and restores the popup to
   * the size/position it had before `fullscreen(true)` was called.
   *
   * For truly borderless fullscreen, double-click the popup canvas or press
   * `F` inside the popup — those paths use a local user gesture and aren't
   * blocked.
   */
  fullscreen(enable: boolean): void {
    if (!this.popup || this.popup.closed || !this.canvas) return;
    const popup = this.popup;
    const doc   = popup.document;

    if (enable) {
      if (this._preFullscreen) return; // already in fake fullscreen

      // Capture current geometry for restoration on `fullscreen 0`.
      this._preFullscreen = {
        x: popup.screenX,
        y: popup.screenY,
        w: popup.innerWidth,
        h: popup.innerHeight,
      };

      // Fake fullscreen: fill the usable screen area. `availLeft/availTop` pin
      // to the top-left of the primary display (Windows taskbar offset, etc.).
      const scr = popup.screen as Screen & { availLeft?: number; availTop?: number };
      const x = scr.availLeft ?? 0;
      const y = scr.availTop  ?? 0;
      popup.moveTo(x, y);
      popup.resizeTo(scr.availWidth, scr.availHeight);

      // Resize the canvas bitmap to the full screen so rendering fills every
      // pixel rather than being upscaled from a smaller default resolution.
      this.width  = scr.availWidth;
      this.height = scr.availHeight;
      this.canvas.width  = this.width;
      this.canvas.height = this.height;

      // Signal the popup to show its click-gate. The popup's own click handler
      // calls requestFullscreen() — a real gesture in the popup's context.
      // Cross-window requestFullscreen() is blocked by all modern browsers.
      popup.postMessage({ type: "patchnet:fullscreen", enable: true }, "*");
    } else {
      if (doc.fullscreenElement) {
        doc.exitFullscreen().catch(() => {});
      }
      popup.postMessage({ type: "patchnet:fullscreen", enable: false }, "*");
      const prev = this._preFullscreen;
      this._preFullscreen = null;
      if (prev) {
        popup.resizeTo(prev.w, prev.h);
        popup.moveTo(prev.x, prev.y);
        this.width  = prev.w;
        this.height = prev.h;
        if (this.canvas) {
          this.canvas.width  = prev.w;
          this.canvas.height = prev.h;
        }
      }
    }
  }

  /** Set dimensions before open() so the popup is created at the right size. */
  setDimensions(w: number, h: number): void {
    this.width  = w;
    this.height = h;
  }

  resizeTo(w: number, h: number): void {
    this.width  = w;
    this.height = h;
    this.popup?.resizeTo(w, h);
    if (this.canvas) {
      this.canvas.width  = w;
      this.canvas.height = h;
    }
  }

  isOpen(): boolean {
    return !!this.popup && !this.popup.closed;
  }

  /**
   * Enable or disable floating mode.
   *
   * While enabled, a `focus` listener on the main window calls
   * `popup.focus()` whenever the user returns to the patchNet tab,
   * keeping the visualizer popup in front of the patchNet window.
   */
  setFloat(enabled: boolean): void {
    this._floating = enabled;

    // Tear down any existing listener
    if (this._focusHandler) {
      window.removeEventListener("focus", this._focusHandler);
      this._focusHandler = null;
    }

    if (enabled) {
      this._focusHandler = () => {
        if (this.popup && !this.popup.closed) {
          // Small delay so the main window finishes activating before
          // we transfer focus to the popup — avoids focus ping-pong.
          setTimeout(() => this.popup?.focus(), 80);
        }
      };
      window.addEventListener("focus", this._focusHandler);
    }
  }

  get floating(): boolean { return this._floating; }

  // ── Layer management ─────────────────────────────────────────────

  addLayer(layer: LayerNode): void {
    if (!this.layers.includes(layer)) this.layers.push(layer);
  }

  removeLayer(layer: LayerNode): void {
    this.layers = this.layers.filter(l => l !== layer);
  }

  clearLayers(): void {
    this.layers = [];
  }

  // ── Render loop ──────────────────────────────────────────────────

  private startLoop(): void {
    if (this.rafId !== null || !this.popup) return;
    // Use the popup's rAF, not the main window's. When the popup goes
    // fullscreen (especially macOS-style, which moves it to its own Space),
    // the main window becomes backgrounded and Chrome throttles its rAF to
    // ~1 fps. Driving the render tick off the VISIBLE popup keeps playback
    // at full framerate regardless of the main window's state.
    const popup = this.popup;
    const tick = () => {
      if (!this.popup || this.popup.closed) { this.rafId = null; return; }
      this.drawFrame();
      this.rafId = popup.requestAnimationFrame(tick);
    };
    this.rafId = popup.requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null && this.popup && !this.popup.closed) {
      this.popup.cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  private drawFrame(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    // Sort: lower priority number = drawn first (background), higher = drawn last (foreground/on top)
    const sorted = [...this.layers].sort((a, b) => a.priority - b.priority);
    for (const layer of sorted) {
      layer.draw(ctx, this.width, this.height);
    }
  }

  // ── Position polling ─────────────────────────────────────────────

  private startPositionPoll(): void {
    if (!this.popup) return;
    const popup = this.popup;
    const poll = () => {
      if (!this.popup || this.popup.closed) { this.positionPollId = null; return; }
      // Skip position reporting while in message-driven fake fullscreen so the
      // (0,0) geometry doesn't overwrite the saved pre-fullscreen position.
      if (this._preFullscreen) {
        this.positionPollId = popup.requestAnimationFrame(poll);
        return;
      }
      const x = this.popup.screenX;
      const y = this.popup.screenY;
      if (x !== this._lastScreenX || y !== this._lastScreenY) {
        this._lastScreenX = x;
        this._lastScreenY = y;
        this.onMove?.(x, y);
      }
      this.positionPollId = popup.requestAnimationFrame(poll);
    };
    this.positionPollId = popup.requestAnimationFrame(poll);
  }

  private stopPositionPoll(): void {
    if (this.positionPollId !== null) {
      if (this.popup && !this.popup.closed) this.popup.cancelAnimationFrame(this.positionPollId);
      this.positionPollId = null;
    }
  }

  /** Exposes the popup canvas so patchViz nodes can drawImage() from it. */
  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  destroy(): void {
    this.setFloat(false); // remove focus listener
    this.close();
    this.layers = [];
  }
}
