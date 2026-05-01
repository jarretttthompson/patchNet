import type { PatchGraph } from "../../graph/PatchGraph";
import { PeerSession } from "./PeerSession";
import type { TopicPayload } from "./topicRouter";

/**
 * PeerRegistry — patch-scoped registry of `peer` runtime sessions, plus the
 * topic-routing fan-out for `netsend` / `netreceive`.
 *
 * Lifecycle:
 *   - `sync(graph)` is called every VisualizerGraph render. It creates a
 *     PeerSession for any new `peer` node and drops sessions whose node is
 *     gone. Idempotent.
 *   - `getDefaultSession(graph)` resolves what netsend / netreceive should
 *     bind to when no explicit peer arg is set: the first `peer` node in the
 *     graph (lowest id). Phase 7B will let users name peers explicitly.
 *
 * Topic routing is local to each session: a netsend "foo" only delivers to
 * netreceive "foo" connected through the same session. Sessions are
 * isolated, so two `peer` objects in one patch can carry independent topic
 * spaces.
 */

interface SessionEntry {
  session: PeerSession;
  topicListeners: Map<string, Set<(payload: TopicPayload) => void>>;
  /** Cleanup callback for the session-level message listener. */
  unbindMessage: () => void;
}

export type NetReceiveEmit = (
  receiverNodeId: string,
  payload: TopicPayload,
) => void;

interface NetReceiveBinding {
  /** PeerSession the binding currently subscribes through. Tracked so we
   *  can detect when the default peer changes and rebind. */
  session: PeerSession;
  topic: string;
  unsubscribe: () => void;
}

export class PeerRegistry {
  private sessions = new Map<string, SessionEntry>();
  /** netreceive nodeId → subscription state. */
  private netReceiveBindings = new Map<string, NetReceiveBinding>();
  private netReceiveEmit: NetReceiveEmit | null = null;

  /** Reconcile sessions against the live graph. Returns the set of node ids
   *  that have an active session post-sync (handy for status emission). */
  sync(graph: PatchGraph): Set<string> {
    const live = new Set<string>();
    for (const node of graph.getNodes()) {
      if (node.type !== "peer") continue;
      live.add(node.id);
      if (!this.sessions.has(node.id)) {
        // Phase 7A: every peer is created in offerer mode by default. Role
        // can be flipped from the panel via the manual-SDP toggle, which
        // tears down and rebuilds the session — see PeerPanel.
        this.createSession(node.id, "offerer");
      }
    }
    for (const id of Array.from(this.sessions.keys())) {
      if (!live.has(id)) this.destroySession(id);
    }
    return live;
  }

  getSession(nodeId: string): PeerSession | null {
    return this.sessions.get(nodeId)?.session ?? null;
  }

  /** Replace the session for a peer node. Used when the panel flips role
   *  (offerer ↔ answerer) — RTCPeerConnection roles are baked at creation
   *  so the cleanest path is teardown + rebuild. Topic listeners are
   *  preserved so existing netsend/netreceive bindings auto-rebind. */
  recreateSession(nodeId: string, role: "offerer" | "answerer"): PeerSession {
    const prev = this.sessions.get(nodeId);
    const preservedTopics = prev?.topicListeners ?? new Map();
    if (prev) this.destroySession(nodeId, /* keepTopics */ true);
    this.createSession(nodeId, role, preservedTopics);
    return this.sessions.get(nodeId)!.session;
  }

  /** Resolve which session a netsend / netreceive without an explicit peer
   *  arg should use: first peer node in document order (lowest id). */
  getDefaultSession(graph: PatchGraph): PeerSession | null {
    let firstId: string | null = null;
    for (const node of graph.getNodes()) {
      if (node.type !== "peer") continue;
      if (firstId === null || node.id < firstId) firstId = node.id;
    }
    return firstId ? this.getSession(firstId) : null;
  }

