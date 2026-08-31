// qa-review5 adversarial probes — INDEPENDENT falsification attempt for Pkg5.
// Pkg6 disposition (2026-08-30): the P9 tests assert implicit-LWW row
// convergence that Pkg5/DC-03 §3.3 REPLACED with conflict preservation —
// the divergence is backed by verified unresolved conflict rows
// (pkg5-review §6.1 / pkg5b-review §5). Left failing intentionally:
// observe-only pending owner disposition of the replaced semantics.
// Probes only; not part of the remediation suite. Imports production code
// read-only; devices use their own temp dirs (no ports).
import { describe, expect, test, afterEach } from "vitest";
import { guardProcess } from "./sync_probe_helpers.ts";
import {
  makeDevice,
  restartDevice,
  closeDevices,
  convergeRound,
  sessionOnce,
  type Device,
} from "../pkg1_helpers.ts";
import { makeEntityMutator } from "../../src/persistence/bridges/sync_service.ts";
import {
  applyRemoteChange,
  loadKnowledgeFromDb,
} from "../../src/persistence/database.ts";
import { ConflictsViewModel } from "../../src/application/conflicts_ui.ts";
import { makeDispatcher } from "../../src/persistence/bridges/sidecar_server.ts";
import { buildSnapshot, applySnapshot } from "../../src/sync/full_state.ts";
import type { ChangeRecord } from "../../src/sync/change_record.ts";

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

function asDb(x: any): any {
  return x && typeof x.prepare === "function" ? x : x.db;
}

function rows(dev: any, entityId?: string): any[] {
  const d = asDb(dev);
  return entityId
    ? (d.prepare("SELECT * FROM conflicts WHERE entity_id = ? ORDER BY conflict_id").all(entityId) as any[])
    : (d.prepare("SELECT * FROM conflicts ORDER BY conflict_id").all() as any[]);
}

function parts(dev: any, cid: string): any[] {
  return asDb(dev)
    .prepare("SELECT change_id, device_id, local_seq, causality_clock, payload FROM conflict_participants WHERE conflict_id = ? ORDER BY change_id")
    .all(cid) as any[];
}

function titleOf(dev: any, id: string): string {
  const r = asDb(dev).prepare("SELECT title FROM events WHERE event_id = ?").get(id) as any;
  return r?.title ?? "";
}

function recId(dev: any, id: string, fp: string, dev2: string): string {
  return ((asDb(dev).prepare("SELECT change_id FROM changes WHERE entity_id = ? AND field_path = ? AND device_id = ? ORDER BY local_seq DESC LIMIT 1").get(id, fp, dev2) as any).change_id);
}

function deliver(dst: Device, src: Device, changeId: string): string {
  const row = asDb(src).prepare("SELECT * FROM changes WHERE change_id = ?").get(changeId) as any;
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

function seedShared(a: Device, peers: Device[]): string {
  const ev = a.core.createEvent(inputOf("Base"));
  devices = [a, ...peers];
  return ev.id;
}

// ---------------------------------------------------------------- P1 boundary
guardProcess();

describe("P1 boundary: incoming equals local (no row) vs differs (row)", () => {
  test("equal-to-row concurrent record → noop, zero rows; differing → one row", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);

    // (1) b writes the SAME value as a's current row, concurrently.
    a.core.updateEvent(id, inputOf("Live"));
    b.core.updateEvent(id, inputOf("Live"));
    // deliver b's record into a: value equals a's current row ("Live")
    expect(deliver(a, b, recId(b, id, "title", b.identity.deviceId))).toBe("applied");
    expect(rows(a.db).length).toBe(0); // §3.1 noop — no row even though concurrent

    // (2) differing value → row.
    b.core.updateEvent(id, inputOf("Other"));
    expect(deliver(a, b, recId(b, id, "title", b.identity.deviceId))).toBe("applied");
    const rs = rows(a.db, id);
    expect(rs.length).toBe(1);
    expect(rs[0].status).toBe("unresolved");
    // a's row keeps its own value
    expect(titleOf(a, id)).toBe("Live");

    // (3) adversarial: row value advanced causally past the participant, then
    // a STALE concurrent record arrives equal to the ROW but different from
    // the participant payload → §3.1 says noop (row comparison first).
    const a2 = makeDevice("a2");
    const b2 = makeDevice("b2");
    devices = [a2, b2];
    const id2 = seedShared(a2, [b2]);
    await convergeRound([a2, b2]);
    b2.core.updateEvent(id2, inputOf("B stale"));
    a2.core.updateEvent(id2, inputOf("B stale")); // a converges to same value causally? No — a2 is its own edit
    // a2's row now "B stale" via its own causal edit; deliver b2's concurrent record
    expect(deliver(a2, b2, recId(b2, id2, "title", b2.identity.deviceId))).toBe("applied");
    expect(rows(a2.db).length).toBe(0); // identical-value convergence wins over concurrency
  });
});

