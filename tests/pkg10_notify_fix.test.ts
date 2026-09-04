// pkg10 F2 fix verification: id:null notification line → no reply envelope,
// mdns_event dispatched. Op request still gets its correlated envelope.
import { describe, expect, test } from "vitest";
import { handleLine } from "../src/persistence/bridges/sidecar_server.ts";

describe("pkg10 F2: Rust id:null notifications consumed, not op-dispatched", () => {
  test("id:null + notification field → dispatched, empty reply (no stdout corruption)", async () => {
    let mdnsCalls = 0;
    const dispatcher = (op: string): unknown => {
      if (op === "mdns_event") mdnsCalls++;
      return null;
    };
    const out = await handleLine(
      dispatcher,
      JSON.stringify({
        id: null,
        notification: "mdns_event",
        args: { kind: "added", instance_name: "abcdef12-9999", host: "10.0.0.5", port: 47471 },
      }),
    );
    expect(mdnsCalls).toBe(1);
    expect(out).toBe(""); // nothing written to stdout → no Rust-side misparse
  });

  test("id:null + notification UNKNOWN name → dropped silently, still no envelope", async () => {
    const out = await handleLine(
      () => null,
      JSON.stringify({ id: null, notification: "some_future", args: {} }),
    );
    expect(out).toBe("");
  });

  test("normal op request still returns its correlated envelope", async () => {
    const out = await handleLine(
      (op: string) => (op === "ping" ? { pong: true } : null),
      JSON.stringify({ id: 5, op: "ping", args: {} }),
    );
    expect(out).toContain('"id":5');
    expect(out).toContain('"ok":true');
  });
});
