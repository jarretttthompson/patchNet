/**
 * Repeatable flicker-probe runner.
 *
 * Owns the full lifecycle so a flicker regression cannot slip past an
 * eyeball check:
 *   1. Reuse a running patchNet dev server, or spawn a private one.
 *   2. Spawn a dedicated, isolated headless Chrome (its own --user-data-dir
 *      and an OS-assigned debug port) that the probe owns exclusively — two
 *      DevTools clients on one port wedge Chrome, which is what hung the
 *      original probe attempt.
 *   3. Generate the test clip if missing.
 *   4. Run the probe; assert; tear everything down.
 *
 * Usage:
 *   node tests/flicker/run.mjs          # auto: reuse :5173 or spawn a server
 *   PATCHNET_BASE_URL=https://localhost:5173/patchNet/ node tests/flicker/run.mjs
 *   CHROME_BIN=/usr/bin/google-chrome   node tests/flicker/run.mjs
 *
 * Exits 0 on PASS, 1 on FAIL/error.
 */
import { spawn } from "node:child_process";
import {
  mkdtempSync, rmSync, existsSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { waitForCdp, createPageTarget, closeTarget, CdpSession } from "./cdp.mjs";
import { ensureClip } from "./gen-clip.mjs";
import { runFlickerProbe } from "./probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");
const CLIP_PATH = join(HERE, "clip.webm");
const CLIP_REL = "tests/flicker/clip.webm"; // path Vite serves it under
const DEFAULT_SERVER = "https://localhost:5173/patchNet/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM a child process and wait for it to actually exit (SIGKILL after 3s). */
function killProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, 3000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
    try { proc.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

/** GET an https URL, ignoring the dev server's self-signed cert. */
function isReachable(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, timeout: 3000 },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** Spawn a private Vite dev server; resolve once it reports ready. */
async function spawnViteServer(log) {
  const port = 5300 + Math.floor(Math.random() * 600);
  log(`spawning private dev server on :${port}`);
  const proc = spawn(
    "npx", ["vite", "--port", String(port), "--strictPort"],
    { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const baseUrl = `https://localhost:${port}/patchNet/`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dev server did not become ready in 30s")),
      30_000,
    );
    const onData = (buf) => {
      if (/ready in|Local:/.test(buf.toString())) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        resolve();
      }
    };
    proc.stdout.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited early (code ${code})`));
    });
  });
  // Give Vite a beat to finish binding the socket after the ready banner.
  await sleep(500);
  return { proc, baseUrl };
}

/** Spawn an isolated headless Chrome; return proc + its CDP port. */
async function spawnChrome(log) {
  const chromeBin = process.env.CHROME_BIN || "google-chrome";
  const userDataDir = mkdtempSync(join(tmpdir(), "patchnet-flicker-chrome-"));
  log(`spawning isolated Chrome (${chromeBin}, profile ${userDataDir})`);
  const proc = spawn(chromeBin, [
    "--headless=new",
    "--remote-debugging-port=0", // OS picks a free port → no collisions
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--ignore-certificate-errors",
    "--disable-gpu",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  proc.stderr.on("data", (b) => { stderr += b.toString(); });

  // Chrome writes the chosen debug port to <profile>/DevToolsActivePort.
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  let port = 0;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Chrome exited early (code ${proc.exitCode}): ${stderr}`);
    }
    if (existsSync(portFile)) {
      const p = parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10);
      if (p > 0) { port = p; break; }
    }
    await sleep(150);
  }
  if (!port) throw new Error("Chrome never reported a DevTools port");
  return { proc, port, userDataDir };
}

/**
 * Run the full flicker check. Returns the probe result augmented with
 * lifecycle info. `result.ok` is the verdict.
 */
export async function runFlicker({ log = console.log } = {}) {
  const cleanup = [];
  const teardown = async () => {
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
    cleanup.length = 0;
  };

  try {
    // ── Dev server: reuse or spawn ────────────────────────────────────
    let baseUrl = process.env.PATCHNET_BASE_URL || DEFAULT_SERVER;
    if (await isReachable(baseUrl)) {
      log(`reusing dev server at ${baseUrl}`);
    } else if (process.env.PATCHNET_BASE_URL) {
      throw new Error(`PATCHNET_BASE_URL not reachable: ${baseUrl}`);
    } else {
      const vite = await spawnViteServer(log);
      baseUrl = vite.baseUrl;
      cleanup.push(() => killProcess(vite.proc));
    }
    const clipUrl = baseUrl.replace(/\/$/, "/") + CLIP_REL;

    // ── Isolated Chrome ───────────────────────────────────────────────
    const chrome = await spawnChrome(log);
    cleanup.push(async () => {
      // Wait for Chrome to fully exit before removing its profile, otherwise
      // it writes into the dir mid-rmSync and the removal throws ENOTEMPTY.
      await killProcess(chrome.proc);
      try {
        rmSync(chrome.userDataDir, { recursive: true, force: true });
      } catch { /* profile already gone */ }
    });
    const ver = await waitForCdp(chrome.port);
    log(`CDP up: ${ver.Browser} (port ${chrome.port})`);

    // ── CDP session + test clip ───────────────────────────────────────
    const target = await createPageTarget(chrome.port);
    const session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect();
    cleanup.push(async () => {
      session.close();
      await closeTarget(chrome.port, target.id);
    });

    const clip = await ensureClip(session, CLIP_PATH);
    log(`test clip: ${clip.bytes} bytes${clip.generated ? " (generated)" : " (cached)"}`);

    // ── Probe ─────────────────────────────────────────────────────────
    const result = await runFlickerProbe({
      session,
      baseUrl,
      clipUrl,
      pausedSamples: Number(process.env.PATCHNET_FLICKER_SAMPLES) || 24,
      log: (s) => log(`  · ${s}`),
    });
    await teardown();
    return result;
  } catch (err) {
    await teardown();
    return {
      ok: false,
      failure: `runner error: ${err && err.message ? err.message : err}`,
      steps: [],
    };
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFlicker({ log: (s) => console.log(s) });
  console.log("");
  if (result.ok) {
    console.log("✓ FLICKER CHECK PASSED — paused VFX chain is pixel-stable");
    process.exit(0);
  } else {
    console.log(`✗ FLICKER CHECK FAILED — ${result.failure}`);
    if (result.playing) console.log(`  playing: ${JSON.stringify(result.playing)}`);
    if (result.paused) console.log(`  paused:  ${JSON.stringify(result.paused)}`);
    process.exit(1);
  }
}
