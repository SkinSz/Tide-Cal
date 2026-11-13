# TIDE DESIGN CONTRACT DC-26
# Calendar View Refresh After Sync
Status: APPROVED by project owner (2026-11-14).
        Owner approved P1-P3; quiet period raised from 0.75 s to 1.5 s at
        the owner's request ("0.75s is a little short"). The conflicts
        badge refresh (§3.3) was added in the same approval round.
Depends on: DC-08 (sync session, SessionStats), DC-13 (scheduler-driven
            sessions), DC-19 (manual Sync now), DC-21 §3.2 (stdio event
            channel precedent: id-less NDJSON notifications).
Unblocks:   cross-device use without manual view navigation.
Resolves:   field report 2026-11-14: data from a completed sync is in the
            local database but the open calendar view keeps showing the
            pre-sync state until the user navigates (week/month switch).

==================================================================
1. PURPOSE
==================================================================

Tide is peer-to-peer: a sync session can be started by this device
(Sync now, scheduler) OR by the other peer (inbound responder session).
The calendar view currently re-reads the database only on navigation,
so changes received by sync stay invisible. This contract defines one
signal, "local data changed by sync", from the sidecar through the
shell to the calendar view, and how the view reacts to it.

==================================================================
2. DEFINITIONS
==================================================================

  session          one authenticated sync session (DC-08), any
                   direction, any trigger.
  applied change   a received change the engine applied to the local
                   database (SessionStats.receivedApplied, DC-08).
  data notice      the new id-less stdout line defined in §3.1.
  view             the calendar window's current week/month rendering.
  edit in progress an open appointment editor/dialog in the view.

==================================================================
3. RULES
==================================================================

3.1  SIDECAR EMITS ONE NOTICE PER SESSION THAT CHANGED DATA (PROPOSAL P1)

     All session paths (inbound responder, scheduler, Sync now) end in
     the same engine call (SyncManager.runEngineSession). After it
     returns, and ONLY if stats.receivedApplied > 0:

       stdout.write(JSON.stringify({
         notice: "data_changed", source: "sync",
         applied: stats.receivedApplied }) + "\n")

     - No "id" field: it is not a response, it never consumes a pending
       request slot (DC-21 §3.2 convention, mirrored direction).
     - Emitted after the session's database transaction committed, so a
       reader re-querying after the notice sees the new data.
     - A failed or aborted session emits nothing (whatever it applied
       before failing is picked up by the next notice or navigation).
     - Sessions that only SENT data emit nothing: the local data did not
       change.
     - Contains no titles, ids or device ids (no calendar data in the
       channel, nothing sensitive in logs).

3.2  SHELL FORWARDS NOTICES TO THE WINDOW (PROPOSAL P2)

     The Rust stdout reader currently warns on any line without "id"
     and drops it. New behavior:

       if line has "notice":
           if notice == "data_changed": emit("tide://data-changed",
                                             {applied})
           else: log at debug, ignore   (unknown notices are harmless)
       elif line has no "id": warn and drop (unchanged)

     The reader never blocks on the emit. No allow-list change: notices
     are outbound only and carry no command.

3.3  VIEW REACTS: COALESCED, POSITION-PRESERVING, EDIT-SAFE (PROPOSAL P3)

     on "tide://data-changed":
         mark refresh pending
         (re)start a 1500 ms quiet timer          -- coalesce bursts
     when the timer fires:
         if edit in progress: keep pending; run on editor close
         else: re-read and re-render the CURRENT view
               (same week/month/date, same selection when the selected
                appointment still exists; selection cleared otherwise)
               and refresh the conflicts badge (DC-14): a sync can
               create a conflict the user must see without navigating

     - Never more than one refresh per quiet period, whatever the number
       of notices.
     - Never closes, resets or overwrites an open editor. A change that
       arrives for the appointment being edited is shown after the
       editor closes (conflict handling stays with DC-08; this contract
       only redraws).
     - A refresh is a read; it never writes.

==================================================================
4. WORKED EXAMPLES
==================================================================

  (a) Windows presses Sync now; Linux is responder; Linux applies 2:
      Linux sidecar stdout: {"notice":"data_changed","source":"sync",
      "applied":2} -> Linux shell emits tide://data-changed -> Linux view
      redraws the week it shows 1.5 s later. Windows applied 0 -> no
      notice on Windows, no redraw.
  (b) Scheduler runs 3 sessions within 1 s, each applies 1: three
      notices, ONE redraw.
  (c) User has the editor open on Linux while Windows syncs a change:
      no redraw until the editor closes; then one redraw.

==================================================================
5. TESTABLE REQUIREMENTS
==================================================================

  TR-1  Engine session with receivedApplied = N > 0 writes exactly one
        stdout line {"notice":"data_changed","source":"sync","applied":N}
        and no "id"; N = 0 writes none; a throwing session writes none.
  TR-2  Notice is written after the applying transaction committed
        (test: a reader opened on the same DB at notice time sees rows).
  TR-3  The notice contains no event titles, entity ids or device ids.
  TR-4  Rust reader: a notice line emits tide://data-changed and does not
        log a warning; it never resolves or disturbs a pending request
        (interleaved notice + response test); unknown notice ignored.
  TR-5  View: N notices within the quiet period -> 1 re-render; the
        rendered range (week/month/date) is unchanged by the refresh.
  TR-6  View: refresh pending while the editor is open -> no re-render;
        exactly one re-render after it closes; editor content untouched.
  TR-7  End-to-end (owner, two machines): an appointment created on one
        peer appears on the other's open view after Sync now, with no
        navigation, in both directions.
  TR-8  Conflicts badge count is re-read on every refresh (a session that
        records a DC-14 conflict updates the badge with no navigation).

==================================================================
6. OUT OF SCOPE
==================================================================

  - Refresh of the Devices / options window (pairing state).
  - Change-level diffing or animations; the view simply re-reads.
  - Notices for local edits (the view already re-renders after them).
  - .ics import refresh (separate path, already re-renders).

==================================================================
7. OPEN ITEMS OWNED ELSEWHERE
==================================================================

  - Conflict presentation while editing: DC-08.
  - Sync scheduling cadence: DC-13.

==================================================================
8. BINDING DECISIONS
==================================================================

  DECIDED
    D1  The view refreshes automatically after a sync that changed
        local data (owner, 2026-11-14).
    D2  Coalesce bursts, keep the current position, never interrupt an
        edit, no refresh when nothing changed (owner approved these four
        behaviors, 2026-11-14).

  DECIDED 2026-11-14 (owner approved as proposed)
    P1  Sidecar notice format and emission point (§3.1).
    P2  Shell forwarding as tide://data-changed (§3.2).
    P3  Quiet period 1.5 s (§3.3) -- DECIDED with P1/P2, see Status.

  IMPLEMENTATION-TIME VERIFICATION (not asserted here)
    V1  Confirm that a received change which ends up as a DC-14 conflict
        is counted in receivedApplied. If it is not, the §3.1 condition
        becomes "receivedApplied > 0 OR a conflict was recorded".
