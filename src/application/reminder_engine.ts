// Tide DC-22: reminder scheduling engine (pure rebuild + fire policy).
//
// Contract: docs/contracts/DC-22_reminders_local_notifications.md.
// Core invariant (D9, verbatim): "Notification delivery is an ephemeral
// local side effect and is not part of Tide's replicated logical state."
//
// Design (all binding decisions implemented here):
// - D8/§3.1: scheduling is a PURE rebuild — local DB state in, full schedule
//   out. No incremental scheduling path.
// - D3/§2.2: reminders store RELATIVE minutes_before; fire instants are
//   derived locally at rebuild time, never stored or replicated.
// - D1/§3.3: missed-while-not-running = show-on-launch, marked missed;
//   discarded once the event's own end has passed.
// - D2/§5.4: all-day events fire on the DAY BEFORE the event at the user's
//   per-event picked time; today-created all-day events fire immediately as
//   missed (never silently swallowed).
// - D10/§8: idempotency via deterministic schedule key
//   (member_id, entity_id, fire_at) + in-session delivered-once guard.
// - D12/§5.5: at most ONE notification per member per discontinuity.
// - D6/§2.5: notification content = event title + start time only.
//
// Delivery mechanism (D7): the caller (sidecar scheduler runtime) invokes
// the OS desktop notification service with the returned payloads. This
// module stays platform-neutral and testable.

export interface ReminderRow {
  member_id: string;
  entity_id: string;
  minutes_before: number;
  /**
   * Smoke-test fix (2026-09-03): the reminder member's last-write HLC (epoch
   * ms). Drives the late-configuration rule: a reminder CREATED after its
   * fire moment already passed must NOT surface as "missed" — the user just
   * configured it and knows the event hasn't started; an immediate fire is
   * noise, not a missed-while-not-running surface (D1 applies to reminders
   * that existed before their fire moment). Optional: null/undefined keeps
   * the legacy always-show behavior (older rows, tests).
   */
  updated_hlc_ms?: number | null;
}

export interface EventRow {
  entity_id: string;
  title: string;
  /** Local wall-clock start "YYYY-MM-DDTHH:MM" (naive, Spec §7). */
  start_wall: string;
  /** Local wall-clock end; null = derive from duration. */
  end_wall: string | null;
  all_day: 0 | 1;
  /** Per-event day-before reminder time for all-day events (§5.4, "HH:MM"). */
  all_day_reminder_time: string | null;
  /**
   * pkg10 F3: authoritative start INSTANT for timed events (epoch ms, from
   * the events table's utc_start_ms — already tz_id-resolved). When present,
   * fire instants derive from THIS, not from interpreting start_wall as
   * device-local time (§5.1 "event start in its own timezone semantics").
   * Null for all-day events (local-midnight arithmetic is correct there).
   */
  utc_start_ms?: number | null;
  /** Authoritative end instant (epoch ms); used by the D1 discard rule. */
  utc_end_ms?: number | null;
}

export interface ScheduledFire {
  /** Deterministic schedule key (§8.1). */
  key: string;
  member_id: string;
  entity_id: string;
  title: string;
  /** Wall-clock rendering of the event start (D6: title + time only). */
  event_start_label: string;
  /** Epoch ms this reminder should fire. */
  fire_at_ms: number;
  /** True when this is a missed-while-not-running surface (D1). */
  missed: boolean;
}

/**
 * Pure rebuild (§3.1/D8): derive the complete schedule from local DB rows.
 * `nowMs` is the evaluation instant. Tombstoned events never reach this
 * function (the caller filters by live entities, §6.1).
 */
