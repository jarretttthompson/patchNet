import type { PatchGraph } from "../graph/PatchGraph";
import { compressPatch, decompressPatch } from "./compress";

// Most browsers/proxies cap URLs around 8KB. Leave headroom.
const MAX_ENCODED_CHARS = 7800;

export type ShareUrlResult = { url: string } | { error: string };

export async function buildShareUrl(graph: PatchGraph): Promise<ShareUrlResult> {
  const text = graph.serialize();
  let encoded: string;
  try {
    encoded = await compressPatch(text);
  } catch {
    return { error: "Compression failed — save as .patchnet file instead" };
  }
  if (encoded.length > MAX_ENCODED_CHARS) {
    return { error: "Patch too large for URL share (contains blobs) — use ↓ Save to file" };
  }
  const { origin, pathname } = window.location;
  return { url: `${origin}${pathname}#p=${encoded}` };
}

export async function loadFromShareUrl(): Promise<string | null> {
  const hash = window.location.hash;
  if (!hash.startsWith("#p=")) return null;
  const encoded = hash.slice(3);
  if (!encoded) return null;
  try {
    return await decompressPatch(encoded);
  } catch {
    console.warn("[patchNet] Failed to decode share URL");
    return null;
  }
}
