import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";
import type { ObjectInteractionController } from "../canvas/ObjectInteractionController";
import { OBJECT_DEFS, getVisibleArgs } from "../graph/objectDefs";
import { VisualizerRuntime } from "./VisualizerRuntime";
import { VisualizerNode } from "./VisualizerNode";
import { LayerNode } from "./LayerNode";
import { MediaVideoNode } from "./MediaVideoNode";
import { MediaImageNode } from "./MediaImageNode";
import { ImageFXNode } from "./ImageFXNode";
import { VfxCrtNode } from "./VfxCrtNode";
import { VfxBlurNode } from "./VfxBlurNode";
import { VideoStore } from "./VideoStore";
import { ImageStore } from "./ImageStore";
import { PatchVizNode } from "./PatchVizNode";
import { LocalBus } from "../control/ControlBus";
import { RenderDirector } from "../control/RenderDirector";

/**
 * VisualizerGraph — keeps the VisualizerRuntime in sync with PatchGraph.
 *
 * Responsibilities:
 *  - Creates / destroys VisualizerNode, LayerNode, MediaVideoNode, MediaImageNode
 *    as patchNet nodes are added or removed
 *  - Routes messages to the correct runtime node
 *  - Re-wires media → layer → visualizer on every graph change
 *  - Fires position-loop rAF for playing mediaVideo nodes (outlet 1)
 */
export class VisualizerGraph {
  private readonly runtime: VisualizerRuntime;

  // Phase 1 of the control/render split — see docs/CONTROL_RENDER_SPLIT.md.
  // Director + bus ride alongside the existing runtime for now; Phase 2 will
  // migrate the remaining deliver* routes off this class onto the director.
  readonly bus      = new LocalBus();
  readonly director: RenderDirector;

  private vizNodes        = new Map<string, VisualizerNode>();   // patchNodeId → VisualizerNode
  private layerNodes      = new Map<string, LayerNode>();         // patchNodeId → LayerNode
  private mediaVideoNodes = new Map<string, MediaVideoNode>();    // patchNodeId → MediaVideoNode
  private mediaImageNodes = new Map<string, MediaImageNode>();    // patchNodeId → MediaImageNode
  private imageFXNodes    = new Map<string, ImageFXNode>();       // patchNodeId → ImageFXNode
  private vfxCrtNodes     = new Map<string, VfxCrtNode>();        // patchNodeId → VfxCrtNode
  private vfxBlurNodes    = new Map<string, VfxBlurNode>();       // patchNodeId → VfxBlurNode
  private patchVizNodes   = new Map<string, PatchVizNode>();      // patchNodeId → PatchVizNode
  private videoIdbKeys    = new Map<string, string>();            // patchNodeId → idb key
  private imageIdbKeys    = new Map<string, string>();            // patchNodeId → idb key
  private imageFXBgKeys   = new Map<string, string>();            // patchNodeId → idb key

  /** rAF IDs for per-video position output loops */
  private positionLoops   = new Map<string, number>();            // patchNodeId → rafId

  private objectInteraction: ObjectInteractionController | null = null;
  private unsubscribe: () => void;

  constructor(private readonly graph: PatchGraph) {
    this.runtime     = VisualizerRuntime.getInstance();
    this.director    = new RenderDirector(graph, this.bus);
    this.unsubscribe = this.graph.on("change", () => this.sync());
    this.sync();
  }

  setObjectInteraction(oi: ObjectInteractionController): void {
    this.objectInteraction = oi;
  }

  // ── Message delivery ─────────────────────────────────────────────

