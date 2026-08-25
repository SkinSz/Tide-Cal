// Tide persistence: database open + DC-07 transactional operations T1/T2.

import Database from "better-sqlite3";
import { DDL, SCHEMA_VERSION } from "./schema.ts";
import {
  changeId,
  type ChangeRecord,
  type VectorClock,
} from "../sync/change_record.ts";
import {
  classifyArrival,
  advanceApplied,
  emptyKnowledge,
  type KnowledgeState,
} from "../sync/knowledge_state.ts";

export interface OpenOptions {
  path: string;
  /** SQLCipher key when an encrypted build is available (see report note). */
  encryptionKey?: string;
}

export function openDatabase(opts: OpenOptions): Database.Database {
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // NOTE (encryption-at-rest, DC-07 owner decision): SQLCipher requires a
  // custom better-sqlite3 build. Dev phase runs plaintext; production build
  // MUST wire opts.encryptionKey into the pragma before shipping.
  initializeSchema(db);
  return db;
}

function initializeSchema(db: Database.Database): void {
  let row: { version: number } | undefined;
  try {
    row = db
      .prepare<[], { version: number }>("SELECT version FROM schema_version")
      .get();
  } catch {
    // Fresh database: table does not exist yet -> initialize below.
    row = undefined;
  }
  if (row === undefined) {
    const tx = db.transaction(() => {
      db.exec(DDL);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at_hlc) VALUES (?, ?)",
      ).run(SCHEMA_VERSION, Date.now());
    });
    tx();
  } else if (row.version > SCHEMA_VERSION) {
    throw new Error(
      `database schema_version ${row.version} newer than supported ${SCHEMA_VERSION}`,
    );
  }
}

// ---------------------------------------------------------------------------
// DC-07 §7 T1 — CREATE LOCAL CHANGE (atomic)
// ---------------------------------------------------------------------------

export interface LocalChangeInput {
  entity_id: string;
  entity_type: ChangeRecord["entity_type"];
  field_path: string;
  operation: ChangeRecord["operation"];
  payload: ChangeRecord["payload"];
  hlc_now: () => number;
}

/**
 * T1: persist a locally created change atomically with the device_clock
 * advance. Entity-row mutation runs inside the same transaction via
 * `mutate` so a crash can never strand one without the other (DC-07 §7 T1).
 */
export function createLocalChange(
  db: Database.Database,
  selfDeviceId: string,
  input: LocalChangeInput,
  mutate?: (db: Database.Database, record: ChangeRecord) => void,
): ChangeRecord {
  const insertChange = db.prepare(`
    INSERT INTO changes (change_id, device_id, local_seq, entity_id,
      entity_type, field_path, operation, payload, hlc_timestamp,
      causality_clock, schema_version)
    VALUES (@change_id, @device_id, @local_seq, @entity_id, @entity_type,
      @field_path, @operation, @payload, @hlc_timestamp, @causality_clock,
      @schema_version)`);

  // C3 (Review 2): element-wise MAX on conflict so a stale/compacted view
  // can never lower another writer's clock entry.
  const upsertClock = db.prepare(`
    INSERT INTO device_clock (peer_device_id, max_seq) VALUES (@d, @s)
    ON CONFLICT(peer_device_id) DO UPDATE SET
      max_seq = MAX(max_seq, excluded.max_seq)`);

  let record!: ChangeRecord;
  const tx = db.transaction(() => {
    // C3 (Review 2): allocate from BOTH sources of truth. MAX(changes.local_seq)
    // alone regresses after compaction deletes own old rows; device_clock alone
    // could drift if rows exist above it. Take the max of both.
    const storedClock = getDeviceClock(db);
    const nextSeq =
      Math.max(storedClock[selfDeviceId] ?? 0, getNextLocalSeq(db, selfDeviceId)) + 1;
    const clock: VectorClock = { ...storedClock, [selfDeviceId]: nextSeq };

    record = {
      change_id: changeId(selfDeviceId, nextSeq),
      device_id: selfDeviceId,
      local_seq: nextSeq,
      entity_id: input.entity_id,
      entity_type: input.entity_type,
      field_path: input.field_path,
      operation: input.operation,
      payload: input.payload as ChangeRecord["payload"],
      hlc_timestamp: input.hlc_now(),
      causality_clock: clock,
      schema_version: 1,
    };

    mutate?.(db, record);
    insertChange.run(serializeChange(record));
    upsertClock.run({ d: selfDeviceId, s: nextSeq });
  });
  tx();

  return record;
}

