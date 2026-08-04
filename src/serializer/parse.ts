import { PatchEdge } from "../graph/PatchEdge";
import { audioPortDefaultWidth, canonicalizeType, ensureBufferArgs, getObjectDef } from "../graph/objectDefs";
import { PatchNode } from "../graph/PatchNode";
import { derivePortsFromCode } from "../canvas/codeboxPorts";
import { validateNodeName } from "../graph/nodeNames";
import { isBlobPlaceholder } from "./serialize";
import { FORMAT_VERSION } from "./version";

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
  const pendingPanelPositions: Array<{
    nodeIndex: number;
    panelX: number;
    panelY: number;
    panelW?: number;
    panelH?: number;
  }> = [];
  const pendingIds: Array<{ nodeIndex: number; id: string; lineNumber: number }> = [];
  const pendingNames: Array<{ nodeIndex: number; name: string; lineNumber: number }> = [];
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

    if (parts[0] === "#N" && parts[1] === "patchnet") {
      requireParts(parts, 3, lineNumber, "patchnet header missing version");
      const version = Number(parts[2]);
      if (!Number.isInteger(version) || version < 0) {
        throw new PatchParseError(lineNumber, "patchnet header version must be a whole number");
      }
      if (version > FORMAT_VERSION) {
        throw new PatchParseError(
          lineNumber,
          `Patch uses format v${version}; this app reads up to v${FORMAT_VERSION}. Update patchNet to open it.`,
        );
      }
      continue;
    }

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

      const type = canonicalizeType(parts[4]);
      let args = parts.slice(5);
      const objectDef = getObjectDef(type);
      let inlets = objectDef.inlets;
      let outlets = objectDef.outlets;

      if (type === "codebox") {
        const language = args[0] ?? "js";
        let source = "";
        const sourcePlaceholder = isBlobPlaceholder(args[1]);

        if (args[1] && !sourcePlaceholder) {
          try {
            source = decodeCodeboxSource(args[1]);
          } catch {
            console.warn(`Failed to decode codebox source on line ${lineNumber}`);
          }
        }

        args[0] = language;
        args[1] = sourcePlaceholder ? args[1] : source;
        // Port derivation depends on source; placeholders mean "preserve old
        // ports from the in-memory node," handled in PatchGraph.deserialize.
        if (!sourcePlaceholder) {
          ({ inlets, outlets } = derivePortsFromCode(source));
        }
      }

      // ── js~ decode ──
      if (type === "js~") {
        // args[0] = raw JSFX source (base64 on disk; ~b64:jsfx-src…~ in display)
        // args[1] = patch library JSON (base64 on disk; "-" or missing = no library)
        // args[2] = locked flag ("0"/"1")
        // args[3] = sliderValues JSON (base64 on disk; "-" or missing = empty)
        const sourceIsPlaceholder = isBlobPlaceholder(args[0]);
        if (!sourceIsPlaceholder) {
          let source = "";
          if (args[0]) {
            try {
              source = decodeCodeboxSource(args[0]);
            } catch {
              console.warn(`Failed to decode js~ source on line ${lineNumber}`);
            }
          }
          args[0] = source;
        }

        if (!isBlobPlaceholder(args[1])) {
          let library = "";
          if (args[1] && args[1] !== "-") {
            try {
              library = decodeCodeboxSource(args[1]);
            } catch {
              console.warn(`Failed to decode js~ library on line ${lineNumber}`);
            }
          }
          args[1] = library;
        }

        args[2] = (args[2] === "1") ? "1" : "0";

        if (!isBlobPlaceholder(args[3])) {
          let sliderValues = "";
          if (args[3] && args[3] !== "-") {
            try {
              sliderValues = decodeCodeboxSource(args[3]);
            } catch {
              console.warn(`Failed to decode js~ sliderValues on line ${lineNumber}`);
            }
          }
          args[3] = sliderValues;
        }
      }

      // ── reaperVideo* decode ──
      if (type === "reaperVideo*") {
        // args[0] = raw video-processor source (base64 on disk; ~b64:rv-src…~ in display)
        // args[1] = patch library JSON (base64 on disk; "-" or missing = no library)
        // args[2] = locked flag ("0"/"1")
        // args[3] = paramValues JSON (base64 on disk; "-" or missing = empty)
        const sourceIsPlaceholder = isBlobPlaceholder(args[0]);
        if (!sourceIsPlaceholder) {
          let source = "";
          if (args[0]) {
            try {
              source = decodeCodeboxSource(args[0]);
            } catch {
              console.warn(`Failed to decode reaperVideo source on line ${lineNumber}`);
            }
          }
          args[0] = source;
        }

        if (!isBlobPlaceholder(args[1])) {
          let library = "";
          if (args[1] && args[1] !== "-") {
            try {
              library = decodeCodeboxSource(args[1]);
            } catch {
              console.warn(`Failed to decode reaperVideo library on line ${lineNumber}`);
            }
          }
          args[1] = library;
        }

        args[2] = (args[2] === "1") ? "1" : "0";

        if (!isBlobPlaceholder(args[3])) {
          let paramValues = "";
          if (args[3] && args[3] !== "-") {
            try {
              paramValues = decodeCodeboxSource(args[3]);
            } catch {
              console.warn(`Failed to decode reaperVideo paramValues on line ${lineNumber}`);
            }
          }
          args[3] = paramValues;
        }
        // Normalize the trailing scalar args so old patches (saved before
        // these existed) converge to the same canonical form as new ones —
        // keeps parse → serialize → parse idempotent. args[4] = maxRenderDim,
        // args[5] = wet/dry.
        if (args[4] === undefined || args[4] === "") args[4] = "360";
        if (args[5] === undefined || args[5] === "") args[5] = "1";
      }

      // ── buffer~ decode ──
      if (type === "buffer~") {
        ensureBufferArgs(args);
        for (let i = 6; i <= 9; i++) {
          if (args[i] === "-") args[i] = "";
        }
        if (args[12] === "-") args[12] = "";
      }

      // ── youtube~* decode ──
      if (type === "youtube~*") {
        args[0] = (args[0] && args[0] !== "-") ? args[0] : "";
        args[1] = (args[1] && args[1] !== "-") ? args[1] : "";
        args[2] = args[2] ?? "0";
        args[3] = args[3] === "1" ? "1" : "0";
        args[4] = args[4] === "1" ? "1" : "0";
      }

      // ── Generic derivePorts/ensureArgs dispatch ──
      // Objects with a derivePorts function on their spec compute dynamic
      // ports from args. This covers: t, pack, unpack, route, sequencer,
      // adc~, dac~, mixer~, fft~, js~, buffer~, reaperVideo*, subPatch.
      // ensureArgs fills sparse positional args for deterministic serialization.
      const spec = getObjectDef(type);
      if (spec.ensureArgs) args = spec.ensureArgs(args);
      if (spec.derivePorts) {
        ({ inlets, outlets } = spec.derivePorts(args));
      }

      // ── codebox: special case — ports derive from code string ──
      if (type === "codebox") {
        ({ inlets, outlets } = derivePortsFromCode(args[1] ?? ""));
      }

      const adcDacWidth =
        (type === "adc~" || type === "dac~") && (inlets.length > 2 || outlets.length > 2)
          ? audioPortDefaultWidth(Math.max(inlets.length, outlets.length))
          : undefined;

      nodes.push(
        new PatchNode({
          id: crypto.randomUUID(),
          type,
          x,
          y,
          args,
          inlets,
          outlets,
          width: adcDacWidth,
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

    if (parts[1] === "name") {
      requireParts(parts, 4, lineNumber, "Name lines must include node index and name");
      const nodeIndex = Number(parts[2]);
      const name = parts[3];
      if (!Number.isInteger(nodeIndex)) {
        throw new PatchParseError(lineNumber, "Name node index must be an integer");
      }
      try {
        validateNodeName(name);
      } catch (err) {
        throw new PatchParseError(
          lineNumber,
          err instanceof Error ? err.message : "Invalid object name",
        );
      }
      pendingNames.push({ nodeIndex, name, lineNumber });
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

    if (parts[1] === "panel") {
      requireParts(parts, 5, lineNumber, "Panel lines must include node index, x, and y");
      const nodeIndex = Number(parts[2]);
      const panelX = Number(parts[3]);
      const panelY = Number(parts[4]);
      if (!Number.isInteger(nodeIndex) || !Number.isFinite(panelX) || !Number.isFinite(panelY)) {
        throw new PatchParseError(lineNumber, "Panel values must be numeric");
      }
      const panelW = parts[5] !== undefined ? Number(parts[5]) : undefined;
      const panelH = parts[6] !== undefined ? Number(parts[6]) : undefined;
      pendingPanelPositions.push({ nodeIndex, panelX, panelY, panelW, panelH });
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

  for (const { nodeIndex, name } of pendingNames) {
    const node = nodes[nodeIndex];
    if (node) node.name = name;
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

    // Attribute and subPatch nodes have dynamically-built inlets that aren't present at parse time;
    // skip range validation for them — they rebuild inlets from their stored args on load.
    const targetIsAttribute = targetNode.type === "attribute" || targetNode.type === "subPatch";
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

  for (const { nodeIndex, panelX, panelY, panelW, panelH } of pendingPanelPositions) {
    const node = nodes[nodeIndex];
    if (node) {
      node.panelX = panelX;
      node.panelY = panelY;
      if (panelW !== undefined) node.panelW = panelW;
      if (panelH !== undefined) node.panelH = panelH;
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
