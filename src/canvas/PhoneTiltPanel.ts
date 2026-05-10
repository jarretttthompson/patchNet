import QRCode from "qrcode";
import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { PhoneSensorRegistry, PhoneSensorSession } from "../runtime/phoneSensor/PhoneSensorRegistry";

/**
 * Inline panel for the [phoneTilt] object — renders the QR code that points
 * a phone at the dev server's sensor page, plus a live readout that updates
 * via rAF while attached. One PhoneTiltPanel per node; the controller below
 * mirrors PeerPanelController and reattaches on every render() so the panel
 * re-binds into freshly-rendered DOM.
 *
 * The QR encodes  http://<lan-ip>:<port>/__sensor/page?room=<id>
 * which is fetched once from /__sensor/info on the same dev server.
 */

interface SensorInfo { ip: string | null; port: number | null }

let cachedInfo: Promise<SensorInfo> | null = null;
function fetchSensorInfo(): Promise<SensorInfo> {
  if (!cachedInfo) {
    cachedInfo = fetch("/__sensor/info")
      .then((r) => r.ok ? r.json() : { ip: null, port: null })
      .catch(() => ({ ip: null, port: null }));
  }
  return cachedInfo;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.patch-object-phonetilt-body { padding: 0; }
.pn-phonetilt-panel { display: flex; flex-direction: column; gap: 6px;
  padding: 8px; height: 100%; box-sizing: border-box; align-items: stretch;
  font-family: var(--pn-font-mono, ui-monospace, Menlo, monospace); font-size: 11px; }
.pn-phonetilt-qr { display: flex; align-items: center; justify-content: center;
  background: var(--pn-bg, #fff); border-radius: 4px; padding: 4px; flex: 0 0 auto; }
.pn-phonetilt-qr canvas, .pn-phonetilt-qr img { display: block; image-rendering: pixelated;
  width: 128px; height: 128px; }
.pn-phonetilt-status { display: flex; align-items: center; gap: 6px; opacity: 0.85;
  font-size: 10px; line-height: 1; }
.pn-phonetilt-dot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex: 0 0 auto; }
.pn-phonetilt-dot--on { background: var(--pn-accent, #2a7); }
.pn-phonetilt-readout { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px;
  font-size: 10px; opacity: 0.85; line-height: 1.3; }
.pn-phonetilt-readout b { font-weight: 500; opacity: 0.6; }
.pn-phonetilt-url { font-size: 9px; opacity: 0.5; word-break: break-all; line-height: 1.2; }
`;
  document.head.appendChild(style);
}

export class PhoneTiltPanel {
  private host: HTMLElement | null = null;
  private node: PatchNode;
  private session: PhoneSensorSession | null = null;
  private qrEl: HTMLDivElement | null = null;
  private dotEl: HTMLDivElement | null = null;
  private statusTextEl: HTMLSpanElement | null = null;
  private urlEl: HTMLDivElement | null = null;
  private readoutPitch: HTMLSpanElement | null = null;
  private readoutRoll:  HTMLSpanElement | null = null;
  private readoutYaw:   HTMLSpanElement | null = null;
  private rafId: number | null = null;
  private lastQrUrl = "";
  private destroyed = false;

  constructor(node: PatchNode, _graph: PatchGraph, private readonly registry: PhoneSensorRegistry) {
    this.node = node;
  }

  attach(host: HTMLElement, node: PatchNode): void {
    this.node = node;
    this.session = this.registry.getSession(node.id);
    if (this.host !== host) {
      this.host = host;
      this.buildShell();
    }
    void this.refreshQr();
    this.startTick();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopTick();
    this.host = null;
  }

  // ── DOM construction ───────────────────────────────────────────────────

  private buildShell(): void {
    if (!this.host) return;
    injectStyles();
    this.host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "pn-phonetilt-panel";

    const qr = document.createElement("div");
    qr.className = "pn-phonetilt-qr";
    this.qrEl = qr;
    root.appendChild(qr);

    const status = document.createElement("div");
    status.className = "pn-phonetilt-status";
    const dot = document.createElement("div");
    dot.className = "pn-phonetilt-dot";
    const text = document.createElement("span");
    text.textContent = "waiting for phone…";
    status.appendChild(dot);
    status.appendChild(text);
    this.dotEl = dot;
    this.statusTextEl = text;
    root.appendChild(status);

    const readout = document.createElement("div");
    readout.className = "pn-phonetilt-readout";
    for (const [label, key] of [
      ["pitch", "readoutPitch"],
      ["roll",  "readoutRoll"],
      ["yaw",   "readoutYaw"],
    ] as const) {
      const b = document.createElement("b");
      b.textContent = label;
      const span = document.createElement("span");
      span.textContent = "—";
      readout.appendChild(b);
      readout.appendChild(span);
      this[key] = span;
    }
    root.appendChild(readout);

    const url = document.createElement("div");
    url.className = "pn-phonetilt-url";
    this.urlEl = url;
    root.appendChild(url);

    this.host.appendChild(root);
  }

  // ── QR rendering ───────────────────────────────────────────────────────

  private async refreshQr(): Promise<void> {
    if (!this.qrEl) return;
    const room = (this.node.args[0] ?? "").trim();
    if (!room) return;
    const info = await fetchSensorInfo();
    if (this.destroyed || !this.qrEl) return;
    // Fall back to the page's own host if the dev server didn't report a LAN
    // IP — the QR will still work for testing on the Mac itself.
    const host = info.ip && info.port
      ? `${info.ip}:${info.port}`
      : window.location.host;
    // Match the dev server's protocol — iOS won't grant DeviceOrientation
    // permission on http://, so the dev server runs on https:// and the
    // QR has to point there too.
    const proto = window.location.protocol === "https:" ? "https" : "http";
    const url = `${proto}://${host}/__sensor/page?room=${encodeURIComponent(room)}`;
    if (url === this.lastQrUrl) return;
    this.lastQrUrl = url;
    if (this.urlEl) this.urlEl.textContent = url;
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        margin: 0,
        width: 128,
        color: { dark: "#000000", light: "#ffffff" },
      });
      if (this.destroyed || !this.qrEl) return;
      this.qrEl.innerHTML = "";
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "Scan with phone";
      this.qrEl.appendChild(img);
    } catch {
      if (!this.qrEl) return;
      this.qrEl.textContent = "QR error";
    }
  }

  // ── Live readout (rAF loop) ────────────────────────────────────────────

  private startTick(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = null;
      if (this.destroyed) return;
      this.applyState();
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopTick(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private applyState(): void {
    // Re-resolve the session each tick — the registry replaces sessions when
    // the user manually reconnects, and we want the panel to follow.
    this.session = this.registry.getSession(this.node.id);
    const state = this.session?.getCurrent();
    if (this.dotEl) this.dotEl.classList.toggle("pn-phonetilt-dot--on", !!state?.connected);
    if (this.statusTextEl) {
      this.statusTextEl.textContent = !state ? "no session"
        : state.connected ? "connected" : "waiting for phone…";
    }
    if (state?.hasSample) {
      if (this.readoutPitch) this.readoutPitch.textContent = state.pitch.toFixed(1) + "°";
      if (this.readoutRoll)  this.readoutRoll.textContent  = state.roll.toFixed(1)  + "°";
      if (this.readoutYaw)   this.readoutYaw.textContent   = state.yaw.toFixed(1)   + "°";
    }
  }
}

export class PhoneTiltPanelController {
  private readonly panels = new Map<string, PhoneTiltPanel>();

  constructor(
    private readonly graph: PatchGraph,
    private registry: PhoneSensorRegistry,
  ) {}

  mount(panGroup: HTMLElement): void {
    for (const node of this.graph.getNodes()) {
      if (node.type !== "phoneTilt") continue;
      const host = panGroup.querySelector<HTMLElement>(
        `[data-phonetilt-panel-host="${node.id}"]`,
      );
      if (!host) continue;
      let panel = this.panels.get(node.id);
      if (!panel) {
        panel = new PhoneTiltPanel(node, this.graph, this.registry);
        this.panels.set(node.id, panel);
      }
      panel.attach(host, node);
    }
  }

  prune(activeNodeIds: Set<string>): void {
    for (const id of Array.from(this.panels.keys())) {
      if (!activeNodeIds.has(id)) {
        this.panels.get(id)?.destroy();
        this.panels.delete(id);
      }
    }
  }

  destroy(): void {
    for (const p of this.panels.values()) p.destroy();
    this.panels.clear();
  }
}