  deliverMessage(nodeId: string, selector: string, args: string[]): void {
    const vn = this.vizNodes.get(nodeId);
    if (!vn) return;
    switch (selector) {
      case "bang": {
        const pnBang = this.graph.nodes.get(nodeId);
        if (vn.isOpen()) {
          vn.close();
          if (pnBang) { pnBang.args[2] = "0"; this.graph.emit("change"); }
        } else {
          this.openAndRestore(nodeId, vn);
          if (pnBang) { pnBang.args[2] = "1"; this.graph.emit("change"); }
        }
        break;
      }
      case "close": {
        vn.close();
        const pnClose = this.graph.nodes.get(nodeId);
        if (pnClose) { pnClose.args[2] = "0"; this.graph.emit("change"); }
        break;
      }
      case "size": {
        const w = parseFloat(args[0] ?? "640");
        const h = parseFloat(args[1] ?? "480");
        if (!isNaN(w) && !isNaN(h)) vn.resizeTo(w, h);
        break;
      }
      case "pos": {
        const x = parseFloat(args[0] ?? "0");
        const y = parseFloat(args[1] ?? "0");
        if (!isNaN(x) && !isNaN(y)) vn.moveTo(x, y);
        break;
      }
      case "float": {
        const enabled = (args[0] ?? "0") !== "0";
        vn.setFloat(enabled);
        const pn = this.graph.nodes.get(nodeId);
        if (pn) { pn.args[1] = enabled ? "1" : "0"; this.graph.emit("change"); }
        break;
      }
      case "open": {
        const pnOpen = this.graph.nodes.get(nodeId);
        if ((args[0] ?? "1") !== "0") {
          this.openAndRestore(nodeId, vn);
          if (pnOpen) { pnOpen.args[2] = "1"; this.graph.emit("change"); }
        } else {
          vn.close();
          if (pnOpen) { pnOpen.args[2] = "0"; this.graph.emit("change"); }
        }
        break;
      }
      case "fullscreen": {
        vn.fullscreen((args[0] ?? "1") !== "0");
        break;
      }
      case "screenX": {
        const pn = this.graph.nodes.get(nodeId);
        if (!pn) break;
        const x = parseFloat(args[0] ?? "0");
        const y = parseFloat(pn.args[4] ?? "0");
        if (!isNaN(x)) { vn.moveTo(x, isNaN(y) ? 0 : y); pn.args[3] = String(Math.round(x)); this.graph.emit("change"); }
        break;
      }
      case "screenY": {
        const pn = this.graph.nodes.get(nodeId);
        if (!pn) break;
        const x = parseFloat(pn.args[3] ?? "0");
        const y = parseFloat(args[0] ?? "0");
        if (!isNaN(y)) { vn.moveTo(isNaN(x) ? 0 : x, y); pn.args[4] = String(Math.round(y)); this.graph.emit("change"); }
        break;
      }
      case "winW": {
        const pn = this.graph.nodes.get(nodeId);
        if (!pn) break;
        const w = parseFloat(args[0] ?? "640");
        const h = parseFloat(pn.args[6] ?? "480");
        if (!isNaN(w)) { vn.resizeTo(w, isNaN(h) ? 480 : h); pn.args[5] = String(Math.round(w)); this.graph.emit("change"); }
        break;
      }
      case "winH": {
        const pn = this.graph.nodes.get(nodeId);
        if (!pn) break;
        const w = parseFloat(pn.args[5] ?? "640");
        const h = parseFloat(args[0] ?? "480");
        if (!isNaN(h)) { vn.resizeTo(isNaN(w) ? 640 : w, h); pn.args[6] = String(Math.round(h)); this.graph.emit("change"); }
        break;
      }
    }
  }

  deliverMediaMessage(nodeId: string, nodeType: "mediaVideo" | "mediaImage", selector: string, args: string[]): void {
    if (nodeType === "mediaVideo") {
      const mvn = this.mediaVideoNodes.get(nodeId);
      if (!mvn) return;
      switch (selector) {
        case "bang":   mvn.togglePlay(); break;
        case "play":   mvn.play();       break;
        case "stop":   mvn.stop();       break;
        case "seek":   mvn.seek(parseFloat(args[0] ?? "0")); break;
        case "loop":   mvn.setLoop(args[0] !== "0"); break;
        case "mute":   mvn.mute();       break;
        case "unmute": mvn.unmute();     break;
        case "open": break; // handled by VisualizerObjectUI
      }
      // play / pause / stop / toggle update args[2] via MediaVideoNode media events
    }
    // mediaImage: bang/open handled by UI layer — no runtime action needed
  }

  /** Called by VisualizerObjectUI after the user picks a file. */
  loadFileForNode(nodeId: string, nodeType: "mediaVideo" | "mediaImage", file: File): void {
    const patchNode = this.graph.nodes.get(nodeId);
    if (!patchNode) return;

    if (nodeType === "mediaVideo") {
      const mvn = this.mediaVideoNodes.get(nodeId);
      if (!mvn) return;
      mvn.loadFile(file);
      // Auto-play when data is ready; muted = true lets this always succeed
      mvn.video.addEventListener("canplay", () => mvn.play(), { once: true });
      // Store binary in IndexedDB; keep only a tiny reference key in args
      file.arrayBuffer().then(buf => VideoStore.save(nodeId, buf)).catch(console.warn);
      patchNode.args[0] = `idb:${nodeId}`;
      patchNode.args[1] = file.name;
      patchNode.args[2] = "stop"; // onPlay will update this to "play" once it actually starts
      this.videoIdbKeys.set(nodeId, nodeId);
      this.graph.emit("change");
    } else {
      const min = this.mediaImageNodes.get(nodeId);
      if (!min) return;
      const mimeType = file.type || "image/png";
      file.arrayBuffer().then(async (buf) => {
        await ImageStore.save(nodeId, buf, mimeType);
        await min.loadBlob(buf, mimeType);
        patchNode.args[0] = `idb:${nodeId}`;
        patchNode.args[1] = file.name;
        patchNode.args[2] = mimeType;
        patchNode.displayUrl = min.url ?? "";
        this.imageIdbKeys.set(nodeId, nodeId);
        this.graph.emit("change");
        this.rewireMedia();
      }).catch(console.warn);
    }
  }

  // ── Sync ─────────────────────────────────────────────────────────

