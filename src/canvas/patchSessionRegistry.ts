/**
 * Global registry of top-level patch sessions (main + scratch tabs).
 *
 * Used to bridge cross-patch features:
 *   - send / receive routing — `s` in any tab can target an `r` in any other tab
 *   - audio — AudioGraph iterates every registered graph to materialise nodes
 *   - tab manager queries this to find a session for a given graph
 *
 * SubPatch sessions are NOT registered here — they live under the main graph
 * via SubPatchManager and inherit their parent's tab.
 */

import type { PatchGraph } from "../graph/PatchGraph";
import type { ObjectInteractionController } from "./ObjectInteractionController";

export interface PatchSessionEntry {
  id: string;            // "main" or scratch-tab nodeId
  graph: PatchGraph;
  oic: ObjectInteractionController;
}

const sessions = new Map<string, PatchSessionEntry>();
const listeners = new Set<() => void>();

export function registerSession(entry: PatchSessionEntry): void {
  sessions.set(entry.id, entry);
  for (const fn of listeners) fn();
}

export function unregisterSession(id: string): void {
  sessions.delete(id);
  for (const fn of listeners) fn();
}

export function getSessions(): PatchSessionEntry[] {
  return [...sessions.values()];
}

export function getSession(id: string): PatchSessionEntry | undefined {
  return sessions.get(id);
}

/** Notified whenever sessions are added/removed — AudioGraph re-syncs on this. */
export function onSessionsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fire all `r` receivers across every registered session matching `channel`.
 * `value === null` → bang; otherwise → message value.
 */
export function broadcastSendReceive(channel: string, value: string | null): void {
  if (!channel) return;
  for (const { graph, oic } of sessions.values()) {
    for (const node of graph.getNodes()) {
      if (node.type !== "r" || node.args[0] !== channel) continue;
      if (value === null) oic.fireBang(node.id, 0);
      else oic.fireOutlet(node.id, 0, value);
    }
  }
}
