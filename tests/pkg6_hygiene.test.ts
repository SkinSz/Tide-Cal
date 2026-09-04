// Pkg 6 (hygiene sweep) regressions — one test per bounded item:
//   1. F-1 (QA-2): ensureDefaultCalendar emits its bootstrap change ONLY when
//      the calendar row is missing — restart no longer adds a spurious
//      authoritative "My Calendar" change per open.
//   2. pkg1-review H1 residual: buildSnapshot's calendar loop is
//      over-inclusive (_unversioned placeholder) like the events loop.
//   3. BND-06: list_series implemented read-only in the sidecar dispatcher.
//   5. F-5: re-delivery of an already-quarantined record after frontier
//      advance never creates a second quarantine row (TD-001).
//   6. F-6: zombie pending_changes rows at/below the applied frontier are
//      GC'd at engine construction / session start.
//   8. P11 (pkg5b-review §3/§6-A): HELLO advertising device_clock[self] >
//      our own is flagged as an anomaly (health cue, not enforcement).
import { describe, expect, test, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import {
  makeDispatcher,
  handleLine,
} from "../src/persistence/bridges/sidecar_server.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import {
  createSyncEngine,
  getHelloClockAnomalyCount,
  type SyncMessage,
} from "../src/sync/sync_engine.ts";
import { buildSnapshot, type Snapshot } from "../src/sync/full_state.ts";
import {
  openDatabase,
  quarantineRecord,
  countQuarantined,
} from "../src/persistence/database.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function mkDir(): string {
  dir = mkdtempSync(join(tmpdir(), "tide-pkg6-"));
  return dir;
}

// ---------------------------------------------------------------------------
// Item 1 — F-1 (QA-2): bootstrap change only when the calendar row is missing
// ---------------------------------------------------------------------------

