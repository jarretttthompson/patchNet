/**
 * Generates the deterministic test video used by the flicker probe.
 *
 * No ffmpeg on this box, so the clip is encoded inside Chrome itself:
 * an animated <canvas> is piped through captureStream() into a MediaRecorder
 * (VP8/WebM). The result is a small clip with clearly distinct frames — the
 * probe needs (a) motion while playing, so it can prove it detects change,
 * and (b) a video Chrome can decode natively (its own MediaRecorder output).
 *
 * The clip is cached on disk; regeneration only happens when it is missing.
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** In-page recorder: animates a canvas for ~2.5s, returns base64 WebM. */
const RECORD_EXPR = `(async () => {
  const W = 160, H = 120;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const cx = cv.getContext("2d");
  const stream = cv.captureStream(30);
  const mime = "video/webm;codecs=vp8";
  if (!MediaRecorder.isTypeSupported(mime)) throw new Error("VP8 WebM unsupported");
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  let f = 0;
  const draw = () => {
    // Every frame is visibly different: hue sweep + a bar that travels across.
    cx.fillStyle = "hsl(" + ((f * 11) % 360) + ",65%,45%)";
    cx.fillRect(0, 0, W, H);
    cx.fillStyle = "#ffffff";
    cx.fillRect((f * 9) % W, 36, 28, 48);
    cx.fillStyle = "#000000";
    cx.font = "22px sans-serif";
    cx.fillText("F" + f, 6, 24);
    f++;
  };
  draw();
  rec.start();
  const iv = setInterval(draw, 33);
  await new Promise((r) => setTimeout(r, 2500));
  clearInterval(iv);
  rec.stop();
  await stopped;

  const blob = new Blob(chunks, { type: "video/webm" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
})()`;

/**
 * Ensure the clip exists at `clipPath`. If missing, record one using the
 * provided CdpSession (which must be attached to any live page — about:blank
 * is fine). Returns metadata about the clip.
 */
export async function ensureClip(session, clipPath) {
  if (existsSync(clipPath) && statSync(clipPath).size > 0) {
    return { path: clipPath, bytes: statSync(clipPath).size, generated: false };
  }
  const b64 = await session.evaluate(RECORD_EXPR);
  if (!b64 || typeof b64 !== "string") {
    throw new Error("clip generation returned no data");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 1000) {
    throw new Error(`clip generation produced only ${buf.length} bytes`);
  }
  mkdirSync(dirname(clipPath), { recursive: true });
  writeFileSync(clipPath, buf);
  return { path: clipPath, bytes: buf.length, generated: true };
}
