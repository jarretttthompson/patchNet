import type { ImageFXNode } from "../runtime/ImageFXNode";
import type { PatchNode }   from "../graph/PatchNode";
import type { PatchGraph }  from "../graph/PatchGraph";
import { buildFilter, floodFillTransparent, floodRemoveEdgeBg } from "../runtime/ImageFXNode";

/**
 * ImageFXPanel — modal editor for imageFX nodes.
 *
 * Shows a live preview canvas on the left and per-parameter sliders on the
 * right. All changes are local until the user clicks Apply, at which point
 * they are written to patchNode.args and graph.emit("change") is fired.
 *
 * Background removal uses flood-fill (connected-region only), not a global
 * color-key sweep. Two modes:
 *   • Auto (edges) — flood-fill from every border pixel
 *   • Click remove  — flood-fill from the clicked pixel
 *
 * The working ImageData is computed once per "Apply BG" action and stored
 * locally. Changing a filter slider resets it (bg work is lost — reapply BG
 * after tweaking filters). On Apply the final ImageData is handed to
 * fxNode.setBgImageData() so the node renders it directly.
 */
export class ImageFXPanel {
  private readonly overlay: HTMLDivElement;
  private readonly previewCanvas: HTMLCanvasElement;
  private readonly previewCtx: CanvasRenderingContext2D;

  // Working copies of params — modified by sliders, not committed until Apply
  private work = { hue: 0, saturation: 1, brightness: 1, contrast: 1, blur: 0, invert: 0 };

  // Flood-fill BG removal state
  private bgTolerance    = 32;
  private workingBgData: ImageData | null = null; // current flood-fill result
  private clickRemoveMode = false;                // toggle for click-to-remove mode

  // Zoom / pan state for the preview canvas
  private zoom = 1;    // 1 | 2 | 4 | 8 | 16
  private panX = 0;    // viewport top-left in image pixels
  private panY = 0;
  private _panDrag: { active: boolean; sx: number; sy: number; px: number; py: number } =
    { active: false, sx: 0, sy: 0, px: 0, py: 0 };

  // UI refs
  private tolReadout!:   HTMLSpanElement;
  private bgStatusEl!:   HTMLDivElement;
  private clickModeBtn!: HTMLButtonElement;
  private zoomReadout!:  HTMLSpanElement;

  constructor(
    private readonly fxNode:     ImageFXNode,
    private readonly patchNode:  PatchNode,
    private readonly graph:      PatchGraph,
  ) {
    const f = (v: string | undefined, def: number) => { const n = parseFloat(v ?? ""); return isNaN(n) ? def : n; };
    this.work.hue        = f(patchNode.args[0], 0);
    this.work.saturation = f(patchNode.args[1], 1);
    this.work.brightness = f(patchNode.args[2], 1);
    this.work.contrast   = f(patchNode.args[3], 1);
    this.work.blur       = f(patchNode.args[4], 0);
    this.work.invert     = f(patchNode.args[5], 0);

    this.previewCanvas = document.createElement("canvas");
    const ctx = this.previewCanvas.getContext("2d");
    if (!ctx) throw new Error("[ImageFXPanel] canvas context unavailable");
    this.previewCtx = ctx;
    this.previewCanvas.className = "pn-imgfx-preview";
    this.previewCanvas.title = "Click to flood-fill remove from this pixel";

    this.overlay = this.buildOverlay();
  }

  open(): void {
    document.body.appendChild(this.overlay);
    requestAnimationFrame(() => this.renderPreview());
  }

  close(): void {
    this.overlay.remove();
  }

  // ── DOM construction ──────────────────────────────────────────────

