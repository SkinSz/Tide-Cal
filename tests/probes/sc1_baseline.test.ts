// SC1: baseline convergence + SC2 concurrent same-field + SC3 different-field + SC4 duplicate delivery
import { expect, test } from "vitest";
import type Database from "better-sqlite3";
import { join } from "node:path";
import { EventCore } from "../../src/persistence/bridges/event_core.ts";
import {
  makeDevice,
  pairDevices,
  sessionOnce,
  oracle,
  fingerprint,
  dumpState,
  saveResult,
  type Device,
  guardProcess,
} from "./sync_probe_helpers.ts";

function mkEvent(d: Device, title: string) {
  const t = Date.now();
  return d.core.createEvent({
    title,
    description: "created by " + d.tag,
    startMs: t,
    endMs: t + 3600_000,
    allDay: false,
  });
}

guardProcess();

test("SC1 baseline: A creates 5 events, bidirectional sessions converge A<->B", async () => {
  const a = makeDevice("A");
  const b = makeDevice("B");
  pairDevices(a, b);
  for (let i = 0; i < 5; i++) mkEvent(a, `ev-${i}`);

  await sessionOnce(a, b);
  await sessionOnce(b, a);
  const o1 = oracle([a, b]);
  expect(o1.converged, JSON.stringify(o1.detail)).toBe(true);

  // duplicate session (idempotence): repeat both directions
  const r3 = await sessionOnce(a, b);
  const r4 = await sessionOnce(b, a);
  const o2 = oracle([a, b]);
  expect(o2.converged).toBe(true);

  const reapplied =
    Number(r3.fromStats.receivedApplied ?? 0) + Number(r3.toStats.receivedApplied ?? 0) +
    Number(r4.fromStats.receivedApplied ?? 0) + Number(r4.toStats.receivedApplied ?? 0);
  const states = { a: dumpState("A", a), b: dumpState("B", b) };
  saveResult("sc1", { o1, o2, dupStats: { ab2: r3.fromStats, ba2: r4.toStats }, reapplied, states });
  expect(reapplied, "replay must not re-apply").toBe(0);
  a.core.db.close();
  b.core.db.close();
});

test("SC2 concurrent SAME-field (title) edits on A and B — DC-03 conflict semantics", async () => {
  // Pkg6 disposition: asserts implicit-LWW convergence replaced by Pkg5/DC-03
  // §3.3 conflict semantics (divergence conflict-backed). Left failing —
  // observe-only pending owner disposition (pkg6-report §remaining).
  const a = makeDevice("A");
  const b = makeDevice("B");
  pairDevices(a, b);
  const ev = mkEvent(a, "original");
  await sessionOnce(a, b);
  await sessionOnce(b, a);
  const oPre = oracle([a, b]);
  expect(oPre.converged).toBe(true);

  // concurrent edits: no session between them
  a.core.updateEvent(ev.id, { title: "edit-A", description: "created by A", startMs: ev.startMs, endMs: ev.endMs, allDay: false });
  b.core.updateEvent(ev.id, { title: "edit-B", description: "created by A", startMs: ev.startMs, endMs: ev.endMs, allDay: false });

  // full convergence attempt: multiple rounds
  await sessionOnce(a, b);
  await sessionOnce(b, a);
  await sessionOnce(a, b);
  await sessionOnce(b, a);
  const o1 = oracle([a, b]);

  const conflictsA = (a.db.prepare("SELECT COUNT(*) c FROM conflicts").get() as { c: number }).c;
  const conflictsB = (b.db.prepare("SELECT COUNT(*) c FROM conflicts").get() as { c: number }).c;
  const tA = (a.db.prepare("SELECT title FROM events WHERE event_id=?").get(ev.id) as { title: string }).title;
  const tB = (b.db.prepare("SELECT title FROM events WHERE event_id=?").get(ev.id) as { title: string }).title;

  // restart simulation: reopen DBs at the same paths, run more sessions
  a.core.db.close();
  b.core.db.close();
  const aR = new EventCore(join(a.dir, "tide.db"), a.identity.deviceId);
  const bR = new EventCore(join(b.dir, "tide.db"), b.identity.deviceId);
  const a2: Device = { ...a, core: aR, db: aR.db as Database.Database };
  const b2: Device = { ...b, core: bR, db: bR.db as Database.Database };
  await sessionOnce(a2, b2);
  await sessionOnce(b2, a2);
  const tA2 = (a2.db.prepare("SELECT title FROM events WHERE event_id=?").get(ev.id) as { title: string }).title;
  const tB2 = (b2.db.prepare("SELECT title FROM events WHERE event_id=?").get(ev.id) as { title: string }).title;
  const o2 = oracle([a2, b2]);
  const conflictsA2 = (a2.db.prepare("SELECT COUNT(*) c FROM conflicts").get() as { c: number }).c;

  saveResult("sc2", {
    titleA: tA, titleB: tB, titleA2: tA2, titleB2: tB2,
    conflictsA, conflictsB, conflictsA2,
    oracleAfterConvergence: o1, oracleAfterRestart: o2,
  });
  a2.core.db.close();
  b2.core.db.close();
});

test("SC3 concurrent DIFFERENT-field edits (title on A, description on B) merge", async () => {
  const a = makeDevice("A");
  const b = makeDevice("B");
  pairDevices(a, b);
  const ev = mkEvent(a, "original");
  await sessionOnce(a, b);
  await sessionOnce(b, a);

  a.core.updateEvent(ev.id, { title: "title-A", description: "created by A", startMs: ev.startMs, endMs: ev.endMs, allDay: false });
  b.core.updateEvent(ev.id, { title: "original", description: "desc-B", startMs: ev.startMs, endMs: ev.endMs, allDay: false });

  await sessionOnce(a, b);
  await sessionOnce(b, a);
  await sessionOnce(a, b);
  await sessionOnce(b, a);
  const o = oracle([a, b]);
  const rowA = a.db.prepare("SELECT title,description FROM events WHERE event_id=?").get(ev.id) as { title: string; description: string };
  const rowB = b.db.prepare("SELECT title,description FROM events WHERE event_id=?").get(ev.id) as { title: string; description: string };
  saveResult("sc3", { oracle: o, rowA, rowB });
  expect(o.converged, JSON.stringify(o.detail)).toBe(true);
  a.core.db.close();
  b.core.db.close();
});

test("SC4 duplicate delivery: repeated sessions are idempotent, fingerprints stable", async () => {
  const a = makeDevice("A");
  const b = makeDevice("B");
  pairDevices(a, b);
  for (let i = 0; i < 4; i++) mkEvent(a, `ev-${i}`);
  await sessionOnce(a, b);
  const o1 = oracle([a, b]);
  expect(o1.converged).toBe(true);
  const r = await sessionOnce(a, b);
  const r2 = await sessionOnce(a, b);
  const applied = Number(r.toStats.receivedApplied) + Number(r2.toStats.receivedApplied);
  saveResult("sc4", { applied, stats: { r: r.toStats, r2: r2.toStats } });
  expect(applied, "replay must not re-apply").toBe(0);
  a.core.db.close();
  b.core.db.close();
});
