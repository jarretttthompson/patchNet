/**
 * Dev-only middleware + WebSocket relay used by the [phoneTilt] object.
 *
 * Architecture:
 *   • patchNet (host) opens   ws://<lan-ip>:<port>/__sensor/ws?room=<id>&role=host
 *   • phone             opens ws://<lan-ip>:<port>/__sensor/ws?room=<id>&role=phone
 *     after loading      http://<lan-ip>:<port>/__sensor/page?room=<id>
 *   • This plugin pairs them by roomId and relays text frames host↔phone.
 *
 * The phone page is served inline (no separate file) so the plugin is one
 * file, easy to grep, and can't get out of sync. iOS Safari requires a
 * user gesture before DeviceOrientation permission can be requested — the
 * page handles that with a tap-to-start button.
 *
 * Lives only in dev. A built/deployed patchNet will not have this endpoint;
 * the [phoneTilt] object surfaces a clear "helper not running" status if
 * the WebSocket fails to open.
 */
import type { Plugin } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";

interface Room {
  host?: WebSocket;
  phone?: WebSocket;
}

const SENSOR_WS_PATH = "/__sensor/ws";
const SENSOR_PAGE_PATH = "/__sensor/page";
const SENSOR_INFO_PATH = "/__sensor/info";

/** Pick the first non-internal IPv4 address — same heuristic Vite uses when
 *  it prints "Network: http://x.y.z.w:5173" on dev start. */
function lanIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const entry of list) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : "");
}

