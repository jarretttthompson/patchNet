/**
 * Focus-throttle probe runner. Shares the flicker probe's lifecycle pattern
 * (isolated headless Chrome, OS-assigned debug port, owned --user-data-dir).
 *
 * Usage:
 *   node tests/focus-throttle/run.mjs            # auto: reuse :5173 or spawn
 *   PATCHNET_BASE_URL=https://localhost:5173/patchNet/ node tests/focus-throttle/run.mjs
 *   CHROME_BIN=/usr/bin/google-chrome   node tests/focus-throttle/run.mjs
 *
 * Exits 0 on PASS, 1 on FAIL/error.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { waitForCdp, createPageTarget, closeTarget, CdpSession } from "../flicker/cdp.mjs";
import { runFocusThrottleProbe } from "./probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");
const DEFAULT_SERVER = "https://localhost:5173/patchNet/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(500);
  return { proc, baseUrl };
}

async function spawnChrome(log) {
  const chromeBin = process.env.CHROME_BIN || "google-chrome";
  const userDataDir = mkdtempSync(join(tmpdir(), "patchnet-focus-throttle-chrome-"));
  log(`spawning isolated Chrome (${chromeBin}, profile ${userDataDir})`);
  const proc = spawn(chromeBin, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--ignore-certificate-errors",
    "--disable-gpu",
    // Do NOT pass --disable-background-timer-throttling or related flags —
    // we install our own deterministic rAF throttle in the page so the probe
    // doesn't depend on Chrome's real focus state.
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  proc.stderr.on("data", (b) => { stderr += b.toString(); });

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

export async function runFocusThrottle({ log = console.log } = {}) {
  const cleanup = [];
  const teardown = async () => {
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
    cleanup.length = 0;
  };

  try {
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

    const chrome = await spawnChrome(log);
    cleanup.push(async () => {
      await killProcess(chrome.proc);
      try {
        rmSync(chrome.userDataDir, { recursive: true, force: true });
      } catch { /* profile already gone */ }
    });
    const ver = await waitForCdp(chrome.port);
    log(`CDP up: ${ver.Browser} (port ${chrome.port})`);

    const target = await createPageTarget(chrome.port);
    const session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect();
    cleanup.push(async () => {
      session.close();
      await closeTarget(chrome.port, target.id);
    });

    const result = await runFocusThrottleProbe({
      session,
      baseUrl,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFocusThrottle({ log: (s) => console.log(s) });
  console.log("");
  if (result.ok) {
    console.log("✓ FOCUS-THROTTLE CHECK PASSED — meter loop survives main-window background throttle");
    process.exit(0);
  } else {
    console.log(`✗ FOCUS-THROTTLE CHECK FAILED — ${result.failure}`);
    if (result.positive) console.log(`  positive: ${JSON.stringify(result.positive)}`);
    if (result.negative) console.log(`  negative: ${JSON.stringify(result.negative)}`);
    process.exit(1);
  }
}
