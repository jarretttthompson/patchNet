/**
 * Global "snap to grid" toggle.
 *
 * When enabled, drag operations snap object positions to GRID_CELL_PX
 * multiples. Persists for the session only — not part of the patch
 * format, since it's an editor preference rather than patch state.
 */

let _snap = true;
const _listeners = new Set<(on: boolean) => void>();

export function getSnap(): boolean {
  return _snap;
}

export function setSnap(on: boolean): void {
  if (_snap === on) return;
  _snap = on;
  for (const fn of _listeners) fn(_snap);
}

export function subscribeSnap(fn: (on: boolean) => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
