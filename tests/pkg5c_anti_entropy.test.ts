// Pkg5c — anti-entropy session symmetry regression (Pkg5b completion).
//
// CONTRACT BASIS (docs/contracts/DC-08_sync_message_protocol.md):
//   §4  CANONICAL ANTI-ENTROPY EXCHANGE: "Both sides run the SAME role. Each
//       independently pulls what IT needs; there is no coordinator, no master, no
//       push authority (INVARIANT 11)." The canonical sequence shows BOTH pulls
//       (A pulls from B AND B pulls from A) inside ONE session, and the SYMMETRY
//       property states: "A pulling from B and B pulling from A are independent
//       exchanges multiplexed over one session. Neither waits for the other's pull
//       to start its own."
//   §7  "NO PUSH AUTHORITY. A peer can never make us apply anything; it can only
//       answer our pulls." — an initiator-push mechanism is contractually excluded.
//   §4  CONVERGENCE: "repeated opportunistic sessions reach eventual consistency".
//
// PRODUCT SHAPE: the engine already implements §4 exactly — the responder runs its
// own full `runSession` (sidecar_server.ts onInbound → runEngineSession), so the
// responder PULLS what it needs (including its own new data being fetched by the
// initiator... no: the responder pulls the INITIATOR's new data; its own new data
// leaves via it SERVING the initiator's pull). One TCP connection = one session =
// both directions.
//
// WHAT THESE TESTS PIN:
//   1. Single-session bidirectional convergence with new data on BOTH sides: after
//      the ONE session (both engine runs complete), both devices converge — and the
//      wire shows CHANGES_REQUEST issued in BOTH directions (responder pull exists).
//   2. Real-TCP mirror of the SC9 phase-2 shape (responder holds new data, initiator
//      pulls; convergence asserted only after BOTH engine runs complete, because §4
//      makes them independent) — 3 runs, deterministic.
//   3. Negative pin: a peer with nothing needed sends no CHANGES_REQUEST (the M-4
//      corrected behavior is preserved — no phantom self-requests either).
import { describe, expect, test } from "vitest";
import { serveSync, connectSync } from "../src/network/sync_runtime.ts";
import {
  guardProcess,
  makeDevice,
  pairDevices,
  oracle,
  msgPipePair,
  type Device,
} from "./probes/sync_probe_helpers.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import type { SyncTransport } from "../src/sync/sync_engine.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

interface TwoEndedSession {
  fromLog: Array<{ type: string }>;
  toLog: Array<{ type: string }>;
  fromStats: Record<string, number>;
  toStats: Record<string, number>;
}

/**
 * One anti-entropy session between from→to over in-memory pipes with the engine
 * running on BOTH ends (the real runtime shape: responder pulls too). Returns the
 * wire logs and session stats of both directions.
 */
async function sessionBothEnds(from: Device, to: Device): Promise<TwoEndedSession> {
  const [rawFrom, rawTo] = msgPipePair();
  const wrap = (raw: ReturnType<typeof msgPipePair>[0]): SyncTransport =>
    ({
      send: async (msg: unknown) => {
        await raw.send(msg);
      },
      receive: async () => (await raw.receive()) as never,
    }) as never;
  const engFrom = createSyncEngine({
    db: from.db,
    selfDeviceId: from.identity.deviceId,
    mutateEntity: makeEntityMutator(),
  });
  const engTo = createSyncEngine({
    db: to.db,
    selfDeviceId: to.identity.deviceId,
    mutateEntity: makeEntityMutator(),
  });
  let fromStats: Record<string, number> = {};
  let toStats: Record<string, number> = {};
  const runF = engFrom
    .runSession(wrap(rawFrom))
    .then((st) => {
      fromStats = st as never;
      rawTo.close();
    })
    .catch(() => rawTo.close());
  const runT = engTo
    .runSession(wrap(rawTo))
    .then((st) => {
      toStats = st as never;
      rawFrom.close();
    })
    .catch(() => rawFrom.close());
  await Promise.allSettled([runF, runT]);
  return {
    fromLog: rawFrom.sentLog as Array<{ type: string }>,
    toLog: rawTo.sentLog as Array<{ type: string }>,
    fromStats,
    toStats,
  };
}

