/**
 * Block *browser* page-zoom (the kind that scales the whole UI — toolbar and
 * all — and is easy to trigger by accident with a trackpad pinch or Cmd +/-).
 *
 * patchNet has its own intentional, bounded **canvas** zoom (Cmd/Ctrl+wheel
 * over the canvas, and the Mod+= / Mod+- / Mod+0 actions). Those are driven by
 * JS handlers that call `canvas.zoomBy()` — they don't rely on the browser's
 * native page zoom, so preventing the browser default here leaves them fully
 * working while killing the accidental whole-page zoom.
 *
 * Sources of accidental page zoom we neutralize:
 *   - Trackpad pinch → macOS dispatches non-standard `gesturestart/change/end`
 *     events (Safari + Chrome) AND synthesized ctrl+`wheel` events.
 *   - Ctrl/⌘ + `wheel` that lands outside the canvas element.
 *   - Ctrl/⌘ + `=` / `+` / `-` / `0` keyboard zoom.
 *
 * We only `preventDefault()` — never `stopPropagation()` — so patchNet's own
 * canvas-zoom listeners still receive the same events and do their thing.
 */
export function installBrowserZoomGuard(target: Window = window): void {
  // Pinch / ctrl+wheel. passive:false is required for preventDefault to take.
  target.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );

  // macOS pinch gesture events (non-standard; not in lib.dom types).
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    target.addEventListener(
      type,
      (e: Event) => e.preventDefault(),
      { passive: false },
    );
  }

  // Keyboard zoom: Cmd/Ctrl + (= + - _ 0). preventDefault blocks the browser's
  // native zoom; patchNet's keymap still fires its own canvas-zoom action.
  target.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_" || e.key === "0") {
        e.preventDefault();
      }
    },
    { passive: false },
  );
}
