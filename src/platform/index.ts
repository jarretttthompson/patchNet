/**
 * src/platform/index.ts
 *
 * Runtime platform detection and shared capability flags.
 *
 * Build-time: Vite injects __PLATFORM__ via define in vite.config.ts.
 *   - "browser"  → standard web build (npm run dev / npm run build)
 *   - "native"   → Tauri desktop build (npm run tauri:dev / tauri:build)
 *
 * Runtime fallback: if __TAURI__ is present on window (Tauri always injects
 * it) we treat the session as native regardless of the build flag. This keeps
 * things correct during local tauri:dev hot-reloads.
 */

declare const __PLATFORM__: "browser" | "native";

export type Platform = "browser" | "native";

function detectPlatform(): Platform {
  // Build-time constant injected by Vite. Falls back gracefully if somehow
  // undefined (e.g. unit tests or non-Vite environments).
  const buildFlag =
    typeof __PLATFORM__ !== "undefined" ? __PLATFORM__ : "browser";

  // Runtime presence of the Tauri global overrides the build flag — covers
  // the case where someone loads a browser build inside the Tauri shell.
  const hasTauri =
    typeof window !== "undefined" &&
    "__TAURI__" in window;

  return hasTauri ? "native" : buildFlag;
}

export const PLATFORM: Platform = detectPlatform();

/** True when running inside the Tauri desktop shell. */
export const isNative: boolean = PLATFORM === "native";

/** True when running in a standard browser tab. */
export const isBrowser: boolean = PLATFORM === "browser";

/**
 * Returns a human-readable label for the current platform.
 * Shown in the status bar and about dialog.
 */
export function platformLabel(): string {
  return isNative ? "desktop" : "browser";
}