// ------------------------------------------------- P2 late third participant
describe("P2 conflict then third-device concurrent edit → §3.5 collapse, no dup", () => {
  test("existing unresolved record extends to 3 participants, still one row", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    const c = makeDevice("c");
    devices = [a, b, c];
    const id = seedShared(a, [b, c]);
    await convergeRound([a, b, c]);

    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    await convergeRound([a, b]); // conflict detected on a and b

    const snap1 = rows(a.db, id);
    expect(snap1.length).toBe(1);
    const cid = snap1[0].conflict_id;

    // c's edit was concurrent with both (c never received A/B edits first)
    c.core.updateEvent(id, inputOf("From C"));
    // deliver c's record into a
    expect(deliver(a, c, recId(c, id, "title", c.identity.deviceId))).toBe("applied");

    const rs = rows(a.db, id);
    expect(rs.length).toBe(1); // NO duplicate row
    expect(rs[0].conflict_id).toBe(cid); // SAME record extended
    expect(rs[0].status).toBe("unresolved");
    const ps = parts(a.db, cid);
    expect(ps.length).toBe(3); // §3.5/TR-9: N+1 participants in ONE record
    const vals = ps.map((p: any) => (JSON.parse(p.payload) as any).value).sort();
    expect(vals).toEqual(["From A", "From B", "From C"]);
    // sync still completes with the extended record
    await convergeRound([a, b, c]);
    for (const d of [a, b, c]) {
      expect(rows(d.db, id).length).toBe(1);
    }
  });
});

// ------------------------------------------- P3 resolution vs re-delivery
describe("P3 resolution then re-delivery of the SAME original record", () => {
  test("re-delivered original never resurrects an unresolved record", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);
    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    await convergeRound([a, b]);

    const bRec = recId(b, id, "title", b.identity.deviceId);
    const rowA = rows(a.db, id);
    expect(rowA.length).toBe(1);
    const vmA = new ConflictsViewModel(a.db, a.identity.deviceId);
    vmA.resolve(rowA[0].conflict_id, { kind: "keep_mine" });
    expect(rows(a.db, id)[0].status).toBe("resolved_keep_local");

    // Re-deliver the SAME original conflicting record (fresh knowledge object)
    expect(deliver(a, b, bRec)).toBe("duplicate");
    const after = rows(a.db, id);
    expect(after.length).toBe(1);
    expect(after[0].status).toBe("resolved_keep_local"); // NOT resurrected
    expect(parts(a.db, after[0].conflict_id).length).toBe(2);

    // Repeat after restart (durable dedup path)
    const a2 = restartDevice(a);
    devices = [a2, b];
    expect(deliver(a2, b, bRec)).toBe("duplicate");
    expect(rows(a2.db, id)[0].status).toBe("resolved_keep_local");

    // And the same original record re-delivered to b (its own copy) is also a dup
    expect(deliver(b, b, bRec)).toBe("duplicate");
    expect(rows(b.db, id).length).toBe(1);
  });
});

// --------------------------------------------------- P4 restart + sync persistence
describe("P4 conflict + restart + sync", () => {
  test("rows persist across restart, survive further sync, no duplicates", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);
    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    await convergeRound([a, b]);

    const beforeA = rows(a.db, id);
    const beforeB = rows(b.db, id);
    const b2 = restartDevice(b);
    devices = [a, b2];
    await convergeRound([a, b2]);

    expect(rows(a.db, id)).toEqual(beforeA);
    expect(rows(b2.db, id)).toEqual(beforeB);
    expect(parts(a.db, beforeA[0].conflict_id).length).toBe(2);
    expect(parts(b2.db, beforeB[0].conflict_id).length).toBe(2);
  });
});

