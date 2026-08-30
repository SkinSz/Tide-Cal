// Pkg5 regression suite (QA M-2 / QA-1 F2): DC-03 conflict detection wired
// into the live pipeline.
//
// The finding: detect() existed only for unit tests; the DC-07 conflicts
// tables had no writer in src/, and concurrent same-field edits silently
// converged (implicit winner selection) with no conflict data ever surfacing.
//
// Two assertion levels, because the live session carries TWO application
// paths (see docs/qa/remediation/pkg5-diagnosis.md §3):
//
//   1. T2/applyRemoteChange (DC-02 §7 change-record path) — THE authoritative
//      layer this package wires. Tests drive applyRemoteChange +
//      makeEntityMutator directly and assert the exact DC-03 outcomes:
//      §3.3/§3.4 conflict row + local value NOT overwritten (deterministic
//      materialization, no LWW even against a later-hlc record).
//
//   2. Full sessions (pkg1 harness) — conflict records must be created on
//      real receivers and survive real traffic. Pkg5b NOTE (was: "the
//      DC-09 snapshot phase converges conflict-diverged ROWS"): with the
//      M-4 trigger fix (neededRanges excludes self-produced seqs) a
//      converged session no longer runs a full-state exchange, and Pkg5b's
//      conflict-aware applySnapshot guard keeps the local value even when
//      one legitimately runs — so conflict-diverged ROWS now stay DIVERGED
//      per DC-03 §3.3/TR-2 until user resolution. The tests therefore
//      assert, at session level: conflict rows on every receiver with ALL
//      payloads preserved verbatim, participant-set consistency, no
//      duplicates, restart persistence, and per-device row divergence
//      (each device keeps its own pre-conflict value; never a third value,
//      never data loss). The §3.3 guarantee is pinned at BOTH levels now.
//
// The independent expected-state oracle (pkg1_helpers ExpectedState) is
// asserted alongside every scenario; conflict scenarios use per-device
// expectations because per-device divergence IS the specified DC-03 outcome.
import { describe, expect, test, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  makeDevice,
  restartDevice,
  closeDevices,
  convergeRound,
  sessionOnce,
  ExpectedState,
  assertAgainstOracle,
  type Device,
} from "./pkg1_helpers.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { applyRemoteChange, loadKnowledgeFromDb } from "../src/persistence/database.ts";
import { ConflictsViewModel } from "../src/application/conflicts_ui.ts";
import { makeDispatcher } from "../src/persistence/bridges/sidecar_server.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";

const T0 = 1_756_000_000_000; // fixed epoch-ms schedule base

function inputOf(title: string): {
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
} {
  return {
    title,
    description: "Base description",
    startMs: T0,
    endMs: T0 + 3_600_000,
    allDay: false,
  };
}

interface ConflictRow {
  conflict_id: string;
  entity_id: string;
  field_path: string;
  status: string;
  detected_at_hlc: number;
  resolved_value: string | null;
  resolved_at_hlc: number | null;
}

function conflictRows(db: Device["db"], entityId?: string): ConflictRow[] {
  const rows = entityId
    ? (db
        .prepare("SELECT * FROM conflicts WHERE entity_id = ? ORDER BY conflict_id")
        .all(entityId) as ConflictRow[])
    : (db.prepare("SELECT * FROM conflicts ORDER BY conflict_id").all() as ConflictRow[]);
  return rows;
}

function participants(
  db: Device["db"],
  conflictId: string,
): Array<{ change_id: string; device_id: string; payload: string }> {
  return db
    .prepare(
      "SELECT change_id, device_id, payload FROM conflict_participants WHERE conflict_id = ? ORDER BY change_id",
    )
    .all(conflictId) as Array<{
    change_id: string;
    device_id: string;
    payload: string;
  }>;
}

/** Per-producer change frontier: max applied local_seq per device_id. */
function producerFrontiers(db: Device["db"]): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT device_id AS d, MAX(local_seq) AS m FROM changes GROUP BY device_id",
    )
    .all() as Array<{ d: string; m: number }>;
  return Object.fromEntries(rows.map((r) => [r.d, r.m]));
}

/**
 * Sessions converge: every device's change frontier covers every producer's
 * latest seq (no stalled/hung/half-applied session — the Pkg4 bounded-session
 * property exercised through real convergeRound traffic).
 */
