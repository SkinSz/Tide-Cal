import { defineConfig } from "vitest/config";

/**
 * Vitest config — adds ONE guard: the noise-c.wasm emscripten glue installs
 * `process.on("unhandledRejection") -> process.exit(1)` at module evaluation,
 * so any late transport rejection kills the whole worker instead of failing
 * one test (observed as ERR_IPC_CHANNEL_CLOSED suite aborts; see TD-020).
 *
 * The setup file loads the glue ONCE (so its handlers register), then swaps
 * them for logging guards. Later lazy requires hit the module cache and
 * never re-register. No production code changes; no validation weakened.
 */
export default defineConfig({
  test: {
    setupFiles: ["./tests/setup-noise-c-guard.ts"],
  },
});
