// Tide sidecar: stdio JSON-RPC host for the TS domain core.
//
// The Tauri (Rust) layer spawns this process with Node >= 23 (native TS type
// stripping) and speaks newline-delimited JSON over stdin/stdout. Every
// mutation is executed by src/persistence/database.ts's DC-07 ops, keeping
// change records + HLC/vector clocks authoritative in one place.
//
// Protocol (one JSON object per line):
//   request:  {"id": <num|string>, "op": "<name>", "args": {...}}
//   response: {"id": ..., "ok": true, "result": ...}
//             {"id": ..., "ok": false, "error": "..."}
//
// Ops:
//   ping                      -> {"pong": true, "device_id": "..."}
//   list_events {from_ms?, to_ms?}            -> CalendarEvent[]
//   create_event {input: EventInput}          -> CalendarEvent
//   update_event {id, input: EventInput}      -> CalendarEvent
//   delete_event {id}                         -> null

import { createInterface } from "node:readline";
import { EventCore } from "./event_core.ts";

type Json = Record<string, unknown>;

export type Dispatcher = (op: string, args: Json) => unknown;

export function makeDispatcher(core: EventCore): Dispatcher {
  return (op, args) => {
    switch (op) {
      case "ping":
        return { pong: true, device_id: core.selfDeviceId };
      case "list_events":
        return core.listEvents({
          fromMs: (args.from_ms as number | null | undefined) ?? null,
          toMs: (args.to_ms as number | null | undefined) ?? null,
        });
      case "create_event":
        return core.createEvent(args.input as never);
      case "update_event":
        return core.updateEvent(args.id as string, args.input as never);
      case "delete_event":
        core.deleteEvent(args.id as string);
        return null;
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
}

export function handleLine(dispatcher: Dispatcher, line: string): string {
  let response: Json;
  try {
    const req = JSON.parse(line) as { id?: unknown; op?: string; args?: Json };
    if (typeof req.op !== "string") throw new Error("missing op");
    try {
      response = {
        id: req.id ?? null,
        ok: true,
        result: dispatcher(req.op, req.args ?? {}),
      };
    } catch (e) {
      response = {
        id: req.id ?? null,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } catch (e) {
    response = {
      id: null,
      ok: false,
      error: `bad request line: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return JSON.stringify(response);
}

function main(): void {
  const dbPath = process.env.TIDE_DB_PATH;
  if (!dbPath) {
    console.error("tide-sidecar: TIDE_DB_PATH is required");
    process.exit(2);
  }
  const core = new EventCore(dbPath);
  const dispatch = makeDispatcher(core);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    process.stdout.write(handleLine(dispatch, trimmed) + "\n");
  });
  rl.on("close", () => {
    // Do NOT process.exit() here: pending async pipe writes would be cut
    // off. Closing the DB and letting the event loop drain exits cleanly.
    core.db.close();
  });
}

// Only auto-run the stdio loop when executed as a script (not under vitest).
const self = process.argv[1] ?? "";
if (process.env.VITEST === undefined && /sidecar\.(mjs|ts|cjs)$/.test(self)) {
  main();
}