/** Inline HTML/JS for the phone sensor page. Kept tiny on purpose. */
function sensorPageHtml(roomId: string): string {
  // The page derives its WebSocket URL from window.location, so it works
  // whether the user typed http://192.168.x.x:5173 or scanned a QR with
  // the same origin. No baked-in IP.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <title>patchNet sensor</title>
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; height: 100%; background: #111; color: #eee;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    body { display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 16px; text-align: center; padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom); }
    h1 { font-size: 18px; font-weight: 500; opacity: 0.7; margin: 0; }
    .room { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: 0.5; font-size: 12px; }
    button { font: inherit; font-size: 18px; padding: 16px 28px; border-radius: 14px;
      background: #2a7; color: #000; border: none; font-weight: 600; }
    button:disabled { background: #333; color: #666; }
    .readout { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 14px; line-height: 1.5; opacity: 0.85;
      background: #1a1a1a; padding: 12px 18px; border-radius: 10px; min-width: 220px; }
    .row { display: flex; justify-content: space-between; gap: 24px; }
    .row b { font-weight: 500; opacity: 0.6; }
    .status { font-size: 13px; opacity: 0.75; }
    .ok    { color: #6f6; }
    .warn  { color: #fc6; }
    .err   { color: #f88; }
  </style>
</head>
<body>
  <h1>patchNet sensor</h1>
  <div class="room">room ${roomId}</div>
  <button id="start">Tap to start</button>
  <div class="status" id="status">idle</div>
  <div class="readout" id="readout" hidden>
    <div class="row"><b>α (yaw)</b><span id="a">—</span></div>
    <div class="row"><b>β (pitch)</b><span id="b">—</span></div>
    <div class="row"><b>γ (roll)</b><span id="g">—</span></div>
  </div>
<script>
(() => {
  const room = ${JSON.stringify(roomId)};
  const startBtn = document.getElementById("start");
  const status = document.getElementById("status");
  const readout = document.getElementById("readout");
  const aEl = document.getElementById("a");
  const bEl = document.getElementById("b");
  const gEl = document.getElementById("g");
  let ws = null;
  let lastSend = 0;
  let pending = null;

  function setStatus(text, cls) {
    status.textContent = text;
    status.className = "status " + (cls || "");
  }

  function openWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + ${JSON.stringify(SENSOR_WS_PATH)} + "?room=" + encodeURIComponent(room) + "&role=phone";
    ws = new WebSocket(url);
    ws.onopen    = () => setStatus("connected — move your phone", "ok");
    ws.onclose   = () => setStatus("disconnected — reload to retry", "warn");
    ws.onerror   = () => setStatus("connection error", "err");
  }

  // Throttle to ~60Hz on the wire — DeviceOrientation can fire faster on some
  // devices, and patchNet doesn't need more than that.
  function maybeSend() {
    if (!ws || ws.readyState !== 1 || !pending) return;
    const now = performance.now();
    if (now - lastSend < 16) return;
    lastSend = now;
    ws.send(JSON.stringify(pending));
    pending = null;
  }

  function onOrientation(ev) {
    const a = ev.alpha == null ? 0 : ev.alpha;   // 0..360 (compass-ish)
    const b = ev.beta  == null ? 0 : ev.beta;    // -180..180 (front-back tilt)
    const g = ev.gamma == null ? 0 : ev.gamma;   // -90..90 (left-right tilt)
    pending = { a, b, g, t: Date.now() };
    aEl.textContent = a.toFixed(1);
    bEl.textContent = b.toFixed(1);
    gEl.textContent = g.toFixed(1);
    maybeSend();
  }

  async function start() {
    startBtn.disabled = true;
    setStatus("requesting permission…");
    try {
      // iOS 13+ requires explicit permission, gated on a user gesture.
      const anyOrientation = window.DeviceOrientationEvent;
      if (anyOrientation && typeof anyOrientation.requestPermission === "function") {
        const result = await anyOrientation.requestPermission();
        if (result !== "granted") {
          setStatus("permission denied", "err");
          startBtn.disabled = false;
          return;
        }
      }
    } catch (err) {
      setStatus("permission error: " + err, "err");
      startBtn.disabled = false;
      return;
    }
    readout.hidden = false;
    startBtn.hidden = true;
    window.addEventListener("deviceorientation", onOrientation, true);
    openWs();
    setInterval(maybeSend, 16);
  }

  startBtn.addEventListener("click", start);
})();
</script>
</body>
</html>`;
}

export function phoneSensorPlugin(): Plugin {
  const rooms = new Map<string, Room>();
  let wss: WebSocketServer | null = null;

  function relay(roomId: string, fromRole: "host" | "phone", payload: string): void {
    const room = rooms.get(roomId);
    if (!room) return;
    const target = fromRole === "phone" ? room.host : room.phone;
    if (target && target.readyState === 1) target.send(payload);
  }

  function attach(roomId: string, role: "host" | "phone", ws: WebSocket): void {
    let room = rooms.get(roomId);
    if (!room) {
      room = {};
      rooms.set(roomId, room);
    }
    // If a previous connection in the same role is still open, close it —
    // the newest claim wins (e.g., user re-scans the QR on a second phone).
    const prior = role === "host" ? room.host : room.phone;
    if (prior && prior.readyState === 1) {
      try { prior.close(1000, "replaced"); } catch { /* ignore */ }
    }
    room[role] = ws;

    // Notify the host whenever the phone connects/disconnects so the object
    // can flip its `connected` outlet without polling.
    const notify = (state: "phone-connected" | "phone-disconnected") => {
      const host = rooms.get(roomId)?.host;
      if (host && host.readyState === 1) host.send(JSON.stringify({ kind: state }));
    };
    if (role === "phone") notify("phone-connected");

    ws.on("message", (data) => {
      // Forward as text. Frames are small JSON; no need to inspect.
      const text = typeof data === "string" ? data : data.toString("utf8");
      relay(roomId, role, text);
    });
    ws.on("close", () => {
      const r = rooms.get(roomId);
      if (!r) return;
      if (r[role] === ws) r[role] = undefined;
      if (role === "phone") notify("phone-disconnected");
      if (!r.host && !r.phone) rooms.delete(roomId);
    });
    ws.on("error", () => { /* browser will see close; nothing to log */ });
  }

  return {
    name: "patchnet-phone-sensor",
    configureServer(server) {
      // Info route — returns the Mac's LAN IPv4 + port so the patchNet UI can
      // build a QR-friendly URL. Without this the QR would encode "localhost"
      // and a phone couldn't reach it.
      server.middlewares.use(SENSOR_INFO_PATH, (req, res) => {
        const ip = lanIPv4();
        // server.config.server.port is the requested port; the actual bound
        // port lives on the underlying http server's address.
        const addr = server.httpServer?.address();
        const port = addr && typeof addr === "object" ? addr.port : null;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ ip, port }));
      });

      // Page route — serve inline HTML so a phone can load the sensor without
      // going through any framework code. Room id comes from ?room=.
      server.middlewares.use(SENSOR_PAGE_PATH, (req, res) => {
        const params = parseQuery(req.url ?? "/");
        const roomId = params.get("room") ?? "";
        if (!roomId) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Missing ?room=");
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(sensorPageHtml(roomId));
      });

      // Attach a WS server to Vite's existing HTTP server, scoped to its own
      // path so we don't collide with HMR's WebSocket.
      if (server.httpServer && !wss) {
        wss = new WebSocketServer({ noServer: true });
        server.httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
          const url = req.url ?? "";
          if (!url.startsWith(SENSOR_WS_PATH)) return;
          const params = parseQuery(url);
          const roomId = params.get("room") ?? "";
          const role = params.get("role");
          if (!roomId || (role !== "host" && role !== "phone")) {
            socket.destroy();
            return;
          }
          wss!.handleUpgrade(req, socket, head, (ws) => {
            attach(roomId, role, ws);
          });
        });
      }
    },
  };
}
