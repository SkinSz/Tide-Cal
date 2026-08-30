// Independent adversarial probes for Pkg1 review — falsification attempts.
// Imports the package's own harness helpers but designs its own scenarios.
import { expect, test } from "vitest";
import {
  assertAgainstOracle,
  closeDevices,
  convergeRound,
  ExpectedState,
  makeDevice,
  restartDevice,
  semanticEvents,
  sessionOnce,
  sweepOn,
  type Device,
} from "../tests/pkg1_helpers.ts";
import { buildSnapshot, applySnapshot } from "../src/sync/full_state.ts";
import { emptyKnowledge } from "../src/sync/knowledge_state.ts";
import type { KnowledgeState } from "../src/sync/knowledge_state.ts";

const T0 = 1_750_000_000_000;
let evCounter = 10_000;

function mkEvent(d: Device, title: string, expected: ExpectedState): string {
  evCounter++;
  const ev = d.core.createEvent({
    title,
    description: "adv",
    startMs: T0 + evCounter * 7200_000,
    endMs: T0 + evCounter * 7200_000 + 3600_000,
    allDay: false,
  });
  expected.create(ev);
  return ev.id;
}

function updEvent(d: Device, id: string, title: string, expected: ExpectedState): void {
  const cur = expected.events.get(id)!;
  d.core.updateEvent(id, { ...cur, title });
  expected.update({ id, ...cur, title } as never);
}

function knowledgeOf(d: Device): KnowledgeState {
  return emptyKnowledge();
}

// R1: compaction run TWICE back-to-back (no intermediate sync), then a
// snapshot exchange with an existing peer and a fresh peer.
test("ADV-R1 double sweep then snapshot", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 5; i++) mkEvent(a, `r1-${i}`, expected);
  await convergeRound([a, b]);
  const s1 = sweepOn(a, [b]);
  const s2 = sweepOn(a, [b]);
  expect(s1.deletedChanges).toBeGreaterThan(0);
  expect(s2.examined).toBeGreaterThanOrEqual(0);

  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  await convergeRound([a, b, c]);
  const oracle = assertAgainstOracle(expected, [a, b, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(c.db).size).toBe(5);
  closeDevices([a, b, c]);
}, 60000);

// R2: snapshot exchange AFTER restart of ONLY the compacted peer.
test("ADV-R2 restart compacted peer, then snapshot exchange", async () => {
  const expected = new ExpectedState();
  let a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 4; i++) mkEvent(a, `r2-${i}`, expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);
  a = restartDevice(a);

  await sessionOnce(a, b);
  await sessionOnce(b, a);
  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  await convergeRound([a, b, c]);
  const oracle = assertAgainstOracle(expected, [a, b, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  closeDevices([a, b, c]);
}, 60000);

// R3: fresh peer D bootstraps ONLY from the compacted peer A, where A has
// PENDING local edits made after compaction; D also has its own local edit
// made before pairing.
test("ADV-R3 fresh peer with own edits bootstraps from compacted peer with pending edits", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 4; i++) mkEvent(a, `r3-${i}`, expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);

  // A's pending post-compaction edits (no sync yet).
  mkEvent(a, "r3-post", expected);
  updEvent(a, expected.order[0]!, "r3-0-edited", expected);

  // D: fresh, with its OWN local event before ever syncing.
  const d = makeDevice("D");
  mkEvent(d, "r3-d-local", expected);

  // Isolate: D syncs ONLY with A.
  await sessionOnce(a, d);
  await sessionOnce(d, a);
  await sessionOnce(a, d);

  const oracle = assertAgainstOracle(expected, [a, d]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(d.db).size).toBe(6);
  closeDevices([a, b, d]);
}, 60000);

// R4: compaction on BOTH peers before any further exchange.
test("ADV-R4 compaction on both peers", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 3; i++) mkEvent(a, `r4a-${i}`, expected);
  mkEvent(b, "r4b-0", expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);
  sweepOn(b, [a]);

  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  await convergeRound([a, b, c]);
  const oracle = assertAgainstOracle(expected, [a, b, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(c.db).size).toBe(4);
  closeDevices([a, b, c]);
}, 60000);

