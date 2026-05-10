import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { autosavePlugin } from "./vite-plugin-autosave";
import { jsfxImportPlugin } from "./vite-plugin-jsfx-import";
import { phoneSensorPlugin } from "./vite-plugin-phone-sensor";

export default defineConfig({
  base: "/patchNet/",
  server: {
    // host: true so the dev server binds to the LAN, letting a phone scan the
    // QR code and reach the sensor page without any tunnel.
    host: true,
    // HTTPS is required so iOS Safari will grant DeviceOrientationEvent
    // permission — that API silently denies on non-secure origins (LAN IPs
    // are not secure contexts; only localhost gets a free pass). The
    // basic-ssl plugin generates a self-signed cert; the phone shows a
    // "Not Private" warning the first time, tap through once to accept.
    https: {},
  },
  plugins: [basicSsl(), autosavePlugin(), jsfxImportPlugin(), phoneSensorPlugin()],
});