export function rebuildSchedule(
  events: EventRow[],
  reminders: ReminderRow[],
  nowMs: number,
  /**
   * Grace context for the D1 missed/on-time decision (owner question,
   * 2026-09-04): "was the engine actually ticking when the fire moment
   * passed?" The caller supplies the epoch ms of the tick that ran
   * immediately BEFORE this one (null on the first tick after start /
   * suspend-resume). Decision:
   *   - lastTickMs != null AND lastTickMs < fireAt  → the engine was alive
   *     at the fire moment and THIS tick is the first delivery chance →
   *     ON TIME (tick-quantized), regardless of how late this tick ran.
   *   - otherwise (first tick, or fire moment predates the previous tick)
   *     → the moment passed while the engine was down/suspended → MISSED.
   * This is exact and self-adjusting: no fixed grace constant to tune, and
   * a delayed/overrun tick never mislabels a live-fire as missed.
   */
  lastTickMs?: number | null,
): ScheduledFire[] {
  const out: ScheduledFire[] = [];
  const byEntity = new Map(events.map((e) => [e.entity_id, e]));
  for (const rem of reminders) {
    const ev = byEntity.get(rem.entity_id);
    if (ev === undefined) continue; // §6.1: tombstoned event → never scheduled

    // pkg10 F3 (§5.1): timed events use the authoritative utc_start_ms
    // instant (already tz_id-resolved) — NEVER reinterpret start_wall as
    // device-local time, which would be wrong when the event's timezone
    // differs from the device's. All-day events keep local-midnight
    // arithmetic (their tz is local by definition).
    const startMs =
      ev.all_day === 1 || ev.utc_start_ms == null
        ? wallToMs(ev.start_wall)
        : ev.utc_start_ms;
    if (!Number.isFinite(startMs)) continue;

    // D1 discard-rule end instant: prefer the authoritative utc_end_ms.
    const endMsFor = (fallbackMs: number): number =>
      ev.utc_end_ms != null ? ev.utc_end_ms : fallbackMs;

    let fireAt: number;
    if (ev.all_day === 1) {
      // D2/§5.4: fire the DAY BEFORE at the picked time. No picked time in
      // the row = reminder not configured (opt-in) → not scheduled.
      if (!ev.all_day_reminder_time) continue;
      const dayBefore = new Date(startMs - 86_400_000);
      fireAt = wallToMs(
        `${isoDate(dayBefore)}T${ev.all_day_reminder_time}`,
      );
      if (!Number.isFinite(fireAt)) continue;
      // §5.4 edge: all-day event created for TODAY, day-before moment
      // already passed → fires immediately as missed (D1).
      if (fireAt > nowMs) {
        out.push(makeFire(rem, ev, fireAt, false));
      } else {
        // Missed unless the event itself has already ended (D1 discard rule).
        const endMs = endMsFor(startMs + 86_400_000);
        if (endMs > nowMs) out.push(makeFire(rem, ev, fireAt, true));
      }
      continue;
    }

    fireAt = startMs - rem.minutes_before * 60_000;
    if (fireAt > nowMs) {
      out.push(makeFire(rem, ev, fireAt, false));
      continue;
    }
    // Missed path (D1): fire_at passed while not running. Show-on-launch
    // UNLESS the event itself has already ended (discard = noise).
    // Smoke-test refinement (2026-09-03): a reminder CONFIGURED after its
    // fire moment (updated_hlc_ms > fireAt) is a late configuration, not a
    // missed-while-not-running surface — the user set it up knowingly, an
    // instant fire is pure noise. The event-ends discard below still applies.
    // D1 on-time test (owner question 2026-09-04, replaces the earlier
    // fixed-30s grace): was the engine TICKING when the moment passed?
    // If the PREVIOUS tick ran before fireAt, this tick is the first
    // delivery chance — on time, however late THIS tick itself ran
    // (overrun, suspend edge). First tick after start/resume (lastTickMs
    // null) or a moment older than the previous tick = the moment passed
    // while the engine was down → genuinely missed. Self-adjusting: no
    // grace constant to tune, correct under arbitrary tick delay.
    if (rem.updated_hlc_ms != null && rem.updated_hlc_ms > fireAt) continue;
    const endMs = endMsFor(startMs + 3_600_000);
    if (endMs > nowMs) {
      const onTime = lastTickMs != null && lastTickMs < fireAt;
      out.push(makeFire(rem, ev, fireAt, !onTime));
    }
  }
  return out.sort((a, b) => a.fire_at_ms - b.fire_at_ms);
}

function makeFire(
  rem: ReminderRow,
  ev: EventRow,
  fireAtMs: number,
  missed: boolean,
): ScheduledFire {
  return {
    key: `${rem.member_id}|${rem.entity_id}|${fireAtMs}`,
    member_id: rem.member_id,
    entity_id: rem.entity_id,
    title: ev.title,
    // pkg10 F4 (D6): all-day events have no meaningful time-of-day — label
    // the DAY, not a fabricated "00:00".
    event_start_label: ev.all_day === 1
      ? ev.start_wall.replace("T", " ").slice(0, "YYYY-MM-DD".length)
      : ev.start_wall.replace("T", " "),
    fire_at_ms: fireAtMs,
    missed,
  };
}

/** Naive local wall-clock string → epoch ms (Spec §7 wall-clock semantics). */
function wallToMs(wall: string): number {
  const m = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return new Date(
    +m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, 0, 0,
  ).getTime();
}

function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * §8.1/D10 idempotency filter: given the rebuilt schedule and the engine's
 * delivered set, return only fires whose keys have NOT fired this session.
 * Rebuilding twice with no state change yields identical keys → no-ops.
 */
export function filterDelivered(
  schedule: ScheduledFire[],
  delivered: Set<string>,
): ScheduledFire[] {
  return schedule.filter((f) => !delivered.has(f.key));
}

/** §8.2: mark keys delivered (in-session side-effect ledger, D9). */
export function markDelivered(delivered: Set<string>, fires: ScheduledFire[]): void {
  for (const f of fires) delivered.add(f.key);
}

/**
 * D1/§3.3 notification text (D6/§2.5: title + start time only; missed
 * notifications include the original fire context).
 */
export function renderNotification(f: ScheduledFire): {
  summary: string;
  body: string;
} {
  return f.missed
    ? {
        summary: `Missed reminder: ${f.title}`,
        body: `Was due ${f.event_start_label}`,
      }
    : {
        summary: f.title,
        body: `Starts ${f.event_start_label}`,
      };
}
