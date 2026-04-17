import type { PortDef } from "../graph/PatchNode";

function getPortOffset(index: number, total: number): number {
  if (total <= 0) {
    return 50;
  }

  return ((index + 1) / (total + 1)) * 100;
}

export function renderPorts(direction: "inlet" | "outlet", ports: PortDef[]): HTMLDivElement {
  const layer = document.createElement("div");
  layer.className = `patch-object-ports patch-object-ports-${direction}`;

  ports.forEach((port, index) => {
    const nub = document.createElement("div");
    const temp = port.temperature ?? "hot";
    nub.className = `patch-port patch-port-${direction} patch-port-type-${port.type} patch-port-${temp}`;
    nub.dataset.portIndex = String(port.index);
    nub.dataset.portType = port.type;
    nub.style.left = `${getPortOffset(index, ports.length)}%`;

    const label = port.label ?? `${direction} ${port.index} (${port.type})`;
    nub.dataset.pnLabel = label;
    nub.setAttribute("aria-label", `${direction} ${port.index}: ${label}`);

    layer.appendChild(nub);
  });

  return layer;
}
