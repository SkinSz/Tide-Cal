// Measure the race window: how long after B's session resolves does A finish
// applying B's data? Also verify whether A ever stalls permanently.
import { test } from "vitest";
import { serveSync, connectSync } from "../../src/network/sync_runtime.ts";
import { guardProcess, makeDevice, pairDevices, type Device } from "./sync_probe_helpers.ts";
import { createSyncEngine } from "../../src/sync/sync_engine.ts";
import { makeEntityMutator } from "../../src/persistence/bridges/sync_service.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

function appliedB(a: Device): number {
  const rows = a.db
    .prepare("SELECT applied_through AS a FROM applied_upto WHERE producer_device_id = ?")
    .all(b.id) as Array<{ a: number }>;
  return rows[0]?.a ?? 0;
}

let b: Device & { id: string };

test("race window measurement", async () => {
  guardProcess();
  const a = makeDevice("SRV");
  const bb = makeDevice("CLI");
  b = bb as Device & { id: string };
  b.id = bb.identity.deviceId;
  pairDevices(a, bb);
  for (let i = 0; i < 5; i++) mkEvent(a, `srv-${i}`);
  const port = 41210;
  const srv = await serveSync(a.identity.privateKey, port, (s) => {
    const eng = createSyncEngine({ db: a.db, selfDeviceId: a.identity.deviceId, mutateEntity: makeEntityMutator() });
    eng.runSession(s.json as never).catch((e) => console.log("[A] session err:", String(e).slice(0, 120)));
  });
  // phase 1
  {
    const s1 = await connectSync(bb.identity.privateKey, "127.0.0.1", port);
    const eng = createSyncEngine({ db: bb.db, selfDeviceId: bb.identity.deviceId, mutateEntity: makeEntityMutator() });
    await eng.runSession(s1.json as never);
    s1.done();
  }
  mkEvent(bb, `cli-1`);
  mkEvent(bb, `cli-2`);
  const t0 = Date.now();
  const s2 = await connectSync(bb.identity.privateKey, "127.0.0.1", port);
  const eng = createSyncEngine({ db: bb.db, selfDeviceId: bb.identity.deviceId, mutateEntity: makeEntityMutator() });
  await eng.runSession(s2.json as never);
  const tResolve = Date.now();
  console.log(`B session resolved at +${tResolve - t0}ms; A applied_upto[B] at that moment = ${appliedB(a)}`);
  // poll A's state every 5ms until it converges or 2s cap
  for (let i = 0; i < 400; i++) {
    if (appliedB(a) >= 3) {
      console.log(`A applied B's data at +${Date.now() - t0}ms (race window: ${Date.now() - tResolve}ms after B resolve)`);
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  console.log(`final applied_upto[B] = ${appliedB(a)}`);
  srv.close();
}, 30000);
