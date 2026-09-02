# DC-22 Reminder Review — pkg10 (blind adversarial retry #2)

Verdict: PENDING

Findings:

## F1 (HIGH) — §7.1/D1: delivery failure marks reminder delivered; never retried
`sidecar_server.ts` reminderTick: `if (deliverNotification(fire)) markDelivered(...)`.
`deliverNotification` uses `spawn(...)` which returns successfully even when
`notify-send` does not exist — the ENOENT surfaces later via async
`child.on("error")`. So the function returns `true`, the schedule key is
marked delivered, and the reminder is silently swallowed forever. This
directly violates §7.1 ("keep the schedule; retry on next rebuild") and D1's
"never silently swallow" posture. Additionally `notify-send` exiting nonzero
(daemon failure) is not observed at all (stdio ignored, exit listener absent).
Fix direction: only mark delivered after confirmed dispatch (e.g. await
spawn/exit success, or track per-fire pending state and unmark on async
failure).

## F2 (MEDIUM) — D5: reminders table has no `enabled` column
Contract §2.4/D5 mandates a nullable `enabled` column (NULL/1=active, 0=
disabled) in the DC-07 next migration, and the engine must never schedule
disabled reminders. schema.ts adds only `events.all_day_reminder_time`; the
`reminders` table (schema.ts:60-67) is unchanged and the engine's SELECT does
not reference `enabled`. Disabled reminders are therefore unrepresentable
and unenforceable. (Possible intent: no disable UI yet — but D5 is a binding
decision and the migration was contract-mandated.)

## F3 (MEDIUM) — §5.1: event timezone (tz_id) ignored on the fire-time path
`rebuildSchedule` interprets `start_wall` as DEVICE-LOCAL wall time
(`wallToMs` uses `new Date(y,m,d,...)`, i.e. local). Events carry `tz_id`
(schema: timed events always have tz_id NOT NULL), so for an event whose
tz_id ≠ device timezone the derived fire_at is wrong by the zone offset.
§5.1 requires "event start in its own timezone semantics". `utc_start_ms`
exists in the schema and is the correct instant source for timed events.
Note: sidecar SQL COALESCEs `start_date||'T00:00'` for all-day (fine, all-day
has tz_id NULL by CHECK), but the timed path (`start_wall`) ignores tz_id.

## F4 (LOW) — D2/D6: all-day notifications render "00:00" start label
`COALESCE(start_date,'T00:00')` flows into `event_start_label`, so an all-day
reminder shows "Starts 2026-09-03 00:00". Not a D6 leak (title+time only),
but semantically wrong content for an all-day event.

## F5 (LOW) — delivered-set unbounded growth
`deliveredReminderKeys` is never pruned; long-running sidecar sessions
accumulate keys indefinitely. Ephemeral and in-memory (D9-compliant), but a
trivial periodic prune or per-day bucketing would bound it.

## F6 (INFO) — D2: unvalidated `all_day_reminder_time` format
If the picked time is stored unpadded ("9:00") or malformed, `wallToMs`
returns NaN → reminder silently never scheduled (engine `continue`). No
CHECK constraint on the new column. Silently dropping violates the spirit of
D1; suggest format validation at write time (event dialog) or a CHECK.

## Checklist results
1. D9 (no changelog writes on reminder path): OK — reminderTick only SELECTs;
   deliveredReminderKeys is in-memory; deliverNotification spawns notify-send
   only; markDelivered mutates the in-memory Set. No INSERT into
   changes/changelog/clock anywhere in the traced path.
2. D1 boundaries: fire_at == now → missed path → fires immediately (OK).
   end == now → `endMs > nowMs` false → discarded (boundary choice acceptable
   under D1 "older than the event's own end"). end null fallback: timed=1h,
   all-day=24h (all-day uses SQL end 23:59 anyway; engine fallback is
   dead-but-safe). OK.
3. D10: key `member|entity|fireAtMs` is deterministic from DB state; restart
   rebuild → same keys → no dupes in-session; clock jump back re-derives same
   past keys → delivered guard blocks (§8.2 OK); delivered set in-memory so
   restart correctly falls to D1 missed policy. Except F1 (async-failure
   marking defeats the guard).
4. D2 all-day: day-before arithmetic OK — `startMs - 86400000` then
   `isoDate(dayBefore)` discards the intermediate time-of-day, so DST/month
   boundaries only shift the intermediate (e.g. 23:00), never the date; the
   fire instant is recomputed from `${date}T${picked}`. Today-created missed
   path OK (end 23:59 > now → missed). Missing picked time → not scheduled
   (matches opt-in D2). See F4/F6.
5. D6: renderNotification emits title + start label only; no notes/location/
   attendees. Only issue is F4 (all-day "00:00" label). No leak.
6. §7.1: module-level `unavailableLogged` logs once per session at both
   failure sites; crash safety OK (in-memory only, restart rebuilds).
   BUT F1: the once-per-session log fires only on async spawn error, while
   the delivered-marking path assumes success — combined effect is silent
   loss, worse than log spam.
7. SQL vs schema: `all_day_reminder_time` column exists (schema.ts:71 ALTER,
   matches §5.4/D2). COALESCE(start_wall, start_date||'T00:00') correct given
   the CHECK constraint (all_day=1 → start_wall NULL; timed → start_date
   NULL); end_wall COALESCE's `end_date||'T23:59'` branch is reachable only
   for all-day (timed rows always have end_wall NOT NULL). No tombstone/
   deleted column on events (DC-06 hard-deletes), so no WHERE filter needed;
   orphaned reminders skipped by the byEntity lookup (§6.1 OK). Real issue is
   F3 (tz_id ignored); reminders SELECT has no enabled filter because the
   column doesn't exist (F2).

## Test runs
- vitest tests/dc22_reminder_engine.test.ts: 11/11 pass.
- tsc --noEmit: clean (exit 0).

## VERDICT: REJECT
Blocking: F1 (silent delivery loss — violates §7.1/D1),
F2 (D5 enabled column missing), F3 (tz_id ignored — §5.1).
Non-blocking: F4, F5, F6.