describe("Pkg6 item 1 (F-1): restart emits no spurious calendar bootstrap change", () => {
  test("open same DB twice -> change count identical after 2nd open; calendar untouched", () => {
    const dbPath = join(mkDir(), "tide.db");
    const a = new EventCore(dbPath);
    try {
      const countAfter1 = (
        a.db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }
      ).c;
      // bootstrap DID produce its auditable change on the very first open
      expect(countAfter1).toBe(1);
      const cal1 = a.db
        .prepare("SELECT title, updated_hlc FROM calendars WHERE calendar_id = 'local'")
        .get() as { title: string; updated_hlc: number };
      a.db.close();

      const b = new EventCore(dbPath);
      const countAfter2 = (
        b.db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }
      ).c;
      const cal2 = b.db
        .prepare("SELECT title, updated_hlc FROM calendars WHERE calendar_id = 'local'")
        .get() as { title: string; updated_hlc: number };
      // THE regression: change count identical after 2nd open (was +1 per restart)
      expect(countAfter2).toBe(countAfter1);
      expect(cal2.title).toBe(cal1.title);
      expect(cal2.updated_hlc).toBe(cal1.updated_hlc);
      b.db.close();
    } finally {
      try {
        a.db.close();
      } catch {
        /* closed above */
      }
    }
  });

  test("latent LWW trap closed: restart does not re-assert the default title over a renamed calendar", () => {
    const dbPath = join(mkDir(), "tide.db");
    const a = new EventCore(dbPath);
    try {
      a.db
        .prepare("UPDATE calendars SET title = 'Renamed By User', updated_hlc = updated_hlc WHERE calendar_id = 'local'")
        .run();
      a.db.close();

      const b = new EventCore(dbPath);
      const title = b.db
        .prepare("SELECT title FROM calendars WHERE calendar_id = 'local'")
        .get() as { title: string };
      const changes = (
        b.db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }
      ).c;
      expect(title.title).toBe("Renamed By User");
      // no new authoritative default-title change record appeared
      const defaultTitleChanges = (
        b.db.prepare(
          "SELECT COUNT(*) c FROM changes WHERE entity_type = 'calendar' AND entity_id = 'local'",
        ).get() as { c: number }
      ).c;
      expect(defaultTitleChanges).toBe(1); // only the original bootstrap record
      b.db.close();
    } finally {
      try {
        a.db.close();
      } catch {
        /* closed above */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Item 2 — buildSnapshot calendar loop over-inclusive
// ---------------------------------------------------------------------------

describe("Pkg6 item 2: buildSnapshot includes version-less calendar rows", () => {
  test("calendar with no entity_versions row rides the snapshot as _unversioned", () => {
    const a = new EventCore(join(mkDir(), "tide.db"));
    try {
      // Simulate a migrated/compaction-affected DB: strip the calendar's
      // durable version state (row + latest producer) without touching the
      // live calendar row.
      a.db.prepare("DELETE FROM entity_versions WHERE entity_id = 'local'").run();
      // also drop the change-log fallback source (compaction analogue) so
      // latestProducer() genuinely has nothing to derive a producer from
      a.db.prepare("DELETE FROM changes WHERE entity_id = 'local'").run();
      const chunks: Snapshot[] = [];
      buildSnapshot(a.db, (s) => chunks.push(s));
      const cal = chunks
        .flatMap((c) => c.entities)
        .find((e) => e.entity_type === "calendar" && e.entity_id === "local");
      expect(cal).toBeDefined();
      expect(cal!.producer_device_id).toBe("_unversioned");
      expect(cal!.producer_seq).toBe(0);
      a.db.close();
    } finally {
      try {
        a.db.close();
      } catch {
        /* closed above */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Item 3 — BND-06: list_series implemented read-only in the dispatcher
// ---------------------------------------------------------------------------

describe("Pkg6 item 3 (BND-06): list_series is a read-only sidecar op", () => {
  test("dispatcher answers list_series with an empty list and stays read-only", async () => {
    const core = new EventCore(join(mkDir(), "tide.db"));
    try {
      const before = core.db
        .prepare("SELECT COUNT(*) c FROM changes")
        .get() as { c: number };
      const parsed = JSON.parse(
        await handleLine(makeDispatcher(core), JSON.stringify({ id: 7, op: "list_series", args: {} })),
      ) as { ok: boolean; result?: unknown };
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.result)).toBe(true);
      expect(parsed.result).toEqual([]);
      const after = core.db
        .prepare("SELECT COUNT(*) c FROM changes")
        .get() as { c: number };
      expect(after.c).toBe(before.c); // read-only: no change records
      core.db.close();
    } finally {
      try {
        core.db.close();
      } catch {
        /* closed above */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Item 5 — F-5: no second quarantine row for the same (device_id, local_seq)
// ---------------------------------------------------------------------------

describe("Pkg6 item 5 (F-5): quarantine re-delivery never creates a second row", () => {
  const raw = {
    change_id: "dev-x:2",
    device_id: "dev-x",
    local_seq: 2,
    entity_id: "evt-z",
    entity_type: "event",
    field_path: "event",
    operation: "set",
    payload: { value: { title: "t" } },
    hlc_timestamp: 1,
    schema_version: 1,
    // causality_clock deliberately absent -> invalid
  };

  test("same (device_id, local_seq) -> exactly one row; different seq -> new row", () => {
    const db = openDatabase({ path: join(mkDir(), "t.db") });
    try {
      quarantineRecord(db, { reason: "r1", senderDeviceId: "s", rawRecord: raw });
      // re-delivery of the SAME invalid record (post-frontier-advance path)
      quarantineRecord(db, { reason: "r1", senderDeviceId: "s", rawRecord: raw });
      expect(countQuarantined(db)).toBe(1);

      // a DIFFERENT record (different producer seq) must still quarantine
      quarantineRecord(db, {
        reason: "r2",
        senderDeviceId: "s",
        rawRecord: { ...raw, local_seq: 9, change_id: "dev-x:9", device_id: "dev-y" },
      });
      expect(countQuarantined(db)).toBe(2);
      db.close();
    } finally {
      try {
        db.close();
      } catch {
        /* closed above */
      }
    }
  });

  test("engine-level: invalid record re-delivered across sessions after frontier advance -> 1 row", async () => {
    const core = new EventCore(join(mkDir(), "tide.db"));
    try {
      const fake = "dev-fake-producer";
      const t = Date.now();
      const invalid = {
        change_id: `${fake}:1`,
        device_id: fake,
        local_seq: 1,
        entity_id: "evt-qi",
        entity_type: "event",
        field_path: "event",
        operation: "set",
        payload: {
          value: { title: "bad", description: "d", startMs: t, endMs: t + 1, allDay: false },
        },
        hlc_timestamp: t,
        schema_version: 1,
        // causality_clock missing -> structurally invalid
      };
      const valid2: ChangeRecord = {
        change_id: `${fake}:2`,
        device_id: fake,
        local_seq: 2,
        entity_id: "evt-v2",
        entity_type: "event",
        field_path: "event",
        operation: "set",
        payload: {
          value: { title: "ok2", description: "d", startMs: t, endMs: t + 1000, allDay: false },
        },
        hlc_timestamp: t + 1,
        causality_clock: { [fake]: 2 },
        schema_version: 1,
      };
      const batch = [invalid, valid2];
      const scripted = (): {
        send(msg: unknown): Promise<void>;
        receive(): Promise<unknown>;
      } => {
        let hello = false;
        let batchSent = false;
        return {
          async send() {},
          async receive() {
            if (!hello) {
              hello = true;
              return { v: 1, type: "HELLO", device_clock: { [fake]: 2 } };
            }
            if (!batchSent) {
              batchSent = true;
              return { v: 1, type: "CHANGES_BATCH", changes: batch, remaining_ranges: [] };
            }
            return null;
          },
        };
      };
      for (let i = 0; i < 2; i++) {
        const eng = createSyncEngine({
          db: core.db,
          selfDeviceId: core.selfDeviceId,
          mutateEntity: makeEntityMutator(),
        });
        await eng.runSession(scripted() as never);
      }
      // First session: 1 quarantine row. Second session re-delivers the same
      // invalid record AFTER the frontier advanced to 2 (skip row GC'd) —
      // TD-001: still exactly ONE quarantine row.
      expect(countQuarantined(core.db)).toBe(1);
      core.db.close();
    } finally {
      try {
        core.db.close();
      } catch {
        /* closed above */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Item 6 — F-6: zombie pending_changes GC
// ---------------------------------------------------------------------------

describe("Pkg6 item 6 (F-6): zombie pending rows are GC'd once the frontier passes them", () => {
  test("engine construction removes pending rows at/below the frontier, keeps real ones", () => {
    const core = new EventCore(join(mkDir(), "tide.db"));
    try {
      const P = "dev-zombie-producer";
      core.db
        .prepare("INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)")
        .run(P, 5);
      const ins = core.db.prepare(
        "INSERT INTO pending_changes (device_id, local_seq, record_payload, received_at_hlc) VALUES (?, ?, ?, ?)",
      );
      ins.run(P, 3, "{}", Date.now()); // zombie: frontier already at 5
      ins.run(P, 7, "{}", Date.now()); // legit: still waiting for the gap
      ins.run("dev-no-frontier", 2, "{}", Date.now()); // no frontier row: kept

      createSyncEngine({
        db: core.db,
        selfDeviceId: core.selfDeviceId,
        mutateEntity: makeEntityMutator(),
      });
      const rows = (
        core.db
          .prepare("SELECT device_id AS d, local_seq AS s FROM pending_changes")
          .all() as Array<{ d: string; s: number }>
      ).sort((x, y) => (x.d + x.s).localeCompare(y.d + y.s));
      expect(rows).toEqual([
        { d: "dev-no-frontier", s: 2 },
        { d: P, s: 7 },
      ]);
      core.db.close();
    } finally {
      try {
        core.db.close();
      } catch {
        /* closed above */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Item 8 — P11: HELLO clock anomaly signal (health cue, not enforcement)
// ---------------------------------------------------------------------------

describe("Pkg6 item 8: HELLO clock anomaly signal (DC-02 §4.1 impossibility)", () => {
  function scriptedPeer(peerClock: Record<string, number>) {
    let hello = false;
    return {
      async send() {},
      async receive(): Promise<unknown> {
        if (!hello) {
          hello = true;
          return { v: 1, type: "HELLO", device_clock: peerClock } as SyncMessage;
        }
        return null;
      },
    };
  }

  test("peer advertising self > our own clock: flagged, counted, warned — session proceeds", async () => {
    const core = new EventCore(join(mkDir(), "tide.db"));
    try {
      // produce some self history so our own clock component is > 0
      core.createEvent({
        title: "a",
        description: "d",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
      });
      const own = core.db
        .prepare<[string], { s: number | null }>(
          "SELECT max_seq AS s FROM device_clock WHERE peer_device_id = ?",
        )
        .get(core.selfDeviceId)?.s ?? 0;
      expect(own).toBeGreaterThan(0);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const before = getHelloClockAnomalyCount();
      const eng = createSyncEngine({
        db: core.db,
        selfDeviceId: core.selfDeviceId,
        mutateEntity: makeEntityMutator(),
      });
      const stats = await eng.runSession(
        scriptedPeer({ [core.selfDeviceId]: own + 5 }) as never,
      );
      expect(stats.helloClockAnomaly).toBe(true);
      expect(getHelloClockAnomalyCount()).toBe(before + 1);
      expect(
        warn.mock.calls.some((args) =>
          String(args[0]).includes("HELLO clock anomaly"),
        ),
      ).toBe(true);
      warn.mockRestore();

      // Health cue ONLY: no misbehavior/hard-block enforcement side effects.
      expect(
        (core.db.prepare("SELECT COUNT(*) c FROM hard_blocks").get() as { c: number }).c,
      ).toBe(0);
      core.db.close();
    } finally {
      try {
        core.db.close();
      } catch {
        /* closed above */
      }
    }
  });

  test("honest HELLO (self component <= our own): no anomaly flag", async () => {
    const core = new EventCore(join(mkDir(), "tide.db"));
    try {
      const before = getHelloClockAnomalyCount();
      const eng = createSyncEngine({
        db: core.db,
        selfDeviceId: core.selfDeviceId,
        mutateEntity: makeEntityMutator(),
      });
      const stats = await eng.runSession(
        scriptedPeer({ "dev-honest-peer": 3 }) as never,
      );
      expect(stats.helloClockAnomaly).toBeUndefined();
      expect(getHelloClockAnomalyCount()).toBe(before);
      core.db.close();
    } finally {
      try {
        core.db.close();
      } catch {
        /* closed above */
      }
    }
  });
});
