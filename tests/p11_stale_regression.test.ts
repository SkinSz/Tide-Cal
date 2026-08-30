// P11 remediation regression tests (work package §4).
// Invariant under test (DC-03 v2 §3.2a):
//   Once newer causally dominant state has been incorporated into the
//   materialized entity, a later-arriving operation that is provably
//   causally before that state must not regress the materialized state.
//
// Assertions target EXTERNAL outcomes: the materialized `events` row value,
// the presence/absence of conflict rows, convergence via the independent
// oracle, and persisted state across restart. None derive their expectation
// by calling the production detection logic.
//
// Scenario 1 (basic stale replay) doubles as the OLD-FAILURE reproduction:
// at pre-fix HEAD the final title was "B stale" (stale overwrite, no
// conflict row); the assertions below pin "C later" + no silent overwrite.
import { describe, expect, test, afterEach } from "vitest";
import {
  makeDevice,
  restartDevice,
  closeDevices,
  convergeRound,
  sessionOnce,
  type Device,
} from "./pkg1_helpers.ts";
import { oracle } from "./probes/sync_probe_helpers.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { applyRemoteChange, loadKnowledgeFromDb } from "../src/persistence/database.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";

const T0 = 1_756_000_000_000;
let devices: Device[] = [];
afterEach(() => closeDevices(devices));

function inputOf(title: string) {
  return {
    title,
    description: "Base description",
    startMs: T0,
    endMs: T0 + 3_600_000,
    allDay: false,
  };
}

/** Deliver one specific change record src->dst directly (single-record path). */
function deliver(dst: Device, src: Device, changeId: string): string {
  const row = src.db.prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId) as any;
  const record: ChangeRecord = {
    change_id: row.change_id,
    device_id: row.device_id,
    local_seq: row.local_seq,
    entity_id: row.entity_id,
    entity_type: row.entity_type,
    field_path: row.field_path,
    operation: row.operation,
    payload: JSON.parse(row.payload),
    hlc_timestamp: row.hlc_timestamp,
    causality_clock: JSON.parse(row.causality_clock),
    schema_version: row.schema_version,
  };
  return applyRemoteChange(dst.db, record, loadKnowledgeFromDb(dst.db), makeEntityMutator());
}

function titleOf(d: Device, id: string): string {
  return (d.db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as any).title;
}

function unresolvedConflicts(d: Device, entityId: string): number {
  return (
    d.db
      .prepare(
        "SELECT COUNT(*) c FROM conflicts WHERE entity_id = ? AND status = 'unresolved'",
      )
      .get(entityId) as { c: number }
  ).c;
}

/** Latest title record of `d` for `id` whose payload value equals `title`. */
function findTitleRecord(d: Device, id: string, title: string): string {
  const rows = d.db
    .prepare(
      "SELECT change_id, payload FROM changes WHERE entity_id = ? AND field_path = 'title' ORDER BY device_id, local_seq",
    )
    .all(id) as Array<{ change_id: string; payload: string }>;
  const match = rows.find((r) => (JSON.parse(r.payload) as { value: string }).value === title);
  if (!match) throw new Error(`no title record with value ${title} on ${d.tag}`);
  return match.change_id;
}

// Shared setup for the delayed-C scenario: Base event converged on a/b/c,
// C = b edits title to "B stale", c applies C and edits to "C later" (D).
// Returns { a, b, c, id, recC } with a NOT yet having seen C or D.
async function setupDelayedC(): Promise<{
  a: Device;
  b: Device;
  c: Device;
  id: string;
  recC: string;
  recD: string;
}> {
  const a = makeDevice("a");
  const b = makeDevice("b");
  const c = makeDevice("c");
  devices = [a, b, c];
  const ev = a.core.createEvent(inputOf("Base"));
  const id = ev.id;
  await convergeRound([a, b, c]);

  b.core.updateEvent(id, inputOf("B stale")); // C (producer b)
  const recC = findTitleRecord(b, id, "B stale");
  expect(deliver(c, b, recC)).toBe("applied");
  c.core.updateEvent(id, inputOf("C later")); // D (producer c)
  const recD = findTitleRecord(c, id, "C later");
  return { a, b, c, id, recC, recD };
}

