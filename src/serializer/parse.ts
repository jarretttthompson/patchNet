import { PatchEdge } from "../graph/PatchEdge";
import { getObjectDef } from "../graph/objectDefs";
import { PatchNode } from "../graph/PatchNode";
import { derivePortsFromCode } from "../canvas/codeboxPorts";

export class PatchParseError extends Error {
  line: number;

  constructor(line: number, message: string) {
    super(`Line ${line}: ${message}`);
    this.name = "PatchParseError";
    this.line = line;
  }
}

export interface ParsedPatch {
  nodes: PatchNode[];
  edges: PatchEdge[];
}

function decodeCodeboxSource(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)));
}

function requireParts(parts: string[], minimum: number, lineNumber: number, message: string): void {
  if (parts.length < minimum) {
    throw new PatchParseError(lineNumber, message);
  }
}

export function parsePatch(text: string): ParsedPatch {
  // Empty (or whitespace-only) text = empty patch. The text panel is the
  // source of truth: clearing it must clear the canvas, not raise an error.
  if (!text.trim()) {
    return { nodes: [], edges: [] };
  }

  const rawLines = text.split(/\r?\n/);
  const nodes: PatchNode[] = [];
  const edges: PatchEdge[] = [];
  const pendingConnections: Array<{
    sourceIndex: number;
    sourceOutlet: number;
    targetIndex: number;
    targetInlet: number;
    lineNumber: number;
  }> = [];
  const pendingSizes: Array<{
    nodeIndex: number;
    width: number;
    height: number;
  }> = [];
  const pendingIds: Array<{ nodeIndex: number; id: string; lineNumber: number }> = [];
  const pendingGroups: Array<{ indices: number[]; lineNumber: number }> = [];
  let sawCanvasHeader = false;

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const trimmed = rawLines[lineIndex].trim();

    if (!trimmed || trimmed.startsWith("//")) {
      continue;
    }

    if (!trimmed.endsWith(";")) {
      throw new PatchParseError(lineNumber, "Missing trailing semicolon");
    }

    const statement = trimmed.slice(0, -1).trim();
    const parts = statement.split(/\s+/);

    requireParts(parts, 2, lineNumber, "Incomplete statement");

    if (parts[0] === "#N" && parts[1] === "canvas") {
      sawCanvasHeader = true;
      continue;
    }

    requireParts(parts, 3, lineNumber, "Unsupported statement");

    if (parts[0] !== "#X") {
      throw new PatchParseError(lineNumber, `Unknown line prefix: ${parts[0]}`);
    }

    if (parts[1] === "obj") {
      requireParts(parts, 5, lineNumber, "Object lines must include x, y, and type");

      const x = Number(parts[2]);
      const y = Number(parts[3]);

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new PatchParseError(lineNumber, "Object coordinates must be numeric");
      }

      const type = parts[4];
      const args = parts.slice(5);
      const objectDef = getObjectDef(type);
      let inlets = objectDef.inlets;
      let outlets = objectDef.outlets;

      if (type === "codebox") {
        const language = args[0] ?? "js";
        let source = "";

        if (args[1]) {
          try {
            source = decodeCodeboxSource(args[1]);
          } catch {
            console.warn(`Failed to decode codebox source on line ${lineNumber}`);
          }
        }

        args[0] = language;
        args[1] = source;
        ({ inlets, outlets } = derivePortsFromCode(source));
      }

      nodes.push(
        new PatchNode({
          id: crypto.randomUUID(),
          type,
          x,
          y,
          args,
          inlets,
          outlets,
        }),
      );

      continue;
    }

    if (parts[1] === "connect") {
      requireParts(
        parts,
        6,
        lineNumber,
        "Connect lines must include source object/outlet and target object/inlet",
      );

      const values = parts.slice(2, 6).map((value) => Number(value));

      if (values.some((value) => !Number.isInteger(value))) {
        throw new PatchParseError(lineNumber, "Connect values must be integers");
      }

      pendingConnections.push({
        sourceIndex: values[0],
        sourceOutlet: values[1],
        targetIndex: values[2],
        targetInlet: values[3],
        lineNumber,
      });

      continue;
    }

    if (parts[1] === "id") {
      requireParts(parts, 4, lineNumber, "Id lines must include node index and UUID");
      const nodeIndex = Number(parts[2]);
      const id = parts[3];
      if (!Number.isInteger(nodeIndex)) {
        throw new PatchParseError(lineNumber, "Id node index must be an integer");
      }
      if (!id) {
        throw new PatchParseError(lineNumber, "Id value missing");
      }
      pendingIds.push({ nodeIndex, id, lineNumber });
      continue;
    }

    if (parts[1] === "size") {
      requireParts(parts, 5, lineNumber, "Size lines must include node index, width, and height");
      const nodeIndex = Number(parts[2]);
      const width = Number(parts[3]);
      const height = Number(parts[4]);
      if (!Number.isInteger(nodeIndex) || !Number.isFinite(width) || !Number.isFinite(height)) {
        throw new PatchParseError(lineNumber, "Size values must be numeric");
      }
      pendingSizes.push({ nodeIndex, width, height });
      continue;
    }

    if (parts[1] === "group") {
      requireParts(parts, 4, lineNumber, "Group lines must include at least two node indices");
      const indices = parts.slice(2).map(Number);
      if (indices.some(i => !Number.isInteger(i))) {
        throw new PatchParseError(lineNumber, "Group node indices must be integers");
      }
      pendingGroups.push({ indices, lineNumber });
      continue;
    }

    throw new PatchParseError(lineNumber, `Unsupported #X statement: ${parts[1]}`);
  }

  if (!sawCanvasHeader) {
    throw new PatchParseError(1, "Patch must start with #N canvas;");
  }

  // Apply stored node ids BEFORE building edges so edge endpoints
  // reference the persisted UUIDs instead of the auto-generated ones.
  for (const { nodeIndex, id } of pendingIds) {
    const node = nodes[nodeIndex];
    if (node) node.id = id;
  }

  pendingConnections.forEach((connection) => {
    const sourceNode = nodes[connection.sourceIndex];
    const targetNode = nodes[connection.targetIndex];

    if (!sourceNode || !targetNode) {
      throw new PatchParseError(
        connection.lineNumber,
        "Connect statement references an object index that does not exist",
      );
    }

    if (connection.sourceOutlet < 0 || connection.sourceOutlet >= sourceNode.outlets.length) {
      throw new PatchParseError(connection.lineNumber, "Source outlet index is out of range");
    }

    // Attribute nodes have dynamically-built inlets that aren't present at parse time;
    // skip range validation for them — syncAttributeNodes() will rebuild inlets on load.
    const targetIsAttribute = targetNode.type === "attribute";
    if (!targetIsAttribute && (connection.targetInlet < 0 || connection.targetInlet >= targetNode.inlets.length)) {
      throw new PatchParseError(connection.lineNumber, "Target inlet index is out of range");
    }

    edges.push(
      new PatchEdge({
        id: crypto.randomUUID(),
        fromNodeId: sourceNode.id,
        fromOutlet: connection.sourceOutlet,
        toNodeId: targetNode.id,
        toInlet: connection.targetInlet,
      }),
    );
  });

  for (const { nodeIndex, width, height } of pendingSizes) {
    const node = nodes[nodeIndex];
    if (node) {
      node.width = width;
      node.height = height;
    }
  }

  for (const { indices } of pendingGroups) {
    const groupId = crypto.randomUUID();
    for (const idx of indices) {
      const node = nodes[idx];
      if (node) node.groupId = groupId;
    }
  }

  return { nodes, edges };
}
