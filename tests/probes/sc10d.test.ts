// SC10-final: hostile payloads over real TCP; evidence saved before any hang risk.
import { expect, test } from "vitest";
import { serveSync, connectSync } from "../../src/network/sync_runtime.ts";
import { guardProcess, makeDevice, pairDevices, oracle, saveResult, type Device } from "./sync_probe_helpers.ts";
import { createSyncEngine, makeEntityMutator } from "./sync_probe_helpers.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

test("SC10 hostile payloads over real TCP mid-convergence", async () => {
  guardProcess();
  const a = makeDevice("SRV");
  const b = makeDevice("CLI");
  pairDevices(a, b);
  for (let i = 0; i < 3; i++) mkEvent(a, `h-ev-${i}`);
  const port = 41070;
  const srv = await serveSync(a.identity.privateKey, port, (s) => {
    const eng = createSyncEngine({ db: a.db, selfDeviceId: a.identity.deviceId, mutateEntity: makeEntityMutator() });
    eng.runSession(s.json as never).then(
      (st) => console.log("[srv] session done", JSON.stringify(st)),
      (e) => console.log("[srv] session err:", String(e).slice(0, 80)),
    );
  });

  const s = await connectSync(b.identity.privateKey, "127.0.0.1", port);
  const t = Date.now();
  const gold = {
    change_id: `${b.identity.deviceId}:1`, device_id: b.identity.deviceId, local_seq: 1,
    entity_id: "evt-gold", entity_type: "event", field_path: "event", operation: "set",
    payload: { value: { title: "gold", description: "", startMs: t, endMs: t + 3600000, allDay: false } },
    hlc_timestamp: t, causality_clock: { [b.identity.deviceId]: 1 }, schema_version: 1,
  };
  const mkBad = (over: Record<string, unknown>) => ({ ...gold, entity_id: "evt-bad", ...over });
  const bads = [
    mkBad({ change_id: "forged:1" }),
    mkBad({ local_seq: 0 }),
    mkBad({ operation: "drop-table" }),
    mkBad({ entity_type: "wallet" }),
    mkBad({ causality_clock: "not-an-object" }),
    mkBad({ hlc_timestamp: "not-a-number" }),
    mkBad({ device_id: "" }),
  ];
  const infRaw = JSON.stringify(mkBad({ change_id: `${b.identity.deviceId}:1` })).replace('"title":"gold"', '"title":1e999');
  const infPayload = JSON.parse(infRaw);

  await s.json.send({ v: 1, type: "HELLO", device_clock: { [b.identity.deviceId]: 1 } });
  const seen: string[] = [];
  let gotRequest = false;
  for (let i = 0; i < 20 && !gotRequest; i++) {
    const m = (await Promise.race([
      s.json.receive(),
      new Promise((r) => setTimeout(() => r("timeout"), 100)),
    ])) as { type?: string } | "timeout";
    if (m === "timeout") { seen.push("TIMEOUT"); break; }
    seen.push((m as { type?: string }).type ?? "?");
    if ((m as { type?: string }).type === "CHANGES_REQUEST") gotRequest = true;
  }
  await s.json.send({ v: 1, type: "CHANGES_BATCH", changes: [infPayload, ...bads, gold], remaining_ranges: [] });
  await new Promise((r) => setTimeout(r, 300));
  s.done();
  await new Promise((r) => setTimeout(r, 300));

  const q = a.db.prepare("SELECT quarantine_id, quarantine_reason FROM quarantine ORDER BY quarantine_id").all() as any[];
  const goldRow = a.db.prepare("SELECT event_id,title FROM events WHERE event_id='evt-gold'").all();
  const badRows = (a.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id='evt-bad'").get() as { c: number }).c;

  // follow-up HEALTHY session; race with timeout so evidence is always saved
  let stats2: unknown = "HUNG>5s (see F3)";
  try {
    const s2 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
    const engCli = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    stats2 = await Promise.race([
      engCli.runSession(s2.json as never),
      new Promise((r) => setTimeout(() => r("HUNG>5s"), 5000)),
    ]);
    s2.done();
  } catch (e) {
    stats2 = `error:${String(e).slice(0, 60)}`;
  }
  srv.close();
  const o = oracle([a, b]);
  saveResult("sc10", {
    serverSaw: seen,
    quarantineReasons: q.map((x) => x.quarantine_reason.slice(0, 60)),
    quarantineCount: q.length,
    goldRow, badRows,
    postHostileSessionStats: stats2,
    convergedAfter: o.converged,
  });
  expect(badRows).toBe(0);
  expect(q.length).toBeGreaterThanOrEqual(1);
  a.core.db.close();
  b.core.db.close();
}, 60000);