  private buildOverlay(): HTMLDivElement {
    const overlay = document.createElement("div");
    overlay.className = "pn-imgfx-overlay";
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.close();
    });

    const modal = document.createElement("div");
    modal.className = "pn-imgfx-modal";
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
    title.textContent = "imageFX";

    const closeBtn = document.createElement("button");
    closeBtn.className = "pn-imgfx-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());

    header.append(title, closeBtn);
    return header;
  }

  private buildContent(): HTMLDivElement {
    const content = document.createElement("div");
    content.className = "pn-imgfx-content";
    content.appendChild(this.buildPreviewCol());
    content.appendChild(this.buildControlsCol());
    return content;
  }

  private buildPreviewCol(): HTMLDivElement {
    const col = document.createElement("div");
    col.className = "pn-imgfx-preview-col";

    const label = document.createElement("div");
    label.className = "pn-imgfx-preview-label";
    label.textContent = "preview  ·  click to flood-fill  ·  scroll or middle-drag to pan";

    const wrap = document.createElement("div");
    wrap.className = "pn-imgfx-preview-wrap";
    wrap.appendChild(this.previewCanvas);

    // ── Zoom controls ──────────────────────────────────────────────
    const zoomRow = document.createElement("div");
    zoomRow.className = "pn-imgfx-zoom-row";

    const zoomOut = document.createElement("button");
    zoomOut.className = "pn-imgfx-btn pn-imgfx-zoom-btn";
    zoomOut.textContent = "−";
    zoomOut.title = "Zoom out";
    zoomOut.addEventListener("click", () => this.stepZoom(-1));

    this.zoomReadout = document.createElement("span");
    this.zoomReadout.className = "pn-imgfx-zoom-readout";
    this.zoomReadout.textContent = "1×";

    const zoomIn = document.createElement("button");
    zoomIn.className = "pn-imgfx-btn pn-imgfx-zoom-btn";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom in";
    zoomIn.addEventListener("click", () => this.stepZoom(1));

    const fitBtn = document.createElement("button");
    fitBtn.className = "pn-imgfx-btn pn-imgfx-zoom-btn";
    fitBtn.textContent = "fit";
    fitBtn.title = "Reset zoom to 1×";
    fitBtn.addEventListener("click", () => { this.zoom = 1; this.panX = 0; this.panY = 0; this.updateZoomReadout(); this.renderPreview(); });

    zoomRow.append(zoomOut, this.zoomReadout, zoomIn, fitBtn);

    this.bgStatusEl = document.createElement("div");
    this.bgStatusEl.className = "pn-imgfx-bg-status";
    this.updateBgStatus();

    // ── Canvas events ──────────────────────────────────────────────
    this.previewCanvas.addEventListener("click",     (e) => this.handlePreviewClick(e));
    this.previewCanvas.addEventListener("wheel",     (e) => this.handleWheel(e), { passive: false });
    this.previewCanvas.addEventListener("mousedown", (e) => this.handleMouseDown(e));

    col.append(label, wrap, zoomRow, this.bgStatusEl);
    return col;
  }

  private buildControlsCol(): HTMLDivElement {
    const col = document.createElement("div");
    col.className = "pn-imgfx-controls-col";

    // ── Color adjustments section ──────────────────────────────────
    const colorSection = document.createElement("div");
    const colorTitle = document.createElement("div");
    colorTitle.className = "pn-imgfx-section-title";
    colorTitle.textContent = "Color Adjustments";
    colorSection.appendChild(colorTitle);

    type WorkKey = "hue" | "saturation" | "brightness" | "contrast" | "blur" | "invert";
    const params: Array<{ key: WorkKey; label: string; min: number; max: number; step: number }> = [
      { key: "hue",        label: "hue",      min: -180, max: 180, step: 1    },
      { key: "saturation", label: "sat",      min: 0,    max: 3,   step: 0.01 },
      { key: "brightness", label: "bright",   min: 0,    max: 3,   step: 0.01 },
      { key: "contrast",   label: "contrast", min: 0,    max: 3,   step: 0.01 },
      { key: "blur",       label: "blur",     min: 0,    max: 20,  step: 0.5  },
      { key: "invert",     label: "invert",   min: 0,    max: 1,   step: 0.01 },
    ];

    for (const p of params) {
      const key = p.key;
      colorSection.appendChild(this.buildSliderRow(p.label, p.min, p.max, p.step, this.work[key], (v) => {
        this.work[key] = v;
        // Changing a filter invalidates any baked BG data
        if (this.workingBgData) {
          this.workingBgData = null;
          this.updateBgStatus();
        }
        this.renderPreview();
      }));
    }

    // ── Background removal section ─────────────────────────────────
    const bgSection = document.createElement("div");
    const bgTitle = document.createElement("div");
    bgTitle.className = "pn-imgfx-section-title";
    bgTitle.textContent = "Background Removal";
    bgSection.appendChild(bgTitle);

    const hintEl = document.createElement("div");
    hintEl.className = "pn-imgfx-swatch-hint";
    hintEl.style.marginBottom = "6px";
    hintEl.textContent = "Auto: removes pixels connected to the image edges. Click: flood-fills from a clicked pixel.";
    bgSection.appendChild(hintEl);

    // Tolerance row
    const tolRow = document.createElement("div");
    tolRow.className = "pn-imgfx-row";
    const tolLabel = document.createElement("span");
    tolLabel.className = "pn-imgfx-label";
    tolLabel.textContent = "tolerance";
    const tolSlider = document.createElement("input");
    tolSlider.type = "range";
    tolSlider.className = "pn-imgfx-slider";
    tolSlider.min   = "0";
    tolSlider.max   = "120";
    tolSlider.step  = "1";
    tolSlider.value = String(this.bgTolerance);
    this.tolReadout = document.createElement("span");
    this.tolReadout.className = "pn-imgfx-readout";
    this.tolReadout.textContent = String(this.bgTolerance);

    tolSlider.addEventListener("input", () => {
      this.bgTolerance = parseInt(tolSlider.value, 10);
      this.tolReadout.textContent = String(this.bgTolerance);
    });
    tolRow.append(tolLabel, tolSlider, this.tolReadout);
    bgSection.appendChild(tolRow);

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.className = "pn-imgfx-btn-row";

    const autoBtn = document.createElement("button");
    autoBtn.className = "pn-imgfx-btn";
    autoBtn.textContent = "Auto (edges)";
    autoBtn.title = "Flood-fill remove all regions connected to the image border";
    autoBtn.addEventListener("click", () => this.applyEdgeFill());

    this.clickModeBtn = document.createElement("button");
    this.clickModeBtn.className = "pn-imgfx-btn";
    this.clickModeBtn.textContent = "Click remove";
    this.clickModeBtn.title = "Toggle: click on preview to flood-fill from that pixel";
    this.clickModeBtn.addEventListener("click", () => {
      this.clickRemoveMode = !this.clickRemoveMode;
      this.updateBgStatus();
    });

    const clearBgBtn = document.createElement("button");
    clearBgBtn.className = "pn-imgfx-btn";
    clearBgBtn.textContent = "Clear BG";
    clearBgBtn.addEventListener("click", () => {
      this.workingBgData = null;
      this.clickRemoveMode = false;
      this.renderPreview();
      this.updateBgStatus();
    });

    btnRow.append(autoBtn, this.clickModeBtn, clearBgBtn);
    bgSection.appendChild(btnRow);

    col.append(colorSection, bgSection);
    return col;
  }

  private buildSliderRow(
    label: string,
    min: number, max: number, step: number,
    value: number,
    onChange: (v: number) => void,
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "pn-imgfx-row";

    const lbl = document.createElement("span");
    lbl.className = "pn-imgfx-label";
    lbl.textContent = label;

    const slider = document.createElement("input");
    slider.type  = "range";
    slider.className = "pn-imgfx-slider";
    slider.min   = String(min);
    slider.max   = String(max);
    slider.step  = String(step);
    slider.value = String(value);

    const readout = document.createElement("span");
    readout.className = "pn-imgfx-readout";
    readout.textContent = this.fmt(value, step);

    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      readout.textContent = this.fmt(v, step);
      onChange(v);
    });

    row.append(lbl, slider, readout);
    return row;
  }

  private buildFooter(): HTMLDivElement {
    const footer = document.createElement("div");
    footer.className = "pn-imgfx-footer";

    const resetBtn = document.createElement("button");
    resetBtn.className = "pn-imgfx-btn";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => {
      this.work = { hue: 0, saturation: 1, brightness: 1, contrast: 1, blur: 0, invert: 0 };
      this.workingBgData = null;
      this.clickRemoveMode = false;
      // Rebuild — simplest way to reset all slider positions
      this.close();
      const fresh = new ImageFXPanel(this.fxNode, this.patchNode, this.graph);
      fresh.open();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "pn-imgfx-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this.close());

    const applyBtn = document.createElement("button");
    applyBtn.className = "pn-imgfx-btn pn-imgfx-btn--accent";
    applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", () => this.handleApply());

    footer.append(resetBtn, cancelBtn, applyBtn);
    return footer;
  }

  // ── Preview rendering ─────────────────────────────────────────────

  private renderPreview(): void {
    const img = this.fxNode.inputImage;
    if (!img) {
      this.previewCanvas.width  = 240;
      this.previewCanvas.height = 160;
      this.previewCtx.fillStyle = "#000";
      this.previewCtx.fillRect(0, 0, 240, 160);
      this.previewCtx.fillStyle = "#00ff00";
      this.previewCtx.font = "11px monospace";
      this.previewCtx.textAlign = "center";
      this.previewCtx.fillText("no image connected", 120, 85);
      return;
    }

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    this.previewCanvas.width  = w;
    this.previewCanvas.height = h;

    this.previewCtx.clearRect(0, 0, w, h);

    if (this.zoom === 1) {
      if (this.workingBgData && this.workingBgData.width === w && this.workingBgData.height === h) {
        this.previewCtx.putImageData(this.workingBgData, 0, 0);
      } else {
        this.previewCtx.filter = buildFilter(this.work);
        this.previewCtx.drawImage(img, 0, 0);
        this.previewCtx.filter = "none";
      }
    } else {
      // Zoomed: draw sub-region (panX,panY → panX+subW, panY+subH) scaled to fill canvas
      const subW = Math.max(1, Math.floor(w / this.zoom));
      const subH = Math.max(1, Math.floor(h / this.zoom));
      this.panX  = Math.max(0, Math.min(w - subW, Math.floor(this.panX)));
      this.panY  = Math.max(0, Math.min(h - subH, Math.floor(this.panY)));

      if (this.workingBgData && this.workingBgData.width === w && this.workingBgData.height === h) {
        // Extract sub-region of the BG-removed ImageData using a tmp canvas
        const tmp = document.createElement("canvas");
        tmp.width  = subW;
        tmp.height = subH;
        tmp.getContext("2d")!.putImageData(this.workingBgData, -this.panX, -this.panY);
        this.previewCtx.drawImage(tmp, 0, 0, subW, subH, 0, 0, w, h);
      } else {
        this.previewCtx.filter = buildFilter(this.work);
        this.previewCtx.drawImage(img, this.panX, this.panY, subW, subH, 0, 0, w, h);
        this.previewCtx.filter = "none";
      }
    }

    this.updatePreviewCursor();
  }

  // ── BG removal helpers ────────────────────────────────────────────

  /**
   * Render the filtered image into a fresh ImageData, then flood-fill from
   * all edge pixels. Stores result in workingBgData and re-renders preview.
   */
  private applyEdgeFill(): void {
    const img = this.fxNode.inputImage;
    if (!img) return;
    const data = this.getFilteredImageData(img);
    floodRemoveEdgeBg(data, this.bgTolerance);
    this.workingBgData = data;
    this.renderPreview();
    this.updateBgStatus();
  }

  /**
   * Flood-fill from a clicked pixel on the preview canvas.
   * If workingBgData already exists, fills on top of it (accumulates).
   * If not, first renders filtered snapshot into workingBgData then fills.
   */
  private floodFromClick(cx: number, cy: number): void {
    const img = this.fxNode.inputImage;
    if (!img) return;
    if (!this.workingBgData) {
      this.workingBgData = this.getFilteredImageData(img);
    }
    floodFillTransparent(this.workingBgData, cx, cy, this.bgTolerance);
    this.renderPreview();
    this.updateBgStatus();
  }

  /**
   * Draw the source image with current CSS filters into a temporary canvas
   * and return its ImageData. Used as the base for flood-fill operations.
   */
  private getFilteredImageData(img: HTMLImageElement): ImageData {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const tmp = document.createElement("canvas");
    tmp.width  = w;
    tmp.height = h;
    const tmpCtx = tmp.getContext("2d")!;
    tmpCtx.filter = buildFilter(this.work);
    tmpCtx.drawImage(img, 0, 0);
    tmpCtx.filter = "none";
    return tmpCtx.getImageData(0, 0, w, h);
  }

  // ── Interactions ──────────────────────────────────────────────────

  private handlePreviewClick(e: MouseEvent): void {
    if (!this.clickRemoveMode) return;

    const { cx, cy } = this.canvasToImageCoords(e);
    this.floodFromClick(cx, cy);
  }

  private handleWheel(e: WheelEvent): void {
    if (this.zoom === 1) return; // nothing to pan at 1×
    e.preventDefault();
    const img = this.fxNode.inputImage;
    if (!img) return;
    const subW = Math.floor(img.naturalWidth  / this.zoom);
    const subH = Math.floor(img.naturalHeight / this.zoom);
    this.panX = Math.max(0, Math.min(img.naturalWidth  - subW, this.panX + e.deltaX / this.zoom));
    this.panY = Math.max(0, Math.min(img.naturalHeight - subH, this.panY + e.deltaY / this.zoom));
    this.renderPreview();
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 1) return; // middle button only
    e.preventDefault();
    const rect   = this.previewCanvas.getBoundingClientRect();
    const scaleX = this.previewCanvas.width  / rect.width;
    const scaleY = this.previewCanvas.height / rect.height;

    this._panDrag = { active: true, sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY };
    this.previewCanvas.style.cursor = "grabbing";

    const onMove = (me: MouseEvent) => {
      if (!this._panDrag.active) return;
      const dx = (me.clientX - this._panDrag.sx) * scaleX;
      const dy = (me.clientY - this._panDrag.sy) * scaleY;
      this.panX = this._panDrag.px - dx / this.zoom;
      this.panY = this._panDrag.py - dy / this.zoom;
      this.renderPreview();
    };

    const onUp = () => {
      this._panDrag.active = false;
      this.updatePreviewCursor();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }

  /** Map a mouse event on the preview canvas to full-resolution image pixel coords. */
  private canvasToImageCoords(e: MouseEvent): { cx: number; cy: number } {
    const rect   = this.previewCanvas.getBoundingClientRect();
    const scaleX = this.previewCanvas.width  / rect.width;
    const scaleY = this.previewCanvas.height / rect.height;
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top)  * scaleY;
    return {
      cx: Math.floor(this.panX + canvasX / this.zoom),
      cy: Math.floor(this.panY + canvasY / this.zoom),
    };
  }

  private stepZoom(dir: 1 | -1): void {
    const img = this.fxNode.inputImage;
    const levels = [1, 2, 4, 8, 16];
    const idx    = levels.indexOf(this.zoom);
    const newIdx = Math.max(0, Math.min(levels.length - 1, idx + dir));
    this.zoom = levels[newIdx];
    if (this.zoom === 1) { this.panX = 0; this.panY = 0; }
    else if (img) {
      // Center pan when zooming in from fit
      const subW = img.naturalWidth  / this.zoom;
      const subH = img.naturalHeight / this.zoom;
      this.panX = (img.naturalWidth  - subW) / 2;
      this.panY = (img.naturalHeight - subH) / 2;
    }
    this.updateZoomReadout();
    this.renderPreview();
  }

  private updateZoomReadout(): void {
    if (this.zoomReadout) this.zoomReadout.textContent = `${this.zoom}×`;
  }

  private updatePreviewCursor(): void {
    if (this.clickRemoveMode) {
      this.previewCanvas.style.cursor = "crosshair";
    } else if (this.zoom > 1) {
      this.previewCanvas.style.cursor = "grab";
    } else {
      this.previewCanvas.style.cursor = "";
    }
  }

  private handleApply(): void {
    const pn = this.patchNode;
    pn.args[0] = String(this.work.hue);
    pn.args[1] = String(this.work.saturation);
    pn.args[2] = String(this.work.brightness);
    pn.args[3] = String(this.work.contrast);
    pn.args[4] = String(this.work.blur);
    pn.args[5] = String(this.work.invert);

    this.fxNode.setBgImageData(this.workingBgData ?? null);
    this.fxNode.hue        = this.work.hue;
    this.fxNode.saturation = this.work.saturation;
    this.fxNode.brightness = this.work.brightness;
    this.fxNode.contrast   = this.work.contrast;
    this.fxNode.blur       = this.work.blur;
    this.fxNode.invert     = this.work.invert;

    // Persist bg removal to a dedicated localStorage entry (synchronous — survives page unload)
    const oldRef = pn.args[6] ?? "";
    if (this.workingBgData) {
      // Re-use an existing stable key or create one
      const stableKey = oldRef.startsWith("bg:") ? oldRef.slice(3) : crypto.randomUUID();
      const dataUrl   = this.fxNode.getBgDataUrl();
      if (dataUrl) {
        try { localStorage.setItem(`patchnet-imgfx-bg-${stableKey}`, dataUrl); } catch (e) {
          console.warn("[imageFX] Could not save bg removal state:", e);
        }
      }
      pn.args[6] = `bg:${stableKey}`;
    } else {
      if (oldRef.startsWith("bg:")) {
        try { localStorage.removeItem(`patchnet-imgfx-bg-${oldRef.slice(3)}`); } catch {}
      }
      pn.args[6] = "";
    }

    this.graph.emit("change");
    this.close();
  }

  // ── UI helpers ────────────────────────────────────────────────────

  private updateBgStatus(): void {
    if (!this.bgStatusEl) return;
    if (this.workingBgData) {
      this.bgStatusEl.textContent = "● BG removal active";
    } else if (this.clickRemoveMode) {
      this.bgStatusEl.textContent = "◎ Click remove mode — click image to fill";
    } else {
      this.bgStatusEl.textContent = "";
    }

    if (this.clickModeBtn) {
      this.clickModeBtn.classList.toggle("pn-imgfx-btn--active", this.clickRemoveMode);
    }
    this.updatePreviewCursor();
  }

  private fmt(v: number, step: number): string {
    return step >= 1 ? String(Math.round(v)) : v.toFixed(2);
  }
}