// R5: tombstoned entities through compaction that ALSO deletes the
// tombstone rows, then fresh-peer bootstrap.
test("ADV-R5 tombstone swept away, fresh peer must not resurrect", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const k1 = mkEvent(a, "r5-keep", expected);
  const k2 = mkEvent(a, "r5-kill", expected);
  await convergeRound([a, b]);
  a.core.deleteEvent(k2);
  expected.delete(k2);
  await convergeRound([a, b]);
  const s1 = sweepOn(a, [b]);
  const s2 = sweepOn(a, [b]); // second sweep may delete the tombstone itself
  const etombsA = a.db.prepare("SELECT COUNT(*) c FROM entities_tombstones").get() as { c: number };

  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  await convergeRound([a, b, c]);
  const oracle = assertAgainstOracle(expected, [a, b, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(c.db).has(k2)).toBe(false);
  expect(semanticEvents(c.db).has(k1)).toBe(true);
  closeDevices([a, b, c]);
}, 60000);

// U1b: create on A, sync to B, delete on A, then stream ONLY
// a snapshot to B (no change delivery) by direct applySnapshot, and verify
// B removes the row via the absence rule with a NON-empty local version.
test("ADV-U1b legit deletion propagates through snapshot-only path", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const id = mkEvent(a, "u1b", expected);
  await convergeRound([a, b]);
  expect(semanticEvents(b.db).has(id)).toBe(true);

  a.core.deleteEvent(id);
  expected.delete(id);

  // Snapshot-only application to B (bypass change delivery entirely).
  const out: any[] = [];
  buildSnapshot(a.db, (s) => out.push(structuredClone(s)));
  let applied: any;
  for (const s of out) {
    applied = applySnapshot(b.db, s, knowledgeOf(b));
  }
  expect(applied.absenceTombstones).toBe(1);
  expect(semanticEvents(b.db).has(id)).toBe(false);
  const oracle = assertAgainstOracle(expected, [a, b]);
  expect(oracle.ok, oracle.detail).toBe(true);
  closeDevices([a, b]);
}, 30000);

// U2: the original SC5 absence bug shape — a compacted source applies an
// EMPTY snapshot (empty snapshot_clock) and must NOT tombstone its own rows.
test("ADV-U2 empty snapshot must not destroy compacted source's live rows", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 4; i++) mkEvent(a, `u2-${i}`, expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);
  const before = semanticEvents(a.db).size;
  expect(before).toBe(4);

  // Fresh empty device D "streams" its (empty) snapshot to A.
  const d = makeDevice("D");
  const out: any[] = [];
  buildSnapshot(d.db, (s) => out.push(structuredClone(s)));
  let applied: any;
  for (const s of out) applied = applySnapshot(a.db, s, knowledgeOf(a));
  expect(applied?.absenceTombstones ?? 0).toBe(0);
  expect(semanticEvents(a.db).size).toBe(4);
  const oracle = assertAgainstOracle(expected, [a]);
  expect(oracle.ok, oracle.detail).toBe(true);
  closeDevices([a, b, d]);
}, 30000);

