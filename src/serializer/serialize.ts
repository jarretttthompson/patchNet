import type { PatchGraph } from "../graph/PatchGraph";
import type { PatchNode } from "../graph/PatchNode";

function encodeCodeboxSource(source: string): string {
  return btoa(unescape(encodeURIComponent(source)));
}

// ── Display abbreviation for blob args ───────────────────────────────────────
// Console-facing serialization replaces base64 payloads with a compact
// `~b64:label:hash:summary~` token. Disk/storage serialization keeps the full
// base64. The token is whitespace-free so it survives the existing parser.
//
// Adding a new object with blob args? Add an entry to BLOB_ARG_SCHEMA below
// and the display path picks it up automatically.

interface BlobSlot {
  index: number;
  label: string;
  summarize: (decoded: string) => string;
  // True when this slot's content drives the node's inlets/outlets (e.g., the
  // raw source for codebox / js~ / reaperVideo). The display path can't run
  // port derivation on a placeholder, so deserialize must preserve old ports.
  drivesPorts?: boolean;
  // True when args[index] already holds the encoded base64 at runtime (the
  // parser doesn't decode it — buffer~ PCM is the canonical example). On the
  // disk path emitBlob passes the value through verbatim instead of re-
  // encoding it; the display path summarizes the base64 directly.
  preEncoded?: boolean;
}

const lineSummary = (s: string): string => {
  if (!s) return "0L";
  const lines = s.split(/\r?\n/).length;
  return `${lines}L`;
};

const librarySummary = (s: string): string => {
  if (!s) return "empty";
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return `${parsed.length}fx`;
    if (parsed && typeof parsed === "object") return `${Object.keys(parsed).length}k`;
  } catch { /* fall through */ }
  return `${s.length}b`;
};

const valuesSummary = (s: string): string => {
  if (!s) return "empty";
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") return `${Object.keys(parsed).length}v`;
  } catch { /* fall through */ }
  return `${s.length}b`;
};

const pcmSummary = (s: string): string => {
  if (!s) return "empty";
  // Each Float32 sample is 4 bytes → base64 inflates ~33%, so:
  // raw bytes ≈ s.length * 3/4; samples = bytes / 4.
  const bytes   = Math.floor(s.length * 0.75);
  const samples = Math.floor(bytes / 4);
  return `${samples}smp`;
};

const BLOB_ARG_SCHEMA: Record<string, BlobSlot[]> = {
  codebox:     [{ index: 1, label: "cb-src",  summarize: lineSummary, drivesPorts: true }],
  "js~":       [
    { index: 0, label: "js-src",  summarize: lineSummary, drivesPorts: true },
    { index: 1, label: "js-lib",  summarize: librarySummary },
    { index: 3, label: "js-vals", summarize: valuesSummary },
  ],
  "reaperVideo*": [
    { index: 0, label: "rv-src",  summarize: lineSummary, drivesPorts: true },
    { index: 1, label: "rv-lib",  summarize: librarySummary },
    { index: 3, label: "rv-vals", summarize: valuesSummary },
  ],
  "buffer~":   [
    { index: 6, label: "buf-L",   summarize: pcmSummary, preEncoded: true },
    { index: 7, label: "buf-R",   summarize: pcmSummary, preEncoded: true },
    { index: 8, label: "buf-Ls",  summarize: pcmSummary, preEncoded: true },
    { index: 9, label: "buf-Rs",  summarize: pcmSummary, preEncoded: true },
  ],
};