function assertFrontiersConverged(devices: Device[]): void {
  const fronts = devices.map((d) => producerFrontiers(d.db));
  const union: Record<string, number> = {};
  for (const f of fronts) {
    for (const [dev, seq] of Object.entries(f)) {
      union[dev] = Math.max(union[dev] ?? 0, seq);
    }
  }
  for (let i = 0; i < devices.length; i++) {
    expect(fronts[i], `${devices[i]!.tag} frontiers`).toEqual(union);
  }
}

/** The title of one event row on a device ("" when the row is absent). */
function rowTitle(d: Device, id: string): string {
  const row = d.db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as
    | { title: string }
    | undefined;
  return row?.title ?? "";
}

/** Create one event on `a`, converge it to all peers, return its id. */
async function seedSharedEvent(a: Device, peers: Device[]): Promise<string> {
  const ev = a.core.createEvent(inputOf("Base"));
  await convergeRound([a, ...peers]);
  return ev.id;
}

/** Deliver ONE change record from `src`'s history directly into T2 on `dst`. */
function deliverRecord(dst: Device, src: Device, changeId: string): "applied" | "buffered" | "duplicate" {
  const row = src.db.prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId) as Record<
    string,
    string | number
  >;
  expect(row, `record ${changeId} on ${src.tag}`).toBeDefined();
  const record: ChangeRecord = {
    change_id: row.change_id as string,
    device_id: row.device_id as string,
    local_seq: row.local_seq as number,
    entity_id: row.entity_id as string,
    entity_type: row.entity_type as ChangeRecord["entity_type"],
    field_path: row.field_path as string,
    operation: row.operation as ChangeRecord["operation"],
    payload: JSON.parse(row.payload as string) as ChangeRecord["payload"],
    hlc_timestamp: row.hlc_timestamp as number,
    causality_clock: JSON.parse(row.causality_clock as string),
    schema_version: row.schema_version as number,
  };
  return applyRemoteChange(dst.db, record, loadKnowledgeFromDb(dst.db), makeEntityMutator());
}

function oracleEvent(id: string, title: string, description = "Base description") {
  return { id, title, description, startMs: T0, endMs: T0 + 3_600_000, allDay: false };
}

let devices: Device[] = [];
afterEach(() => {
  closeDevices(devices);
  devices = [];
});

