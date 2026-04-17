/**
 * PortTooltip — shows port labels on hover using proximity detection.
 *
 * CSS :hover on port nubs fails when a connected cable's hit line (z-index 5,
 * pointer-events: stroke) sits on top of the nub. This class uses mousemove
 * on the canvas element itself — which always receives events — and computes
 * distance from the cursor to each port center. When within SNAP_RADIUS it
 * shows a floating tooltip positioned via fixed coords.
 */

const SNAP_RADIUS = 32; // px — how close the cursor must be to trigger

export class PortTooltip {
  private readonly tip: HTMLDivElement;
  private currentPort: HTMLElement | null = null;

  constructor(private readonly canvasEl: HTMLElement) {
    this.tip = document.createElement("div");
    this.tip.className = "pn-port-tooltip";
    document.body.appendChild(this.tip);

    canvasEl.addEventListener("mousemove", this.onMove);
    canvasEl.addEventListener("mouseleave", this.hide);
  }

  private readonly onMove = (e: MouseEvent): void => {
    const ports = this.canvasEl.querySelectorAll<HTMLElement>("[data-pn-label]");
    let nearest: HTMLElement | null = null;
    let bestDist = SNAP_RADIUS;

    for (const port of ports) {
      const rect = port.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = port;
      }
    }

    if (nearest) {
      if (nearest !== this.currentPort) {
        this.currentPort = nearest;
        const rect = nearest.getBoundingClientRect();
        const isInlet    = nearest.classList.contains("patch-port-inlet");
        const isSideLeft = nearest.classList.contains("patch-port-side-left");

        this.tip.textContent = nearest.dataset.pnLabel!;

        if (isSideLeft) {
          // Position tooltip to the left of the nub
          this.tip.style.left      = `${rect.left - 6}px`;
          this.tip.style.top       = `${rect.top + rect.height / 2}px`;
          this.tip.style.transform = "translate(-100%, -50%)";
        } else {
          this.tip.style.left      = `${rect.left + rect.width / 2}px`;
          this.tip.style.top       = isInlet ? `${rect.top - 6}px` : `${rect.bottom + 6}px`;
          this.tip.style.transform = isInlet ? "translate(-50%, -100%)" : "translate(-50%, 0)";
        }

        this.tip.classList.add("pn-port-tooltip--visible");
      }
    } else {
      this.hide();
    }
  };

  private readonly hide = (): void => {
    if (this.currentPort) {
      this.tip.classList.remove("pn-port-tooltip--visible");
      this.currentPort = null;
    }
  };

  destroy(): void {
    this.canvasEl.removeEventListener("mousemove", this.onMove);
    this.canvasEl.removeEventListener("mouseleave", this.hide);
    this.tip.remove();
  }
}
