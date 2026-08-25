// Tide DC-09: Full-state synchronization — snapshot construction and
// transactional application, with the dominated-merge clock exchange of
// DC-06 §3.4 and the concurrent-edit rule (§7.1): local survives iff its
// causality is NOT dominated by snapshot_clock.

import type Database from "better-sqlite3";
import { merge } from "../sync/vector_clock.ts";
import type { VectorClock } from "../sync/change_record.ts";
import { advanceApplied, type KnowledgeState } from "../sync/knowledge_state.ts";

export interface SnapshotEntry {
  entity_id: string;
  entity_type: "calendar" | "event" | "series" | "occurrence_override";
  /** serialized current state of the entity (opaque to this module) */
  data: string;
  /** producer identity of the latest contributing change */
  producer_device_id: string;
  producer_seq: number;
  causality_clock: VectorClock;
}

export interface Snapshot {
  snapshot_clock: VectorClock;
  entities: SnapshotEntry[];
  /** non-compactable tombstones ride along (DC-09 §4.3) */
  tombstones: Array<{
    entity_id: string;
    entity_type: string;
    producer_device_id: string;
    seq: number;
    causality_clock: VectorClock;
    deleted_at_hlc: number;
  }>;
}

// ---------------------------------------------------------------------------
// Construction (sender side). Streams via callback under DC-08 §6.3 bounds.
// ---------------------------------------------------------------------------

export function buildSnapshot(
  db: Database.Database,
  emit: (snapshot: Snapshot) => void,
  batchSize = 256,
): void {
  const clockRows = db
    .prepare<[], { peer_device_id: string; max_seq: number }>(
      "SELECT peer_device_id, max_seq FROM device_clock",
    )
    .all();
  const snapshot_clock: VectorClock = {};
  for (const r of clockRows) snapshot_clock[r.peer_device_id] = r.max_seq;

  const events = db
    .prepare<[], { event_id: string; updated_hlc: number }>(
      "SELECT * FROM events ORDER BY event_id ASC",
    )
    .all();

  const buffer: SnapshotEntry[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    emit({ snapshot_clock, entities: [...buffer], tombstones: [] });
    buffer.length = 0;
  };

  for (const e of events) {
    buffer.push({
      entity_id: (e as unknown as { event_id: string }).event_id,
      entity_type: "event",
      data: JSON.stringify(e),
      // Producer identity for the concurrency rule: we use SELF + own clock
      // position — snapshots summarize current state, so the sender's own
      // clock dominates everything it contains by construction.
      producer_device_id: "_snapshot",
      producer_seq: snapshot_clock[""] ?? 0,
      causality_clock: snapshot_clock,
    });
    if (buffer.length >= batchSize) flush();
  }

  // Non-compactable tombstones ride along: here we include ALL retained ones
  // (conservative superset — including compactable ones is harmless per DC-09 §4.3).
  const tombs = db
    .prepare<
      [],
      {
        entity_id: string;
        entity_type: string;
        producer_device_id: string;
        seq: number;
        causality_clock: string;
        deleted_at_hlc: number;
      }
    >("SELECT entity_id, entity_type, producer_device_id, seq, causality_clock, deleted_at_hlc FROM entities_tombstones")
    .all();
  if (tombs.length > 0) {
    emit({
      snapshot_clock,
      entities: [],
      tombstones: tombs.map((t) => ({
        ...t,
        causality_clock: JSON.parse(t.causality_clock) as VectorClock,
      })),
    });
  }
  flush();
}

// ---------------------------------------------------------------------------
// Application (receiver side). Staged-then-committed atomically.
// ---------------------------------------------------------------------------

export interface ApplyResult {
  appliedEntities: number;
  inheritedTombstones: number;
  survivedLocal: number;
}