  private sync(): void {
    const activeIds = new Set(this.graph.getNodes().map(n => n.id));

    // ── Teardown removed nodes ──────────────────────────────────────
    for (const [id, vn] of this.vizNodes) {
      if (!activeIds.has(id)) {
        this.runtime.unregister(vn.name);
        this.director.detach(id);
        vn.destroy();
        this.vizNodes.delete(id);
      }
    }
    for (const id of this.layerNodes.keys()) {
      if (!activeIds.has(id)) this.layerNodes.delete(id);
    }
    for (const [id, mvn] of this.mediaVideoNodes) {
      if (!activeIds.has(id)) {
        this.stopPositionLoop(id);
        mvn.destroy();
        this.mediaVideoNodes.delete(id);
        const idbKey = this.videoIdbKeys.get(id);
        if (idbKey) { VideoStore.remove(idbKey).catch(() => {}); this.videoIdbKeys.delete(id); }
      }
    }
    for (const [id, min] of this.mediaImageNodes) {
      if (!activeIds.has(id)) {
        min.destroy();
        this.mediaImageNodes.delete(id);
        const idbKey = this.imageIdbKeys.get(id);
        if (idbKey) { ImageStore.remove(idbKey).catch(() => {}); this.imageIdbKeys.delete(id); }
      }
    }
    for (const [id, fx] of this.imageFXNodes) {
      if (!activeIds.has(id)) {
        fx.destroy();
        this.imageFXNodes.delete(id);
        const bgKey = this.imageFXBgKeys.get(id);
        if (bgKey) {
          try { localStorage.removeItem(`patchnet-imgfx-bg-${bgKey}`); } catch {}
          this.imageFXBgKeys.delete(id);
        }
      }
    }
    for (const [id, vfx] of this.vfxCrtNodes) {
      if (!activeIds.has(id)) { vfx.destroy(); this.vfxCrtNodes.delete(id); }
    }
    for (const [id, vfx] of this.vfxBlurNodes) {
      if (!activeIds.has(id)) { vfx.destroy(); this.vfxBlurNodes.delete(id); }
    }
    for (const [id, pvn] of this.patchVizNodes) {
      if (!activeIds.has(id)) {
        this.runtime.unregister(pvn.contextName);
        this.director.detach(id);
        pvn.destroy();
        this.patchVizNodes.delete(id);
      }
    }

    // ── Create new nodes ────────────────────────────────────────────
    for (const node of this.graph.getNodes()) {
      if (node.type === "visualizer" && !this.vizNodes.has(node.id)) {
        const contextName = node.args[0] ?? "world1";
        const vn = new VisualizerNode(contextName);
        vn.onOpen  = () => this.fireOutlet(node.id, 0);
        vn.onClose = () => {
          this.fireOutlet(node.id, 1);
          const pn = this.graph.nodes.get(node.id);
          if (pn) { pn.args[2] = "0"; this.graph.emit("change"); }
        };
        vn.onResize = (w, h) => {
          const pn = this.graph.nodes.get(node.id);
          if (!pn) return;
          pn.args[5] = String(w);
          pn.args[6] = String(h);
          this.notifyAttributeSliders(node.id, "winW", String(w));
          this.notifyAttributeSliders(node.id, "winH", String(h));
          this.graph.emit("change");
        };
        vn.onMove = (x, y) => {
          const pn = this.graph.nodes.get(node.id);
          if (!pn) return;
          pn.args[3] = String(x);
          pn.args[4] = String(y);
          this.notifyAttributeSliders(node.id, "screenX", String(x));
          this.notifyAttributeSliders(node.id, "screenY", String(y));
          this.graph.emit("change");
        };
        vn.setFloat((node.args[1] ?? "0") !== "0");
        this.vizNodes.set(node.id, vn);
        this.runtime.register(contextName, vn);
        this.director.attach(node.id, vn);

        // Restore open state — defer one tick so the page is interactive
        if ((node.args[2] ?? "0") === "1") {
          setTimeout(() => this.openAndRestore(node.id, vn), 150);
        }
      }

      if (node.type === "layer" && !this.layerNodes.has(node.id)) {
        const priority = parseInt(node.args[1] ?? "0", 10);
        const scaleX   = parseFloat(node.args[2] ?? "1");
        const scaleY   = parseFloat(node.args[3] ?? "1");
        const posX     = parseFloat(node.args[4] ?? "0");
        const posY     = parseFloat(node.args[5] ?? "0");
        this.layerNodes.set(node.id, new LayerNode(
          node.id,
          isNaN(priority) ? 0  : priority,
          isNaN(scaleX)   ? 1  : scaleX,
          isNaN(scaleY)   ? 1  : scaleY,
          isNaN(posX)     ? 0  : posX,
          isNaN(posY)     ? 0  : posY,
        ));
      }

      if (node.type === "mediaVideo" && !this.mediaVideoNodes.has(node.id)) {
        const mvn = new MediaVideoNode();
        if (node.args[2] === undefined || node.args[2] === "") {
          node.args[2] = "stop";
        }
        mvn.onPlay = () => {
          this.setMediaVideoTransportArg(node.id);
          this.startPositionLoop(node.id);
        };
        mvn.onPause = () => {
          this.setMediaVideoTransportArg(node.id);
          this.stopPositionLoop(node.id);
        };
        mvn.onEnded = () => {
          this.setMediaVideoTransportArg(node.id);
          this.stopPositionLoop(node.id);
        };
        this.mediaVideoNodes.set(node.id, mvn);

        const ref = node.args[0] ?? "";
        if (ref.startsWith("idb:")) {
          const key = ref.slice(4);
          this.videoIdbKeys.set(node.id, key);
          VideoStore.load(key).then(buf => {
            if (!buf) return;
            mvn.loadBlob(buf);
            // After async load, re-apply transport so "play" state is restored
            mvn.video.addEventListener("canplay", () => {
              const pn = this.graph.nodes.get(node.id);
              if (pn) this.applyMediaVideoTransportFromArgs(node.id, mvn, pn);
            }, { once: true });
          }).catch(console.warn);
        } else if (ref) {
          mvn.loadUrl(ref);
        }
      }

      if (node.type === "mediaImage" && !this.mediaImageNodes.has(node.id)) {
        const min = new MediaImageNode();
        this.mediaImageNodes.set(node.id, min);
        const ref = node.args[0] ?? "";
        if (ref.startsWith("idb:")) {
          const key = ref.slice(4);
          this.imageIdbKeys.set(node.id, key);
          ImageStore.load(key).then((stored) => {
            if (!stored) return;
            return min.loadBlob(stored.data, stored.mimeType).then(() => {
              const pn = this.graph.nodes.get(node.id);
              if (pn) pn.displayUrl = min.url ?? "";
              this.graph.emit("change");
              this.rewireMedia();
            });
          }).catch(console.warn);
        } else if (ref.startsWith("data:")) {
          // Legacy patches stored the full data URL inline. Migrate to IDB.
          this.migrateLegacyImageDataUrl(node.id, ref, node.args[1] ?? "")
            .then(() => this.rewireMedia())
            .catch(console.warn);
          min.loadUrl(ref);
          min.image.addEventListener("load", () => {
            const pn = this.graph.nodes.get(node.id);
            if (pn) pn.displayUrl = ref;
            this.graph.emit("change");
            this.rewireMedia();
          }, { once: true });
        } else if (ref) {
          min.loadUrl(ref);
          min.image.addEventListener("load", () => {
            const pn = this.graph.nodes.get(node.id);
            if (pn) pn.displayUrl = min.url ?? ref;
            this.graph.emit("change");
            this.rewireMedia();
          }, { once: true });
        }
      }

      if (node.type === "imageFX" && !this.imageFXNodes.has(node.id)) {
        const fx = new ImageFXNode();
        this.syncFXParams(fx, node);
        this.imageFXNodes.set(node.id, fx);

        const bgRef = node.args[6] ?? "";
        if (bgRef.startsWith("bg:")) {
          const stableKey = bgRef.slice(3);
          this.imageFXBgKeys.set(node.id, stableKey);
          try {
            const dataUrl = localStorage.getItem(`patchnet-imgfx-bg-${stableKey}`);
            if (dataUrl) fx.setBgFromDataUrl(dataUrl).catch(console.warn);
          } catch {}
        }
      }

      if (node.type === "vfxCRT" && !this.vfxCrtNodes.has(node.id)) {
        const vfx = new VfxCrtNode();
        this.syncVfxCrtParams(vfx, node);
        this.vfxCrtNodes.set(node.id, vfx);
      }

      if (node.type === "vfxBlur" && !this.vfxBlurNodes.has(node.id)) {
        const vfx = new VfxBlurNode();
        this.syncVfxBlurParams(vfx, node);
        this.vfxBlurNodes.set(node.id, vfx);
      }

      if (node.type === "patchViz" && !this.patchVizNodes.has(node.id)) {
        const contextName = node.args[0] ?? "world1";
        const pvn = new PatchVizNode(contextName);
        if ((node.args[1] ?? "1") === "0") pvn.disable();
        this.patchVizNodes.set(node.id, pvn);
        this.runtime.register(contextName, pvn);
        this.director.attach(node.id, pvn);
      }
    }

    // ── Update patchViz context name and enabled state in case args changed ──
    for (const [id, pvn] of this.patchVizNodes) {
      const pn = this.graph.nodes.get(id);
      if (!pn) continue;
      const newName = pn.args[0] ?? "world1";
      if (pvn.contextName !== newName) {
        this.runtime.unregister(pvn.contextName);
        pvn.contextName = newName;
        this.runtime.register(newName, pvn);
      }
      const shouldBeEnabled = (pn.args[1] ?? "1") !== "0";
      if (pvn.enabled !== shouldBeEnabled) {
        shouldBeEnabled ? pvn.enable() : pvn.disable();
      }
    }

    // ── Update mutable state on existing nodes ──────────────────────
    // Sync imageFX params from args (attribute panel / message may have changed them)
    for (const [id, fx] of this.imageFXNodes) {
      const pn = this.graph.nodes.get(id);
      if (pn) { this.syncFXParams(fx, pn); fx.process(); }
    }
    // Sync vfxCRT/vfxBlur params from args
    for (const [id, vfx] of this.vfxCrtNodes) {
      const pn = this.graph.nodes.get(id);
      if (pn) this.syncVfxCrtParams(vfx, pn);
    }
    for (const [id, vfx] of this.vfxBlurNodes) {
      const pn = this.graph.nodes.get(id);
      if (pn) this.syncVfxBlurParams(vfx, pn);
    }

    // Sync visualizer float arg in case it changed
    for (const [id, vn] of this.vizNodes) {
      const pn = this.graph.nodes.get(id);
      if (!pn) continue;
      const shouldFloat = (pn.args[1] ?? "0") !== "0";
      if (vn.floating !== shouldFloat) vn.setFloat(shouldFloat);
    }

    // Sync layer priority/scale/position in case args changed
    for (const [id, layer] of this.layerNodes) {
      const pn = this.graph.nodes.get(id);
      if (!pn) continue;
      const priority = parseInt(pn.args[1] ?? "0", 10);
      const scaleX   = parseFloat(pn.args[2] ?? "1");
      const scaleY   = parseFloat(pn.args[3] ?? "1");
      const posX     = parseFloat(pn.args[4] ?? "0");
      const posY     = parseFloat(pn.args[5] ?? "0");
      layer.priority = isNaN(priority) ? 0  : priority;
      layer.scaleX   = isNaN(scaleX)   ? 1  : scaleX;
      layer.scaleY   = isNaN(scaleY)   ? 1  : scaleY;
      layer.posX     = isNaN(posX)     ? 0  : posX;
      layer.posY     = isNaN(posY)     ? 0  : posY;
    }

    // Apply mediaVideo transport from patch args (text / attribute edits)
    for (const [id, mvn] of this.mediaVideoNodes) {
      const pn = this.graph.nodes.get(id);
      if (pn) this.applyMediaVideoTransportFromArgs(id, mvn, pn);
    }

    // ── Re-wire media → layer → visualizer ─────────────────────────
    this.rewireMedia();
  }

