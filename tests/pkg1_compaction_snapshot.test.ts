// Pkg1 deterministic regression tests (QA C-1): compaction × full-state
// snapshot must never destroy or strand live events.
//
// Every test asserts BOTH:
//   (a) semantic correctness — each peer's events table equals the
//       INDEPENDENT expected-state oracle (pkg1_helpers.ts ExpectedState,
//       maintained by the driver from its own operation log), and
//   (b) convergence — all peers pairwise identical.
// Cover: docs/qa/remediation/pkg1-tests.md (deterministic list).
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
  type ExpectedEvent,
} from "./pkg1_helpers.ts";

const T0 = 1_750_000_000_000; // fixed base instant (ms)
let evCounter = 0;

function mkEvent(
  d: Device,
  title: string,
  expected: ExpectedState,
  startMs = T0 + evCounter * 7200_000,
): string {
  evCounter++;
  const ev = d.core.createEvent({
    title,
    description: "pkg1",
    startMs,
    endMs: startMs + 3600_000,
    allDay: false,
  });
  expected.create(ev);
  return ev.id;
}

function updEvent(d: Device, id: string, title: string, expected: ExpectedState): void {
  const cur = expected.events.get(id)!;
  const input: ExpectedEvent = {
    title,
    description: cur.description,
    startMs: cur.startMs,
    endMs: cur.endMs,
    allDay: cur.allDay,
  };
  d.core.updateEvent(id, input);
  expected.update({ id, ...input } as never);
}

test("P1.1 live events → compaction → snapshot: source keeps data in BOTH stream directions", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const c = makeDevice("C");
  const devices = [a, b, c];
  for (let i = 0; i < 6; i++) mkEvent(a, `pre-${i}`, expected);
  await convergeRound(devices);
  expect(assertAgainstOracle(expected, devices).ok).toBe(true);

  const stats = sweepOn(a, [b, c]);
  expect(stats.deletedChanges).toBeGreaterThan(0);

  // Fresh peer D; enough rounds that BOTH offer-race orderings occur across
  // the 3 runs of the outer loop below (direction is identity-dependent).
  const d = makeDevice("D");
  await convergeRound([a, b, c, d]);
  await convergeRound([a, b, c, d]);

  const oracle = assertAgainstOracle(expected, [a, b, c, d]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(a.db).size).toBe(6);
  expect(semanticEvents(d.db).size).toBe(6);
  closeDevices(devices.concat(d));
}, 60000);

test("P1.2 compacted source → fresh peer bootstrap (deterministic SC5 shape, 3 identities)", async () => {
  for (let run = 0; run < 3; run++) {
    const expected = new ExpectedState();
    const a = makeDevice("A");
    const b = makeDevice("B");
    for (let i = 0; i < 6; i++) mkEvent(a, `run${run}-pre-${i}`, expected);
    await sessionOnce(a, b);
    await sessionOnce(b, a);
    expect(assertAgainstOracle(expected, [a, b]).ok).toBe(true);

    sweepOn(a, [b]);
    const c = makeDevice("C");
    await convergeRound([a, b, c]);
    await convergeRound([a, b, c]);
    const oracle = assertAgainstOracle(expected, [a, b, c]);
    expect(oracle.ok, `run ${run}: ${oracle.detail}`).toBe(true);
    expect(semanticEvents(c.db).size, `run ${run}`).toBe(6);
    closeDevices([a, b, c]);
  }
}, 90000);

test("P1.3 compaction → restart → snapshot: version state survives restart", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 5; i++) mkEvent(a, `r-${i}`, expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);

  // Restart BOTH devices before any snapshot exchange.
  const a2 = restartDevice(a);
  const b2 = restartDevice(b);

  const c = makeDevice("C");
  await convergeRound([a2, b2, c]);
  const oracle = assertAgainstOracle(expected, [a2, b2, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(c.db).size).toBe(5);
  closeDevices([a2, b2, c]);
}, 60000);

test("P1.4 multiple peers (3+): compaction on one peer, snapshot to two fresh peers", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const c = makeDevice("C");
  for (let i = 0; i < 4; i++) mkEvent(a, `m-${i}`, expected);
  await convergeRound([a, b, c]);
  sweepOn(a, [b, c]);

  const d = makeDevice("D");
  const e = makeDevice("E");
  await convergeRound([a, b, c, d]);
  await convergeRound([a, b, c, d]);
  await convergeRound([a, b, c, d, e]);
  await convergeRound([a, b, c, d, e]);

  const oracle = assertAgainstOracle(expected, [a, b, c, d, e]);
  expect(oracle.ok, oracle.detail).toBe(true);
  closeDevices([a, b, c, d, e]);
}, 90000);

