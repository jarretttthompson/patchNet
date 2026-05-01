/**
 * Topic router — encodes/decodes topic-prefixed messages on a peer's
 * single control data channel.
 *
 * Phase 7A wire format: JSON `{t, p}` where `t` is the topic string and
 * `p` is the payload. Phase 7B+ may swap to MessagePack for compactness;
 * frame() / parse() are the only call sites that need to change.
 *
 * Payload type intentionally permissive — patchNet's control rate carries
 * bangs (null), floats (number), symbols (string), and lists (array).
 */
export type TopicPayload = null | number | string | boolean | TopicPayload[];

export interface TopicMessage {
  topic: string;
  payload: TopicPayload;
}

export function frame(topic: string, payload: TopicPayload): string {
  return JSON.stringify({ t: topic, p: payload });
}

export function parse(raw: string): TopicMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const t = (obj as { t?: unknown }).t;
    if (typeof t !== "string" || t.length === 0) return null;
    return { topic: t, payload: (obj as { p?: TopicPayload }).p ?? null };
  } catch {
    return null;
  }
}