  private rewireMedia(): void {
    // Detach every layer from every render context (popup and inline)
    for (const vn of this.vizNodes.values()) vn.clearLayers();
    for (const pvn of this.patchVizNodes.values()) pvn.clearLayers();

    // ── Wire imageFX inputs from upstream mediaImage ────────────────
    for (const [patchId, fx] of this.imageFXNodes) {
      fx.setInput(null);
      for (const edge of this.graph.getEdges()) {
        if (edge.toNodeId !== patchId) continue;
        const fromNode = this.graph.nodes.get(edge.fromNodeId);
        if (fromNode?.type === "mediaImage") {
          const min = this.mediaImageNodes.get(edge.fromNodeId);
          if (min) { fx.setInput(min); break; }
        }
      }
      fx.process();
    }

    // ── Wire vfxCRT inputs from upstream mediaVideo or vFX chain ────
    for (const [patchId, vfx] of this.vfxCrtNodes) {
      vfx.setInput(null);
      vfx.setVfxInput(null);
      for (const edge of this.graph.getEdges()) {
        if (edge.toNodeId !== patchId) continue;
        const fromNode = this.graph.nodes.get(edge.fromNodeId);
        if (!fromNode) continue;
        if (fromNode.type === "mediaVideo") {
          const mvn = this.mediaVideoNodes.get(edge.fromNodeId);
          if (mvn) { vfx.setInput(mvn.video); break; }
        } else if (fromNode.type === "vfxCRT") {
          const up = this.vfxCrtNodes.get(edge.fromNodeId);
          if (up) { vfx.setVfxInput(up); break; }
        } else if (fromNode.type === "vfxBlur") {
          const up = this.vfxBlurNodes.get(edge.fromNodeId);
          if (up) { vfx.setVfxInput(up); break; }
        }
      }
    }

    // ── Wire vfxBlur inputs from upstream mediaVideo or vFX chain ───
    for (const [patchId, vfx] of this.vfxBlurNodes) {
      vfx.setInput(null);
      vfx.setVfxInput(null);
      for (const edge of this.graph.getEdges()) {
        if (edge.toNodeId !== patchId) continue;
        const fromNode = this.graph.nodes.get(edge.fromNodeId);
        if (!fromNode) continue;
        if (fromNode.type === "mediaVideo") {
          const mvn = this.mediaVideoNodes.get(edge.fromNodeId);
          if (mvn) { vfx.setInput(mvn.video); break; }
        } else if (fromNode.type === "vfxCRT") {
          const up = this.vfxCrtNodes.get(edge.fromNodeId);
          if (up) { vfx.setVfxInput(up); break; }
        } else if (fromNode.type === "vfxBlur") {
          const up = this.vfxBlurNodes.get(edge.fromNodeId);
          if (up) { vfx.setVfxInput(up); break; }
        }
      }
    }

    // ── Wire layers from upstream media (video / vfx / imageFX / image) ──
    for (const [patchId, layer] of this.layerNodes) {
      const patchNode = this.graph.nodes.get(patchId);
      if (!patchNode) continue;

      layer.clearMedia();

      for (const edge of this.graph.getEdges()) {
        if (edge.toNodeId !== patchId) continue;
        const fromNode = this.graph.nodes.get(edge.fromNodeId);
        if (!fromNode) continue;
        if (fromNode.type === "mediaVideo") {
          const mvn = this.mediaVideoNodes.get(edge.fromNodeId);
          if (mvn) layer.setMediaVideo(mvn);
        } else if (fromNode.type === "vfxCRT") {
          const vfx = this.vfxCrtNodes.get(edge.fromNodeId);
          if (vfx) layer.setVideoFX(vfx);
        } else if (fromNode.type === "vfxBlur") {
          const vfx = this.vfxBlurNodes.get(edge.fromNodeId);
          if (vfx) layer.setVideoFX(vfx);
        } else if (fromNode.type === "imageFX") {
          const fxn = this.imageFXNodes.get(edge.fromNodeId);
          if (fxn) layer.setMediaFX(fxn);
        } else if (fromNode.type === "mediaImage") {
          const min = this.mediaImageNodes.get(edge.fromNodeId);
          if (min) layer.setMediaImage(min);
        }
      }

      // Register layer with every render context sharing this name
      const contextName = patchNode.args[0] ?? "world1";
      let layerAdded = false;
      for (const vn of this.vizNodes.values()) {
        if (vn.name === contextName) { vn.addLayer(layer); layerAdded = true; }
      }
      for (const pvn of this.patchVizNodes.values()) {
        if (pvn.contextName === contextName) { pvn.addLayer(layer); layerAdded = true; }
      }
      if (!layerAdded) {
        const fallback = this.runtime.getFirst();
        if (fallback) fallback.addLayer(layer);
      }
    }
  }

