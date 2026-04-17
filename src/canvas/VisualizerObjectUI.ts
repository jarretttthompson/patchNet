import type { PatchGraph } from "../graph/PatchGraph";
import type { VisualizerGraph } from "../runtime/VisualizerGraph";

/**
 * VisualizerObjectUI — attaches double-click file-picker behavior to
 * mediaVideo and mediaImage canvas objects.
 *
 * Uses event delegation on the pan group so newly-rendered objects are
 * picked up automatically without re-registering listeners.
 */
export class VisualizerObjectUI {
  private readonly onDblClick: (e: MouseEvent) => void;

  constructor(
    private readonly panGroup: HTMLElement,
    private readonly graph: PatchGraph,
    private readonly vizGraph: VisualizerGraph,
  ) {
    this.onDblClick = this.handleDblClick.bind(this);
    panGroup.addEventListener("dblclick", this.onDblClick);
  }

  destroy(): void {
    this.panGroup.removeEventListener("dblclick", this.onDblClick);
  }

  private handleDblClick(e: MouseEvent): void {
    const objectEl = (e.target as Element).closest<HTMLElement>(".patch-object");
    const nodeId   = objectEl?.dataset.nodeId;
    if (!nodeId) return;

    const node = this.graph.nodes.get(nodeId);
    if (!node) return;

    if (node.type === "mediaVideo") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.openFilePicker("video/*", nodeId, "mediaVideo");
    } else if (node.type === "mediaImage") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.openFilePicker("image/*", nodeId, "mediaImage");
    }
  }

  private openFilePicker(accept: string, nodeId: string, nodeType: "mediaVideo" | "mediaImage"): void {
    const input = document.createElement("input");
    input.type   = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) this.vizGraph.loadFileForNode(nodeId, nodeType, file);
      input.remove();
    }, { once: true });

    input.click();
  }
}
