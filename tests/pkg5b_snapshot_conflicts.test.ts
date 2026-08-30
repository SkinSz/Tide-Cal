// Pkg5b regression suite (Pkg5-residual, MAJOR — Pkg5-review P9 + QA M-4):
// conflict-aware snapshot application + Trigger-A excludes self-produced seqs.
//
// Findings fixed (both reproduced at HEAD 2079ad2, see
// docs/qa/remediation/pkg5b-report.md §2):
//
//   F-A (P9): DC-09 §7.1 snapshot domination silently overwrote the
//        MATERIALIZED row VALUE of an entity with an UNRESOLVED conflict
//        ("From A" → "From B" observed) while the conflict ROW survived —
//        defeating DC-03 §3.3/§3.4/TR-2 "local value kept until resolution".
//        Fix: applySnapshot skips replacement AND absence-deletion for
//        entities carrying an unresolved conflicts row (non-conflicted
//        entities keep §7.1 unchanged — pinned by test 6).
//
//   F-B (M-4 root cause): the peer's advertised clock contains a component
//        for OUR OWN device id (it learned our seqs by applying our
//        changes), and the receiver-side knowledge state never tracks an
//        applied_upto frontier for self. neededRanges therefore requested
//        our own history back every session; the range never shrank
//        (duplicates don't advance applied_upto) or was unservable
//        post-compaction → gapRetries → DC-09 §3 Trigger A fired on EVERY
//        session between converged peers (probe trace at HEAD:
//        HELLO, CHANGES_REQUEST{self}, CHANGES_REQUEST{self},
//        FULL_STATE_OFFER, FULL_STATE_ACCEPT, CHANGES_ACK).
//        Fix: neededRanges(k, advertised, selfDeviceId?) excludes
//        self-produced sequences; Trigger A fires only on genuinely
//        unservable gaps (pinned by test 4; Pkg1 SC5 suite still green).
import { describe, expect, test, afterEach } from "vitest";
import {
  makeDevice,
  closeDevices,
  convergeRound,
  sessionOnce,
  semanticEvents,
  sweepOn,
  msgPipePair,
  makeEntityMutator,
  createSyncEngine,
  type Device,
  type MsgPipe,
} from "./pkg1_helpers.ts";
import { applyRemoteChange, loadKnowledgeFromDb } from "../src/persistence/database.ts";
import { neededRanges, emptyKnowledge } from "../src/sync/knowledge_state.ts";
import { buildSnapshot, applySnapshot } from "../src/sync/full_state.ts";
import { ConflictsViewModel } from "../src/application/conflicts_ui.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";

const T0 = 1_756_000_000_000;

function inputOf(title: string) {
  return {
    title,
    description: "Base description",
    startMs: T0,
    endMs: T0 + 3_600_000,
    allDay: false,
  };
}

let devices: Device[] = [];
afterEach(() => {
  closeDevices(devices);
  devices = [];
});

// --- shared helpers (same shape as pkg5_conflicts.test.ts) -----------------

function rowTitle(d: Device, id: string): string {
  const row = d.db.prepare("SELECT title FROM events WHERE event_id = ?").get(id) as
    | { title: string }
    | undefined;
  return row?.title ?? "";
}

function conflictRows(
  db: Device["db"],
  entityId?: string,
): Array<{
  conflict_id: string;
  entity_id: string;
  field_path: string;
  status: string;
  resolved_value: string | null;
  resolved_at_hlc: number | null;
}> {
  const sql = entityId
    ? "SELECT * FROM conflicts WHERE entity_id = ?"
    : "SELECT * FROM conflicts";
  const args = entityId ? [entityId] : [];
  return db.prepare(sql).all(...args) as Array<{
    conflict_id: string;
    entity_id: string;
    field_path: string;
    status: string;
    resolved_value: string | null;
    resolved_at_hlc: number | null;
  }>;
}

function participants(db: Device["db"], conflictId: string) {
  return db
    .prepare(
      "SELECT change_id, device_id, payload FROM conflict_participants WHERE conflict_id = ? ORDER BY change_id",
    )
    .all(conflictId) as Array<{ change_id: string; device_id: string; payload: string }>;
}