  /** Subscribe to messages on a topic for a given session. Returns an
   *  unsubscribe function. Multiple listeners per topic are allowed (one
   *  patch can have multiple netreceive "foo" objects). */
  subscribe(
    session: PeerSession,
    topic: string,
    fn: (payload: TopicPayload) => void,
  ): () => void {
    const entry = this.findEntryBySession(session);
    if (!entry) return () => {};
    let set = entry.topicListeners.get(topic);
    if (!set) {
      set = new Set();
      entry.topicListeners.set(topic, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) entry.topicListeners.delete(topic);
    };
  }

  destroyAll(): void {
    for (const [, binding] of this.netReceiveBindings) binding.unsubscribe();
    this.netReceiveBindings.clear();
    for (const id of Array.from(this.sessions.keys())) this.destroySession(id);
  }

  /** Set the callback that delivers received topic payloads to a netreceive
   *  node's outlet. Wired in main.ts to objectInteraction.fireOutlet. */
  setNetReceiveEmit(fn: NetReceiveEmit | null): void {
    this.netReceiveEmit = fn;
  }

  /** Reconcile netreceive subscriptions against the live graph. Each
   *  netreceive node binds to the default peer session on its topic. Called
   *  from the graph "change" listener after `sync()`. */
  syncNetReceives(graph: PatchGraph): void {
    const defaultSession = this.getDefaultSession(graph);
    const live = new Set<string>();
    for (const node of graph.getNodes()) {
      if (node.type !== "netreceive") continue;
      live.add(node.id);
      const topic = (node.args[0] ?? "").trim();
      if (!topic || !defaultSession) {
        // Topic empty or no peer in the graph — drop any prior binding.
        this.unbindNetReceive(node.id);
        continue;
      }
      const existing = this.netReceiveBindings.get(node.id);
      if (existing && existing.session === defaultSession && existing.topic === topic) {
        continue;  // already bound correctly
      }
      this.unbindNetReceive(node.id);
      const unsubscribe = this.subscribe(defaultSession, topic, (payload) => {
        this.netReceiveEmit?.(node.id, payload);
      });
      this.netReceiveBindings.set(node.id, { session: defaultSession, topic, unsubscribe });
    }
    // Drop bindings whose node was deleted.
    for (const id of Array.from(this.netReceiveBindings.keys())) {
      if (!live.has(id)) this.unbindNetReceive(id);
    }
  }

  /** Send a netsend payload on its topic via the default peer. Returns true
   *  if delivered to the wire (data channel open), false otherwise. */
  sendFromNetSend(graph: PatchGraph, topic: string, payload: TopicPayload): boolean {
    const session = this.getDefaultSession(graph);
    if (!session) return false;
    if (!topic) return false;
    return session.send(topic, payload);
  }

  private unbindNetReceive(nodeId: string): void {
    const binding = this.netReceiveBindings.get(nodeId);
    if (!binding) return;
    binding.unsubscribe();
    this.netReceiveBindings.delete(nodeId);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private createSession(
    nodeId: string,
    role: "offerer" | "answerer",
    preservedTopics?: Map<string, Set<(payload: TopicPayload) => void>>,
  ): void {
    const session = new PeerSession({ role });
    const topicListeners = preservedTopics ?? new Map<string, Set<(payload: TopicPayload) => void>>();
    const unbindMessage = session.addMessageListener((topic, payload) => {
      const listeners = topicListeners.get(topic);
      if (!listeners) return;
      for (const fn of listeners) {
        try { fn(payload); } catch { /* ok */ }
      }
    });
    this.sessions.set(nodeId, { session, topicListeners, unbindMessage });
  }

  private destroySession(nodeId: string, keepTopics = false): void {
    const entry = this.sessions.get(nodeId);
    if (!entry) return;
    entry.unbindMessage();
    entry.session.close();
    if (!keepTopics) entry.topicListeners.clear();
    this.sessions.delete(nodeId);
  }

  private findEntryBySession(session: PeerSession): SessionEntry | null {
    for (const entry of this.sessions.values()) {
      if (entry.session === session) return entry;
    }
    return null;
  }
}