// djb2 — small, fast, deterministic, no async crypto. We only need a stable
// short fingerprint so the user sees the token change when the source changes.
function shortHash(s: string): string {
  if (!s) return "0";
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

function blobPlaceholder(label: string, decoded: string, summarize: (s: string) => string): string {
  return `~b64:${label}:${shortHash(decoded)}:${summarize(decoded)}~`;
}

export function isBlobPlaceholder(s: string | undefined): boolean {
  return typeof s === "string" && /^~b64:[A-Za-z0-9_-]+:[0-9a-f]+:[^~\s]+~$/.test(s);
}

export function getBlobSchema(type: string): readonly BlobSlot[] | undefined {
  return BLOB_ARG_SCHEMA[type];
}

export type { BlobSlot };

// ─────────────────────────────────────────────────────────────────────────────

interface SerializeOptions {
  forDisplay?: boolean;
}

function serializeNode(node: PatchNode, opts: SerializeOptions = {}): string {
  const parts = ["#X", "obj", String(Math.round(node.x)), String(Math.round(node.y)), node.type];
  const display = opts.forDisplay === true;
  const blobSchema = BLOB_ARG_SCHEMA[node.type];

  // Helper: emit a blob arg as either a placeholder (display) or full base64 (disk).
  // `emptyMarker` is what to write when the value is empty AND the slot supports
  // the "-" convention (js~/reaperVideo libs/values). codebox source has no such
  // convention — pass undefined to always encode.
  const emitBlob = (value: string, slotLabel: string, emptyMarker: "-" | undefined): string => {
    const slot = blobSchema?.find(s => s.label === slotLabel);
    if (display) {
      if (!slot) return value; // shouldn't happen; defensive
      if (!value && emptyMarker) return emptyMarker;
      return blobPlaceholder(slot.label, value, slot.summarize);
    }
    if (!value && emptyMarker) return emptyMarker;
    // preEncoded slots (buffer~ PCM) already hold base64 at runtime — pass
    // through verbatim instead of double-encoding.
    if (slot?.preEncoded) return value;
    return encodeCodeboxSource(value);
  };

  if (node.type === "codebox") {
    const language = node.args[0] ?? "js";
    const source = node.args[1] ?? "";
    parts.push(language, emitBlob(source, "cb-src", undefined));
  } else if (node.type === "js~") {
    const source  = node.args[0] ?? "";
    const library = node.args[1] ?? "";
    const locked  = node.args[2] ?? "0";
    const sliderValues = node.args[3] ?? "";
    parts.push(emitBlob(source, "js-src", undefined));
    parts.push(emitBlob(library, "js-lib", "-"));
    parts.push(locked);
    parts.push(emitBlob(sliderValues, "js-vals", "-"));
  } else if (node.type === "youtube~*") {
    const url = node.args[0] ?? "";
    const videoId = node.args[1] ?? "";
    const startSeconds = node.args[2] ?? "0";
    const captureOnLoad = node.args[3] ?? "0";
    const locked = node.args[4] ?? "1";
    parts.push(url || "-");
    parts.push(videoId || "-");
    parts.push(startSeconds);
    parts.push(captureOnLoad);
    parts.push(locked);
  } else if (node.type === "buffer~") {
    // Positional layout (13 slots):
    //   mode rate loop maxLen transport position bufL bufR bufLStereo bufRStereo
    //   rangeStart rangeEnd storageKey
    // bufL/R/Ls/Rs slots are kept for backwards-compat with patches saved
    // before OPFS storage existed; new saves write "-" and use storageKey.
    const mode      = node.args[0] ?? "stereo";
    const rate      = node.args[1] ?? "1";
    const loop      = node.args[2] ?? "0";
    const maxLen    = node.args[3] ?? "180";
    const transport = node.args[4] ?? "stop";
    const position  = node.args[5] ?? "0";
    const bufL      = node.args[6] ?? "";
    const bufR      = node.args[7] ?? "";
    const bufLs     = node.args[8] ?? "";
    const bufRs     = node.args[9] ?? "";
    const rangeStart = node.args[10] ?? "0";
    const rangeEnd   = node.args[11] ?? "0";
    const storageKey = node.args[12] ?? "";
    parts.push(mode, rate, loop, maxLen, transport, position);
    parts.push(emitBlob(bufL,  "buf-L",  "-"));
    parts.push(emitBlob(bufR,  "buf-R",  "-"));
    parts.push(emitBlob(bufLs, "buf-Ls", "-"));
    parts.push(emitBlob(bufRs, "buf-Rs", "-"));
    parts.push(rangeStart, rangeEnd);
    parts.push(storageKey || "-");
  } else if (node.type === "reaperVideo*") {
    const source  = node.args[0] ?? "";
    const library = node.args[1] ?? "";
    const locked  = node.args[2] ?? "0";
    const paramValues = node.args[3] ?? "";
    parts.push(emitBlob(source, "rv-src", undefined));
    parts.push(emitBlob(library, "rv-lib", "-"));
    parts.push(locked);
    parts.push(emitBlob(paramValues, "rv-vals", "-"));
  } else if (node.args.length > 0) {
    parts.push(...node.args);
  }

  return `${parts.join(" ")};`;
}

function serializeInternal(graph: PatchGraph, opts: SerializeOptions): string {
  const lines = ["#N canvas;"];
  const nodes = graph.getNodes();
  const nodeIndexById = new Map<string, number>();

  nodes.forEach((node, index) => {
    nodeIndexById.set(node.id, index);
    lines.push(serializeNode(node, opts));
    // Persist node identity so diff-based deserialize can preserve runtime state.
    lines.push(`#X id ${index} ${node.id};`);
    if (node.name) {
      lines.push(`#X name ${index} ${node.name};`);
    }
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

export function serializePatch(graph: PatchGraph): string {
  return serializeInternal(graph, {});
}

export function serializePatchForDisplay(graph: PatchGraph): string {
  return serializeInternal(graph, { forDisplay: true });
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
