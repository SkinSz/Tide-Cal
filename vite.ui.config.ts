import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "frontend"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist"),
    // dist/ also holds dist/sidecar.mjs (the Node domain-core sidecar the
    // Rust shell spawns, built by `npm run sidecar:build`). Wiping it would
    // break every subsequent app launch until sidecar:build is re-run, so
    // ui:build only refreshes index.html + assets/ on top of it.
    emptyOutDir: false,
  },
});