describe("pkg5c: anti-entropy session symmetry (DC-08 §4)", () => {
  test("single session, new data on BOTH sides → bidirectional convergence; responder pulls", async () => {
    guardProcess();
    const a = makeDevice("A");
    const b = makeDevice("B");
    pairDevices(a, b);
    // Phase 1 equivalent: seed a's data so the pair is partially converged.
    for (let i = 0; i < 3; i++) mkEvent(a, `seed-a-${i}`);
    await sessionBothEnds(b, a); // b initiates; both engines run
    expect(oracle([a, b]).converged).toBe(true);

    // THE test: new data on BOTH sides, ONE session, both converge.
    mkEvent(a, `new-a-1`);
    mkEvent(a, `new-a-2`);
    mkEvent(b, `new-b-1`);
    mkEvent(b, `new-b-2`);
    const s = await sessionBothEnds(b, a); // b initiates toward a
    expect(oracle([a, b]).converged, JSON.stringify(oracle([a, b]).detail)).toBe(true);

    // DC-08 §4 SYMMETRY evidence: BOTH directions issued CHANGES_REQUEST in the
    // one session (the responder pulled what IT needed), and both applied records.
    expect(s.fromLog.some((m) => m.type === "CHANGES_REQUEST")).toBe(true);
    expect(s.toLog.some((m) => m.type === "CHANGES_REQUEST")).toBe(true);
    expect(s.fromStats.receivedApplied).toBeGreaterThan(0);
    expect(s.toStats.receivedApplied).toBeGreaterThan(0);

    // Both sides' full data present on both.
    for (const d of [a, b]) {
      const titles = d.db
        .prepare("SELECT title FROM events ORDER BY title")
        .all()
        .map((r) => (r as { title: string }).title);
      expect(titles).toContain("new-a-1");
      expect(titles).toContain("new-a-2");
      expect(titles).toContain("new-b-1");
      expect(titles).toContain("new-b-2");
    }
  });

  test("peer with nothing needed sends no CHANGES_REQUEST (no phantom self-range)", async () => {
    guardProcess();
    const a = makeDevice("A2");
    const b = makeDevice("B2");
    pairDevices(a, b);
    for (let i = 0; i < 2; i++) mkEvent(a, `seed-${i}`);
    await sessionBothEnds(b, a);
    expect(oracle([a, b]).converged).toBe(true);
    // Fully converged pair: neither side needs anything — zero requests, zero
    // batches (M-4 corrected behavior, cf. pkg5b test 6).
    const s = await sessionBothEnds(b, a);
    for (const log of [s.fromLog, s.toLog]) {
      expect(log.some((m) => m.type === "CHANGES_REQUEST")).toBe(false);
      expect(log.some((m) => m.type.startsWith("FULL_STATE"))).toBe(false);
    }
  });

  test("real TCP (SC9 phase-2 shape): responder's new data reaches initiator in ONE session, 3/3", async () => {
    guardProcess();
    for (let run = 0; run < 3; run++) {
      const a = makeDevice("SRV");
      const b = makeDevice("CLI");
      pairDevices(a, b);
      for (let i = 0; i < 5; i++) mkEvent(a, `tcp-r${run}-srv-${i}`);
      const port = 41310 + run;
      // Responder's session is an INDEPENDENT exchange (DC-08 §4) — record its
      // promise; convergence is asserted only after BOTH engine runs complete.
      const serverDone: Array<Promise<unknown>> = [];
      const srv = await serveSync(a.identity.privateKey, port, (s) => {
        const eng = createSyncEngine({
          db: a.db,
          selfDeviceId: a.identity.deviceId,
          mutateEntity: makeEntityMutator(),
        });
        serverDone.push(eng.runSession(s.json as never).catch(() => {}));
      });
      {
        const s1 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
        const eng = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
        await eng.runSession(s1.json as never);
        s1.done();
        await Promise.race([
          Promise.allSettled(serverDone),
          new Promise((r) => setTimeout(r, 15_000)),
        ]);
      }
      expect(oracle([a, b]).converged).toBe(true);
      mkEvent(b, `tcp-r${run}-cli-1`);
      mkEvent(b, `tcp-r${run}-cli-2`);
      {
        const s2 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
        const eng = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
        await eng.runSession(s2.json as never);
        s2.done();
        await Promise.race([
          Promise.allSettled(serverDone),
          new Promise((r) => setTimeout(r, 15_000)),
        ]);
      }
      const o = oracle([a, b]);
      expect(o.converged, JSON.stringify(o.detail)).toBe(true);
      srv.close();
      a.core.db.close();
      b.core.db.close();
    }
  }, 60000);
});