function serializeChange(r: ChangeRecord) {
  return {
    ...r,
    payload: JSON.stringify(r.payload),
    causality_clock: JSON.stringify(r.causality_clock),
  };
}

function getNextLocalSeq(db: Database.Database, deviceId: string): number {
  const row = db
    .prepare<[string], { m: number | null }>(
      "SELECT MAX(local_seq) AS m FROM changes WHERE device_id = ?",
    )
    .get(deviceId);
  return row?.m ?? 0;
}

export function getDeviceClock(db: Database.Database): VectorClock {
  const rows = db
    .prepare<[], { peer_device_id: string; max_seq: number }>(
      "SELECT peer_device_id, max_seq FROM device_clock",
    )
    .all();
  const clock: VectorClock = {};
  for (const r of rows) clock[r.peer_device_id] = r.max_seq;
  return clock;
}

// ---------------------------------------------------------------------------
// DC-07 §7 T2 — APPLY REMOTE CHANGE (atomic per DC-02 §7)
// ---------------------------------------------------------------------------

export type ApplyOutcome = "applied" | "buffered" | "duplicate";

/**
 * T2: dedupe / apply / buffer an incoming change atomically with
 * knowledge-state updates and element-wise-max clock merge.
 * Entity mutation callback runs inside the same transaction only for
 * records actually applied (including drained pending records).
 */
export function applyRemoteChange(
  db: Database.Database,
  incoming: ChangeRecord,
  knowledge: KnowledgeState,
  mutate?: (db: Database.Database, record: ChangeRecord) => void,
): ApplyOutcome {
  const insertPending = db.prepare(`
    INSERT INTO pending_changes (device_id, local_seq, record_payload, received_at_hlc)
    VALUES (?, ?, ?, ?)`);

  const insertChange = db.prepare(`
    INSERT INTO changes (change_id, device_id, local_seq, entity_id,
      entity_type, field_path, operation, payload, hlc_timestamp,
      causality_clock, schema_version)
    VALUES (@change_id, @device_id, @local_seq, @entity_id, @entity_type,
      @field_path, @operation, @payload, @hlc_timestamp, @causality_clock,
      @schema_version)`);

  // C1 (Review 2): applied_upto is monotone per producer; still use MAX so a
  // stale caller can never lower the stored frontier.
  const setAppliedUpto = db.prepare(`
    INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
    ON CONFLICT(producer_device_id) DO UPDATE SET
      applied_through = MAX(applied_through, excluded.applied_through)`);

  const deletePending = db.prepare(
    "DELETE FROM pending_changes WHERE device_id = ? AND local_seq = ?",
  );

  const loadAllPending = db.prepare<
    [string],
    { device_id: string; local_seq: number; record_payload: string }
  >(
    "SELECT device_id, local_seq, record_payload FROM pending_changes WHERE device_id = ?",
  );

  // C3 (Review 2): element-wise MAX upsert — clock merge is a join, never an
  // overwrite.
  const upsertClockStmt = db.prepare(`
    INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
    ON CONFLICT(peer_device_id) DO UPDATE SET
      max_seq = MAX(max_seq, excluded.max_seq)`);

  function mergeClocks(clock: VectorClock): void {
    for (const [d, s] of Object.entries(clock)) {
      upsertClockStmt.run(d, s);
    }
  }

  let dbKnowledge!: KnowledgeState;
  try {
    const outcome = db.transaction(() => {
      // C2/C1 (Review 2): classification is derived from DB state INSIDE the
      // transaction (DB is source of truth). A stale in-memory knowledge
      // object can no longer misclassify (e.g. after restart).
      dbKnowledge = loadKnowledgeFromDb(db);
      const cls = classifyArrival(
        dbKnowledge,
        incoming.device_id,
        incoming.local_seq,
      );

      if (cls === "duplicate") {
        mergeClocks(incoming.causality_clock);
        return "duplicate" as const;
      }

      if (cls === "buffer") {
        insertPending.run(
          incoming.device_id,
          incoming.local_seq,
          JSON.stringify(incoming),
          Date.now(),
        );
        mergeClocks(incoming.causality_clock);
        return "buffered" as const;
      }

      // apply + drain consecutive pending in order
      const drained = advanceApplied(
        dbKnowledge,
        incoming.device_id,
        incoming.local_seq,
      );
      for (const step of drained) {
        let record: ChangeRecord;
        if (
          step.device_id === incoming.device_id &&
          step.local_seq === incoming.local_seq
        ) {
          record = incoming;
        } else {
          const rows = loadAllPending.all(step.device_id);
          const match = rows.find((r) => r.local_seq === step.local_seq);
          if (!match) {
            throw new Error(
              `pending payload missing for ${step.device_id}:${step.local_seq}`,
            );
          }
          record = JSON.parse(match.record_payload) as ChangeRecord;
        }
        mutate?.(db, record);
        insertChange.run(serializeChange(record));
        deletePending.run(step.device_id, step.local_seq);
      }
      setAppliedUpto.run(
        incoming.device_id,
        drained[drained.length - 1]!.local_seq,
      );
      mergeClocks(incoming.causality_clock);
      return "applied" as const;
    })();

    // C2 (Review 2): transaction committed -> now mirror the DB-derived state
    // onto the caller's object. If anything above threw, we never get here and
    // the caller-visible knowledge stays at pre-call values.
    knowledge.appliedUpto = dbKnowledge.appliedUpto;
    knowledge.pending = dbKnowledge.pending;
    return outcome;
  } catch (err) {
    // C1 safety net (DC-02 §7.1 / DC-03 TR-8): a UNIQUE violation from the
    // changes/pending_changes inserts means this is a redelivery our in-memory
    // view missed — idempotently reclassify as duplicate instead of crashing.
    if (isUniqueViolation(err)) {
      db.transaction(() => mergeClocks(incoming.causality_clock))();
      const fresh = loadKnowledgeFromDb(db);
      knowledge.appliedUpto = fresh.appliedUpto;
      knowledge.pending = fresh.pending;
      return "duplicate";
    }
    throw err;
  }
}

