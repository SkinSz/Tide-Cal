// Tide DC-01: Field-Level Change Record Schema (APPROVED contract)
// Types and constructors. Pure data — no I/O, no side effects.

export type Operation =
  | "set"
  | "remove"
  | "member_add"
  | "member_update"
  | "member_remove";

export type EntityType =
  | "calendar"
  | "event"
  | "series"
  | "occurrence_override"
  | "reminder"
  | "tombstone-marker";

/** causality_clock: device_id -> highest observed local_seq */
export type VectorClock = Record<string, number>;

export interface ChangeRecord {
  /** "<device_id>:<local_seq>" — globally unique, stable forever */
  change_id: string;
  /** Cryptographic device identity of the PRODUCING device */
  device_id: string;
  /** Producer's gap-free monotonic sequence number */
  local_seq: number;
  entity_id: string;
  entity_type: EntityType;
  /** Logical field path, e.g. "title", "reminders.<member_id>" */
  field_path: string;
  operation: Operation;
  payload: ChangePayload;
  /** Hybrid logical clock ms — PRESENTATION ONLY (DC-01 §4.4) */
  hlc_timestamp: number;
  /** Producer's device clock at change creation */
  causality_clock: VectorClock;
  schema_version: number;
}

export type ChangePayload =
  | { value: unknown }
  | { member_id: string; value?: unknown }
  | Record<string, never>; // remove: {}

export function changeId(deviceId: string, localSeq: number): string {
  return `${deviceId}:${localSeq}`;
}

export class ChangeRecordError extends Error {
  constructor(
    public code:
      | "missing_field"
      | "bad_operation"
      | "bad_entity_type"
      | "bad_seq"
      | "id_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ChangeRecordError";
  }
}

const OPERATIONS: readonly Operation[] = [
  "set",
  "remove",
  "member_add",
  "member_update",
  "member_remove",
];
const ENTITY_TYPES: readonly EntityType[] = [
  "calendar",
  "event",
  "series",
  "occurrence_override",
  "reminder",
  "tombstone-marker",
];

/**
 * Structural validation per DC-01 §2 and DC-08 §5 Stage 2.
 * Throws ChangeRecordError on any violation. Pure.
 * TR-1 support: identical input => identical record or identical error.
 */
export function validateChangeRecord(r: unknown): ChangeRecord {
  if (typeof r !== "object" || r === null) {
    throw new ChangeRecordError("missing_field", "record is not an object");
  }
  const rec = r as Record<string, unknown>;

  for (const key of [
    "change_id",
    "device_id",
    "entity_id",
    "field_path",
  ] as const) {
    if (typeof rec[key] !== "string" || (rec[key] as string).length === 0) {
      throw new ChangeRecordError("missing_field", `invalid ${key}`);
    }
  }
  if (
    typeof rec.local_seq !== "number" ||
    !Number.isInteger(rec.local_seq) ||
    (rec.local_seq as number) <= 0
  ) {
    throw new ChangeRecordError("bad_seq", "local_seq must be a positive integer");
  }
  if (
    typeof rec.operation !== "string" ||
    !OPERATIONS.includes(rec.operation as Operation)
  ) {
    throw new ChangeRecordError("bad_operation", `invalid operation ${String(rec.operation)}`);
  }
  if (
    typeof rec.entity_type !== "string" ||
    !ENTITY_TYPES.includes(rec.entity_type as EntityType)
  ) {
    throw new ChangeRecordError("bad_entity_type", `invalid entity_type ${String(rec.entity_type)}`);
  }
  const cc = rec.causality_clock;
  if (typeof cc !== "object" || cc === null || Array.isArray(cc)) {
    throw new ChangeRecordError("missing_field", "causality_clock must be an object");
  }
  for (const [k, v] of Object.entries(cc as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "number" || !Number.isInteger(v) || (v as number) < 0) {
      throw new ChangeRecordError("missing_field", `causality_clock[${k}] invalid`);
    }
  }
  if (typeof rec.hlc_timestamp !== "number" || !Number.isFinite(rec.hlc_timestamp)) {
    throw new ChangeRecordError("missing_field", "hlc_timestamp must be a finite number");
  }

  // TD-002: JSON.parse('{"x":1e999}') yields Infinity — a *number* per
  // `typeof` that passes every structural check above, then corrupts durable
  // rows (better-sqlite3 binds Infinity as REAL Infinity, NaN as NULL, and
  // schedule wall/date strings derive to "NaN:NaN:NaN"-style garbage).
  // Non-finite numbers can never be legitimately produced on the wire
  // (JSON.stringify(NaN|Infinity) === "null"), so reject them here; the sync
  // engine quarantines the record durably on validation failure.
  {
    const stack: unknown[] = [rec.payload];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (typeof cur === "number" && !Number.isFinite(cur)) {
        throw new ChangeRecordError(
          "missing_field",
          "payload contains a non-finite number (NaN/Infinity from 1e999-style JSON overflow)",
        );
      }
      if (Array.isArray(cur)) {
        stack.push(...cur);
      } else if (typeof cur === "object" && cur !== null) {
        stack.push(...Object.values(cur as Record<string, unknown>));
      }
    }
  }

  // change_id consistency (DC-01 §2 format rule)
  const expected = changeId(rec.device_id as string, rec.local_seq as number);
  if (rec.change_id !== expected) {
    throw new ChangeRecordError("id_mismatch", `change_id ${rec.change_id} != ${expected}`);
  }

  return Object.freeze({ ...rec }) as unknown as ChangeRecord;
}
