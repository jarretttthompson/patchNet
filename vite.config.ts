import { defineConfig } from "vite";
import { autosavePlugin } from "./vite-plugin-autosave";

export default defineConfig({
  base: "/patchNet/",
  plugins: [autosavePlugin()],
});
