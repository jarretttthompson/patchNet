import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { autosavePlugin } from "./vite-plugin-autosave";
import { jsfxImportPlugin } from "./vite-plugin-jsfx-import";
import { phoneSensorPlugin } from "./vite-plugin-phone-sensor";

// Platform is set via the VITE_PLATFORM env var.
//   browser build (default): VITE_PLATFORM unset or "browser"
//   Tauri build:             VITE_PLATFORM=native  (set by tauri:dev / tauri:build scripts)
const platform = (process.env.VITE_PLATFORM ?? "browser") as "browser" | "native";

// HTTPS is only needed in browser mode (phone sensor requires a secure
// context on LAN IPs). In native/Tauri mode, WKWebView rejects self-signed
// certs, so we drop to plain HTTP on localhost.
const useHttps = platform === "browser";

export default defineConfig({
  base: "/patchNet/",
  define: {
    // Injected at compile time — tree-shakes platform-only code in production.
    __PLATFORM__: JSON.stringify(platform),
  },
  server: {
    // host: true so the dev server binds to the LAN, letting a phone scan the
    // QR code and reach the sensor page without any tunnel.
    host: true,
    // Native mode: lock to 5173 so tauri.conf.json devUrl always matches.
    // Browser mode: let Vite pick the next available port if 5173 is taken.
    ...(platform === "native" ? { port: 5173, strictPort: true } : {}),
    // HTTPS is required so iOS Safari will grant DeviceOrientationEvent
    // permission — that API silently denies on non-secure origins (LAN IPs
    // are not secure contexts; only localhost gets a free pass). The
    // basic-ssl plugin generates a self-signed cert; the phone shows a
    // "Not Private" warning the first time, tap through once to accept.
    // Disabled in native mode — WKWebView rejects self-signed certs.
    ...(useHttps ? { https: {} } : {}),
  },
  plugins: [
    ...(useHttps ? [basicSsl()] : []),
    autosavePlugin(),
    jsfxImportPlugin(),
    phoneSensorPlugin(),
  ],
});