  deliverPatchVizMessage(nodeId: string, selector: string, _args: string[]): void {
    const pvn = this.patchVizNodes.get(nodeId);
    const pn  = this.graph.nodes.get(nodeId);
    if (!pvn) return;
    // Phase 1 proof path: renderer touch goes through director → bus → renderer.apply.
    // Args mirroring stays controller-side here; Phase 2 moves it to a Status subscriber.
    switch (selector) {
      case "bang":
        this.director.trigger(nodeId, "bang");
        if (pn) { pn.args[1] = pvn.enabled ? "1" : "0"; this.graph.emit("change"); }
        break;
      case "enable":
        this.director.command(nodeId, "enable");
        if (pn) { pn.args[1] = "1"; this.graph.emit("change"); }
        break;
      case "disable":
        this.director.command(nodeId, "disable");
        if (pn) { pn.args[1] = "0"; this.graph.emit("change"); }
        break;
      default:
        this.runtime.register(pvn.contextName, pvn);
    }
  }

  deliverLayerMessage(nodeId: string, selector: string, args: string[]): void {
    const layer     = this.layerNodes.get(nodeId);
    const patchNode = this.graph.nodes.get(nodeId);
    if (!layer || !patchNode) return;

    const val = parseFloat(args[0] ?? "1");
    if (isNaN(val)) return;

    switch (selector) {
      case "scaleX":
        layer.scaleX = val;
        patchNode.args[2] = String(val);
        break;
      case "scaleY":
        layer.scaleY = val;
        patchNode.args[3] = String(val);
        break;
      case "scale":
        layer.scaleX = val;
        layer.scaleY = val;
        patchNode.args[2] = String(val);
        patchNode.args[3] = String(val);
        break;
      case "posX":
        layer.posX = val;
        patchNode.args[4] = String(val);
        break;
      case "posY":
        layer.posY = val;
        patchNode.args[5] = String(val);
        break;
      case "pos": {
        const val2 = parseFloat(args[1] ?? "0");
        layer.posX = val;
        layer.posY = isNaN(val2) ? val : val2;
        patchNode.args[4] = String(layer.posX);
        patchNode.args[5] = String(layer.posY);
        break;
      }
      default:
        return;
    }
    this.graph.emit("display");
  }

