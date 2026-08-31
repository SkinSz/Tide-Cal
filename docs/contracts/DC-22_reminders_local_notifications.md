# TIDE DESIGN CONTRACT DC-22
# Reminders and Local Notification Semantics
Status: APPROVED by project owner (2026-09-01)

OWNER DECISIONS (2026-09-01):
- D1 missed-while-not-running: show-on-launch with missed-marking;
  discard once the event itself has ended.
- D2 all-day events: reminder fires the day before (fixed);
  PER EVENT the user ticks it on and picks the exact time in
  the event dialog (corrected 2026-09-01: not a global Options
  setting).

Depends on: Architecture Spec v0.3 §3, §4, §5, §6, §7, §31;
            DC-01 (change records); DC-07 §reminders (storage);
            DC-08 (sync protocol boundary); DC-13 (sidecar scheduler
            runtime); DC-16 §Tier-1 (failure-handling posture)
Unblocks: reminder creation/edit UI; notification scheduling engine;
          missed-reminder on-launch pass; recurrence-reminder wiring
Resolves: an undefined delivery layer for a first-class synced entity
          (Spec §3/§4 store reminders; no contract defined when/how the
          user is actually notified)

==================================================
1. PURPOSE
==================================================

The frozen spec makes reminders FIRST-CLASS SYNCED DATA: they are in
the SQLite inventory (§3), in the event field list (§4), and are
collection-merged like any other collection (§5: concurrent additions
on two devices = union; DC-07 defines the `reminders` table with a
member_id primary key, entity_id, minutes_before).

What nothing defines is DELIVERY: when an actual OS notification is
shown, what it contains, what happens after a restart, and how the
local schedule reconciles with replicated state.

This contract decides exactly that layer — and draws the boundary
between what replicates and what does not.

CORE PRINCIPLE (owner-mandated, binding):

    "Notification delivery is an ephemeral local side effect and is
     not part of Tide's replicated logical state."

Analogy: reminder CONFIGURATION is the letter's contents and
replicates like all mail. The notification is the postman knocking —
purely local, never mailed to anyone, never recorded as a change.

Frozen constraints implemented here:

  - Spec §3/§4: reminders are stored per-device and synchronize.
  - Spec §5: collection merge union semantics apply to reminder
    members; this contract adds nothing to merge logic (DC-04).
  - Spec §7: all fire times are computed with real timezone/DST
    semantics; wall-clock preservation for recurring events (§8,
    INVARIANT 9).
  - Spec INVARIANT 1: everything here is best-effort. If the
    notification engine never runs, calendar data is unaffected.
  - Spec INVARIANT 2: SQLite remains authoritative. The schedule is
    always DERIVED from local DB state, never stored as truth.
  - DC-01/DC-08: change records describe replicated logical state.
    Delivery is not logical state, so no "notification sent" event is
    ever emitted into the changelog, on any device, ever.
  - DC-13: the sidecar already runs a timer-driven scheduler runtime.
    The reminder engine REUSES that runtime; no new background
    process is created.

==================================================
2. REMINDER REPRESENTATION
==================================================

2.1  WHAT CONSTITUTES A REMINDER

     A reminder is a collection member (DC-07 `reminders` row):
     stable member_id (UUIDv4), owning entity_id, and a trigger
     offset. It exists independently of whether it is enabled or
     whether any notification was ever shown.

2.2  RELATIVE, NOT ABSOLUTE (DECIDED)

     The stored, replicated form is RELATIVE: minutes_before >= 0
     (already fixed by the DC-07 CHECK constraint).

     The absolute fire time is ALWAYS DERIVED LOCALLY at schedule
     time: fire_at = event_start - minutes_before, computed in the
     event's own timezone semantics (§5 below). The absolute time is
     never stored and never replicated.

     Justification: relative offsets survive event moves, timezone
     changes, and DST automatically — an absolute timestamp would go
     stale the moment the event moves and would silently desync
     across devices. This matches Spec §7 (wall-clock preservation)
     and every major calendar product's on-disk semantics.