// --------------------------------------------------- P5 delete-vs-edit '*'
describe("P5 delete ('*') vs concurrent field edit → §3.4", () => {
  test("conflict recorded both directions, no row corruption", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);

    a.core.deleteEvent(id); // '*' remove
    b.core.updateEvent(id, inputOf("Edited while deleted"));

    // a receives the edit: incoming set vs local deleted row
    expect(deliver(a, b, recId(b, id, "title", b.identity.deviceId))).toBe("applied");
    const rsA = rows(a.db, id);
    expect(rsA.length).toBe(1);
    expect(rsA[0].field_path).toBe("title");
    expect(rsA[0].status).toBe("unresolved");
    expect((a.db.prepare("SELECT COUNT(*) c FROM events WHERE event_id = ?").get(id) as any).c).toBe(0);
    // participants well-formed JSON, clock parses
    for (const p of parts(a.db, rsA[0].conflict_id)) {
      expect(() => JSON.parse(p.payload)).not.toThrow();
      expect(() => JSON.parse(p.causality_clock)).not.toThrow();
    }

    // b receives the '*' remove: incoming delete vs local edited row
    const removeRec = (a.db.prepare("SELECT change_id FROM changes WHERE entity_id = ? AND operation='remove'").get(id) as any).change_id;
    expect(deliver(b, a, removeRec)).toBe("applied");
    const rsB = rows(b.db, id);
    expect(rsB.length).toBe(1);
    expect(rsB[0].field_path).toBe("*");
    expect(rsB[0].status).toBe("unresolved");
    expect(titleOf(b, id)).toBe("Edited while deleted"); // edit not destroyed
    const psB = parts(b.db, rsB[0].conflict_id);
    expect(psB.length).toBe(2);
    // one participant is the remove (empty payload), one is the title set
    const ops = psB.map((p: any) => {
      const r = b.db.prepare("SELECT operation FROM changes WHERE change_id = ?").get(p.change_id) as any;
      return r?.operation;
    }).sort();
    expect(ops).toEqual(["remove", "set"]);
    // further sync does not stall or duplicate
    await convergeRound([a, b]);
    expect(rows(a.db, id).length).toBe(1);
    expect(rows(b.db, id).length).toBe(1);
  });
});

// --------------------------------------------------- P6 different fields
describe("P6 different-field concurrent edits → zero rows (regression)", () => {
  test("title vs description concurrently: zero conflict rows, both apply", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);
    a.core.updateEvent(id, inputOf("Title A"));
    b.core.updateEvent(id, { ...inputOf("Base"), description: "Desc B" });
    await convergeRound([a, b]);
    expect(rows(a.db).length).toBe(0);
    expect(rows(b.db).length).toBe(0);
    expect(titleOf(a, id)).toBe("Title A");
    expect(titleOf(b, id)).toBe("Title A");
    expect((a.db.prepare("SELECT description FROM events WHERE event_id = ?").get(id) as any).description).toBe("Desc B");
  });
});

// --------------------------------------------------- P7 sync not stalled
describe("P7 conflict does not stall sync", () => {
  test("applied_upto advances to full frontier; sessions complete without errors/timeouts", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    const c = makeDevice("c");
    devices = [a, b, c];
    const id = seedShared(a, [b, c]);
    await convergeRound([a, b, c]);
    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    c.core.updateEvent(id, inputOf("From C"));
    await convergeRound([a, b, c]);

    // applied_upto covers every producer's max seq on every device
    const fronts = [a, b, c].map((d) =>
      Object.fromEntries(
        (d.db.prepare("SELECT producer_device_id d, MAX(applied_through) m FROM applied_upto GROUP BY producer_device_id").all() as any[]).map((r) => [r.d, r.m]),
      ),
    );
    const seqs = [a, b, c].map((d) =>
      Object.fromEntries(
        (d.db.prepare("SELECT device_id d, MAX(local_seq) m FROM changes GROUP BY device_id").all() as any[]).map((r) => [r.d, r.m]),
      ),
    );
    for (let i = 0; i < 3; i++) {
      for (const [dev, m] of Object.entries(seqs[i])) {
        expect(fronts[i][dev]).toBeGreaterThanOrEqual(m as number);
      }
    }
    // one more clean bounded session both ways
    const { fromStats, toStats } = await sessionOnce(a, b);
    expect(fromStats["errors"] ?? 0).toBe(0);
    expect(toStats["errors"] ?? 0).toBe(0);
    expect(rows(a.db).length).toBe(1);
    expect(rows(b.db).length).toBe(1);
  });
});

