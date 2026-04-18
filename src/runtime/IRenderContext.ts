import type { LayerNode } from "./LayerNode";

export interface IRenderContext {
  addLayer(layer: LayerNode): void;
  removeLayer(layer: LayerNode): void;
  clearLayers(): void;
  getCanvas(): HTMLCanvasElement | null;
  destroy(): void;
}
