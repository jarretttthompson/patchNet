/** Resize a canvas's backing bitmap to match its CSS display size at the
 *  current devicePixelRatio. Returns the bitmap dimensions to draw against.
 *  Returns null if the canvas isn't laid out yet (zero-sized rect — e.g. it's
 *  inside a collapsed/hidden subtree). Callers should bail in that case. */
export function fitScopeCanvas(canvas: HTMLCanvasElement): { w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { w, h };
}