/** Deliver ONE change record from src's history directly into T2 on dst. */
function deliverRecord(
  dst: Device,
  src: Device,
  changeId: string,
): "applied" | "buffered" | "duplicate" {
  const row = src.db.prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId) as Record<
    string,
    string | number
  >;
  const record: ChangeRecord = {
    change_id: row.change_id as string,
    device_id: row.device_id as string,
    local_seq: row.local_seq as number,
    entity_id: row.entity_id as string,
    entity_type: row.entity_type as ChangeRecord["entity_type"],
    field_path: row.field_path as string,
    operation: row.operation as ChangeRecord["operation"],
    payload: JSON.parse(row.payload as string),
    hlc_timestamp: row.hlc_timestamp as number,
    causality_clock: JSON.parse(row.causality_clock as string),
    schema_version: row.schema_version as number,
  };
  return applyRemoteChange(dst.db, record, loadKnowledgeFromDb(dst.db), makeEntityMutator());
}

function titleRec(d: Device, id: string, deviceId: string): string {
  return (
    d.db
      .prepare(
        "SELECT change_id FROM changes WHERE entity_id = ? AND field_path = 'title' AND device_id = ?",
      )
      .get(id, deviceId) as { change_id: string }
  ).change_id;
}

/** Build the peer's full snapshot chunks (DC-09 §4 sender side). */
function snapshotChunks(sender: Device): unknown[] {
  const chunks: unknown[] = [];
  buildSnapshot(sender.db, (s) => chunks.push(s));
  return chunks;
}

/** Apply every chunk of sender's snapshot to receiver (DC-09 §5). */
function applyAll(receiver: Device, sender: Device) {
  const results = snapshotChunks(sender).map((s) =>
    applySnapshot(receiver.db, s as never, loadKnowledgeFromDb(receiver.db)),
  );
  return results.reduce(
    (acc, r) => ({
      appliedEntities: acc.appliedEntities + r.appliedEntities,
      conflictPreserved: acc.conflictPreserved + r.conflictPreserved,
      survivedLocal: acc.survivedLocal + r.survivedLocal,
      absenceTombstones: acc.absenceTombstones + r.absenceTombstones,
      inheritedTombstones: acc.inheritedTombstones + r.inheritedTombstones,
    }),
    { appliedEntities: 0, conflictPreserved: 0, survivedLocal: 0, absenceTombstones: 0, inheritedTombstones: 0 },
  );
}

/**
 * One session from->to capturing BOTH sides' sent logs (sessionOnce only
 * returns the initiator's log; the snapshot stream flows the other way).
 */
async function sessionBoth(
  from: Device,
  to: Device,
): Promise<{ fromLog: unknown[]; toLog: unknown[] }> {
  const [pFrom, pTo] = msgPipePair() as [MsgPipe, MsgPipe];
  const engFrom = createSyncEngine({
    db: from.db,
    selfDeviceId: from.identity.deviceId,
    mutateEntity: makeEntityMutator(),
  });
  const engTo = createSyncEngine({
    db: to.db,
    selfDeviceId: to.identity.deviceId,
    mutateEntity: makeEntityMutator(),
  });
  const runF = engFrom.runSession(pFrom as never).catch(() => {});
  const runT = engTo.runSession(pTo as never).then(
    () => {},
    () => {},
  );
  await Promise.allSettled([runF, runT]);
  return { fromLog: pFrom.sentLog, toLog: pTo.sentLog };
}

function typesOf(log: unknown[]): string[] {
  return log.map((m) => (m as { type: string }).type);
}

// ---------------------------------------------------------------------------

describe("Pkg5b unit — Trigger A excludes self-produced sequences (M-4 root cause)", () => {
  test("neededRanges excludes the self device's advertised component", () => {
    const SELF = "device-self";
    const k = emptyKnowledge();
    // Converged peers: we already applied everything P and Q produced, and
    // the peers advertise our own (self-produced) seqs back at us.
    k.appliedUpto = { P: 5, Q: 3 };
    const advertised = { P: 5, Q: 3, [SELF]: 9 };
    // Before Pkg5b this returned [{device_id: SELF, lo: 1, hi: 9}] — the
    // phantom self-request that kept gap rounds alive every session.
    expect(neededRanges(k, advertised, SELF)).toEqual([]);
    // Without the self exclusion (legacy 2-arg form) self WOULD appear —
    // documents the old behavior the engine no longer exercises.
    expect(neededRanges(k, advertised)).toEqual([{ device_id: SELF, lo: 1, hi: 9 }]);
  });

  test("neededRanges still reports genuine gaps for OTHER producers", () => {
    const SELF = "device-self";
    const k = emptyKnowledge();
    k.appliedUpto = { P: 5 };
    expect(neededRanges(k, { P: 8, [SELF]: 2 }, SELF)).toEqual([
      { device_id: "P", lo: 6, hi: 8 },
    ]);
    // Pending/skipped exclusions still honored alongside the self filter
    // (seq 7 pending → split ranges around it; 8 itself still needed).
    k.pending.set("P", new Set([7]));
    expect(neededRanges(k, { P: 8, [SELF]: 2 }, SELF)).toEqual([
      { device_id: "P", lo: 6, hi: 6 },
      { device_id: "P", lo: 8, hi: 8 },
    ]);
  });
});

