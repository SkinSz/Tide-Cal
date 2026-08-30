// Diagnosis probe: replicate SC9 phase-2 (B has new data, B initiates toward A)
// over BOTH in-memory pipes and real TCP, with per-message wire logs on both
// ends, plus knowledge-state dumps. READ-ONLY wrt product code.
import { test } from "vitest";
import { serveSync, connectSync, loadOrCreateIdentity } from "../../src/network/sync_runtime.ts";
import { guardProcess, makeDevice, pairDevices, type Device } from "./sync_probe_helpers.ts";
import { createSyncEngine } from "../../src/sync/sync_engine.ts";
import { makeEntityMutator } from "../../src/persistence/bridges/sync_service.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({ title, description: "c", startMs: t, endMs: t + 3600_000, allDay: false });
}

function wire(tag: string, t: unknown) {
  const ch = t as { send: (m: unknown) => Promise<void>; receive: () => Promise<unknown> };
  const ts = () => (Date.now() % 100000).toString().padStart(5, "0");
  return {
    send: async (m: unknown) => {
      console.log(`[${tag} ${ts()}] ->`, JSON.stringify(m).slice(0, 120));
      await ch.send(m);
    },
    receive: async () => {
      const m = await ch.receive();
      console.log(`[${tag} ${ts()}] <-`, m === null ? "null(CLOSED)" : JSON.stringify(m).slice(0, 120));
      return m;
    },
  };
}

function dump(tag: string, d: Device) {
  const q = (sql: string) => d.db.prepare(sql).all();
  console.log(`[${tag}] events=`, q("SELECT title FROM events ORDER BY title").map((r) => (r as { title: string }).title));
  console.log(`[${tag}] applied_upto=`, JSON.stringify(q("SELECT producer_device_id, applied_through FROM applied_upto")));
  console.log(`[${tag}] device_clock=`, JSON.stringify(q("SELECT peer_device_id, max_seq FROM device_clock")));
}

test("phase-2 wire trace over in-memory pipes", async () => {
  guardProcess();
  const a = makeDevice("SRV");
  const b = makeDevice("CLI");
  pairDevices(a, b);
  for (let i = 0; i < 5; i++) mkEvent(a, `srv-${i}`);
  // phase 1 equivalent
  const { sessionOnce } = await import("./sync_probe_helpers.ts");
  const r1 = await sessionOnce(b, a);
  console.log("=== phase1 fromLog:", JSON.stringify(r1.fromLog.map((m) => (m as { type: string }).type)));
  console.log("=== phase1 fromStats:", JSON.stringify(r1.fromStats), "toStats:", JSON.stringify(r1.toStats));
  mkEvent(b, `cli-1`);
  mkEvent(b, `cli-2`);
  console.log("=== PHASE 2: B -> A ===");
  const r2 = await sessionOnce(b, a);
  console.log("=== phase2 fromLog:", JSON.stringify(r2.fromLog.map((m) => (m as { type: string }).type)));
  console.log("=== phase2 fromStats:", JSON.stringify(r2.fromStats), "toStats:", JSON.stringify(r2.toStats));
  dump("A", a);
  dump("B", b);
}, 30000);

test("phase-2 wire trace over real TCP", async () => {
  guardProcess();
  const a = makeDevice("SRV");
  const b = makeDevice("CLI");
  pairDevices(a, b);
  for (let i = 0; i < 5; i++) mkEvent(a, `srv-${i}`);
  const port = 41190;
  const srv = await serveSync(a.identity.privateKey, port, (s) => {
    const eng = createSyncEngine({ db: a.db, selfDeviceId: a.identity.deviceId, mutateEntity: makeEntityMutator() });
    eng.runSession(wire("A", s.json) as never).catch((e) => console.log("[A] session err:", String(e).slice(0, 120)));
  });
  // phase 1
  {
    const s1 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
    const eng = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    await eng.runSession(wire("B", s1.json) as never).catch((e) => console.log("[B] p1 err:", String(e).slice(0, 120)));
    s1.done();
  }
  // phase 2 — EXACTLY like SC9: no settle sleep, immediate dump after s2.done()
  mkEvent(b, `cli-1`);
  mkEvent(b, `cli-2`);
  console.log("=== PHASE 2 TCP: B -> A (SC9 timing) ===");
  {
    const s2 = await connectSync(b.identity.privateKey, "127.0.0.1", port);
    const eng = createSyncEngine({ db: b.db, selfDeviceId: b.identity.deviceId, mutateEntity: makeEntityMutator() });
    await eng.runSession(wire("B", s2.json) as never).catch((e) => console.log("[B] p2 err:", String(e).slice(0, 120)));
    s2.done();
  }
  console.log("=== B session resolved; dumping A immediately (oracle timing) ===");
  srv.close();
  dump("A", a);
  dump("B", b);
}, 30000);
