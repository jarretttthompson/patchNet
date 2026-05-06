/**
 * Global patch-mode state. When OFF, cable drawing/interaction is disabled
 * and cables visually drop behind objects. Owned by main.ts, observed by
 * every CanvasController (main + subpatch sessions) so the toggle applies
 * across all tabs.
 */

type Listener = (on: boolean) => void;

let patchMode = true;
const listeners = new Set<Listener>();

export function getPatchMode(): boolean {
  return patchMode;
}

export function setPatchModeState(on: boolean): void {
  if (patchMode === on) return;
  patchMode = on;
  for (const l of listeners) l(on);
}

export function subscribePatchMode(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
