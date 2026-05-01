import type { PatchGraph } from "../graph/PatchGraph";
import type { AudioGraph } from "../runtime/AudioGraph";
import type { PatchNode } from "../graph/PatchNode";
import { mixerChannelCount } from "../graph/objectDefs";

function parseMixerFloats(raw: string, count: number, defaultVal: number): number[] {
  const parts = raw ? raw.split(",") : [];
  return Array.from({ length: count }, (_, i) => {
    const v = parseFloat(parts[i] ?? "");
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : defaultVal;
  });
}

function parseMixerLinks(raw: string, count: number): number[] {
  const parts = raw ? raw.split(",") : [];
  return Array.from({ length: count }, (_, i) => {
    const v = parseInt(parts[i] ?? "-1", 10);
    return Number.isFinite(v) && v >= 0 && v < count ? v : -1;
  });
}

export class MixerPanel {
  private readonly el: HTMLElement;
  private audioGraph: AudioGraph | null;
  private readonly node: PatchNode;
  private readonly graph: PatchGraph;

  private gains: number[];
  private pans: number[];
  private links: number[];
  private meterRafId = 0;
  private activeMenu: HTMLElement | null = null;

  constructor(node: PatchNode, graph: PatchGraph, audioGraph: AudioGraph | null) {
    this.node = node;
    this.graph = graph;
    this.audioGraph = audioGraph;

    const n = mixerChannelCount(node.args);
    this.gains = parseMixerFloats(node.args[1] ?? "", n, 0.75);
    this.pans  = parseMixerFloats(node.args[2] ?? "", n, 0.5);
    this.links = parseMixerLinks(node.args[4] ?? "", n);

    this.el = this.buildDOM(n);
  }

  setAudioGraph(ag: AudioGraph | null): void {
    this.audioGraph = ag;
    if (ag) {
      this.startMeterLoop();
    } else {
      this.stopMeterLoop();
    }
  }

  syncFromArgs(): void {
    const n = mixerChannelCount(this.node.args);
    this.gains = parseMixerFloats(this.node.args[1] ?? "", n, 0.75);
    this.pans  = parseMixerFloats(this.node.args[2] ?? "", n, 0.5);
    this.links = parseMixerLinks(this.node.args[4] ?? "", n);
    this.refreshSliders();
    this.refreshLinkVisuals();
  }

  attach(host: HTMLElement): void {
    if (!host.contains(this.el)) {
      host.innerHTML = "";
      host.appendChild(this.el);
    }
    if (this.audioGraph) this.startMeterLoop();
  }

  destroy(): void {
    this.stopMeterLoop();
    this.dismissMenu();
    this.el.remove();
  }

  // ── DOM construction ────────────────────────────────────────────────

  private buildDOM(n: number): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "pn-mixer-panel";

    for (let i = 0; i < n; i++) {
      panel.appendChild(this.buildStrip(i));
    }

