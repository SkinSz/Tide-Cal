import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, createLocalChange } from "../src/persistence/database.ts";
import { createSyncEngine, type SyncTransport, type SyncMessage } from "../src/sync/sync_engine.ts";
import type { ChangeRecord } from "../src/sync/change_record.ts";

// In-memory paired transport (DC-08 TR-1 harness)
function pairedTransports(): [SyncTransport, SyncTransport] {
  const qA: SyncMessage[] = [];
  const qB: SyncMessage[] = [];
  let wakeA: (() => void) | null = null;
  let wakeB: (() => void) | null = null;

  const make = (
    inQ: SyncMessage[],
    outQ: SyncMessage[],
    getWake: () => (() => void) | null,
  ): SyncTransport => ({
    async send(msg) {
      outQ.push(msg);
      const w = getWake();
      w?.();
    },
    receive() {
      if (inQ.length > 0) return Promise.resolve(inQ.shift()!);
      return new Promise((resolve) => {
        const w = () => {
          resolve(inQ.shift() ?? null);
        };
        // store wake on closure holder
        (this as unknown as { _wake?: () => void })._wake = undefined;
        pendingResolvers.push(() => resolve(inQ.shift() ?? null));
        void getWake;
      });
    },
  });

  const pendingResolvers: Array<() => void> = [];
  // Simpler: polling receive with small delay to avoid complexity
  const poll = <T>(q: T[]): Promise<T | null> =>
    new Promise((resolve) => {
      const check = () => {
        const v = q.shift();
        if (v !== undefined) resolve(v);
        else setTimeout(check, 1);
      };
      check();
    });

  const tA: SyncTransport = {
    async send(msg) {
      qA.push(msg);
    },
    receive: () => poll(qB),
  };
  const tB: SyncTransport = {
    async send(msg) {
      qB.push(msg);
    },
    receive: () => poll(qA),
  };
  return [tA, tB];
}

describe("DC-08 TR-1: two-device convergence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tide-sync-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("edits on both devices converge after one session each way", async () => {
    const dbA = openDatabase({ path: join(dir, "a.db") });
    const dbB = openDatabase({ path: join(dir, "b.db") });

    // A makes two edits
    for (const v of ["one", "two"]) {
      createLocalChange(dbA, "d-A", {
        entity_id: "e-1",
        entity_type: "event",
        field_path: "title",
        operation: "set",
        payload: { value: v },
        hlc_now: () => Date.now(),
      });
    }
    // B makes one edit
    createLocalChange(dbB, "d-B", {
      entity_id: "e-2",
      entity_type: "event",
      field_path: "description",
      operation: "set",
      payload: { value: "bring cake" },
      hlc_now: () => Date.now(),
    });

    const [tA, tB] = pairedTransports();
    const engA = createSyncEngine({ db: dbA, selfDeviceId: "d-A" });
    const engB = createSyncEngine({ db: dbB, selfDeviceId: "d-B" });

    await Promise.all([engA.runSession(tA), engB.runSession(tB)]);

    const countChanges = (db: Database.Database) =>
      (db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c;
    expect(countChanges(dbA)).toBe(3);
    expect(countChanges(dbB)).toBe(3);

    const appliedA = dbA
      .prepare("SELECT producer_device_id d, applied_through a FROM applied_upto")
      .all() as Array<{ d: string; a: number }>;
    const appliedB = dbB
      .prepare("SELECT producer_device_id d, applied_through a FROM applied_upto")
      .all() as Array<{ d: string; a: number }>;
    expect(appliedA).toContainEqual({ d: "d-B", a: 1 });
    expect(appliedB).toContainEqual({ d: "d-A", a: 2 });

    dbA.close();
    dbB.close();
  });
});
