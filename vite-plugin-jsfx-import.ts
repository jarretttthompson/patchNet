/**
 * Dev-only middleware that exposes the user's REAPER JSFX Effects folder
 * to the browser via GET /__jsfx-import. Used by the js~ library dialog's
 * "Import from Reaper" flow — the browser cannot read arbitrary local
 * directories itself, so this plugin reads them server-side and hands the
 * file contents back as JSON.
 *
 * Default root is `~/Library/Application Support/REAPER/Effects` on macOS.
 * Callers may pass `?path=` to point at a different folder. Skips obvious
 * non-JSFX assets (images, docs, includes, binaries) so the response stays
 * small even on dense effect collections.
 *
 * Lives only in dev — production builds will return 404 for this URL,
 * which the import button handles by surfacing a friendly error.
 */
import type { Plugin } from "vite";
import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import { join, relative, extname } from "node:path";

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".html", ".htm",
  ".txt", ".md", ".lua", ".eel", ".jsfx-inc", ".reabank",
  ".rpl", ".reapeaks", ".reaperthemezip", ".reaperkeymap",
  ".dll", ".so", ".dylib", ".zip", ".gz",
]);

const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB — JSFX scripts run far smaller.

interface ImportEntry {
  relpath: string;
  content: string;
}

interface WalkResult {
  files: ImportEntry[];
  skipped: number;
}

async function walkEffectsDir(root: string): Promise<WalkResult> {
  const files: ImportEntry[] = [];
  let skipped = 0;

  async function recurse(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (SKIP_EXTENSIONS.has(ext)) {
        skipped += 1;
        continue;
      }
      let size = 0;
      try {
        size = (await fs.stat(full)).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(full, "utf8");
      } catch {
        skipped += 1;
        continue;
      }
      // Quick binary check — null bytes in the first KB mean this isn't
      // JSFX source even if the extension/heuristic let it through.
      if (content.slice(0, 1024).includes("\0")) {
        skipped += 1;
        continue;
      }
      files.push({ relpath: relative(root, full), content });
    }
  }

  await recurse(root);
  return { files, skipped };
}

export function jsfxImportPlugin(): Plugin {
  const defaultRoot = join(homedir(), "Library", "Application Support", "REAPER", "Effects");

  return {
    name: "patchnet-jsfx-import",
    configureServer(server) {
      server.middlewares.use("/__jsfx-import", async (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const path = url.searchParams.get("path") || defaultRoot;
          // Catch obvious typos / non-existent paths up front so the browser
          // gets a clear 404 instead of an empty list it might mistake for
          // "no plugins found".
          let stat: import("node:fs").Stats;
          try {
            stat = await fs.stat(path);
          } catch {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: `Effects folder not found: ${path}` }));
            return;
          }
          if (!stat.isDirectory()) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: `Not a directory: ${path}` }));
            return;
          }
          const { files, skipped } = await walkEffectsDir(path);
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ root: path, files, skipped }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