/**
 * C1 (Review 2): rebuild KnowledgeState from durable tables after restart.
 * appliedUpto comes from applied_upto; pending from pending_changes.
 */
export function loadKnowledgeFromDb(db: Database.Database): KnowledgeState {
  const k = emptyKnowledge();
  for (const r of db
    .prepare<[], { producer_device_id: string; applied_through: number }>(
      "SELECT producer_device_id, applied_through FROM applied_upto",
    )
    .all()) {
    k.appliedUpto[r.producer_device_id] = r.applied_through;
  }
  for (const r of db
    .prepare<[], { device_id: string; local_seq: number }>(
      "SELECT device_id, local_seq FROM pending_changes",
    )
    .all()) {
    let set = k.pending.get(r.device_id);
    if (!set) {
      set = new Set();
      k.pending.set(r.device_id, set);
    }
    set.add(r.local_seq);
  }
  return k;
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed");
}

// ---------------------------------------------------------------------------
// DC-04 §4.3 / DC-08 §5 Stage 2 — DURABLE QUARANTINE
// ---------------------------------------------------------------------------

export interface QuarantineOptions {
  /** Machine-readable reason code, e.g. "invalid_member_id" (DC-04 §4.3b). */
  reason: string;
  /** Noise peer that sent the record (DC-08 §5 Stage 2). */
  senderDeviceId: string;
  /** The offending record, stored JSON.stringify-verbatim for inspection. */
  rawRecord: unknown;
}

/**
 * H-3: persist an invalid incoming record durably before dropping it from
 * processing. Quarantine is a diagnostic surface (DC-04 §4.3c): countable,
 * inspectable, never user-resolvable, never blocking the session.
 */
export function quarantineRecord(
  db: Database.Database,
  opts: QuarantineOptions,
): void {
  db.prepare(`
    INSERT INTO quarantine
      (quarantine_reason, received_at_hlc, sender_device_id, raw_record)
    VALUES (?, ?, ?, ?)`).run(
    opts.reason,
    Date.now(),
    opts.senderDeviceId,
    JSON.stringify(opts.rawRecord),
  );
}

/**
 * Count quarantined records — all, or filtered by reason code so a test can
 * assert "exactly one record quarantined with reason X" (DC-04 §4.3c).
 */
export function countQuarantined(db: Database.Database, reason?: string): number {
  if (reason === undefined) {
    const row = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM quarantine")
      .get();
    return row?.c ?? 0;
  }
  const row = db
    .prepare<[string], { c: number }>(
      "SELECT COUNT(*) AS c FROM quarantine WHERE quarantine_reason = ?",
    )
    .get(reason);
  return row?.c ?? 0;
}
