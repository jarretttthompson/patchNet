import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";

function encodeCodeboxSource(source: string): string {
  return btoa(unescape(encodeURIComponent(source)));
}

function serializeNode(node: PatchNode): string {
  const parts = ["#X", "obj", String(Math.round(node.x)), String(Math.round(node.y)), node.type];

  if (node.type === "codebox") {
    const language = node.args[0] ?? "js";
    const source = node.args[1] ?? "";
    parts.push(language, encodeCodeboxSource(source));
  } else if (node.args.length > 0) {
    parts.push(...node.args);
  }

  return `${parts.join(" ")};`;
}

export function serializePatch(graph: PatchGraph): string {
  const lines = ["#N canvas;"];
  const nodes = graph.getNodes();
  const nodeIndexById = new Map<string, number>();

  nodes.forEach((node, index) => {
    nodeIndexById.set(node.id, index);
    lines.push(serializeNode(node));
    // Persist node identity so diff-based deserialize can preserve runtime state.
    lines.push(`#X id ${index} ${node.id};`);
    if (node.width !== undefined && node.height !== undefined) {
      lines.push(`#X size ${index} ${node.width} ${node.height};`);
    }
    if (node.panelX !== undefined && node.panelY !== undefined) {
      const pw = node.panelW !== undefined ? ` ${Math.round(node.panelW)}` : "";
      const ph = node.panelH !== undefined ? ` ${Math.round(node.panelH)}` : "";
      lines.push(`#X panel ${index} ${Math.round(node.panelX)} ${Math.round(node.panelY)}${pw}${ph};`);
    }
  });

  for (const edge of graph.getEdges()) {
    const sourceIndex = nodeIndexById.get(edge.fromNodeId);
    const targetIndex = nodeIndexById.get(edge.toNodeId);

    if (sourceIndex === undefined || targetIndex === undefined) {
      continue;
    }

    lines.push(
      `#X connect ${sourceIndex} ${edge.fromOutlet} ${targetIndex} ${edge.toInlet};`,
    );
  }

  serializeGroups(nodes, nodeIndexById, lines);

  return lines.join("\n");
}

function serializeGroups(
  nodes: PatchNode[],
  _nodeIndexById: Map<string, number>,
  lines: string[],
): void {
  const groupMap = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    if (!node.groupId) return;
    if (!groupMap.has(node.groupId)) groupMap.set(node.groupId, []);
    groupMap.get(node.groupId)!.push(index);
  });
  for (const indices of groupMap.values()) {
    if (indices.length >= 2) {
      lines.push(`#X group ${indices.join(" ")};`);
    }
  }
}