describe("Pkg5b unit — applySnapshot is conflict-aware (DC-03 §3.3 continuation)", () => {
  test("THE core regression: snapshot exchange over an unresolved conflict keeps the local row value and the conflict row", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const ev = a.core.createEvent(inputOf("Base"));
    await convergeRound([a, b]);

    // Same-field concurrent edits; conflict created at T2 on BOTH devices
    // (direct delivery — no session, so no snapshot phase runs first).
    a.core.updateEvent(ev.id, inputOf("From A"));
    b.core.updateEvent(ev.id, inputOf("From B"));
    expect(deliverRecord(a, b, titleRec(b, ev.id, b.identity.deviceId))).toBe("applied");
    expect(deliverRecord(b, a, titleRec(a, ev.id, a.identity.deviceId))).toBe("applied");
    expect(rowTitle(a, ev.id)).toBe("From A");
    expect(rowTitle(b, ev.id)).toBe("From B");
    expect(conflictRows(a.db, ev.id).length).toBe(1);
    expect(conflictRows(a.db, ev.id)[0]!.status).toBe("unresolved");

    // Snapshot exchange in BOTH directions (DC-09 §7.1 would overwrite the
    // dominated side's value at HEAD — P9 observed "From A" → "From B").
    const rA = applyAll(a, b);
    expect(rowTitle(a, ev.id)).toBe("From A"); // NOT overwritten
    expect(rA.conflictPreserved).toBe(1); // the guard fired for exactly this entity
    const rB = applyAll(b, a);
    expect(rowTitle(b, ev.id)).toBe("From B"); // NOT overwritten
    expect(rB.conflictPreserved).toBe(1);

    // The conflict ROWS survive untouched: unresolved, both payloads verbatim.
    for (const d of [a, b]) {
      const rows = conflictRows(d.db, ev.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("unresolved");
      const parts = participants(d.db, rows[0]!.conflict_id);
      expect(parts.length).toBe(2);
      const values = parts.map((p) => (JSON.parse(p.payload) as { value: string }).value);
      expect(values.sort()).toEqual(["From A", "From B"]);
    }
  });

  test("absence rule does not destroy a conflicted live row missing from the snapshot", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const conflict = a.core.createEvent(inputOf("Conflicted"));
    const plain = a.core.createEvent(inputOf("Plain"));
    await convergeRound([a, b]);

    // Same-field concurrent edits; conflict created at T2 on BOTH devices
    // (direct delivery — no session, so no snapshot phase runs first).
    a.core.updateEvent(conflict.id, inputOf("Mine"));
    b.core.updateEvent(conflict.id, inputOf("Theirs"));
    expect(deliverRecord(a, b, titleRec(b, conflict.id, b.identity.deviceId))).toBe("applied");
    expect(deliverRecord(b, a, titleRec(a, conflict.id, a.identity.deviceId))).toBe("applied");
    expect(conflictRows(a.db, conflict.id).length).toBe(1);

    // Build a snapshot from b that does NOT contain `plain` at all… by
    // deleting it on b first, then snapshotting: absence of the CONFLICTED
    // row is simulated by stripping it from the chunk stream.
    b.core.deleteEvent(plain.id);
    const chunks = snapshotChunks(b) as Array<{
      snapshot_clock: Record<string, number>;
      entities: Array<{ entity_id: string }>;
      tombstones: unknown[];
    }>;
    for (const c of chunks) {
      c.entities = c.entities.filter((e) => e.entity_id !== plain.id);
    }
    const results = chunks.map((c) =>
      applySnapshot(a.db, c as never, loadKnowledgeFromDb(a.db)),
    );
    // The absent-but-dominated plain event is still absence-tombstoned (§7.1
    // unchanged for non-conflicted entities)…
    expect(
      (a.db.prepare("SELECT COUNT(*) AS c FROM events WHERE event_id = ?").get(plain.id) as { c: number }).c,
    ).toBe(0);
    // …while the conflicted live row (present in the snapshot, dominated)
    // keeps its local value — neither overwritten nor deleted.
    expect(rowTitle(a, conflict.id)).toBe("Mine");
    expect(results.reduce((n, r) => n + r.conflictPreserved, 0)).toBeGreaterThanOrEqual(1);
  });

  test("after user resolution the guard lifts: resolution value stands and the row stays resolved", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const ev = a.core.createEvent(inputOf("Base"));
    await convergeRound([a, b]);
    a.core.updateEvent(ev.id, inputOf("From A"));
    b.core.updateEvent(ev.id, inputOf("From B"));
    expect(deliverRecord(a, b, titleRec(b, ev.id, b.identity.deviceId))).toBe("applied");
    expect(conflictRows(a.db, ev.id)[0]!.status).toBe("unresolved");

    // User resolves keep_mine (DC-14): normal change record + status flip.
    const vmA = new ConflictsViewModel(a.db, a.identity.deviceId);
    vmA.resolve(conflictRows(a.db, ev.id)[0]!.conflict_id, { kind: "keep_mine" });
    expect(conflictRows(a.db, ev.id)[0]!.status).toBe("resolved_keep_local");
    expect(rowTitle(a, ev.id)).toBe("From A");

    // Snapshot exchange no longer treats the entity as conflicted — and the
    // resolution change raised a's version clock above b's snapshot_clock,
    // so the local (resolution) value survives the §7.1 check itself.
    const r = applyAll(a, b);
    expect(rowTitle(a, ev.id)).toBe("From A");
    expect(r.conflictPreserved).toBe(0); // guard lifted
    expect(conflictRows(a.db, ev.id)[0]!.status).toBe("resolved_keep_local");
    expect(conflictRows(a.db, ev.id)[0]!.resolved_at_hlc).not.toBeNull();
  });

  test("non-conflicted entities keep §7.1 domination semantics unchanged", () => {
    const a = makeDevice("a");
    devices = [a];
    a.core.createEvent(inputOf("Local v1"));
    const id = (
      a.db.prepare("SELECT event_id FROM events LIMIT 1").get() as { event_id: string }
    ).event_id;

    // Synthetic dominated snapshot entry with a DIFFERENT value: no conflict
    // row exists, so §7.1 applies verbatim — the snapshot replaces the row.
    // snapshot_clock must cover the receiver's own component for domination.
    const chunks = [
      {
        snapshot_clock: { "d-sender": 4, [a.identity.deviceId]: 5 },
        entities: [
          {
            entity_id: id,
            entity_type: "event",
            data: JSON.stringify({
              ...(a.db.prepare("SELECT * FROM events WHERE event_id = ?").get(id) as object),
              title: "Winner by domination",
            }),
            producer_device_id: "d-sender",
            producer_seq: 2,
            causality_clock: { "d-sender": 2 },
          },
        ],
        tombstones: [],
      },
    ];
    const r = chunks.reduce(
      (acc, c) => {
        const res = applySnapshot(a.db, c as never, loadKnowledgeFromDb(a.db));
        acc.applied += res.appliedEntities;
        return acc;
      },
      { applied: 0 },
    );
    expect(r.applied).toBe(1);
    expect(rowTitle(a, id)).toBe("Winner by domination");
    expect(conflictRows(a.db).length).toBe(0);
  });
});

