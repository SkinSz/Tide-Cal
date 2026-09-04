// SC9: real TCP end-to-end convergence x3 (Noise_XX over 127.0.0.1, ports 41000-41999)
//
// Pkg5b-completion anti-entropy diagnosis (docs/qa/remediation/pkg5b-report.md §6):
// DC-08 §4 defines ONE session as bidirectional anti-entropy — "Both sides run the
// SAME role. Each independently pulls what IT needs" and the two directions are
// "independent exchanges multiplexed over one session. Neither waits for the other's
// pull to start its own." The engine implements exactly that: the responder runs its
// own full runSession (sidecar_server.ts onInbound → runEngineSession) and pulls what
// IT needs — the wire trace shows the responder sending CHANGES_REQUEST and applying
// the served batch. There is NO push path in the protocol by design (DC-08 §7
// "NO PUSH AUTHORITY"); the responder's new data reaches the initiator through the
// responder's OWN pull inside the same session.
//
// CONSEQUENCE FOR THIS PROBE: the initiator's runSession resolving does NOT imply the
// responder's session has finished applying (the directions are independent per §4).
// The original probe read the convergence oracle immediately after the client session
// resolved, racing the responder's in-flight session — masked at the QA baseline by
// the accidental every-session full-state exchange (Pkg5b M-4 fix removed it), which
// happened to serialize the two directions. The fix below awaits the responder's
// session (bounded) before reading the oracle; convergence itself is unchanged
// protocol behavior and needs no second session — the single bidirectional session
// carries both directions per DC-08 §4.
import { expect, test } from "vitest";
import { serveSync, connectSync } from "../../src/network/sync_runtime.ts";
import { guardProcess, makeDevice, pairDevices, oracle, saveResult, type Device } from "./sync_probe_helpers.ts";
import { createSyncEngine, makeEntityMutator } from "./sync_probe_helpers.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

/**
 * Await the responder-side engine sessions recorded so far (bounded).
 * DC-08 §4: the responder's pull is an independent exchange in the same session —
 * the initiator's completion is not a barrier for it, so the probe must wait for it
 * explicitly before asserting convergence.
 */
async function awaitResponderSessions(
  sessions: Promise<unknown>[],
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (sessions.length < expectedCount && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.race([
    Promise.allSettled(sessions),
    new Promise((r) => setTimeout(r, 15_000)),
  ]);
}

test("SC9 real TCP full sessions x3: bidirectional convergence", async () => {
  guardProcess();
  const runs: unknown[] = [];
  for (let run = 0; run < 3; run++) {
    const a = makeDevice("SRV");
    const b = makeDevice("CLI");
    pairDevices(a, b);
    for (let i = 0; i < 5; i++) mkEvent(a, `tcp-r${run}-srv-${i}`);

    const port = 41060 + run;
    const serverSessions: Promise<unknown>[] = [];
    const srv = await serveSync(a.identity.privateKey, port, (s) => {
      const eng = createSyncEngine({ db: a.db, selfDeviceId: a.identity.deviceId, mutateEntity: makeEntityMutator() });
      // Pkg5b-completion: record the responder's session promise so the probe can
      // await it (DC-08 §4 independence of the two directions; see header note).
      const p = eng
        .runSession(s.json as never)
        .catch((e) => console.log("[srv] session err:", String(e).slice(0, 80)));
      serverSessions.push(p);
    });

    // phase 1: A -> B over real TCP
    const s1 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
    const engCli1 = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    const p1 = await Promise.race([
      engCli1.runSession(s1.json as never).then(() => "resolved", (e) => `rejected:${String(e).slice(0, 60)}`),
      new Promise((r) => setTimeout(() => r("HUNG>5s"), 5000)),
    ]);
    s1.done();
    await awaitResponderSessions(serverSessions, 1);
    const o1 = oracle([a, b]);

    // phase 2: B creates, B -> A over real TCP
    mkEvent(b, `tcp-r${run}-cli-1`);
    mkEvent(b, `tcp-r${run}-cli-2`);
    const s2 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
    const engCli2 = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    const p2 = await Promise.race([
      engCli2.runSession(s2.json as never).then(() => "resolved", (e) => `rejected:${String(e).slice(0, 60)}`),
      new Promise((r) => setTimeout(() => r("HUNG>5s"), 5000)),
    ]);
    s2.done();
    await awaitResponderSessions(serverSessions, 2);
    const o2 = oracle([a, b]);
    srv.close();
    runs.push({ run, phase1Session: p1, phase1Converged: o1.converged, phase2Session: p2, phase2Converged: o2.converged, detail: o2.detail });
    saveResult(`sc9-run${run}`, runs[runs.length - 1]);
    a.core.db.close();
    b.core.db.close();
  }
  expect(runs.every((r) => (r as { phase2Converged: boolean }).phase2Converged), JSON.stringify(runs)).toBe(true);
}, 120000);