describe("Pkg5 level 1 — DC-03 materialization at T2/applyRemoteChange (authoritative layer)", () => {
  // -------------------------------------------------------------------------
  // 1. Same-field concurrency at T2: conflict row + local value kept (§3.3)
  // -------------------------------------------------------------------------
  test("T2 same-field concurrent record → conflict row, BOTH payloads kept, local value NOT overwritten (§3.3/TR-2)", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");

    // a's own title record id, and b's concurrent title record id.
    const aTitleRec = (
      a.db
        .prepare("SELECT change_id FROM changes WHERE entity_id = ? AND field_path = 'title' AND device_id = ?")
        .get(id, a.identity.deviceId) as { change_id: string }
    ).change_id;
    const bTitleRec = (
      b.db
        .prepare("SELECT change_id FROM changes WHERE entity_id = ? AND field_path = 'title' AND device_id = ?")
        .get(id, b.identity.deviceId) as { change_id: string }
    ).change_id;

    // Deliver b's concurrent edit into a through the REAL T2 path.
    expect(deliverRecord(a, b, bTitleRec)).toBe("applied");

    // §3.3: the record entered history and knowledge advanced…
    expect(
      (a.db.prepare("SELECT COUNT(*) AS c FROM changes WHERE change_id = ?").get(bTitleRec) as { c: number }).c,
    ).toBe(1);
    // …but the entity row was NOT overwritten: a keeps its own value.
    expect(rowTitle(a, id)).toBe("From A");

    // Exactly ONE unresolved conflict record for (id, "title"), holding BOTH
    // payloads verbatim (§4 / TR-2).
    const rows = conflictRows(a.db, id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.field_path).toBe("title");
    expect(rows[0]!.status).toBe("unresolved");
    const parts = participants(a.db, rows[0]!.conflict_id);
    expect(parts.map((p) => p.change_id).sort()).toEqual([aTitleRec, bTitleRec].sort());
    const values = parts.map((p) => (JSON.parse(p.payload) as { value: string }).value);
    expect(values.sort()).toEqual(["From A", "From B"]);

    // Independent oracle: a's semantic state = its own edit (per-device
    // expectation — divergence is the specified DC-03 outcome).
    const expA = new ExpectedState();
    expA.create(oracleEvent(id, "Base"));
    expA.update(oracleEvent(id, "From A"));
    expect(assertAgainstOracle(expA, [a]).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. No-LWW at T2 (§5 / TR-7): a concurrent record with a LATER hlc still
  //    does not win — the local value stays until explicit resolution.
  // -------------------------------------------------------------------------
  test("T2 no-LWW: later-hlc concurrent record cannot overwrite the local value", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");
    const bTitleRec = concurrentTitleRec(b, id, b.identity.deviceId);

    // Make the incoming record arbitrarily "newer" by wall clock.
    const later = Date.now() + 3_600_000;
    b.db.prepare("UPDATE changes SET hlc_timestamp = ? WHERE change_id = ?").run(later, bTitleRec);

    expect(deliverRecord(a, b, bTitleRec)).toBe("applied");
    expect(rowTitle(a, id)).toBe("From A"); // recency did NOT decide
    expect(conflictRows(a.db, id).length).toBe(1);
    expect(conflictRows(a.db, id)[0]!.status).toBe("unresolved");
  });

  // -------------------------------------------------------------------------
  // 3. Identical value concurrently at T2 → noop, no conflict row (§3.1/TR-5)
  // -------------------------------------------------------------------------
  test("T2 identical-value concurrent record → no conflict row, no state change", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "Same Value");
    editViaCore(b, id, "Same Value");
    const before = a.db.prepare("SELECT title, updated_hlc FROM events WHERE event_id = ?").get(id);

    expect(deliverRecord(a, b, concurrentTitleRec(b, id, b.identity.deviceId))).toBe("applied");
    expect(conflictRows(a.db).length).toBe(0);
    // §3.1: no-op — not even an updated_hlc rewrite.
    expect(a.db.prepare("SELECT title, updated_hlc FROM events WHERE event_id = ?").get(id)).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // 4. Delete-vs-edit at T2 → conflict, neither side silently wins (§3.4/TR-4)
  // -------------------------------------------------------------------------
  test("T2 delete vs concurrent edit → conflict; delete not silently destroyed, edit not silently resurrected", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);

    // Side A deletes the event (whole-entity remove, field_path '*');
    // side B edits the title concurrently.
    a.core.deleteEvent(id);
    editViaCore(b, id, "Edited while deleted elsewhere");

    // Receiver A: incoming edit vs local delete → conflict; row stays deleted.
    expect(deliverRecord(a, b, concurrentTitleRec(b, id, b.identity.deviceId))).toBe("applied");
    const rowsA = conflictRows(a.db, id);
    expect(rowsA.length).toBe(1);
    expect(rowsA[0]!.status).toBe("unresolved");
    expect(participants(a.db, rowsA[0]!.conflict_id).length).toBe(2);
    expect(
      (a.db.prepare("SELECT COUNT(*) AS c FROM events WHERE event_id = ?").get(id) as { c: number }).c,
    ).toBe(0); // the concurrent edit did NOT resurrect the deleted event

    // Receiver B: incoming delete vs local edit → conflict; row keeps the edit.
    const removeRec = (
      a.db
        .prepare("SELECT change_id FROM changes WHERE entity_id = ? AND operation = 'remove'")
        .get(id) as { change_id: string }
    ).change_id;
    expect(deliverRecord(b, a, removeRec)).toBe("applied");
    const rowsB = conflictRows(b.db, id);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0]!.status).toBe("unresolved");
    expect(rowTitle(b, id)).toBe("Edited while deleted elsewhere"); // NOT destroyed
  });
});

// Helpers used above (declared after use is fine for function declarations).
function editViaCore(d: Device, id: string, title: string): void {
  d.core.updateEvent(id, inputOf(title));
}
function concurrentTitleRec(d: Device, id: string, deviceId: string): string {
  return (
    d.db
      .prepare(
        "SELECT change_id FROM changes WHERE entity_id = ? AND field_path = 'title' AND device_id = ?",
      )
      .get(id, deviceId) as { change_id: string }
  ).change_id;
}