test("P1.5 events created before AND after the compaction boundary", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const c = makeDevice("C");
  for (let i = 0; i < 4; i++) mkEvent(a, `pre-${i}`, expected);
  await convergeRound([a, b, c]);
  sweepOn(a, [b, c]);

  // Post-compaction creates on the compacted device AND a peer.
  mkEvent(a, "post-a", expected);
  mkEvent(b, "post-b", expected);
  updEvent(a, expected.order[0]!, "pre-0-edited", expected);
  await convergeRound([a, b, c]);

  const d = makeDevice("D");
  await convergeRound([a, b, c, d]);
  await convergeRound([a, b, c, d]);

  const oracle = assertAgainstOracle(expected, [a, b, c, d]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(d.db).size).toBe(6);
  closeDevices([a, b, c, d]);
}, 90000);

test("P1.6 tombstoned (deleted) events through compaction + snapshot stay deleted", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  const keep1 = mkEvent(a, "keep-1", expected);
  const kill1 = mkEvent(a, "kill-1", expected);
  const kill2 = mkEvent(a, "kill-2", expected);
  mkEvent(a, "keep-2", expected);
  await convergeRound([a, b]);

  // Delete BEFORE compaction on A, and after compaction on the peer side.
  a.core.deleteEvent(kill1);
  expected.delete(kill1);
  await convergeRound([a, b]);
  sweepOn(a, [b]);

  a.core.deleteEvent(kill2);
  expected.delete(kill2);
  await convergeRound([a, b]);

  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  await convergeRound([a, b, c]);

  const oracle = assertAgainstOracle(expected, [a, b, c]);
  expect(oracle.ok, oracle.detail).toBe(true);
  expect(semanticEvents(c.db).size).toBe(2);
  expect(semanticEvents(c.db).has(kill1)).toBe(false);
  expect(semanticEvents(c.db).has(kill2)).toBe(false);
  expect(semanticEvents(a.db).has(keep1)).toBe(true);
  closeDevices([a, b, c]);
}, 90000);

test("P1.7 repeated snapshot exchanges are idempotent and lossless post-compaction", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 5; i++) mkEvent(a, `x-${i}`, expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);

  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  for (let round = 0; round < 4; round++) {
    await convergeRound([a, b, c]);
    const oracle = assertAgainstOracle(expected, [a, b, c]);
    expect(oracle.ok, `round ${round}: ${oracle.detail}`).toBe(true);
  }
  closeDevices([a, b, c]);
}, 90000);

test("P1.8 snapshot after restart on the RECEIVING side", async () => {
  const expected = new ExpectedState();
  const a = makeDevice("A");
  const b = makeDevice("B");
  for (let i = 0; i < 4; i++) mkEvent(a, `rr-${i}`, expected);
  await convergeRound([a, b]);
  sweepOn(a, [b]);

  const c = makeDevice("C");
  await convergeRound([a, b, c]);
  expect(semanticEvents(c.db).size).toBe(4);

  // Receiver restarts, then more snapshot exchanges with a compacted peer.
  const c2 = restartDevice(c);
  sweepOn(a, [b, c2]);
  const d = makeDevice("D");
  await convergeRound([a, b, c2, d]);
  await convergeRound([a, b, c2, d]);

  const oracle = assertAgainstOracle(expected, [a, b, c2, d]);
  expect(oracle.ok, oracle.detail).toBe(true);
  closeDevices([a, b, c2, d]);
}, 90000);

test("P1.9 repeated compaction/snapshot cycles (5 rounds) with updates interleaved", async () => {
  const expected = new ExpectedState();
  let a = makeDevice("A");
  let b = makeDevice("B");
  mkEvent(a, "c-0", expected);
  await convergeRound([a, b]);

  for (let round = 0; round < 5; round++) {
    mkEvent(a, `c-${round + 1}`, expected);
    if (round > 0) {
      updEvent(a, expected.order[round - 1]!, `c-${round - 1}-upd-${round}`, expected);
    }
    await convergeRound([a, b]);
    sweepOn(a, [b]);
    const c = makeDevice(`C${round}`);
    await convergeRound([a, b, c]);
    await convergeRound([a, b, c]);
    const oracle = assertAgainstOracle(expected, [a, b, c]);
    expect(oracle.ok, `round ${round}: ${oracle.detail}`).toBe(true);
    // Restart the veterans in place (same identities, fresh handles) so the
    // next round exercises compaction on a restarted DB too.
    a = restartDevice(a);
    b = restartDevice(b);
    c.core.db.close();
  }
  closeDevices([a, b]);
}, 90000);
