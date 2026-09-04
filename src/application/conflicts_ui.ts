// Tide DC-14: Conflict Resolution UI — headless view-model + command API.
//
// This is the APPLICATION LAYER of the normative Conflicts surface
// (DC-14, APPROVED 2026-08-25). No Tauri/frontend code lives here; a UI
// binds to this API later. Semantics implemented:
//
//   P1  Explicit human action only — every status transition out of
//       "unresolved" flows through a command method below. Nothing here
//       runs timers or heuristics (TR-8).
//   P2  No blocking — this module never gates entity reads/writes; it
//       only reports badge counts (§3.1). No modal concept exists.
//   P3  Undo until propagation proof — undo() restores prior effective
//       value AND "unresolved" via NEW normal change records; withheld
//       once the caller marks the resolution propagated (§6.2).
//   P4  No timestamp winners — HLCs are surfaced as presentation-only
//       metadata; no option ordering, ranking, or pre-selection anywhere.
//
// Write path (§6.1): each resolution executes inside ONE transaction:
// createLocalChange (fresh local_seq + causality clock entry) plus the
// conflicts.status flip. better-sqlite3 nests transactions as SAVEPOINTs,
// so T1 inside our outer transaction stays atomic (crash-safe per DC-07 §7).
//
// Status mapping (§4): keep_mine -> resolved_keep_local,
// keep_theirs -> resolved_keep_incoming, keep_both/custom ->
// resolved_custom (+resolved_value), skip -> NO WRITE (TR-2).

import type { Database } from "better-sqlite3";
import { createLocalChange } from "../persistence/database.ts";
import type { ChangeRecord, VectorClock } from "../sync/change_record.ts";

export type ConflictStatus =
  | "unresolved"
  | "resolved_keep_local"
  | "resolved_keep_incoming"
  | "resolved_custom"
  | "obsolete";

export class ConflictCommandError extends Error {
  constructor(
    public code:
      | "not_found"
      | "not_unresolved"
      | "no_local_participant"
      | "unknown_candidate"
      | "undo_withheld_propagated",
    message: string,
  ) {
    super(message);
    this.name = "ConflictCommandError";
  }
}

/** §4 exact option-to-status mapping — the ONLY terminal outcomes. */
export type ResolutionOption =
  | { kind: "keep_mine" }
  | { kind: "keep_theirs"; /** Required when >1 non-local participant (N-way, §3.2c). */ change_id?: string }
  | { kind: "keep_both"; value: unknown };

export interface CandidateView {
  change_id: string;
  device_id: string;
  /** Paired-device display name; "This device" for self (§3.2b). */
  device_name: string;
  /** True when this side is a deletion ("value was removed", §3.2b). */
  deleted: boolean;
  /** Effective value (undefined when deleted). */
  value: unknown;
  /** PRESENTATION ONLY (P4): never used for ordering or pre-selection. */
  hlc_timestamp: number;
}

export interface ConflictDetailView {
  conflict_id: string;
  entity_id: string;
  entity_title: string | null;
  field_path: string;
  status: ConflictStatus;
  candidates: CandidateView[];
  /** Local (this-device) candidate, when one exists (§4 "Keep mine"). */
  local_change_id: string | null;
  /** Resolved custom value, when status is resolved_custom. */
  resolved_value?: unknown;
  resolved_at_hlc?: number;
}

export interface ConflictListItem {
  conflict_id: string;
  entity_id: string;
  field_path: string;
  status: ConflictStatus;
  participant_count: number;
}

export interface ListFilter {
  entity_id?: string;
  /** Filter by calendar of the affected event entity (§5.2 minimum filter). */
  calendar_id?: string;
  /** Date-range filter over the affected entity (§5.2), ms since epoch. */
  utc_from_ms?: number;
  utc_to_ms?: number;
}

interface ParticipantRow {
  change_id: string;
  device_id: string;
  local_seq: number;
  causality_clock: string;
  payload: string;
}

function parseJson(s: string): unknown {
  return JSON.parse(s) as unknown;
}

/** Effective value of a stored change row (mirrors DC-03 effectiveValue). */
function effectiveOf(row: { operation: string; payload: string }): {
  deleted: boolean;
  value: unknown;
} {
  switch (row.operation) {
    case "set":
      return { deleted: false, value: (parseJson(row.payload) as { value: unknown }).value };
    case "member_add":
    case "member_update":
      return { deleted: false, value: parseJson(row.payload) };
    case "remove":
    case "member_remove":
      return { deleted: true, value: undefined };
    default:
      return { deleted: false, value: parseJson(row.payload) };
  }
}

