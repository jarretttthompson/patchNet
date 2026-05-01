import { frame, parse, type TopicPayload } from "./topicRouter";

/**
 * PeerSession — wraps a single `RTCPeerConnection` plus one ordered+reliable
 * data channel ("pn-control") for topic-routed control-rate messages.
 *
 * Phase 7A is manual-SDP only: the local side calls `createOffer()` to
 * produce an SDP blob, the remote side calls `acceptOffer()` to produce an
 * answer blob, and the local side closes the loop with `acceptAnswer()`.
 * No signaling server, no peer-list, no media tracks.
 *
 * Lifecycle:
 *   - new PeerSession({ role })
 *   - role "offerer":  createOffer() → emit offerSdp
 *                      acceptAnswer(sdp) when the remote answer arrives
 *   - role "answerer": acceptOffer(sdp) → emit answerSdp
 *   - either side: send(topic, payload), addMessageListener(fn), close()
 *
 * Status emits a single string per transition so callers can drive a UI pill
 * and a status outlet without subscribing to the underlying ICE machinery.
 */
export type PeerRole = "offerer" | "answerer";

export type PeerStatus =
  | "idle"
  | "creating-offer"
  | "awaiting-answer"
  | "accepting-offer"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export type StatusListener = (status: PeerStatus, detail?: string) => void;
export type MessageListener = (topic: string, payload: TopicPayload) => void;

interface PeerSessionOptions {
  role: PeerRole;
  /** Optional ICE servers. Phase 7A defaults to none — works on LAN /
   *  Thunderbolt bridge / same machine without help. WAN with NAT will need
   *  STUN at minimum (Phase 7B concern). */
  iceServers?: RTCIceServer[];
  /** Test seam: inject a custom RTCPeerConnection constructor. */
  pcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
}

export class PeerSession {
  readonly role: PeerRole;
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private status: PeerStatus = "idle";
  private statusListeners = new Set<StatusListener>();
  private messageListeners = new Set<MessageListener>();
  private iceCompletePromise: Promise<void>;
  private destroyed = false;

  constructor(opts: PeerSessionOptions) {
    this.role = opts.role;
    const config: RTCConfiguration = { iceServers: opts.iceServers ?? [] };
    this.pc = opts.pcFactory ? opts.pcFactory(config) : new RTCPeerConnection(config);

    // Wait for ICE candidate gathering to complete before exporting an SDP.
    // Manual-SDP mode requires the *finalized* SDP (with all candidates baked
    // in via the trickle-in-blob trick — much simpler than separate ICE blob
    // exchanges, at the cost of waiting ~1s for gathering).
    this.iceCompletePromise = new Promise<void>((resolve) => {
      if (this.pc.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const onChange = () => {
        if (this.pc.iceGatheringState === "complete") {
          this.pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      this.pc.addEventListener("icegatheringstatechange", onChange);
    });

    this.pc.addEventListener("connectionstatechange", () => this.onPcStateChange());
    this.pc.addEventListener("datachannel", (ev) => this.bindDataChannel(ev.channel));

    if (this.role === "offerer") {
      // The offerer creates the channel; answerer receives it via "datachannel".
      this.bindDataChannel(this.pc.createDataChannel("pn-control", { ordered: true }));
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  getStatus(): PeerStatus { return this.status; }

  addStatusListener(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  addMessageListener(fn: MessageListener): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  /** Offerer: produce the SDP blob to hand to the remote. Awaits ICE
   *  gathering so the blob is self-contained. */
  async createOffer(): Promise<string> {
    if (this.role !== "offerer") throw new Error("createOffer requires role=offerer");
    this.setStatus("creating-offer");
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.iceCompletePromise;
    this.setStatus("awaiting-answer");
    return JSON.stringify(this.pc.localDescription);
  }

  /** Answerer: accept the offerer's SDP blob, return the answer blob. */
  async acceptOffer(offerBlob: string): Promise<string> {
    if (this.role !== "answerer") throw new Error("acceptOffer requires role=answerer");
    this.setStatus("accepting-offer");
    const offer = parseSdpBlob(offerBlob);
    if (!offer) throw new Error("invalid offer blob");
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.iceCompletePromise;
    this.setStatus("connecting");
    return JSON.stringify(this.pc.localDescription);
  }

  /** Offerer: close the loop with the answerer's SDP blob. */
  async acceptAnswer(answerBlob: string): Promise<void> {
    if (this.role !== "offerer") throw new Error("acceptAnswer requires role=offerer");
    const answer = parseSdpBlob(answerBlob);
    if (!answer) throw new Error("invalid answer blob");
    await this.pc.setRemoteDescription(answer);
    this.setStatus("connecting");
  }

  /** Send a control-rate message. Returns false if the channel isn't open
   *  yet — caller decides whether to drop or buffer. */
  send(topic: string, payload: TopicPayload): boolean {
    if (!this.dc || this.dc.readyState !== "open") return false;
    try {
      this.dc.send(frame(topic, payload));
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.dc?.close(); } catch { /* ok */ }
    try { this.pc.close(); } catch { /* ok */ }
    this.dc = null;
    if (this.status !== "failed") this.setStatus("disconnected");
    this.statusListeners.clear();
    this.messageListeners.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private bindDataChannel(channel: RTCDataChannel): void {
    this.dc = channel;
    channel.addEventListener("open", () => {
      // Connection becomes useful only when the data channel opens; the pc
      // "connected" state can briefly precede this.
      if (this.status !== "connected") this.setStatus("connected");
    });
    channel.addEventListener("close", () => {
      if (this.status === "connected") this.setStatus("disconnected");
    });
    channel.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;  // 7A is text-only
      const msg = parse(ev.data);
      if (!msg) return;
      for (const fn of this.messageListeners) {
        try { fn(msg.topic, msg.payload); } catch { /* listener errors don't kill the session */ }
      }
    });
  }

  private onPcStateChange(): void {
    const state = this.pc.connectionState;
    if (state === "failed") this.setStatus("failed", "ice connection failed");
    else if (state === "disconnected" && this.status === "connected") this.setStatus("disconnected");
    else if (state === "closed" && this.status !== "disconnected" && this.status !== "failed") {
      this.setStatus("disconnected");
    }
  }

  private setStatus(next: PeerStatus, detail?: string): void {
    if (this.status === next) return;
    this.status = next;
    for (const fn of this.statusListeners) {
      try { fn(next, detail); } catch { /* ok */ }
    }
  }
}

function parseSdpBlob(blob: string): RTCSessionDescriptionInit | null {
  try {
    const obj = JSON.parse(blob);
    if (!obj || typeof obj !== "object") return null;
    const type = (obj as { type?: unknown }).type;
    const sdp  = (obj as { sdp?: unknown }).sdp;
    if ((type !== "offer" && type !== "answer") || typeof sdp !== "string") return null;
    return { type, sdp };
  } catch {
    return null;
  }
}