2.3  MULTIPLE REMINDERS PER EVENT (DECIDED)

     Allowed. The schema already keys members independently
     (UNIQUE entity_id+member_id). Any number of reminder members
     may attach to one event. The schedule engine handles each
     independently.

2.4  DISABLED REMINDERS (DECIDED)

     A disabled reminder is STORED but INACTIVE: it replicates, it
     merges, it shows in UI, but the schedule engine never schedules
     it. Representation: the DC-07 schema's next migration adds a
     nullable `enabled` column (default 1). NULL/1 = active; 0 =
     disabled. (Schema change is additive; no data migration.)

2.5  SENSITIVE CONTENT (DECIDED)

     Notification content is derived from CURRENT local state at
     fire time (never from a cached payload captured at schedule
     time) and is minimal: event title + start time only. Event
     notes, locations, and attendee data NEVER appear in a
     notification unless the owner later explicitly opts a field in
     (future setting; none exists in v1).

==================================================
3. SCHEDULING LIFECYCLE
==================================================

3.1  WHEN AN EVENT BECOMES SCHEDULED (DECIDED)

     The schedule is rebuilt from local DB state on every trigger:
     (a) event created/edited/deleted locally; (b) reminder added,
     edited, disabled, or removed; (c) sync session applies changes
     (post-merge recompute, §6.4); (d) sidecar start; (e) clock or
     timezone discontinuity detected (§5.5). Scheduling is a pure
     function: local DB state in -> full schedule out. There is no
     incremental "schedule one reminder" path in v1; rebuild is
     cheap at calendar scale.

3.2  AFTER RESTART (DECIDED)

     On sidecar start the engine rebuilds the schedule from the DB.
     Schedules are not persisted; there is nothing to restore and
     therefore nothing to go stale.

3.3  MISSED WHILE TIDE WAS NOT RUNNING (OPEN — D1)

     If fire_at passed while Tide was down, the reminder "missed".
     Options:
       (a) show-on-launch: fire the notification on next start,
           marked as missed (recommended);
       (b) discard silently.
     RECOMMENDATION: (a). A calendar that silently swallows reminders
     fails its one job. Missed notifications include the original
     fire time. A missed reminder older than the event's own end
     time is discarded (reminding about a past event start the user
     is watching in the grid is noise). Owner to decide.

3.4  EVENT CHANGES (DECIDED)

     Any change to the event (move, resize, timezone change,
     recurrence edit) or its reminders invalidates the derived
     schedule; §3.1's rebuild recomputes fire times from current
     state. Old OS notifications that are still visible are
     replaced/cancelled per §6.

==================================================
4. OS NOTIFICATION DELIVERY
==================================================

4.1  MECHANISM (DECIDED)

     Linux first target: the sidecar fires OS desktop notifications
     via the desktop notification service (freedesktop.org
     org.freedesktop.Notifications — the standard KDE/GNOME path),
     invoked from the DC-13 sidecar scheduler runtime. The Tauri
     shell's notification capability is the fallback if direct D-Bus
     invocation proves fragile; the contract requires only that
     delivery goes through the OS notification service, NOT that a
     specific bus library be used. Implementation agent picks the
     concrete library and documents it in the PR.

4.2  FIRING (DECIDED)

     At fire_at the engine re-reads the event from SQLite and
     renders the notification from THAT state (title + derived time
     per §2.5). If the event was deleted or its reminder disabled in
     the meantime, nothing fires — the DB is the gate, not the
     schedule entry.

==================================================
5. TIME SEMANTICS
==================================================

5.1  TIMEZONE OF COMPUTATION (DECIDED)

     Fire time = (event start in its own timezone semantics,
     per Spec §7/§8) - minutes_before, evaluated in LOCAL wall-clock
     time of THIS device at schedule/rebuild time. Each device
     independently derives its own fire instants; the offset
     replicates, instants do not.