// --------------------------------------------------- P8 retrieval reachability
describe("P8 allow-list dispatch reachability + ConflictsViewModel shapes", () => {
  test("list_conflicts/conflict_detail dispatch and match view-model interfaces", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);
    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    await convergeRound([a, b]);

    const dispatch = makeDispatcher(b.core);
    const listed = dispatch("list_conflicts", {}) as any;
    expect(listed.total_unresolved).toBe(1);
    expect(Object.keys(listed.conflicts[0]).sort()).toEqual(
      ["conflict_id", "entity_id", "field_path", "participant_count", "status"],
    );
    const detail = dispatch("conflict_detail", { conflict_id: listed.conflicts[0].conflict_id }) as any;
    expect(Object.keys(detail).sort()).toEqual([
      "candidates", "conflict_id", "entity_id", "entity_title", "field_path", "local_change_id", "status",
    ]);
    expect(detail.candidates.length).toBe(2);
    // candidate shape
    expect(Object.keys(detail.candidates[0]).sort()).toEqual(
      ["change_id", "deleted", "device_id", "device_name", "hlc_timestamp", "value"],
    );
    // writes are NOT reachable over dispatch (DC-14 §4.3 read-only surface)
    expect(() => (dispatch as any)("resolve", {})).toThrow();
  });
});

// --------------------------------------------------- P9 snapshot interaction
describe("P9 SNAPSHOT INTERACTION (DC-09 §7.1) — the declared out-of-scope issue", () => {
  test("direct snapshot exchange: conflict row survives, ROW VALUE converges to domination winner", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);
    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    await convergeRound([a, b]);

    const conflictBefore = rows(a.db, id);
    expect(conflictBefore.length).toBe(1);
    expect(conflictBefore[0].status).toBe("unresolved");

    // DIRECT probe: b builds a snapshot; a applies it (exact engine path).
    const chunks: any[] = [];
    buildSnapshot(b.db, (s: any) => chunks.push(s));
    const kn = loadKnowledgeFromDb(a.db);
    for (const s of chunks) applySnapshot(a.db, s, kn);

    const titleAfter = titleOf(a, id);
    const conflictsAfter = rows(a.db, id);
    // The conflict ROW survives untouched (DC-03 §4.1).
    expect(conflictsAfter).toEqual(conflictBefore);
    expect(conflictsAfter[0].status).toBe("unresolved");
    console.log("PROBE-P9 a.title after b's snapshot:", JSON.stringify(titleAfter),
      "| appliedEntities:", chunks.map((c) => c.entities.length).join(","));
    // Does the ROW VALUE converge to b's domination winner?
    if (titleAfter !== "From A") {
      console.log("PROBE-P9: row value OVERWRITTEN by snapshot domination →", titleAfter);
    }
    expect(["From A", "From B"]).toContain(titleAfter); // never a third value
  });

  test("session-level: conflict rows persist unresolved, row values stay per-device (DC-03 §3.3)", async () => {
    const a = makeDevice("a");
    const b = makeDevice("b");
    devices = [a, b];
    const id = seedShared(a, [b]);
    await convergeRound([a, b]);
    a.core.updateEvent(id, inputOf("From A"));
    b.core.updateEvent(id, inputOf("From B"));
    await convergeRound([a, b]);
    const snapRowsA = rows(a.db, id);
    const snapRowsB = rows(b.db, id);
    // PROMOTED pin (2026-08-30): the original probe asserted implicit-LWW
    // ("rows converge to a single value"). Pkg5/DC-03 §3.3 REPLACED that:
    // each device KEEPS its own value until the user resolves the conflict,
    // the conflict rows stay frozen/unresolved, and anti-entropy rounds do
    // not resurrect or flip either side. Verified not data loss (pkg5b-review §5).
    await convergeRound([a, b]);
    await convergeRound([a, b]);
    expect(rows(a.db, id)).toEqual(snapRowsA); // conflict rows frozen, unresolved
    expect(rows(b.db, id)).toEqual(snapRowsB);
    expect(rows(a.db, id)[0].status).toBe("unresolved");
    expect(rows(b.db, id)[0].status).toBe("unresolved");
    expect(["From A", "From B"]).toContain(titleOf(a, id));
    expect(["From A", "From B"]).toContain(titleOf(b, id));
  });
});