describe("P11 §3.2a regression: stale causal-before never regresses materialized state", () => {
  test("1. basic stale replay: newer value survives stale C delivery", async () => {
    const { a, b, c, id, recC, recD } = await setupDelayedC();

    // a receives ONLY D (contiguous, no gap) — newer state incorporated.
    expect(deliver(a, c, recD)).toBe("applied");
    expect(titleOf(a, id)).toBe("C later");

    // The OLD FAILURE: stale C (causally dominated by D) overwrote the row.
    const res = deliver(a, b, recC);
    expect(["applied", "duplicate"]).toContain(res);
    // THE INVARIANT: materialized state not regressed.
    expect(titleOf(a, id)).toBe("C later");
    // No silent winner-pick and no conflict either: C is superseded knowledge.
    expect(unresolvedConflicts(a, id)).toBe(0);

    // b and c remain consistent (their own rows were already correct).
    expect(titleOf(b, id)).toBe("B stale"); // b never saw D yet
    expect(titleOf(c, id)).toBe("C later");
    void b;
  });

  test("2. multi-peer delayed delivery: stale C via full anti-entropy rounds", async () => {
    const { a, b, c, id, recC, recD } = await setupDelayedC();

    expect(deliver(a, c, recD)).toBe("applied");
    expect(titleOf(a, id)).toBe("C later");

    // Stale C arrives via a DIFFERENT peer (b), then full anti-entropy runs.
    deliver(a, b, recC);
    await convergeRound([a, b, c]);
    await convergeRound([a, b, c]);

    // After convergence every device's materialized title is the newest
    // value ("C later") — the stale value exists only in history.
    for (const d of [a, b, c]) {
      expect(titleOf(d, id)).toBe("C later");
      expect(unresolvedConflicts(d, id)).toBe(0);
    }
  });

  test("3. replay/anti-entropy: historical re-delivery cannot regress state", async () => {
    const { a, b, c, id, recC, recD } = await setupDelayedC();
    expect(deliver(a, c, recD)).toBe("applied");

    // Deliver stale C, then run real sync sessions (engine-driven, not just
    // single-record delivery) in every direction — replays must be inert.
    deliver(a, b, recC);
    for (const [x, y] of [
      [a, b],
      [b, a],
      [a, c],
      [c, a],
      [b, c],
      [c, b],
    ] as Array<[Device, Device]>) {
      await sessionOnce(x, y);
    }
    for (const d of [a, b, c]) expect(titleOf(d, id)).toBe("C later");
  });

  test("4. concurrent distinction: genuine concurrency still conflicts (not dropped as stale)", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const ev = a.core.createEvent(inputOf("Base"));
    const id = ev.id;
    await convergeRound([a, b]);

    // GENUINE CONCURRENT edits (neither dominates the other): a and b each
    // edit title without seeing the other's edit.
    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    await convergeRound([a, b]);

    // §3.3 must fire: unresolved conflict rows on BOTH devices, both values
    // preserved until user resolution (not silently dropped as "stale").
    expect(unresolvedConflicts(a, id)).toBeGreaterThanOrEqual(1);
    expect(unresolvedConflicts(b, id)).toBeGreaterThanOrEqual(1);
    const aVal = titleOf(a, id);
    const bVal = titleOf(b, id);
    expect(["From A", "From B"]).toContain(aVal);
    expect(["From A", "From B"]).toContain(bVal);
    expect(aVal).toBe("From A"); // local value preserved on a (§3.3)
    expect(bVal).toBe("From B"); // local value preserved on b (§3.3)
  });

  test("5. restart persistence: stale C after restart still cannot regress", async () => {
    const { a, b, c, id, recC, recD } = await setupDelayedC();
    expect(deliver(a, c, recD)).toBe("applied");
    expect(titleOf(a, id)).toBe("C later");

    // Restart a (durable state reload), then the stale C arrives.
    const a2 = restartDevice(a);
    devices[devices.indexOf(a)] = a2;
    expect(titleOf(a2, id)).toBe("C later"); // survived restart
    const res = deliver(a2, b, recC);
    expect(["applied", "duplicate"]).toContain(res);
    expect(titleOf(a2, id)).toBe("C later"); // STILL not regressed
    expect(unresolvedConflicts(a2, id)).toBe(0);
    void c;
  });

  test("6. snapshot interaction: stale records cannot ride a snapshot to regress state", async () => {
    const { a, b, c, id, recC, recD } = await setupDelayedC();
    expect(deliver(a, c, recD)).toBe("applied");
    expect(titleOf(a, id)).toBe("C later");
    deliver(a, b, recC); // stale C now in a's history too

    // Fresh peer d receives a FULL SNAPSHOT from a (which contains a's
    // applied history incl. the stale record's effects per the snapshot
    // model) — the materialized title must be the newest value, and the
    // snapshot must not reintroduce the stale value.
    const d1 = makeDevice("d");
    devices.push(d1);
    // Pair a<->d1 by exchange: convergeRound performs sessions between all
    // ordered pairs; first contact pairs the peers at the protocol level.
    await convergeRound([a, d1]);
    await convergeRound([a, b, c, d1]);

    expect(titleOf(d1, id)).toBe("C later");
    expect(unresolvedConflicts(d1, id)).toBe(0);
    // Whole-network convergence on the semantic value (oracle = independent
    // expected-state tracker, not production logic).
    const o = oracle([a, b, c, d1]);
    expect(o.converged, JSON.stringify(o.detail)).toBe(true);
  });
});
