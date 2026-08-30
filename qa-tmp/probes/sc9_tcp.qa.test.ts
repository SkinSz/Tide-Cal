// SC9: real TCP end-to-end convergence x3 (Noise_XX over 127.0.0.1, ports 41000-41999)
import { expect, test } from "vitest";
import { serveSync, connectSync } from "../../src/network/sync_runtime.ts";
import { guardProcess, makeDevice, pairDevices, oracle, saveResult, type Device } from "./helpers.ts";
import { createSyncEngine, makeEntityMutator } from "./helpers.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
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
    const srv = await serveSync(a.identity.privateKey, port, (s) => {
      const eng = createSyncEngine({ db: a.db, selfDeviceId: a.identity.deviceId, mutateEntity: makeEntityMutator() });
      eng.runSession(s.json as never).catch((e) => console.log("[srv] session err:", String(e).slice(0, 80)));
    });

    // phase 1: A -> B over real TCP
    const s1 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
    const engCli1 = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    const p1 = await Promise.race([
      engCli1.runSession(s1.json as never).then(() => "resolved", (e) => `rejected:${String(e).slice(0, 60)}`),
      new Promise((r) => setTimeout(() => r("HUNG>5s"), 5000)),
    ]);
    s1.done();
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
    const o2 = oracle([a, b]);
    srv.close();
    runs.push({ run, phase1Session: p1, phase1Converged: o1.converged, phase2Session: p2, phase2Converged: o2.converged, detail: o2.detail });
    saveResult(`sc9-run${run}`, runs[runs.length - 1]);
    a.core.db.close();
    b.core.db.close();
  }
  expect(runs.every((r) => (r as { phase2Converged: boolean }).phase2Converged), JSON.stringify(runs)).toBe(true);
}, 120000);