  deliverImageFXMessage(nodeId: string, selector: string, args: string[]): void {
    const fx = this.imageFXNodes.get(nodeId);
    const pn = this.graph.nodes.get(nodeId);
    if (!fx || !pn) return;

    const val = parseFloat(args[0] ?? "0");

    switch (selector) {
      case "hue":        fx.hue        = isNaN(val) ? 0   : val; pn.args[0] = String(fx.hue);        break;
      case "saturation": fx.saturation = isNaN(val) ? 1   : val; pn.args[1] = String(fx.saturation); break;
      case "brightness": fx.brightness = isNaN(val) ? 1   : val; pn.args[2] = String(fx.brightness); break;
      case "contrast":   fx.contrast   = isNaN(val) ? 1   : val; pn.args[3] = String(fx.contrast);   break;
      case "blur":       fx.blur       = isNaN(val) ? 0   : val; pn.args[4] = String(fx.blur);       break;
      case "invert":     fx.invert     = isNaN(val) ? 0   : val; pn.args[5] = String(fx.invert);     break;
      case "removeBg":   /* BG removal requires interactive flood-fill — use the panel */ return;
      case "clearBg":    fx.clearBg(); return;
      default: return;
    }
    fx.process();
  }

  /** Exposes the runtime node to ImageFXPanel for live preview. */
  getImageFXNode(nodeId: string): ImageFXNode | undefined {
    return this.imageFXNodes.get(nodeId);
  }

  /**
   * Re-parent each PatchVizNode canvas into its DOM mount slot.
   * Call this after every render() pass (same pattern as CodeboxController).
   */
  mountPatchViz(panGroup: HTMLElement): void {
    for (const [id, pvn] of this.patchVizNodes) {
      const slot = panGroup.querySelector<HTMLElement>(
        `[data-patchviz-node-id="${id}"]`,
      );
      if (slot && pvn.canvas.parentElement !== slot) {
        slot.appendChild(pvn.canvas);
      }
    }
  }

