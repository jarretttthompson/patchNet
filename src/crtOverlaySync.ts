/**
 * Drives CRT overlay transforms from scroll so phosphor layers drift with the
 * patch canvas — reads as one moving "virtual screen" surface.
 */
export function initCrtOverlayScroll(canvasRoot: HTMLElement): void {
  const overlay = document.querySelector<HTMLElement>(".crt-overlay");
  if (!overlay) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return;

  let ticking = false;
  const sync = (): void => {
    overlay.style.setProperty("--crt-sx", String(canvasRoot.scrollLeft));
    overlay.style.setProperty("--crt-sy", String(canvasRoot.scrollTop));
  };

  const onScroll = (): void => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      sync();
    });
  };

  canvasRoot.addEventListener("scroll", onScroll, { passive: true });
  sync();
}
