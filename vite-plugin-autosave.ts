import type { Plugin } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

export function autosavePlugin(): Plugin {
  const dir = resolve(process.cwd(), "autosaves");
  let pending: ((path: string) => void) | null = null;

  return {
    name: "patchnet-autosave",
    configureServer(server) {
      mkdirSync(dir, { recursive: true });

      server.middlewares.use("/__autosave", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          const { filename, content } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof filename !== "string" || typeof content !== "string") {
            res.statusCode = 400;
            res.end("bad request");
            return;
          }
          const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
          const fullPath = join(dir, safe);
          writeFileSync(fullPath, content, "utf8");
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ path: fullPath }));
          if (pending) {
            const resolver = pending;
            pending = null;
            resolver(fullPath);
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      server.middlewares.use("/__force-autosave", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const result = new Promise<string>((resolveFn, rejectFn) => {
          pending = resolveFn;
          setTimeout(() => {
            if (pending === resolveFn) {
              pending = null;
              rejectFn(new Error("timeout: no autosave received within 5s"));
            }
          }, 5000);
        });
        server.ws.send({ type: "custom", event: "patchnet:force-autosave" });
        try {
          const path = await result;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ path }));
        } catch (err) {
          res.statusCode = 504;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