5.2  TIMEZONE CHANGES (DECIDED)

     A device timezone change is a discontinuity: trigger §3.1(d)
     rebuild. Fire instants move with the wall clock (a 09:00
     reminder fires at 09:00 local on the device, wherever it is) —
     this is standard calendar behavior and consistent with §5.1.

5.3  DST TRANSITIONS (DECIDED)

     Derivation uses the established date/time library (Spec §7
     MUST). A 02:30 event across a spring-forward gap resolves per
     the library's documented gap handling; reminders inherit the
     event's resolution — they never invent their own.

5.4  FLOATING AND ALL-DAY EVENTS (DECIDED — owner 2026-09-01)

     - Floating/local events: fire_at computed in local wall time
       directly.
     - All-day events: the reminder fires on the DAY BEFORE the
       event (fixed). Per event, the user ticks reminder on/off and
       picks the exact time of day for that day-before moment
       (e.g. 20:00) in the event dialog — NOT a global Options
       setting (owner correction 2026-09-01). The picked time is
       the base fire moment; relative minutes_before offsets
       measure back from it. Edge case: all-day event created for
       TODAY, after the day-before moment has already passed ->
       fires immediately as a missed reminder on next rebuild (D1
       policy: never silently swallow). No default time in v1:
       reminder is opt-in per all-day event, user picks the time
       when ticking it on.

5.5  CLOCK JUMPS (DECIDED)

     System clock moved forward/backward, NTP corrections, or
     suspend/resume gaps are detected by the existing DC-13 timer
     runtime's tick checks (compare wall-clock delta vs expected).
     Response: rebuild the schedule (§3.1(e)). No catch-up storm:
     at most ONE notification per reminder member fires per
     discontinuity; if a rebuild finds multiple members whose
     fire_at is in the past, they follow §3.3's missed policy
     (one missed notification each, bounded, deduplicated by
     schedule key).

==================================================
6. CANCELLATION / REPLACEMENT
==================================================

6.1  EVENT DELETED (DECIDED)

     Event delete produces a tombstone (DC-06) and removes the
     event from local state; its reminders become orphans in the
     collection. Rule: reminders of a tombstoned event are never
     scheduled; the rebuild drops them. (Orphan rows are compacted
     per DC-06 normally.)

6.2  EVENT MOVED (DECIDED)

     The rebuild recomputes fire_at; the engine cancels/replaces the
     previously-shown still-visible OS notification for that reminder
     (replace-by-notification-id where the OS service supports it)
     and schedules the new one.

6.3  REMINDER CHANGED (DECIDED)

     Editing or disabling a reminder member invalidates its old
     schedule entry; only the new state schedules.

6.4  SYNC RECEIVES NEWER EVENT STATE (DECIDED)

     After a sync session applies changes, the engine rebuilds from
     POST-MERGE local DB state (§3.1(c)). The engine NEVER schedules
     directly from an incoming change record's reminder field — the
     merged local state is the only input. This is what keeps
     INVARIANT 2 (SQLite authoritative) true on the reminder path.

==================================================
7. FAILURE BEHAVIOR
==================================================

Posture: DC-16 Tier-1 style. Every failure degrades, logs, and never
crashes the sidecar. Notifications are best-effort (INVARIANT 1
spirit): a lost notification loses nothing replicated.

7.1  OS PERMISSION DENIED / SERVICE UNAVAILABLE (DECIDED)

     Log once per session (not per attempt, to avoid log spam);
     keep the schedule; retry on next rebuild. No user-visible error
     surfaces in v1 (a future options-window indicator is possible
     but not required by this contract).

7.2  TIDE CRASHED (DECIDED)

     Nothing special: on restart, §3.2 + §3.3 apply. Missed
     reminders surface per the D1 decision.

7.3  DEVICE ASLEEP / OFFLINE (DECIDED)

     Sleep is transparent — suspend freezes timers; on wake the
     tick check sees the gap and §5.5 applies (missed policy, one
     notification per member). Offline is irrelevant: reminders are
     purely local (INVARIANT 1); sync state plays no role in firing.

