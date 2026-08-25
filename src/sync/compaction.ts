// Tide DC-06: Tombstone/history compaction.
// Safety rule: retention is always safe; deletion requires PROOF that every
// CONSTRAINT_SET peer provably knows the record (lastKnownClock[P][D] >= S).
// Unresolved-conflict participants are NEVER compactable (§4.1).

import Database from "better-sqlite3";
type Db = Database.Database;

export interface CompactionDeps {
  db: Db;
  /** own device id (never in constraint set for our own records) */
  selfDeviceId: string;
  /**
   * lastKnownClock(P)[D] -> highest producer seq peer P provably knows.
   * Built ONLY from P's authenticated advertisements (DC-06 §2.1).
   * Keyed: peerId -> { producerId -> seq }.
   */
  lastKnownClock: Record<string, Record<string, number>>;
  /** trusted + possibly-rejoining peers, minus revoked-learned (DC-06 §2.3/2.6) */
  constraintSet: string[];
}

export interface SweepStats {
  examined: number;
  deletedChanges: number;
  deletedEntityTombstones: number;
  deletedMemberTombstones: number;
}

/**
 * DC-06 §5.1 predicate. A record (producer D, seq S) is compactable iff:
 *  - it does not participate in an UNRESOLVED conflict (§4.1), and
 *  - every P in CONSTRAINT_SET has lastKnownClock(P)[D] >= S.
 */
export function compactable(
  deps: CompactionDeps,
  producer: string,
  seq: number,
): boolean {
  if (participatesInUnresolvedConflict(deps.db, producer, seq)) return false;
  for (const peer of deps.constraintSet) {
    const known = deps.lastKnownClock[peer]?.[producer] ?? 0;
    if (known < seq) return false;
  }
  return true;
}

function participatesInUnresolvedConflict(
  db: Db,
  producer: string,
  seq: number,
): boolean {
  const row = db
    .prepare<[string, number], { c: number }>(`
      SELECT COUNT(*) AS c
      FROM conflict_participants cp
      JOIN conflicts c ON c.conflict_id = cp.conflict_id
      WHERE cp.device_id = ? AND cp.local_seq = ? AND c.status = 'unresolved'`)
    .get(producer, seq);
  return (row?.c ?? 0) > 0;
}

/**
 * DC-06 §5.2 batch sweep. Order: member tombstones -> entity history ->
 * entity tombstones, all within ONE transaction (crash-safe, TR-6).
 * Deterministic; idempotent on rerun (TR-8); never fabricates knowledge (TR-7).
 */
export function sweep(deps: CompactionDeps): SweepStats {
  const stats: SweepStats = {
    examined: 0,
    deletedChanges: 0,
    deletedEntityTombstones: 0,
    deletedMemberTombstones: 0,
  };
  const db = deps.db;

  const victimIds: Array<{ change_id: string }> = [];
  const changes = db
    .prepare<[], { change_id: string; device_id: string; local_seq: number }>(
      "SELECT change_id, device_id, local_seq FROM changes ORDER BY device_id, local_seq",
    )
    .all();
  for (const r of changes) {
    stats.examined++;
    if (compactable(deps, r.device_id, r.local_seq)) {
      victimIds.push({ change_id: r.change_id });
    }
  }

  const etombVictims: Array<{ entity_id: string; p: string; s: number }> = [];
  const etombs = db
    .prepare<[], { entity_id: string; producer_device_id: string; seq: number }>(
      "SELECT entity_id, producer_device_id, seq FROM entities_tombstones",
    )
    .all();
  for (const t of etombs) {
    stats.examined++;
    if (compactable(deps, t.producer_device_id, t.seq)) {
      etombVictims.push({ entity_id: t.entity_id, p: t.producer_device_id, s: t.seq });
    }
  }

  const mtombVictims: Array<{ e: string; c: string; m: string; p: string; s: number }> = [];
  const mtombs = db
    .prepare<
      [],
      {
        entity_id: string;
        collection_path: string;
        member_id: string;
        producer_device_id: string;
        seq: number;
      }
    >("SELECT entity_id, collection_path, member_id, producer_device_id, seq FROM member_tombstones")
    .all();
  for (const t of mtombs) {
    stats.examined++;
    if (compactable(deps, t.producer_device_id, t.seq)) {
      mtombVictims.push({
        e: t.entity_id,
        c: t.collection_path,
        m: t.member_id,
        p: t.producer_device_id,
        s: t.seq,
      });
    }
  }

  // Single transaction: DC-06 §6.1 atomic apply-and-remove. Members first,
  // then entity records, then entity tombstones (§3.2 ordering).
  const delChange = db.prepare("DELETE FROM changes WHERE change_id = ?");
  const delETomb = db.prepare(
    "DELETE FROM entities_tombstones WHERE entity_id=? AND producer_device_id=? AND seq=?",
  );
  const delMTomb = db.prepare(
    "DELETE FROM member_tombstones WHERE entity_id=? AND collection_path=? AND member_id=? AND producer_device_id=? AND seq=?",
  );

  const tx = db.transaction(() => {
    for (const v of mtombVictims) {
      delMTomb.run(v.e, v.c, v.m, v.p, v.s);
      stats.deletedMemberTombstones++;
    }
    for (const v of victimIds) {
      delChange.run(v.change_id);
      stats.deletedChanges++;
    }
    for (const v of etombVictims) {
      delETomb.run(v.entity_id, v.p, v.s);
      stats.deletedEntityTombstones++;
    }
  });
  tx();
  return stats;
}

/**
 * DC-06 §5.3 per-producer MIN-uncompacted-seq summary via index-supported
 * query (TR-8 requires no full scan; idx_changes_device_seq provides it).
 */
export function retainedLo(db: Db): Record<string, number> {
  const rows = db
    .prepare<[], { device_id: string; min_seq: number | null }>(
      `SELECT device_id, MIN(local_seq) AS min_seq FROM changes GROUP BY device_id`,
    )
    .all();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.device_id] = r.min_seq ?? 1;
  return out;
}