// R6: update AFTER compaction — version vector on the receiving peer must
// contain the producer's post-compaction seq (independently derived).
test("ADV-R6 post-compaction update produces a complete version vector on the peer", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const id = mkEvent(a, "r6-0", expected);
  const id2 = mkEvent(a, "r6-1", expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);
  updEvent(a, id, "r6-0-edited", expected);
  await convergeRound([a, b]);

  // Independent expectation: element-wise max of causality_clocks over ALL
  // changes for the entity as A applied them (from the OP LOG: creation seq
  // and the update seq are both A's; the peer must see the max).
  const aClockRow = a.db.prepare("SELECT max_seq s FROM device_clock WHERE peer_device_id = ?").get(a.identity.deviceId) as { s: number };
  const bVer = b.db.prepare("SELECT version FROM entity_versions WHERE entity_id = ?").get(id) as { version: string };
  expect(bVer).toBeDefined();
  const parsed = JSON.parse(bVer.version);
  expect(parsed[a.identity.deviceId]).toBe(aClockRow.s);

  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  await convergeRound([a, b, c]);
  const oracle = assertAgainstOracle(expected, [a, b, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  closeDevices([a, b, c]);
}, 60000);

// R7: compaction on the FRESH (snapshot-receiving) peer, then a NEWER peer
// bootstraps ONLY from it. The fresh peer holds entities with no change
// records of its own — its entity_versions must be able to serve a full
// snapshot onward.
test("ADV-R7 compaction on the receiving peer; newest peer bootstraps only from it", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 5; i++) mkEvent(a, `r7-${i}`, expected);
  await convergeRound([a, b]);

  const d = makeDevice("D");
  await convergeRound([a, b, d]);
  await convergeRound([a, b, d]);
  expect(semanticEvents(d.db).size).toBe(5);

  // D compacts (its own change records are few; received entities have none).
  const sD = sweepOn(d, [a, b]);
  // Even if nothing was swept, exercise the snapshot path from D only.
  const e = makeDevice("E");
  await sessionOnce(d, e);
  await sessionOnce(e, d);
  await sessionOnce(d, e);
  const oracle = assertAgainstOracle(expected, [d, e]);
  expect(oracle.ok, `D->E: ${oracle.detail}`).toBe(true);
  expect(semanticEvents(e.db).size).toBe(5);
  closeDevices([a, b, d, e]);
}, 60000);

// R8: divergent applied_through — B was offline while A created+compacted
// against a stale advertisement; B returns and must still converge.
test("ADV-R8 divergent applied_through (stale offline peer)", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 3; i++) mkEvent(a, `r8-${i}`, expected);
  await convergeRound([a, b]);
  // B goes offline. A creates more and compacts against B's STALE ack.
  for (let i = 0; i < 3; i++) mkEvent(a, `r8-off-${i}`, expected);
  // A single extra sync round so the new events reached B before compaction?
  // No: keep B truly stale — compact using ONLY B's old applied_upto.
  const stats = sweepOn(a, [b]);
  // Compaction may only delete records B provably knows (<= stale ack).
  expect(stats.deletedChanges).toBeGreaterThanOrEqual(0);

  // B returns; several rounds.
  await convergeRound([a, b]);
  await convergeRound([a, b]);
  const oracle = assertAgainstOracle(expected, [a, b]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(b.db).size).toBe(6);
  closeDevices([a, b]);
}, 60000);

// R9: SC5-shape 6 iterations for offer-race ordering coverage (both §7.3
// orderings should occur across identities).
test("ADV-R9 six SC5-shape runs for race-ordering coverage", async () => {
  for (let run = 0; run < 6; run++) {
    const expected = new ExpectedState();
    const a = makeDevice("A");
    const b = makeDevice("B");
    for (let i = 0; i < 4; i++) mkEvent(a, `r9-${run}-${i}`, expected);
    await sessionOnce(a, b);
    await sessionOnce(b, a);
    sweepOn(a, [b]);
    const c = makeDevice("C");
    await convergeRound([a, b, c]);
    await convergeRound([a, b, c]);
    const oracle = assertAgainstOracle(expected, [a, b, c]);
    expect(oracle.ok, `run ${run}: ${oracle.detail}`).toBe(true);
    expect(semanticEvents(c.db).size, `run ${run}`).toBe(4);
    closeDevices([a, b, c]);
  }
}, 120000);

// R10: compaction BETWEEN two sync rounds on a 3-peer ring (compaction
// interleaved with live traffic, not just before bootstrap).
test("ADV-R10 compaction interleaved between sync rounds (3 peers)", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const c = makeDevice("C");
  mkEvent(a, "r10-0", expected);
  await convergeRound([a, b, c]);
  sweepOn(a, [b, c]);
  mkEvent(b, "r10-1", expected);
  await convergeRound([a, b, c]);
  sweepOn(b, [a, c]);
  updEvent(a, expected.order[0]!, "r10-0-ed", expected);
  mkEvent(c, "r10-2", expected);
  await convergeRound([a, b, c]);
  sweepOn(c, [a, b]);
  await convergeRound([a, b, c]);
  const oracle = assertAgainstOracle(expected, [a, b, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  closeDevices([a, b, c]);
}, 60000);