describe("Pkg5 level 2 — detection through real sessions (pkg1 harness)", () => {
  // -------------------------------------------------------------------------
  // 5. Same-field concurrent edits over real sessions → conflict rows on
  //    BOTH receivers with both payloads preserved; rows STAY DIVERGED per
  //    DC-03 §3.3 (Pkg5b: no snapshot domination of unresolved conflicts —
  //    previously the every-session Trigger A snapshot phase converged them).
  // -------------------------------------------------------------------------
  test("sessions: conflict rows on both receivers, payloads preserved, rows diverged pending resolution", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);

    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");
    await convergeRound([a, b]);

    assertFrontiersConverged([a, b]);

    // Exactly ONE unresolved conflict record per device, both values kept.
    for (const d of [a, b]) {
      const rows = conflictRows(d.db, id);
      expect(rows.length, `${d.tag} conflict rows`).toBe(1);
      expect(rows[0]!.field_path).toBe("title");
      expect(rows[0]!.status).toBe("unresolved");
      const parts = participants(d.db, rows[0]!.conflict_id);
      expect(parts.length).toBe(2);
      const values = parts.map((p) => (JSON.parse(p.payload) as { value: string }).value);
      expect(values.sort()).toEqual(["From A", "From B"]);
    }

    // Rows stay DIVERGED: each device keeps its own pre-conflict value
    // until user resolution (DC-03 §3.3/TR-2, Pkg5b) — never a third value,
    // never data loss.
    expect(rowTitle(a, id)).toBe("From A");
    expect(rowTitle(b, id)).toBe("From B");
  });

  // -------------------------------------------------------------------------
  // 6. Different-field concurrent edits → NO conflict rows, full merge (§3.6)
  // -------------------------------------------------------------------------
  test("sessions: different-field concurrent edits merge with zero conflict rows", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);

    a.core.updateEvent(id, inputOf("Title by A"));
    b.core.updateEvent(id, { ...inputOf("Base"), description: "Description by B" });
    await convergeRound([a, b]);

    assertFrontiersConverged([a, b]);
    expect(conflictRows(a.db).length).toBe(0);
    expect(conflictRows(b.db).length).toBe(0);

    const exp = new ExpectedState();
    exp.create(oracleEvent(id, "Base"));
    exp.update(oracleEvent(id, "Title by A", "Description by B"));
    expect(assertAgainstOracle(exp, [a, b]).ok).toBe(true); // full convergence
  });

  // -------------------------------------------------------------------------
  // 7. Identical value concurrently over sessions → no conflict row (§3.1)
  // -------------------------------------------------------------------------
  test("sessions: identical value concurrently → no conflict rows, converged", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);

    editViaCore(a, id, "Same Value");
    editViaCore(b, id, "Same Value");
    await convergeRound([a, b]);

    assertFrontiersConverged([a, b]);
    expect(conflictRows(a.db).length).toBe(0);
    expect(conflictRows(b.db).length).toBe(0);

    const exp = new ExpectedState();
    exp.create(oracleEvent(id, "Base"));
    exp.update(oracleEvent(id, "Same Value"));
    expect(assertAgainstOracle(exp, [a, b]).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. Conflict records persist across restartDevice (§4.1 / TR-8)
  // -------------------------------------------------------------------------
  test("conflict records survive restart byte-identical and unresolved", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");
    await convergeRound([a, b]);
    const before = conflictRows(b.db, id);
    expect(before.length).toBe(1);

    const b2 = restartDevice(b);
    devices = [a, b2];
    const after = conflictRows(b2.db, id);
    expect(after).toEqual(before);
    expect(participants(b2.db, after[0]!.conflict_id).length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 9. Repeated sessions after a conflict → no duplicate conflict rows
  // -------------------------------------------------------------------------
  test("repeated sessions after a conflict never duplicate or reopen rows", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");
    await convergeRound([a, b]);
    const snapA = conflictRows(a.db, id);
    const snapB = conflictRows(b.db, id);
    expect(snapA.length).toBe(1);
    expect(snapB.length).toBe(1);

    await convergeRound([a, b]);
    await convergeRound([a, b]);

    expect(conflictRows(a.db, id)).toEqual(snapA);
    expect(conflictRows(b.db, id)).toEqual(snapB);
    expect(participants(a.db, snapA[0]!.conflict_id).length).toBe(2);
    expect(participants(b.db, snapB[0]!.conflict_id).length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 10. 3-peer same-field conflict → ONE record with 3 participants per
  //     device, consistent participant sets, per-device divergence (§3.5/TR-9
  //     + Pkg5b §3.3: each device keeps its own value until resolution)
  // -------------------------------------------------------------------------
  test("3-peer same-field conflict → one 3-participant record per device, consistent sets, rows diverged", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    const c = makeDevice("c");
    devices = [a, b, c];
    const id = await seedSharedEvent(a, [b, c]);

    editViaCore(a, id, "Title A");
    editViaCore(b, id, "Title B");
    editViaCore(c, id, "Title C");
    await convergeRound([a, b, c]);

    assertFrontiersConverged([a, b, c]);
    const perDevice = [a, b, c].map((d) => {
      const rows = conflictRows(d.db, id);
      expect(rows.length, `${d.tag} exactly one conflict row`).toBe(1);
      expect(rows[0]!.status).toBe("unresolved");
      expect(rows[0]!.field_path).toBe("title");
      const parts = participants(d.db, rows[0]!.conflict_id);
      expect(parts.length).toBe(3); // §3.5: all N+1 participants, ONE record
      const values = parts.map((p) => (JSON.parse(p.payload) as { value: string }).value);
      expect(values.sort()).toEqual(["Title A", "Title B", "Title C"]);
      return parts.map((p) => p.change_id).sort();
    });
    // Consistent participant identity across devices (no divergence).
    expect(perDevice[1]).toEqual(perDevice[0]);
    expect(perDevice[2]).toEqual(perDevice[0]);

    // Rows stay DIVERGED per device (Pkg5b §3.3 continuation): each keeps
    // its own pre-conflict value pending resolution — never a third value,
    // never data loss.
    expect(rowTitle(a, id)).toBe("Title A");
    expect(rowTitle(b, id)).toBe("Title B");
    expect(rowTitle(c, id)).toBe("Title C");
  });

  // -------------------------------------------------------------------------
  // 11. Resolution semantics (DC-03 §4.3/§4.4 + DC-14 §4/§6): UI-only
  //     resolve; resolution propagates as a NORMAL change record; a resolved
  //     conflict never re-appears as unresolved; the peer's copy is marked
  //     through the DC-14 §6.3 remote-resolution intake (engine wiring of the
  //     intake is deferred #11 — documented, deliberately not built here).
  // -------------------------------------------------------------------------
  test("resolve keep_mine → resolved stays resolved, propagates causally, no new conflicts", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");
    await convergeRound([a, b]);

    const rowA = conflictRows(a.db, id)[0]!;
    const vmA = new ConflictsViewModel(a.db, a.identity.deviceId);
    const resolution = vmA.resolve(rowA.conflict_id, { kind: "keep_mine" });
    expect(resolution.field_path).toBe("title");
    expect(vmA.getDetail(rowA.conflict_id).status).toBe("resolved_keep_local");
    expect(conflictRows(a.db, id)[0]!.resolved_at_hlc).not.toBeNull();

    await convergeRound([a, b]);
    assertFrontiersConverged([a, b]);

    // b applied the resolution change causally (§4.4): its row carries the
    // winning value and NO new conflict row appeared.
    expect(conflictRows(b.db, id).length).toBe(1); // only the original detection
    expect(conflictRows(b.db, id)[0]!.status).toBe("unresolved"); // device-local until intake
    expect(rowTitle(b, id)).toBe("From A");
    expect(rowTitle(a, id)).toBe("From A"); // §4.4 wrote the winner as a normal change

    // a's resolution does NOT re-appear as unresolved after more sessions.
    await convergeRound([a, b]);
    expect(conflictRows(a.db, id)[0]!.status).toBe("resolved_keep_local");

    // DC-14 §6.3/§6.4 remote-resolution intake: b's copy flips via the
    // exported outcome (application-layer mechanism, matching participant set).
    const exported = vmA.exportResolution(rowA.conflict_id)!;
    const vmB = new ConflictsViewModel(b.db, b.identity.deviceId);
    expect(
      vmB.applyRemoteResolution({
        entity_id: exported.entity_id,
        field_path: exported.field_path,
        status: exported.status,
        participant_change_ids: exported.participant_change_ids,
      }),
    ).toBe("resolved_on_receipt");
    expect(conflictRows(b.db, id)[0]!.status).toBe("resolved_keep_local");
    await convergeRound([a, b]);
    expect(conflictRows(b.db, id)[0]!.status).toBe("resolved_keep_local");
  });

  // -------------------------------------------------------------------------
  // 12. Bounded sessions over conflict-carrying DBs still complete (Pkg4)
  // -------------------------------------------------------------------------
  test("sessionOnce completes cleanly with conflict rows present", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");
    await convergeRound([a, b]);
    const { fromStats, toStats } = await sessionOnce(a, b);
    expect(fromStats["errors"] ?? 0).toBe(0);
    expect(toStats["errors"] ?? 0).toBe(0);
  });
});

