/**
 * Parse a user-entered YouTube URL into a video id + start offset.
 *
 * Accepts the five common URL shapes:
 *   - https://www.youtube.com/watch?v=VIDEOID
 *   - https://youtu.be/VIDEOID
 *   - https://www.youtube.com/embed/VIDEOID
 *   - https://m.youtube.com/watch?v=VIDEOID
 *   - https://www.youtube.com/shorts/VIDEOID
 *
 * Scheme is optional; we prefix `https://` so URL parsing succeeds.
 *
 * Start offset is read from `?t=` / `?start=` (also `&` variants). Accepted
 * forms: `90`, `90s`, `1m30s`, `1h2m3s`. Bad / missing → 0.
 */

export type ParseResult =
  | { ok: true; videoId: string; startSeconds: number }
  | { ok: false; reason: string };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeUrl(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "empty url" };

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "not a valid url" };
  }

  const host = url.hostname.toLowerCase();
  if (
    host !== "youtu.be"
    && host !== "youtube.com"
    && host !== "www.youtube.com"
    && host !== "m.youtube.com"
    && host !== "music.youtube.com"
  ) {
    return { ok: false, reason: "not a youtube url" };
  }

  const videoId = extractVideoId(host, url);
  if (!videoId) return { ok: false, reason: "missing video id" };
  if (!VIDEO_ID_RE.test(videoId)) return { ok: false, reason: "invalid video id" };

  const startSeconds = parseStartSeconds(url);
  return { ok: true, videoId, startSeconds };
}

function extractVideoId(host: string, url: URL): string | null {
  if (host === "youtu.be") {
    return url.pathname.slice(1).split("/")[0] || null;
  }
  // youtube.com & subdomains
  const v = url.searchParams.get("v");
  if (v) return v;
  // /embed/<id>, /shorts/<id>, /v/<id>
  const m = url.pathname.match(/^\/(embed|shorts|v)\/([^/?#]+)/);
  if (m) return m[2];
  return null;
}

function parseStartSeconds(url: URL): number {
  const raw = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (!raw) return 0;
  return parseTimeToken(raw);
}

/** "90" / "90s" / "1m30s" / "1h2m3s" → seconds. Returns 0 on parse failure. */
export function parseTimeToken(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (!s) return 0;
  // Bare integer
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // Composite h/m/s
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m) return 0;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const sec = parseInt(m[3] ?? "0", 10);
  const total = h * 3600 + min * 60 + sec;
  return Number.isFinite(total) ? total : 0;
}