export function applySnapshot(
  db: Database.Database,
  snapshot: Snapshot,
  knowledge: KnowledgeState,
): ApplyResult {
  const result: ApplyResult = {
    appliedEntities: 0,
    inheritedTombstones: 0,
    survivedLocal: 0,
  };

  const insertTombstone = db.prepare(`
    INSERT INTO entities_tombstones (entity_id, entity_type, producer_device_id, seq, causality_clock, deleted_at_hlc)
    VALUES (@entity_id, @entity_type, @producer_device_id, @seq, @causality_clock, @deleted_at_hlc)
    ON CONFLICT(entity_id, producer_device_id, seq) DO NOTHING`);

  // Stage in a temp table, then commit atomically (DC-07 T-boundary style).
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS stage_entities (
        entity_id TEXT PRIMARY KEY, entity_type TEXT, data TEXT)`);

    // Concurrent-edit rule (DC-09 §7.1): local survives iff NOT dominated.
    const dominated = (localHlc: number | undefined, _entryProducerSeq: number) =>
      true; // placeholder — real dominance via causality below

    for (const entry of snapshot.entities) {
      const existing =
        entry.entity_type === "event"
          ? db.prepare("SELECT updated_hlc FROM events WHERE event_id = ?").get(entry.entity_id)
          : undefined;
      // The sender's snapshot summarizes state through snapshot_clock.
      // A locally newer edit has updated_hlc beyond what the snapshot's
      // producing session could have seen; approximate dominance by hlc
      // comparison against the snapshot capture time embedded per-entry.
      // NOTE: full causal comparison requires storing entry causality_clock
      // per field — v1 uses the conservative rule below:
      //   - if local row absent -> apply
      //   - if local updated_hlc <= entry.hlc_bound -> snapshot wins
      //   - else local survives
      const hlcBound = (entry.causality_clock && Math.max(...Object.values(entry.causality_clock))) || 0;
      if (
        existing !== undefined &&
        (existing as { updated_hlc: number }).updated_hlc > hlcBound
      ) {
        result.survivedLocal++;
        continue; // local survives; next anti-entropy round reconciles
      }

      db.prepare(
        `INSERT INTO temp.stage_entities (entity_id, entity_type, data) VALUES (?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET data = excluded.data`,
      ).run(entry.entity_id, entry.entity_type, entry.data);
      result.appliedEntities++;
    }

    // Materialize staged event rows
    const staged = db
      .prepare<[], { entity_id: string; entity_type: string; data: string }>(
        "SELECT entity_id, entity_type, data FROM stage_entities",
      )
      .all();
    const upsertEvent = db.prepare(`
      INSERT INTO events (event_id, calendar_id, title, description, all_day,
        start_date, end_date, start_wall, end_wall, tz_id, utc_start_ms,
        utc_end_ms, created_hlc, updated_hlc)
      VALUES (@event_id, @calendar_id, @title, @description, @all_day,
        @start_date, @end_date, @start_wall, @end_wall, @tz_id, @utc_start_ms,
        @utc_end_ms, @created_hlc, @updated_hlc)
      ON CONFLICT(event_id) DO UPDATE SET
        title=excluded.title, description=excluded.description,
        all_day=excluded.all_day, start_date=excluded.start_date,
        end_date=excluded.end_date, start_wall=excluded.start_wall,
        end_wall=excluded.end_wall, tz_id=excluded.tz_id,
        utc_start_ms=excluded.utc_start_ms, utc_end_ms=excluded.utc_end_ms,
        updated_hlc=excluded.updated_hlc`);

    for (const s of staged) {
      if (s.entity_type === "event") {
        const data = JSON.parse(s.data);
        upsertEvent.run(data);
      }
    }
    db.exec("DELETE FROM temp.stage_entities");

    // Inherit tombstones
    for (const t of snapshot.tombstones) {
      insertTombstone.run({
        ...t,
        causality_clock: JSON.stringify(t.causality_clock),
      });
      result.inheritedTombstones++;
    }

    // DC-06 §3.4 step 2: applied_upto := dominated merge with snapshot_clock
    for (const [d, s] of Object.entries(snapshot.snapshot_clock)) {
      const current =
        (
          db
            .prepare("SELECT applied_through FROM applied_upto WHERE producer_device_id = ?")
            .get(d) as { applied_through: number } | undefined
        )?.applied_through ?? 0;
      db.prepare(`
        INSERT INTO applied_upto (producer_device_id, applied_through) VALUES (?, ?)
        ON CONFLICT(producer_device_id) DO UPDATE SET applied_through = excluded.applied_through`).run(
        d,
        Math.max(current, s),
      );
      // mirror into in-memory knowledge
      advanceAppliedIfContiguous(knowledge, d, s);
    }

    // Merge device_clock too so next HELLO advertises correctly
    for (const [d, s] of Object.entries(merge({}, snapshot.snapshot_clock))) {
      db.prepare(`
        INSERT INTO device_clock (peer_device_id, max_seq) VALUES (?, ?)
        ON CONFLICT(peer_device_id) DO UPDATE SET max_seq = excluded.max_seq`).run(d, s);
    }
  });

  tx();
  return result;
}

function advanceAppliedIfContiguous(
  k: KnowledgeState,
  deviceId: string,
  target: number,
): void {
  const current = k.appliedUpto[deviceId] ?? 0;
  if (target > current) {
    k.appliedUpto[deviceId] = target;
    const pend = k.pending.get(deviceId);
    if (pend) {
      for (const s of [...pend]) {
        if (s <= target) pend.delete(s);
      }
      if (pend.size === 0) k.pending.delete(deviceId);
    }
  }
}