/**
 * Headless Conflicts surface. Constructed over the SQLite database;
 * all commands are synchronous and atomic. The UI layer renders what
 * the view methods return and forwards user intent to the command
 * methods — nothing else may move a conflict out of "unresolved".
 */
export class ConflictsViewModel {
  /**
   * Conflict ids whose resolution change record has been PROVEN propagated
   * (DC-06 §4.2 knowledge machinery, wired by the caller). Undo is withheld
   * for these (P3 / TR-3).
   */
  private readonly propagated = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly selfDeviceId: string,
  ) {}

  // ------------------------------------------------------------------
  // Badge layer (§3.1) — advisory counts, never gating anything
  // ------------------------------------------------------------------

  /** Unresolved-conflict count per entity id. */
  badgeCounts(): Map<string, number> {
    const rows = this.db
      .prepare<[], { entity_id: string; c: number }>(
        `SELECT entity_id, COUNT(*) AS c FROM conflicts
         WHERE status = 'unresolved' GROUP BY entity_id`,
      )
      .all();
    return new Map(rows.map((r) => [r.entity_id, r.c]));
  }

  /** Optional global indicator total (§3.1). */
  totalUnresolved(): number {
    const row = this.db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM conflicts WHERE status = 'unresolved'",
      )
      .get();
    return row?.c ?? 0;
  }

  // ------------------------------------------------------------------
  // List view (§5.2)
  // ------------------------------------------------------------------

  listUnresolved(filter: ListFilter = {}): ConflictListItem[] {
    const clauses: string[] = ["c.status = 'unresolved'"];
    const params: Record<string, unknown> = {};
    if (filter.entity_id !== undefined) {
      clauses.push("c.entity_id = @entity_id");
      params.entity_id = filter.entity_id;
    }
    if (filter.calendar_id !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM events e WHERE e.event_id = c.entity_id
                 AND e.calendar_id = @calendar_id)`,
      );
      params.calendar_id = filter.calendar_id;
    }
    if (filter.utc_from_ms !== undefined || filter.utc_to_ms !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM events e WHERE e.event_id = c.entity_id
                 AND (@utc_from_ms IS NULL OR e.utc_start_ms >= @utc_from_ms)
                 AND (@utc_to_ms IS NULL OR e.utc_start_ms <= @utc_to_ms))`,
      );
      params.utc_from_ms = filter.utc_from_ms ?? null;
      params.utc_to_ms = filter.utc_to_ms ?? null;
    }
    const rows = this.db
      .prepare<Record<string, unknown>, {
        conflict_id: string;
        entity_id: string;
        field_path: string;
        status: ConflictStatus;
        participant_count: number;
      }>(
        `SELECT c.conflict_id, c.entity_id, c.field_path, c.status,
                (SELECT COUNT(*) FROM conflict_participants p
                 WHERE p.conflict_id = c.conflict_id) AS participant_count
         FROM conflicts c WHERE ${clauses.join(" AND ")}
         ORDER BY c.detected_at_hlc`,
      )
      .all(params);
    return rows.map((r) => ({ ...r }));
  }

  // ------------------------------------------------------------------
  // Presentation accessor: entity display title for list rows.
  // ------------------------------------------------------------------

  /** Display title of an affected event entity, or null when unknown. */
  entityTitle(entityId: string): string | null {
    const row = this.db
      .prepare<[string], { title: string }>(
        "SELECT title FROM events WHERE event_id = ?",
      )
      .get(entityId);
    return row?.title ?? null;
  }

  // ------------------------------------------------------------------
  // Detail view (§3.2) — pure read, no detection run, no mutation
  // ------------------------------------------------------------------

  getDetail(conflictId: string): ConflictDetailView {
    const c = this.loadConflict(conflictId);
    if (c === undefined) {
      throw new ConflictCommandError("not_found", `no conflict ${conflictId}`);
    }
    const participants = this.loadParticipants(conflictId);
    const candidates: CandidateView[] = [];
    let localChangeId: string | null = null;
    for (const p of participants) {
      const change = this.db
        .prepare<[string], { operation: string }>(
          "SELECT operation FROM changes WHERE change_id = ?",
        )
        .get(p.change_id);
      // §7.2: participant payloads must exist while unresolved; if the
      // change row is gone we still render from the stored participant
      // payload rather than fabricating a value.
      const eff =
        change !== undefined
          ? effectiveOf({ operation: change.operation, payload: p.payload })
          : { deleted: false, value: parseJson(p.payload) };
      if (p.device_id === this.selfDeviceId) localChangeId = p.change_id;
      candidates.push({
        change_id: p.change_id,
        device_id: p.device_id,
        device_name: this.deviceName(p.device_id),
        deleted: eff.deleted,
        value: eff.value,
        hlc_timestamp: this.changeHlc(p.change_id),
      });
    }
    const titleRow = this.db
      .prepare<[string], { title: string }>(
        "SELECT title FROM events WHERE event_id = ?",
      )
      .get(c.entity_id);
    return {
      conflict_id: conflictId,
      entity_id: c.entity_id,
      entity_title: titleRow?.title ?? null,
      field_path: c.field_path,
      status: c.status,
      candidates,
      local_change_id: localChangeId,
      ...(c.status === "resolved_custom" && c.resolved_value !== null
        ? { resolved_value: parseJson(c.resolved_value as string) }
        : {}),
      ...(c.resolved_at_hlc !== null && c.resolved_at_hlc !== undefined
        ? { resolved_at_hlc: c.resolved_at_hlc }
        : {}),
    };
  }

  /** Is undo currently offered for this conflict? (P3) */
  undoAvailable(conflictId: string): boolean {
    const c = this.loadConflict(conflictId);
    return (
      c !== undefined &&
      c.status.startsWith("resolved_") &&
      !this.propagated.has(conflictId)
    );
  }

  /** Caller invokes after DC-06 §4.2 propagation proof for this resolution. */
  markPropagated(conflictId: string): void {
    this.propagated.add(conflictId);
  }

  // ------------------------------------------------------------------
  // Commands (§4 / §6.1)
  // ------------------------------------------------------------------

  /**
   * Resolve one conflict. ONE transaction writes BOTH the winning-value
   * normal change record (fresh local_seq + clock entry, via standard T1)
   * AND the status flip with resolved_at_hlc (TR-1). Returns the new
   * change record.
   */
  resolve(conflictId: string, option: ResolutionOption): ChangeRecord {
    const c = this.loadConflict(conflictId);
    if (c === undefined) {
      throw new ConflictCommandError("not_found", `no conflict ${conflictId}`);
    }
    if (c.status !== "unresolved") {
      throw new ConflictCommandError(
        "not_unresolved",
        `conflict already ${c.status}`,
      );
    }

    // Decide status + winning value WITHOUT consulting any timestamp (P4).
    let status: ConflictStatus;
    let win: { deleted: boolean; value: unknown };
    switch (option.kind) {
      case "keep_mine": {
        const local = this.localParticipant(conflictId); // throws when absent
        status = "resolved_keep_local";
        win = this.effectiveOfParticipant(local);
        break;
      }
      case "keep_theirs": {
        const locals = this.participantsOf(conflictId).filter(
          (p) => p.device_id === this.selfDeviceId,
        );
        const nonLocal = this.participantsOf(conflictId).filter(
          (p) => p.device_id !== this.selfDeviceId,
        );
        let pick = nonLocal[0];
        if (option.change_id !== undefined) {
          pick = nonLocal.find((p) => p.change_id === option.change_id);
          if (pick === undefined) {
            throw new ConflictCommandError(
              "unknown_candidate",
              `change_id ${option.change_id} is not an incoming participant`,
            );
          }
        } else if (nonLocal.length !== 1) {
          throw new ConflictCommandError(
            "unknown_candidate",
            "N-way conflict requires an explicit change_id for keep_theirs",
          );
        }
        void locals;
        status = "resolved_keep_incoming";
        win = this.effectiveOfParticipant(pick!);
        break;
      }
      case "keep_both": {
        status = "resolved_custom";
        win = { deleted: false, value: option.value };
        break;
      }
    }

    let record!: ChangeRecord;
    const tx = this.db.transaction(() => {
      // Step 1 (§6.1.1): the chosen value as a NORMAL new change record via T1.
      record = createLocalChange(this.db, this.selfDeviceId, {
        entity_id: c.entity_id,
        entity_type: "event",
        field_path: c.field_path,
        operation: win.deleted ? "remove" : "set",
        payload: win.deleted ? {} : { value: win.value },
        hlc_now: () => Date.now(),
      });
      // Step 2 (§6.1.2): status flip in the SAME transaction.
      this.db
        .prepare(
          `UPDATE conflicts SET status = ?, resolved_value = ?,
           resolved_at_hlc = ? WHERE conflict_id = ?`,
        )
        .run(
          status,
          status === "resolved_custom" ? JSON.stringify(win.value) : null,
          Date.now(),
          conflictId,
        );
    });
    tx();
    return record;
  }

  /** §4 "Skip / decide later": a strict NO-OP (TR-2). Returns nothing. */
  skip(_conflictId: string): void {
    /* intentional no-op — skipping must not write anything */
  }

  /**
   * §6.2 UNDO: another normal change record restoring the prior effective
   * value, plus status back to "unresolved", in one transaction. History is
   * append-only — no rows are updated or deleted in `changes`. Withheld
   * after a propagation proof (P3 / TR-3).
   */
  undo(conflictId: string): ChangeRecord {
    const c = this.loadConflict(conflictId);
    if (c === undefined) {
      throw new ConflictCommandError("not_found", `no conflict ${conflictId}`);
    }
    if (!c.status.startsWith("resolved_")) {
      throw new ConflictCommandError(
        "not_unresolved",
        `cannot undo status ${c.status}`,
      );
    }
    if (this.propagated.has(conflictId)) {
      throw new ConflictCommandError(
        "undo_withheld_propagated",
        "resolution already propagated — make a new edit instead (P3)",
      );
    }
    // Prior effective value = the LOCAL current value at resolution time
    // (the participant produced by this device / applied locally, §4).
    const prior = this.effectiveOfParticipant(
      this.localParticipant(conflictId),
    );

    let record!: ChangeRecord;
    const tx = this.db.transaction(() => {
      record = createLocalChange(this.db, this.selfDeviceId, {
        entity_id: c.entity_id,
        entity_type: "event",
        field_path: c.field_path,
        operation: prior.deleted ? "remove" : "set",
        payload: prior.deleted ? {} : { value: prior.value },
        hlc_now: () => Date.now(),
      });
      this.db
        .prepare(
          `UPDATE conflicts SET status = 'unresolved', resolved_value = NULL,
           resolved_at_hlc = NULL WHERE conflict_id = ?`,
        )
        .run(conflictId);
    });
    tx();
    this.propagated.delete(conflictId);
    return record;
  }

  /**
   * §5.3 bulk = N SEQUENTIAL INDIVIDUALS through the identical write path.
   * A failure mid-bulk leaves completed items resolved and the rest
   * untouched (each individually consistent, TR-7).
   */
  resolveBulk(decisions: Array<{ conflictId: string; option: ResolutionOption }>): void {
    for (const d of decisions) this.resolve(d.conflictId, d.option);
  }

  // ------------------------------------------------------------------
  // §6.3 / §6.4 remote-resolution intake (sync-driven transitions)
  // ------------------------------------------------------------------

  exportResolution(
    conflictId: string,
  ): {
    entity_id: string;
    field_path: string;
    status: ConflictStatus;
    resolved_value?: unknown;
    participant_change_ids: string[];
  } | null {
    const c = this.loadConflict(conflictId);
    if (c === undefined || !c.status.startsWith("resolved_")) return null;
    return {
      entity_id: c.entity_id,
      field_path: c.field_path,
      status: c.status,
      ...(c.resolved_value !== null
        ? { resolved_value: parseJson(c.resolved_value as string) }
        : {}),
      participant_change_ids: this.participantsOf(conflictId).map(
        (p) => p.change_id,
      ),
    };
  }

  exportType = "RESOLVED_CONFLICT" as const;

  /**
   * DC-14 §6.3 RESOLVED-ON-RECEIPT dedup rule. Receiving a resolution NEVER
   * mutates entity data here (the value travels via CHANGES_BATCH, §6.3).
   *
   *   - matching unresolved copy (same conflict entity + participant set):
     *     mark resolved with the arrived outcome (suppress re-prompting);
     *   - local copy already resolved: stale arrival is RECORDED but does
     *     NOT overwrite local status/value (§6.4 v1 first-by-arrival);
     *   - participants don't match: separate local variant — untouched.
   */
  applyRemoteResolution(remote: {
    entity_id: string;
    field_path: string;
    status: ConflictStatus;
    resolved_value?: unknown;
    participant_change_ids: string[];
  }): "resolved_on_receipt" | "recorded_stale" | "no_match" {
    if (!remote.status.startsWith("resolved_")) {
      throw new Error("applyRemoteResolution requires a resolved_* status");
    }
    const want = [...remote.participant_change_ids].sort().join("\u0000");
    const rows = this.db
      .prepare<
        [string, string],
        { conflict_id: string; status: ConflictStatus; ids: string | null }
      >(
        `SELECT c.conflict_id AS conflict_id, c.status AS status,
                (SELECT GROUP_CONCAT(change_id, ',') FROM conflict_participants p
                 WHERE p.conflict_id = c.conflict_id) AS ids
         FROM conflicts c WHERE c.entity_id = ? AND c.field_path = ?`,
      )
      .all(remote.entity_id, remote.field_path);
    const match = rows.find(
      (r) =>
        r.ids !== null &&
        [...r.ids.split(",")].sort().join("\u0000") === want,
    );
    if (match === undefined) return "no_match";
    if (match.status !== "unresolved") return "recorded_stale";
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE conflicts SET status = ?, resolved_value = ?,
           resolved_at_hlc = ? WHERE conflict_id = ?`,
        )
        .run(
          remote.status,
          remote.resolved_value !== undefined
            ? JSON.stringify(remote.resolved_value)
            : null,
          Date.now(),
          match.conflict_id,
        );
    });
    tx();
    return "resolved_on_receipt";
  }

  // ------------------------------------------------------------------
  // §7.1 obsolete closure on parent-entity tombstone
  // ------------------------------------------------------------------

  /**
   * Called when entity `entityId` is tombstoned: flips its unresolved
   * conflicts to the TERMINAL device-local state "obsolete" (never a
   * resolved_* value — no choice was made). Retained and explainable via
   * the tombstone reference. Terminal: subsequent resolve() calls refuse.
   */
  closeObsoleteOnTombstone(entityId: string, tombstoneRef: string): number {
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE conflicts SET status = 'obsolete', resolved_value = ?
           WHERE entity_id = ? AND status = 'unresolved'`,
        )
        .run(
          JSON.stringify({ closed_obsolete_by_tombstone: tombstoneRef }),
          entityId,
        );
      return info.changes;
    });
    return tx() as unknown as number;
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private loadConflict(
    conflictId: string,
  ):
    | {
        conflict_id: string;
        entity_id: string;
        field_path: string;
        status: ConflictStatus;
        resolved_value: string | null;
        resolved_at_hlc: number | null;
      }
    | undefined {
    return this.db
      .prepare<[string], {
        conflict_id: string;
        entity_id: string;
        field_path: string;
        status: ConflictStatus;
        resolved_value: string | null;
        resolved_at_hlc: number | null;
      }>(
        `SELECT conflict_id, entity_id, field_path, status, resolved_value,
                resolved_at_hlc FROM conflicts WHERE conflict_id = ?`,
      )
      .get(conflictId);
  }

  private participantsOf(conflictId: string): ParticipantRow[] {
    return this.db
      .prepare<[string, string], ParticipantRow>(
        `SELECT change_id, device_id, local_seq, causality_clock, payload
         FROM conflict_participants WHERE conflict_id = ?
         ORDER BY (device_id = ?) DESC, change_id`,
      )
      .all(conflictId, this.selfDeviceId);
  }

  private loadParticipants(conflictId: string): ParticipantRow[] {
    return this.participantsOf(conflictId);
  }

  /** §4 "local current value" — the participant produced by THIS device. */
  private localParticipant(conflictId: string): ParticipantRow {
    const mine = this.participantsOf(conflictId).find(
      (p) => p.device_id === this.selfDeviceId,
    );
    if (mine === undefined) {
      throw new ConflictCommandError(
        "no_local_participant",
        "keep_mine/undo require a locally produced participant (§4)",
      );
    }
    return mine;
  }

  private effectiveOfParticipant(p: ParticipantRow): {
    deleted: boolean;
    value: unknown;
  } {
    const change = this.db
      .prepare<[string], { operation: string }>(
        "SELECT operation FROM changes WHERE change_id = ?",
      )
      .get(p.change_id);
    if (change !== undefined) {
      return effectiveOf({ operation: change.operation, payload: p.payload });
    }
    // Fallback without fabricating values: infer deletion from empty payload.
    const parsed = parseJson(p.payload) as Record<string, unknown>;
    const deleted =
      parsed === null ||
      typeof parsed !== "object" ||
      Object.keys(parsed).length === 0;
    return { deleted, value: deleted ? undefined : parsed };
  }

  private changeHlc(changeId: string): number {
    const row = this.db
      .prepare<[string], { hlc_timestamp: number }>(
        "SELECT hlc_timestamp FROM changes WHERE change_id = ?",
      )
      .get(changeId);
    return row?.hlc_timestamp ?? 0;
  }

  /** §3.2b device attribution through paired-device display names. */
  private deviceName(deviceId: string): string {
    if (deviceId === this.selfDeviceId) return "This device";
    const row = this.db
      .prepare<[string], { display_name: string }>(
        "SELECT display_name FROM peers WHERE device_id = ?",
      )
      .get(deviceId);
    return row?.display_name ?? deviceId;
  }
}

/** Convenience: build a causality-clock type re-export for callers/tests. */
export type { VectorClock };