  deliverVfxMessage(nodeId: string, nodeType: "vfxCRT" | "vfxBlur", selector: string, args: string[]): void {
    const pn  = this.graph.nodes.get(nodeId);
    if (!pn) return;
    const val = parseFloat(args[0] ?? "0");

    if (nodeType === "vfxCRT") {
      const vfx = this.vfxCrtNodes.get(nodeId);
      if (!vfx) return;
      switch (selector) {
        case "scanlines":  vfx.scanlines  = isNaN(val) ? 0.35 : val; pn.args[0] = String(vfx.scanlines);  break;
        case "vignette":   vfx.vignette   = isNaN(val) ? 0.45 : val; pn.args[1] = String(vfx.vignette);   break;
        case "rgbShift":   vfx.rgbShift   = isNaN(val) ? 1.5  : val; pn.args[2] = String(vfx.rgbShift);   break;
        case "curvature":  vfx.curvature  = isNaN(val) ? 0.15 : val; pn.args[3] = String(vfx.curvature);  break;
        case "brightness": vfx.brightness = isNaN(val) ? 1    : val; pn.args[4] = String(vfx.brightness); break;
        default: return;
      }
    } else {
      const vfx = this.vfxBlurNodes.get(nodeId);
      if (!vfx) return;
      switch (selector) {
        case "radius":     vfx.radius     = isNaN(val) ? 2 : val; pn.args[0] = String(vfx.radius);     break;
        case "saturation": vfx.saturation = isNaN(val) ? 1 : val; pn.args[1] = String(vfx.saturation); break;
        case "brightness": vfx.brightness = isNaN(val) ? 1 : val; pn.args[2] = String(vfx.brightness); break;
        default: return;
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private syncFXParams(fx: ImageFXNode, pn: { args: string[] }): void {
    const f = (v: string | undefined, def: number) => { const n = parseFloat(v ?? ""); return isNaN(n) ? def : n; };
    fx.hue        = f(pn.args[0], 0);
    fx.saturation = f(pn.args[1], 1);
    fx.brightness = f(pn.args[2], 1);
    fx.contrast   = f(pn.args[3], 1);
    fx.blur       = f(pn.args[4], 0);
    fx.invert     = f(pn.args[5], 0);
  }

  private syncVfxCrtParams(vfx: VfxCrtNode, pn: { args: string[] }): void {
    const f = (v: string | undefined, def: number) => { const n = parseFloat(v ?? ""); return isNaN(n) ? def : n; };
    vfx.scanlines  = f(pn.args[0], 0.35);
    vfx.vignette   = f(pn.args[1], 0.45);
    vfx.rgbShift   = f(pn.args[2], 1.5);
    vfx.curvature  = f(pn.args[3], 0.15);
    vfx.brightness = f(pn.args[4], 1.0);
  }

  private async migrateLegacyImageDataUrl(nodeId: string, dataUrl: string, filename: string): Promise<void> {
    const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
    const mimeType = match?.[1] ?? "image/png";
    const res = await fetch(dataUrl);
    const buf = await res.arrayBuffer();
    await ImageStore.save(nodeId, buf, mimeType);
    const pn = this.graph.nodes.get(nodeId);
    if (!pn) return;
    pn.args[0] = `idb:${nodeId}`;
    pn.args[1] = filename || pn.args[1] || "";
    pn.args[2] = mimeType;
    this.imageIdbKeys.set(nodeId, nodeId);
    this.graph.emit("change");
  }

  private syncVfxBlurParams(vfx: VfxBlurNode, pn: { args: string[] }): void {
    const f = (v: string | undefined, def: number) => { const n = parseFloat(v ?? ""); return isNaN(n) ? def : n; };
    vfx.radius     = f(pn.args[0], 2);
    vfx.saturation = f(pn.args[1], 1);
    vfx.brightness = f(pn.args[2], 1);
  }

  /** Maps HTMLVideoElement state to the `transport` arg (text panel / attr). */
  private computeMediaVideoTransport(mvn: MediaVideoNode): "play" | "pause" | "stop" {
    const v = mvn.video;
    if (!v.paused) return "play";
    if (v.currentTime <= 0.02) return "stop";
    return "pause";
  }

  private setMediaVideoTransportArg(patchNodeId: string): void {
    const mvn = this.mediaVideoNodes.get(patchNodeId);
    const pn  = this.graph.nodes.get(patchNodeId);
    if (!mvn || !pn) return;
    const next = this.computeMediaVideoTransport(mvn);
    if (pn.args[2] === next) return;
    pn.args[2] = next;
    this.graph.emit("change");
  }

  private applyMediaVideoTransportFromArgs(
    _patchNodeId: string,
    mvn: MediaVideoNode,
    pn: PatchNode,
  ): void {
    let desired = (pn.args[2] ?? "stop").toLowerCase();
    if (desired !== "play" && desired !== "pause" && desired !== "stop") {
      desired = "stop";
    }
    const cur = this.computeMediaVideoTransport(mvn);
    if (desired === cur) return;
    if (desired === "play") mvn.play();
    else if (desired === "stop") mvn.stop();
    else mvn.pause();
  }

  // ── Position loop (mediaVideo outlet 1) ──────────────────────────

  private startPositionLoop(patchNodeId: string): void {
    if (this.positionLoops.has(patchNodeId)) return;
    const tick = () => {
      const mvn = this.mediaVideoNodes.get(patchNodeId);
      if (!mvn || mvn.video.paused || mvn.video.ended) {
        this.positionLoops.delete(patchNodeId);
        return;
      }
      this.fireFloatOutlet(patchNodeId, 1, mvn.position);
      this.positionLoops.set(patchNodeId, requestAnimationFrame(tick));
    };
    this.positionLoops.set(patchNodeId, requestAnimationFrame(tick));
  }

  private stopPositionLoop(patchNodeId: string): void {
    const id = this.positionLoops.get(patchNodeId);
    if (id !== undefined) cancelAnimationFrame(id);
    this.positionLoops.delete(patchNodeId);
  }

  // ── Outlet helpers ────────────────────────────────────────────────

  private fireOutlet(patchNodeId: string, outletIndex: number): void {
    if (!this.objectInteraction) return;
    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId !== patchNodeId || edge.fromOutlet !== outletIndex) continue;
      const target = this.graph.nodes.get(edge.toNodeId);
      if (target) this.objectInteraction.deliverBang(target, edge.toInlet);
    }
  }

  private fireFloatOutlet(patchNodeId: string, outletIndex: number, value: number): void {
    if (!this.objectInteraction) return;
    const str = value.toFixed(4);
    for (const edge of this.graph.getEdges()) {
      if (edge.fromNodeId !== patchNodeId || edge.fromOutlet !== outletIndex) continue;
      const target = this.graph.nodes.get(edge.toNodeId);
      if (target) this.objectInteraction.deliverMessageValue(target, edge.toInlet, str);
    }
  }

  // ── Open helpers ─────────────────────────────────────────────────

  private openAndRestore(nodeId: string, vn: VisualizerNode): void {
    const pn = this.graph.nodes.get(nodeId);
    if (pn) {
      // Pre-set inner dimensions so window.open() features use the saved size.
      // This avoids calling resizeTo() after open, which takes outer dimensions
      // and causes a shrink-on-each-reopen feedback loop via the resize event.
      const sw = parseInt(pn.args[5] ?? "", 10);
      const sh = parseInt(pn.args[6] ?? "", 10);
      if (!isNaN(sw) && !isNaN(sh)) vn.setDimensions(sw, sh);
    }
    vn.open();
    if (pn) {
      const sx = parseInt(pn.args[3] ?? "", 10);
      const sy = parseInt(pn.args[4] ?? "", 10);
      if (!isNaN(sx) && !isNaN(sy)) vn.moveTo(sx, sy);
    }
  }

  // ── Attribute panel feedback ──────────────────────────────────────

  /**
   * Pushes a single arg update to the DOM of every attribute node
   * connected (outlet 0) to the given visualizer patch node.
   * Skips attribute nodes whose arg is already at the new value.
   */
  private notifyAttributeSliders(vizNodeId: string, argName: string, value: string): void {
    if (!this.objectInteraction) return;
    const def = OBJECT_DEFS["visualizer"];
    if (!def) return;
    const visible = getVisibleArgs(def);
    const argIdx = visible.findIndex(a => a.name === argName);
    if (argIdx < 0) return;

    for (const node of this.graph.getNodes()) {
      if (node.type !== "attribute" || node.args[0] !== "visualizer") continue;
      const connected = this.graph.getEdges().some(
        e => e.fromNodeId === node.id && e.fromOutlet === 0 && e.toNodeId === vizNodeId,
      );
      if (!connected) continue;
      if (node.args[argIdx + 1] === value) continue; // already up to date — skip feedback loop
      node.args[argIdx + 1] = value;
      this.objectInteraction.updateAttrSlider(node.id, argIdx, value);
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────

  destroy(): void {
    this.unsubscribe();
    this.director.destroy();
    this.bus.destroy();

    for (const id of this.positionLoops.keys()) this.stopPositionLoop(id);

    for (const mvn of this.mediaVideoNodes.values()) mvn.destroy();
    for (const min of this.mediaImageNodes.values()) min.destroy();
    for (const fx  of this.imageFXNodes.values())    fx.destroy();
    for (const vfx of this.vfxCrtNodes.values())     vfx.destroy();
    for (const vfx of this.vfxBlurNodes.values())    vfx.destroy();

    for (const vn of this.vizNodes.values()) {
      this.runtime.unregister(vn.name);
      vn.destroy();
    }

    this.vizNodes.clear();
    this.layerNodes.clear();
    this.mediaVideoNodes.clear();
    this.mediaImageNodes.clear();
    this.imageFXNodes.clear();
    this.vfxCrtNodes.clear();
    this.vfxBlurNodes.clear();
    this.videoIdbKeys.clear();
    this.imageFXBgKeys.clear();
  }
}
