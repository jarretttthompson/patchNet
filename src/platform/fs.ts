/**
 * src/platform/fs.ts
 *
 * File system abstraction.
 *
 * Browser:  save → download link,  open → <input type=file>
 * Native:   save → Tauri native save dialog + fs write
 *           open → Tauri native open dialog + fs read
 *
 * Tauri API imports are dynamic so this file tree-shakes cleanly in the
 * browser build (no Tauri SDK in node_modules for browser builds).
 */

import { isNative } from "./index";

// ─── Save ────────────────────────────────────────────────────────────────────

/**
 * Save text content to a file.
 *
 * Browser:  triggers a download with the given filename.
 * Native:   opens a native Save As dialog; returns the chosen path or null
 *           if the user cancelled.
 */
export async function saveTextFile(
  content: string,
  defaultName: string,
): Promise<string | null> {
  if (isNative) {
    return saveTextFileNative(content, defaultName);
  }
  saveTextFileBrowser(content, defaultName);
  return defaultName;
}

function saveTextFileBrowser(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function saveTextFileNative(
  content: string,
  defaultName: string,
): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — @tauri-apps/plugin-dialog not installed until tauri init
    const { save }   = await import("@tauri-apps/plugin-dialog");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — @tauri-apps/plugin-fs not installed until tauri init
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "patchNet patch", extensions: ["patchnet"] }],
    });
    if (!path) return null;
    await writeTextFile(path, content);
    return path;
  } catch (err) {
    console.error("[platform/fs] saveTextFileNative failed:", err);
    return null;
  }
}

// ─── Open ─────────────────────────────────────────────────────────────────────

export interface OpenedFile {
  name: string;
  content: string;
}

/**
 * Open a text file.
 *
 * Browser:  opens a file picker via a hidden <input>.
 * Native:   opens a native Open dialog.
 *
 * Returns null if the user cancelled.
 */
export async function openTextFile(): Promise<OpenedFile | null> {
  if (isNative) {
    return openTextFileNative();
  }
  return openTextFileBrowser();
}

function openTextFileBrowser(): Promise<OpenedFile | null> {
  return new Promise(resolve => {
    const input       = document.createElement("input");
    input.type        = "file";
    input.accept      = ".patchnet,.txt";
    input.onchange    = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () =>
        resolve({ name: file.name, content: reader.result as string });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function openTextFileNative(): Promise<OpenedFile | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — @tauri-apps/plugin-dialog not installed until tauri init
    const { open }    = await import("@tauri-apps/plugin-dialog");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — @tauri-apps/plugin-fs not installed until tauri init
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({
      multiple: false,
      filters: [{ name: "patchNet patch", extensions: ["patchnet", "txt"] }],
    });
    if (!path || typeof path !== "string") return null;
    const content = await readTextFile(path);
    const name    = path.split(/[\\/]/).pop() ?? path;
    return { name, content };
  } catch (err) {
    console.error("[platform/fs] openTextFileNative failed:", err);
    return null;
  }
}