describe("Pkg5b session level — Trigger A fires only on genuine gaps", () => {
  test("M-4 efficiency: sessions between CONVERGED peers exchange ZERO full-state messages", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    a.core.createEvent(inputOf("One"));
    a.core.createEvent(inputOf("Two"));
    await convergeRound([a, b]);

    // Fully converged: several sessions in both directions.
    for (let i = 0; i < 3; i++) {
      const ab = await sessionBoth(a, b);
      const ba = await sessionBoth(b, a);
      for (const log of [ab.fromLog, ab.toLog, ba.fromLog, ba.toLog]) {
        const types = typesOf(log);
        expect(types).not.toContain("FULL_STATE_OFFER");
        expect(types).not.toContain("FULL_STATE_ACCEPT");
        expect(types).not.toContain("FULL_STATE_SNAPSHOT");
        // No phantom re-request of our own history either (the M-4 trace).
        for (const m of log as Array<{ type: string; ranges?: Array<{ device_id: string }> }>) {
          if (m.type === "CHANGES_REQUEST") {
            for (const r of m.ranges ?? []) {
              expect(r.device_id).not.toBe(a.identity.deviceId);
              expect(r.device_id).not.toBe(b.identity.deviceId);
            }
          }
        }
      }
    }

    // Same guarantee through the pkg1 harness path (initiator log).
    const { fromLog } = await sessionOnce(a, b);
    expect(typesOf(fromLog)).toEqual(["HELLO", "CHANGES_ACK"]);
  });

  test("Pkg5b companion: re-delivery of the device's OWN record classifies duplicate (seeded self frontier)", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const ev = a.core.createEvent(inputOf("Base"));
    await convergeRound([a, b]);
    a.core.updateEvent(ev.id, inputOf("From A"));
    b.core.updateEvent(ev.id, inputOf("From B"));
    await convergeRound([a, b]); // sessions now seed applied_upto[self]

    // A peer echoing our own record back (buggy/malicious peer, or a relay)
    // must classify duplicate, not buffer/apply — the device applied its own
    // records at T1 by definition.
    const aRec = titleRec(a, ev.id, a.identity.deviceId);
    expect(deliverRecord(a, a, aRec)).toBe("duplicate");
    expect(rowTitle(a, ev.id)).toBe("From A"); // no state change from the echo
    // The concurrent-edit conflict row from the setup is untouched.
    expect(conflictRows(a.db, ev.id).length).toBe(1);
  });

  test("genuinely gapped peer → Trigger A still fires and the snapshot exchange completes", async () => {
    const a = makeDevice("A");
    const b = makeDevice("B");
    devices = [a, b];
    for (let i = 0; i < 5; i++) a.core.createEvent(inputOf(`evt-${i}`));
    await convergeRound([a, b]);

    // Compaction removes A's change history → the gap becomes unservable
    // for any peer that has not yet applied A's seqs (Pkg1 SC5 shape).
    const stats = sweepOn(a, [b]);
    expect(stats.deletedChanges).toBeGreaterThan(0);

    const c = makeDevice("C");
    devices = [a, b, c];
    const { fromLog, toLog } = await sessionBoth(c, a);

    // Trigger A fired: the gapped initiator (c) emitted the distress offer…
    const fromTypes = typesOf(fromLog);
    expect(fromTypes).toContain("FULL_STATE_OFFER");
    const offer = fromLog.find((m) => (m as { type: string }).type === "FULL_STATE_OFFER") as {
      reason?: string;
    };
    expect(offer.reason).toBe("GAP_ROUNDS");
    expect(fromTypes).toContain("FULL_STATE_ACCEPT");
    // …and the compacted side streamed its full state (Pkg1's fixed path).
    expect(typesOf(toLog)).toContain("FULL_STATE_OFFER");
    expect(typesOf(toLog)).toContain("FULL_STATE_SNAPSHOT");

    // The exchange COMPLETED: c materialized all 5 events from the snapshot.
    expect(semanticEvents(c.db).size).toBe(5);
    await convergeRound([a, b, c]);
    expect(semanticEvents(c.db).size).toBe(5);
    const frontiers = [a, b, c].map(
      (d) =>
        Object.fromEntries(
          (
            d.db
              .prepare("SELECT device_id AS d, MAX(local_seq) AS m FROM changes GROUP BY device_id")
              .all() as Array<{ d: string; m: number }>
          ).map((r) => [r.d, r.m]),
        ),
    );
    expect(frontiers[2]).toEqual(frontiers[0]);
  });

  test("conflict created at T2 then a full session: local value still kept after real-session snapshot phases", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const ev = a.core.createEvent(inputOf("Base"));
    await convergeRound([a, b]);
    a.core.updateEvent(ev.id, inputOf("From A"));
    b.core.updateEvent(ev.id, inputOf("From B"));
    // Conflict materializes through the REAL session pipeline.
    await convergeRound([a, b]);
    expect(conflictRows(a.db, ev.id).length).toBe(1);
    expect(conflictRows(b.db, ev.id).length).toBe(1);

    // More real sessions (whatever snapshot phases legitimately run) must
    // not silently converge the unresolved conflict's row value.
    await convergeRound([a, b]);
    await sessionOnce(a, b);
    await sessionOnce(b, a);

    expect(rowTitle(a, ev.id)).toBe("From A"); // local value kept (§3.3)
    expect(rowTitle(b, ev.id)).toBe("From B");
    for (const d of [a, b]) {
      const rows = conflictRows(d.db, ev.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("unresolved");
    }
  });
});