// -------------------------------------------------------------------------
// 13. Retrieval: read-only sidecar ops return ConflictsViewModel shapes;
//     Rust allow-list carries the new ops (allow-list drift guard).
// -------------------------------------------------------------------------
describe("Pkg5 retrieval — list_conflicts / conflict_detail ops", () => {
  test("ops return exact ConflictsViewModel shapes; allow-list entries exist", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = await seedSharedEvent(a, [b]);
    editViaCore(a, id, "From A");
    editViaCore(b, id, "From B");
    await convergeRound([a, b]);

    const dispatch = makeDispatcher(b.core);
    const listed = dispatch("list_conflicts", {}) as {
      total_unresolved: number;
      conflicts: Array<{
        conflict_id: string;
        entity_id: string;
        field_path: string;
        status: string;
        participant_count: number;
      }>;
    };
    expect(listed.total_unresolved).toBe(1);
    expect(listed.conflicts.length).toBe(1);
    const item = listed.conflicts[0]!;
    // ConflictListItem shape (DC-14 §5.2) exactly.
    expect(Object.keys(item).sort()).toEqual(
      ["conflict_id", "entity_id", "field_path", "participant_count", "status"],
    );
    expect(item.entity_id).toBe(id);
    expect(item.field_path).toBe("title");
    expect(item.status).toBe("unresolved");
    expect(item.participant_count).toBe(2);

    // entity_id filter round-trips.
    const filtered = dispatch("list_conflicts", { entity_id: "no-such" }) as {
      total_unresolved: number;
      conflicts: unknown[];
    };
    expect(filtered.total_unresolved).toBe(1); // total is global
    expect(filtered.conflicts.length).toBe(0);

    // ConflictDetailView shape (DC-14 §3.2) exactly, both candidate values.
    const detail = dispatch("conflict_detail", { conflict_id: item.conflict_id }) as {
      conflict_id: string;
      entity_id: string;
      entity_title: string | null;
      field_path: string;
      status: string;
      candidates: Array<{
        change_id: string;
        device_id: string;
        device_name: string;
        deleted: boolean;
        value: unknown;
        hlc_timestamp: number;
      }>;
      local_change_id: string | null;
    };
    expect(Object.keys(detail).sort()).toEqual([
      "candidates",
      "conflict_id",
      "entity_id",
      "entity_title",
      "field_path",
      "local_change_id",
      "status",
    ]);
    expect(detail.entity_title).toBe(rowTitle(b, id));
    expect(detail.status).toBe("unresolved");
    expect(detail.candidates.length).toBe(2);
    const values = detail.candidates.map((c) => c.value).sort();
    expect(values).toEqual(["From A", "From B"]);
    expect(detail.local_change_id).not.toBeNull();
    for (const c of detail.candidates) {
      expect(typeof c.hlc_timestamp).toBe("number");
      expect(typeof c.device_name).toBe("string");
      expect(c.deleted).toBe(false);
    }

    // Validation + not_found surface as op errors.
    expect(() => dispatch("conflict_detail", {})).toThrow();
    expect(() => dispatch("conflict_detail", { conflict_id: "missing" })).toThrow(/no conflict/);

    // Rust sync_op allow-list carries both new ops (allow-list drift guard).
    const librs = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(librs).toContain('"list_conflicts"');
    expect(librs).toContain('"conflict_detail"');
  });
});