    return panel;
  }

  private buildStrip(i: number): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "pn-mixer-strip";
    strip.dataset.ch = String(i);

    // ── Pan row ───────────────────────────────────────────────────────
    const panLabel = document.createElement("div");
    panLabel.className = "pn-mixer-pan-label";
    panLabel.textContent = "PAN";

    const panSlider = document.createElement("input");
    panSlider.type = "range";
    panSlider.className = "pn-mixer-pan";
    panSlider.min = "0";
    panSlider.max = "1";
    panSlider.step = "0.01";
    panSlider.value = String(this.pans[i] ?? 0.5);
    panSlider.addEventListener("mousedown", e => e.stopPropagation());
    panSlider.addEventListener("input", () => {
      const v = parseFloat(panSlider.value);
      this.pans[i] = v;
      this.persistPans();
      this.audioGraph?.getMixerNode(this.node.id)?.setPan(i, v);
    });

    // ── Fader + meter ─────────────────────────────────────────────────
    const faderTrack = document.createElement("div");
    faderTrack.className = "pn-mixer-fader-track";

    const meterFill = document.createElement("div");
    meterFill.className = "pn-mixer-meter-fill";

    const faderFill = document.createElement("div");
    faderFill.className = "pn-mixer-fader-fill";
    faderFill.style.height = `${(this.gains[i] ?? 0.75) * 100}%`;

    const faderThumb = document.createElement("div");
    faderThumb.className = "pn-mixer-fader-thumb";
    faderThumb.style.bottom = `${(this.gains[i] ?? 0.75) * 100}%`;

    faderTrack.appendChild(meterFill);
    faderTrack.appendChild(faderFill);
    faderTrack.appendChild(faderThumb);

    faderTrack.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const setFromEvent = (ev: MouseEvent) => {
        const rect = faderTrack.getBoundingClientRect();
        const v = Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
        this.applyGain(i, v);
      };

      setFromEvent(e);

      const onMove = (ev: MouseEvent) => setFromEvent(ev);
      const onUp   = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });

    // ── Readout + label ───────────────────────────────────────────────
    const readout = document.createElement("div");
    readout.className = "pn-mixer-readout";
    readout.textContent = (this.gains[i] ?? 0.75).toFixed(2);

    const label = document.createElement("div");
    label.className = "pn-mixer-ch-label";
    label.textContent = String(i + 1);

    // ── Right-click context menu ──────────────────────────────────────
    strip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e, i);
    });

    strip.appendChild(panLabel);
    strip.appendChild(panSlider);
    strip.appendChild(faderTrack);
    strip.appendChild(readout);
    strip.appendChild(label);

    // Apply initial link visual
    this.applyLinkClass(strip, i);

    return strip;
  }

  // ── Gain application (with link ganging) ───────────────────────────

  private applyGain(ch: number, v: number): void {
    const channelsToUpdate = [ch];
    const partner = this.links[ch];
    if (partner !== -1) channelsToUpdate.push(partner);

    for (const c of channelsToUpdate) {
      this.gains[c] = v;
      const strip = this.el.querySelector<HTMLElement>(`.pn-mixer-strip[data-ch="${c}"]`);
      if (strip) {
        const fill  = strip.querySelector<HTMLElement>(".pn-mixer-fader-fill");
        const thumb = strip.querySelector<HTMLElement>(".pn-mixer-fader-thumb");
        const readout = strip.querySelector<HTMLElement>(".pn-mixer-readout");
        if (fill)    fill.style.height   = `${v * 100}%`;
        if (thumb)   thumb.style.bottom  = `${v * 100}%`;
        if (readout) readout.textContent = v.toFixed(2);
      }
      this.audioGraph?.getMixerNode(this.node.id)?.setGain(c, v);
    }

    this.persistGains();
  }

  // ── Context menu ───────────────────────────────────────────────────

  private showContextMenu(e: MouseEvent, ch: number): void {
    this.dismissMenu();

    const n = mixerChannelCount(this.node.args);
    const partner = this.links[ch];

    const menu = document.createElement("div");
    menu.className = "pn-context-menu";

    const addItem = (label: string, disabled: boolean, onClick: () => void): void => {
      const btn = document.createElement("button");
      btn.className = "pn-context-menu-item";
      btn.textContent = label;
      if (disabled) {
        btn.disabled = true;
        btn.style.opacity = "0.4";
        btn.style.cursor = "default";
      } else {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onClick();
          this.dismissMenu();
        });
      }
      menu.appendChild(btn);
    };

    if (partner !== -1) {
      // Already linked — offer unlink
      addItem(`Unlink ch ${ch + 1} & ch ${partner + 1}`, false, () => {
        this.links[partner] = -1;
        this.links[ch] = -1;
        this.persistLinks();
        this.refreshLinkVisuals();
      });
    } else {
      // Offer to link to left neighbor
      const leftCh = ch - 1;
      if (leftCh >= 0) {
        const leftFree = this.links[leftCh] === -1;
        addItem(
          leftFree ? `Link with ch ${leftCh + 1} (left)` : `Ch ${leftCh + 1} already linked`,
          !leftFree,
          () => {
            this.links[ch] = leftCh;
            this.links[leftCh] = ch;
            this.persistLinks();
            this.refreshLinkVisuals();
          },
        );
      }

      // Offer to link to right neighbor
      const rightCh = ch + 1;
      if (rightCh < n) {
        const rightFree = this.links[rightCh] === -1;
        addItem(
          rightFree ? `Link with ch ${rightCh + 1} (right)` : `Ch ${rightCh + 1} already linked`,
          !rightFree,
          () => {
            this.links[ch] = rightCh;
            this.links[rightCh] = ch;
            this.persistLinks();
            this.refreshLinkVisuals();
          },
        );
      }

      if (n === 1) {
        addItem("Only one channel — nothing to link", true, () => {});
      }
    }

    // Position near cursor, nudge inward if it would clip the viewport
    menu.style.left = `${e.clientX}px`;
    menu.style.top  = `${e.clientY}px`;
    document.body.appendChild(menu);
    this.activeMenu = menu;

    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = `${e.clientX - r.width}px`;
      if (r.bottom > window.innerHeight) menu.style.top  = `${e.clientY - r.height}px`;
    });

    // Dismiss on next outside click
    const onOutsideClick = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        this.dismissMenu();
        document.removeEventListener("mousedown", onOutsideClick);
      }
    };
    document.addEventListener("mousedown", onOutsideClick);
  }

  private dismissMenu(): void {
    this.activeMenu?.remove();
    this.activeMenu = null;
  }

  // ── Link visuals ───────────────────────────────────────────────────

  private refreshLinkVisuals(): void {
    const strips = this.el.querySelectorAll<HTMLElement>(".pn-mixer-strip");
    strips.forEach((strip, i) => this.applyLinkClass(strip, i));
  }

  private applyLinkClass(strip: HTMLElement, i: number): void {
    const partner = this.links[i];
    strip.classList.toggle("pn-mixer-strip--linked", partner !== -1);
    strip.classList.toggle("pn-mixer-strip--linked-left",  partner !== -1 && partner < i);
    strip.classList.toggle("pn-mixer-strip--linked-right", partner !== -1 && partner > i);
  }

  // ── Slider refresh ─────────────────────────────────────────────────

  private refreshSliders(): void {
    const strips = this.el.querySelectorAll<HTMLElement>(".pn-mixer-strip");
    strips.forEach((strip, i) => {
      const fill    = strip.querySelector<HTMLElement>(".pn-mixer-fader-fill");
      const thumb   = strip.querySelector<HTMLElement>(".pn-mixer-fader-thumb");
      const readout = strip.querySelector<HTMLElement>(".pn-mixer-readout");
      const pan     = strip.querySelector<HTMLInputElement>(".pn-mixer-pan");
      const g = this.gains[i] ?? 0.75;
      if (fill)    fill.style.height   = `${g * 100}%`;
      if (thumb)   thumb.style.bottom  = `${g * 100}%`;
      if (readout) readout.textContent = g.toFixed(2);
      if (pan)     pan.value           = String(this.pans[i] ?? 0.5);
    });
  }

  // ── Meter loop ─────────────────────────────────────────────────────

  private startMeterLoop(): void {
    this.stopMeterLoop();
    const tick = () => {
      this.meterRafId = requestAnimationFrame(tick);
      const mixerNode = this.audioGraph?.getMixerNode(this.node.id);
      if (!mixerNode) return;
      const n = mixerChannelCount(this.node.args);
      for (let i = 0; i < n; i++) {
        const level = mixerNode.getChannelLevel(i);
        const bar = this.el.querySelector<HTMLElement>(
          `.pn-mixer-strip[data-ch="${i}"] .pn-mixer-meter-fill`,
        );
        if (bar) bar.style.height = `${Math.min(level * 4, 1) * 100}%`;
      }
    };
    this.meterRafId = requestAnimationFrame(tick);
  }

  private stopMeterLoop(): void {
    if (this.meterRafId) {
      cancelAnimationFrame(this.meterRafId);
      this.meterRafId = 0;
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  private persistGains(): void {
    this.node.args[1] = this.gains.map(v => v.toFixed(3)).join(",");
    this.graph.emit("change");
  }

  private persistPans(): void {
    this.node.args[2] = this.pans.map(v => v.toFixed(3)).join(",");
    this.graph.emit("change");
  }

  private persistLinks(): void {
    this.node.args[4] = this.links.map(v => String(v)).join(",");
    this.graph.emit("change");
  }
}
