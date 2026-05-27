/**
 * Minimal Chrome DevTools Protocol client over a WebSocket.
 *
 * Deliberately tiny — no puppeteer/playwright dependency. Speaks raw CDP to a
 * Chrome started with --remote-debugging-port. Every command carries a 30s
 * timeout so a wedged browser fails loud instead of hanging the probe (the
 * original CDP attempt for the flicker check hung silently — never again).
 */
import WebSocket from "ws";

const CMD_TIMEOUT_MS = 30_000;

/** GET/PUT the CDP HTTP endpoint (target list / target creation). */
async function cdpHttp(port, path, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  if (!res.ok) throw new Error(`CDP HTTP ${method} ${path} -> ${res.status}`);
  return res.json();
}

/** Poll until the CDP endpoint answers, or throw after `timeoutMs`. */
export async function waitForCdp(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await cdpHttp(port, "/json/version");
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`CDP on port ${port} never responded: ${lastErr}`);
}

/** Create a fresh page target and return its metadata (incl. ws debugger URL). */
export async function createPageTarget(port) {
  // Chrome >= 111 requires PUT for /json/new; older builds accept GET.
  try {
    return await cdpHttp(port, "/json/new?about:blank", "PUT");
  } catch {
    return await cdpHttp(port, "/json/new?about:blank", "GET");
  }
}

/** Close a target by id (best effort). */
export async function closeTarget(port, targetId) {
  try {
    await cdpHttp(port, `/json/close/${targetId}`);
  } catch {
    /* target already gone */
  }
}

/** One attached CDP session bound to a single page target. */
export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
      this.ws.on("message", (data) => this._onMessage(data));
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      const fns = this.listeners.get(msg.method);
      if (fns) for (const fn of fns) fn(msg.params);
    }
  }

  /** Send a CDP command; resolves with its result, rejects on error/timeout. */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CMD_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribe to a CDP event (e.g. "Page.loadEventFired"). */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** Wait for a single CDP event, or reject after `timeoutMs`. */
  once(method, timeoutMs = CMD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`CDP event timed out: ${method}`)),
        timeoutMs,
      );
      const fn = (params) => {
        const fns = this.listeners.get(method);
        if (fns) this.listeners.set(method, fns.filter((f) => f !== fn));
        clearTimeout(timer);
        resolve(params);
      };
      this.on(method, fn);
    });
  }

  /**
   * Evaluate a JS expression in the page. `expr` may be an async IIFE.
   * Returns the value (returnByValue). Throws if the page code throws.
   */
  async evaluate(expr) {
    const res = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception?.description || d.text || "page exception";
      throw new Error(`Page evaluation failed: ${text}`);
    }
    return res.result?.value;
  }

  close() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}