7.4  SCHEDULING FAILS (DECIDED)

     A rebuild error is logged and leaves the previous schedule in
     place; next trigger retries. Data is never at risk (the
     schedule is derived, §1).

==================================================
8. IDEMPOTENCY
==================================================

8.1  MECHANISM (DECIDED)

     Schedule key = deterministic function of
     (member_id, entity_id, derived fire_at instant).
     The engine maintains a map keyed by schedule key. Scheduling an
     existing key is a NO-OP; changed fire_at yields a NEW key and
     the old entry is dropped. Replace-before-schedule: an entry is
     never double-booked.

     Consequences (all required testable properties):
     - Restarting Tide cannot duplicate notifications (schedule is
       rebuilt, keys identical -> no-ops).
     - Re-syncing the same event cannot duplicate (post-merge state
       unchanged -> same keys).
     - Repeated scheduling converges on exactly ONE local schedule
       per (reminder, fire time).

8.2  DELIVERED-ONCE GUARD (DECIDED)

     Within one sidecar session, a schedule key that has FIRED is
     marked delivered and cannot fire again even if a rebuild
     re-derives the same key (e.g. clock jump backward recreating a
     past fire_at). The delivered set is in-memory (ephemeral, per
     §1); across restarts §3.3's missed policy governs instead.
     This is a side effect ledger, not replicated state.

==================================================
9. DEFERRED
==================================================

  - Per-event snooze from the notification (OS action buttons) —
    future contract if the owner wants it; requires an interaction
    surface this contract deliberately avoids.
  - Reminder settings UI (default minutes_before for new events) —
    implemented as a DC-20 settings amendment at implementation
    time, not a separate contract. (All-day day-before reminder
    time is PER-EVENT per D2 — no global setting exists.)
  - Notification content beyond title+time (opt-in fields).
  - Non-Linux delivery specifics (DC-15 packaging scope).

==================================================
10. BINDING DECISIONS
==================================================

D1. Missed-while-not-running policy: show-on-launch with
    missed-marking; discard once the event itself has ended.
    DECIDED by owner (2026-09-01) — recommendation (a) accepted.
D2. All-day events: reminder fires on the DAY BEFORE the event
    (fixed); per event the user ticks it on and picks the exact
    time in the event dialog (not a global Options setting);
    minutes_before offsets measure from the picked moment;
    today-created events fire immediately as missed reminders.
    DECIDED by owner (2026-09-01, corrected: per-event, not
    global).
D3. Reminder representation is RELATIVE minutes_before; absolute
    times always derived locally. DECIDED (DC-07 constraint + §2.2).
D4. Multiple reminders per event allowed. DECIDED (§2.3).
D5. Disabled reminders stored-but-inactive, replicating. DECIDED
    (§2.4).
D6. Notification content: current-state-derived, title + time only;
    no sensitive fields without explicit future opt-in. DECIDED
    (§2.5).
D7. Delivery via OS desktop notification service, fired by the
    DC-13 sidecar scheduler runtime; no new background process.
    DECIDED (§4.1).
D8. Scheduling is a pure rebuild-from-local-DB function triggered
    by the §3.1 trigger list; never scheduled from incoming change
    records. DECIDED (§3.1, §6.4).
D9. Core invariant, verbatim: "Notification delivery is an ephemeral
    local side effect and is not part of Tide's replicated logical
    state." No delivery event ever enters the changelog. DECIDED
    (§1, owner-mandated).
D10. Idempotency via deterministic schedule key +
     replace-before-schedule + in-session delivered-once guard;
     all three properties required testable. DECIDED (§8).
D11. All failure modes degrade DC-16-Tier-1 style: log, keep
     schedule, never crash the sidecar. DECIDED (§7).
D12. Clock jumps and DST: rebuild on discontinuity; bounded missed
     policy; no catch-up storms. DECIDED (§5.5).
