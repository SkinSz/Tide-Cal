// Builds dist/sidecar.mjs (npm run sidecar:build). Same bundle options as
// before; additionally compiles the build identity (scripts/build_info.mjs)
// into the bundle. `--outfile=<path>` overrides the output.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "./build_info.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv.slice(2).find((a) => a.startsWith("--outfile="));
const outfile = arg ? arg.slice("--outfile=".length) : join(root, "dist", "sidecar.mjs");
const info = readBuildInfo(root);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

await build({
  entryPoints: [join(root, "src/persistence/bridges/sidecar_server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["better-sqlite3"],
  outfile,
  logLevel: "info",
  define: {
    __TIDE_BUILD_COMMIT__: JSON.stringify(info.commit),
    __TIDE_BUILD_DIRTY__: JSON.stringify(info.dirty),
    __TIDE_BUILD_LABEL__: JSON.stringify(info.label),
    __TIDE_VERSION__: JSON.stringify(version),
  },
});
