// Vitest setup: permanently neutralize noise-c.wasm's process.exit(1) handlers.
//
// The emscripten glue (node_modules/noise-c.wasm/src/noise-c.js) registers
// `process.on("unhandledRejection", () => process.exit(1))` when the module is
// evaluated — which happens LAZILY inside a worker when noise_transport first
// loads it. Any late transport rejection then kills the worker and the whole
// suite aborts with ERR_IPC_CHANNEL_CLOSED before any summary (TD-020).
//
// Because the glue may be evaluated per-worker at unpredictable times, a
// one-time removal is not enough. Instead we veto re-registration: after this
// setup, NO handler may re-register unhandledRejection/uncaughtException
// listeners that unconditionally exit. Legitimate (logging) handlers installed
// by guardProcess() / this setup are allowed through.
const vetoEvents = new Set(["unhandledRejection", "uncaughtException"]);
const origOn = process.on.bind(process);

type Handler = (...args: unknown[]) => void;

process.on = ((event: string, handler: Handler, ...rest: unknown[]) => {
  if (vetoEvents.has(event)) {
    const src = String(handler);
    if (src.includes("process.exit(1)") || /^\(\)\s*=>\s*process\.exit/.test(src)) {
      console.error(`[setup] vetoed ${event} exit-handler registration`);
      return process;
    }
  }
  return (origOn as unknown as (...a: unknown[]) => NodeJS.Process)(
    event,
    handler,
    ...rest,
  );
}) as typeof process.on;

console.error("[setup] noise-c exit-handler veto installed");
