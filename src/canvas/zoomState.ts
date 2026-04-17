/**
 * Shared zoom state for the canvas.
 *
 * CanvasController owns mutation via setZoomValue. Other controllers
 * (Drag, CableDraw, Resize) read via getZoom to convert mouse display
 * pixels into intrinsic world coordinates.
 */

let _zoom = 1;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3.0;

export function getZoom(): number {
  return _zoom;
}

export function setZoomValue(z: number): void {
  _zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}
