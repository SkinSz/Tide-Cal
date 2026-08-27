# TIDE DESIGN CONTRACT DC-16
# Peer Misbehavior Handling: Detection, Throttling, and
# Blocking of Invalid-Packet Floods
Status: APPROVED by project owner (2026-08-27, v2 as committed).
        Open items resolved with owner go-ahead for implementation:
        D7 = NO auto-escalation of suspend (Level-4 recommendation is
        surfaced on inspection only); O3 = silence on the wire (no
        DC-08 signaling); O4 = minimal read-only Paired Devices list
        in this package, extended later. Thresholds (D6) ship as
        config with the §2.4 values as initial defaults.
Depends on: DC-05 (device identity, pairing); DC-08 (sync message
            protocol); DC-10 (revocation propagation); DC-13 (background
            sync scheduling: debounce_seconds 10, sweep_minutes 10);
            TD-001 (per-record quarantine design); TD-005 (quarantine
            retention); TD-006 (owner directive, this contract's source)
Unblocks: Implementation of TD-006 ONLY after owner approval of this
          draft; no code may be written before sign-off
Resolves: TD-006 (design portion; implementation is a separate
          approved work item)

==================================================
1. PURPOSE AND THREAT STATEMENT
==================================================

TD-001 quarantine semantics make a SINGLE invalid record non-blocking:
it is durably quarantined (quarantineRecord stores {reason,
senderDeviceId, rawRecord} verbatim; applyBatch counts
stats.receivedQuarantined) and the batch proceeds. That is necessary
but NOT sufficient. Nothing currently bounds a peer that repeatedly
sends invalid records.

1.1 Threat model
  - BUGGY PEER (more likely): a device with a schema/format bug, a
    stale version, or a corrupted local database emits large volumes
    of records the receiver rejects. Repeated sync rounds re-send the
    same rejects.
  - MALICIOUS PEER (less likely, must still be bounded): a compromised
    or spoofed device deliberately floods invalid payloads to exhaust
    the receiver.

1.2 Costs of an unbounded flood (per receiver)
  - Storage growth: every UNIQUE invalid packet creates a durable
    quarantine row plus a skip entry (TD-001 semantics); a flood grows
    both without bound until TD-005 retention prunes.
  - Wasted sync rounds: each sync round re-validates, re-rejects, and
    re-records the same garbage; sync cycles between the pair burn
    time and battery with no useful progress.
  - UI noise: the Sync-Errors surface fills with per-record entries,
    drowning out real, actionable errors.

1.3 Principle (owner, TD-006): NOTHING data-destructive or
    pair-ending happens silently or autonomously. This contract's
    entire design is shaped by that rule: local, graduated,
    reversible measures only, with user confirmation required before
    anything permanent.

==================================================
2. DETECTION
==================================================

2.1 Signal (binding in shape, thresholds OPEN — see D-list)
  - Per-PRODUCER bookkeeping keyed by senderDeviceId (from the batch
    envelope; same identity DC-05 attests). Global counters alone are
    rejected: one bad device must not poison the view of good peers.
  - Two metrics per producer over a ROLLING WINDOW:
      (a) invalid COUNT — absolute volume of rejected records;
      (b) invalid RATIO — rejected / total received from that peer
          (so a peer sending 10,000 mostly-valid records is not
          treated like one sending 10,000 all-invalid).
  - Window frame: DC-13's scheduling gives the natural measurement
    frame — sweep_minutes (10) is the default evaluation window, with
    a small number of consecutive windows used to smooth spikes.
    Detection code must NOT assume a fixed sync frequency; it counts
    what actually arrives per window.

2.2 What counts as "invalid"
  - COUNTED: validation-rejections that reach applyBatch's quarantine
    branch — schema/format failures, rejected records, anything that
    increments stats.receivedQuarantined for that sender.
  - NOT COUNTED here: transport and protocol errors (connection
    failures, malformed frames, auth/handshake failures). Those are
    transport-layer conditions tracked separately (counted, surfaced,
    but governed by their own future rules; they do NOT feed this
    ladder). Keeping the two apart prevents a flaky Wi-Fi link from
    looking like a misbehaving peer.

2.3 Durability of bookkeeping (binding)
  - In-memory rolling-window counters: authoritative for DECISIONS.
    Restart resets suspicion; a throttled peer is unthrottled after a
    restart. This is deliberate: memory loss must fail OPEN, never
    fail into a blocked state.
  - A small durable tally (per-producer total invalid count and last-
    seen timestamp, appended at the same time quarantine rows are
    written) is kept ONLY so the UI can show history across restarts
    and so repeated long-term abuse is visible after reboot. The
    durable tally NEVER triggers blocking on its own; it informs,
    thresholds on the live window decide.
  - Rationale: a false durable block that survives restarts is the
    worst failure mode (silent, self-inflicted, hard to notice).
    In-memory decisions keep the blast radius of a bug to one session.

2.4 Thresholds (OWNER DIRECTIVE v2: pick a REASONABLE QUOTA, sized
    for the actual product — a single person's calendar. Legitimate
    volume here is tiny: an active user creates perhaps 5-20 events
    per day; even a busy initial sync of a years-long calendar is
    thousands, not millions, of records, and initial sync is exempt
    from the ladder anyway — see 2.5.)

  TIER 1 — MISBEHAVIOR QUOTA (soft tier, self-clearing ladder as in
  §3, Levels 0-3):
    The quota must be generous enough that NO plausible legitimate
    use case ever trips it, and small enough that accidental bugs
    cannot flood indefinitely:
      - soft ceiling: > 500 invalid records from ONE producer in a
        10-minute window, AND invalid-ratio > 50%.
      - Rationale: 500 is ~25x a heavy user's daily event volume;
        ratio guards against counting a legitimate bulk import that
        hits a format bug. Initial full-state sync (the only
        legitimately large transfer) is exempt: records arriving via
        FULL_STATE_SNAPSHOT do not feed this ladder (they are
        individually quarantined per DC-08 §3.6 without counting).
    Tier 1 escalation is the §3 ladder; every level below 4 remains
    self-clearing (restart clears suspicion, automatic recovery).

  TIER 2 — FLOOD/DDoS PROTECTION (hard tier, NOT self-clearing):
    Threat model (owner, v2): Tide is OPEN SOURCE. An attacker can
    read every constant, every threshold, and every code path, and
    can send bursts at line rate from a compromised paired device.
    Tier-1 windows and soft ceilings therefore cannot be the last
    line of defense — an attacker who knows them simply paces just
    under them forever ("slow-drip"), or bursts far past them.

    Hard trigger (binding): > 5,000 invalid records from one producer
    within ANY rolling 10-minute window — i.e. 10x the soft ceiling —
    triggers an immediate HARD BLOCK of that producer, regardless of
    ratio, regardless of ladder state. 5,000 garbage records between
    two paired devices on a LAN is not a bug scenario; nothing
    legitimate produces that.

    HARD BLOCK PROPERTIES (binding, all differ from Tier 1):
      - NOT self-clearing: survives restart, survives app updates,
        survives the attacker going quiet for weeks. In-memory
        fail-open (2.3) applies ONLY to Tier 1. Rationale (owner):
        a DDoS block must not evaporate because the attacker paused
        or the receiver rebooted — that would let an attacker toggle
        protection off at will.
      - Durable, tamper-evident record: the block state lives in the
        database (hardened_blocks table: producer id, first/last
        trigger timestamps, triggering counts), alongside the
        existing quarantine/skip machinery. It is removed ONLY by
        explicit user action (§4.2) or by unpair/revocation.
      - Intake drops everything from that producer while blocked
        (same receive-side silence as Tier 1 Level 2+, but permanent
        until cleared). Requests FROM the blocked peer are still
        answered — the user's other devices must keep working, and
        data still flows OUT.
      - Bounded storage: while hard-blocked, NOTHING from that
        producer is quarantined, skipped, or listed — intake drop
        happens before validation, so a sustained flood costs a
        constant ~zero storage. The flood cannot outwait the block.
      - Burst resistance: detection evaluates on ARRIVAL, not on
        timer — a line-rate burst of 100k records in 3 seconds hits
        the 5,000 mark mid-burst and intake closes immediately. The
        remaining burst records are dropped at the socket-read loop,
        costing near-zero CPU (no JSON parse, no validation).

  2.5 Exemption (binding): records delivered inside
      FULL_STATE_SNAPSHOT are quarantined per-record if invalid
      (existing DC-08 §3.6 behavior) but do NOT count toward either
      tier. The one legitimate high-volume scenario must never be
      punishable. Snapshot-derived floods are instead bounded by the
      snapshot's own dominance rules — an attacker cannot inject
      snapshots for a producer they do not control.

==================================================
3. ACTION LADDER (graduated, REVERSIBLE)
==================================================

Level 0 — OBSERVE (default): record metrics, quarantine per TD-001,
  surface entries in Sync-Errors as today. No behavior change.

Level 1 — WARN: same as observe, plus a persistent, dismissible UI
  indication that a peer is producing unusual volumes of invalid
  data (see §4). No throttling yet.

Level 2 — THROTTLE: the receiver SUSPENDS ACCEPTING that peer's
  records for a backoff window: incoming batches from that sender
  are dropped at intake (not quarantined — no new quarantine rows,
  no skip entries, no UI entries per packet; a single counter
  "N dropped while throttled" is kept). Requests FROM the peer are
  still answered normally: throttling is receive-side only, so the
  peer's own view of the pair is undisturbed and it can still pull
  valid data. Backoff is exponential with a cap and resets to the
  lowest level on a window with no invalid records. Fully automatic
  recovery: if the peer's input returns to normal, throttle lifts
  itself with no user action.

Level 3 — SUSPEND: after sustained throttle-level behavior, stop
  processing that peer's sync contribution entirely for that session
  (receive-side; transport still works). Reversible: re-evaluated each
  session; a restart clears it (per 2.3). Suspend still answers
  requests — data flows OUT, invalid data does not flow IN.

Level 4 — RECOMMEND UNPAIR: the ladder NEVER executes an unpair. At
  sustained Level 3, the UI recommends unpairing and links into the
  EXISTING DC-10 revocation flow. Only the user, with explicit
  confirmation, performs revocation. NO new unpair mechanism is
  created.

3.1 Binding properties of the ladder
  - Every level below 4 is LOCAL and REVERSIBLE: clearing is
    automatic on recovery, on restart, or by one manual action (§4).
  - Escalation is gradual (never skip more than one level without a
    sustained signal); de-escalation is always faster than
    escalation.
  - Nothing in this contract changes what is SENT on the wire. The
    throttled/suspended peer is never notified, challenged, or
    signaled. ANY peer-notification or throttle-signaling would be a
    DC-08 wire-protocol extension — explicitly LEFT OPEN for the
    owner (D-list O3) and NOT designed here. Silence is also the
    safer default against a malicious peer.

==================================================
4. USER VISIBILITY AND RECOVERY
==================================================

4.0 PAIRED DEVICES MENU (owner directive v2, binding; extends this
  contract beyond misbehavior handling):
  A "Paired Devices" management surface is REQUIRED regardless of
  misbehavior handling — the product currently has no place where a
  user can see and manage the devices paired with this one (DC-05
  defined pairing but no management UI). DC-16 requires it as the
  home of block state:
    - List of all paired devices: identity id, user-settable display
      name, paired-since, last-seen, last-sync summary.
    - Per-device: current Tier-1 ladder level (if any) and Tier-2
      hard-block state (if any), with reason and timestamp.
    - Per-device actions: "Reset peer state" (Tier 1, one click),
      "Unblock" (Tier 2 hard block — see 4.2), "Unpair" (routes into
      the existing DC-10 revocation flow, with its own confirmation).
  Implementation note for scoping: this menu is a DC-05/pairing
  work item that DC-16 DEPENDS ON for Tier-2 visibility; the
  misbehavior state (levels, blocks) plugs into it as data. If the
  Paired Devices menu is built as part of this contract's
  implementation, scope both together; otherwise build a minimal
  read-only device list first and extend. Exact split is an
  implementation-planning decision, not a protocol one.

4.1 Visibility (binding)
  - The Sync-Errors surface gains a per-peer state badge (extended
    dialog/badge, not a new screen): peer name/id, current ladder
    level, invalid count/ratio in the current window, dropped-while-
    throttled counter, and a history link backed by the durable tally
    (2.3).
  - Levels 1-4 are all visible; Level 0 adds nothing (no noise for
    healthy peers).
  - During Level 2/3 the flood contributes AT MOST one aggregated UI
    line — never one entry per rejected record.

4.2 Recovery (binding)
  - Tier 1: manual override ALWAYS available at every level —
    "Reset peer state" clears all bookkeeping for that producer and
    returns it to Level 0 immediately. One click, no confirmation
    gauntlet, no restart needed. Automatic recovery on normal input
    or restart also applies (self-clearing by design).
  - Tier 2 (HARD BLOCK): deliberately NOT self-clearing (owner
    directive). Clearing requires EXPLICIT user action through the
    Paired Devices menu (4.0): an "Unblock" action with a
    two-step confirmation that states why the device was blocked,
    when, and warning that unblocking re-exposes the receiver to
    the flood that triggered it. Unblocking clears the hardened_
    blocks row and returns the peer to Tier-1 Level 0 observation.
    Alternative permanent resolution: Unpair via DC-10.
    Rationale: a self-clearing DDoS block lets an attacker simply
    wait out a restart; a user-cleared block cannot be outwaited.
  - NO autonomous permanent action beyond the hard block itself:
    the system never deletes pair state, never revokes, never wipes
    data, and never ends a pairing without EXPLICIT user
    confirmation through the existing DC-10 flow. Owner principle:
    nothing data-destructive or pair-ending happens silently.

==================================================
5. INTERPLAY WITH EXISTING CONTRACTS
==================================================

5.1 TD-001 (per-record quarantine): unchanged and still the first
    line of defense. The ladder sits ABOVE per-record handling: it
    never alters what happens to a single record, only whether more
    of that producer's input is accepted at all. While throttled, new
    quarantine rows for that peer are NOT created (intake is dropped
    before validation).

5.2 TD-005 (quarantine retention): a flood can fill quarantine up to
    the retention cap; TD-005 pruning proceeds normally. Throttling
    exists precisely to stop the flood from outpacing retention. The
    durable per-producer tally (2.3) is NOT part of quarantine
    storage and is not pruned with it (tiny, bounded: one row per
    paired producer).

5.3 DC-05 (identity/pairing): the ladder keys strictly on paired
    identities (senderDeviceId). Records from unknown/unpaired
    senders are rejected by pairing rules BEFORE this ladder ever
    sees them; misbehavior handling applies only to accepted,
    paired peers.

5.4 DC-10 (revocation propagation): the ONLY path out of the ladder
    toward ending a relationship. Level 4 recommends; DC-10 executes,
    with its existing propagation and confirmation semantics. No new
    unpair mechanism (D4).

5.5 DC-13 (scheduling): sweep_minutes (10) is the evaluation window
    frame; debounce_seconds (10) bounds how quickly a throttle
    decision can take effect after a batch lands. Detection runs
    inside the existing background cycle — no new timers or wakeups.

5.6 DC-08 (protocol): untouched. This contract is entirely
    receive-side behavior over existing messages. Any signaling
    extension is out of scope (O3).

==================================================
6. EXPLICITLY DEFERRED (with trigger conditions)
==================================================

6.1 Cross-device reputation sharing: deferred. TRIGGER: more than one
    receiver independently flagging the same producer, or a fleet
    deployment with a shared trust domain. Until then every device
    judges its own inputs only.
6.2 Crypto/auth-layer responses (key rotation, proof-of-work
    challenges, re-auth on suspicion): deferred. TRIGGER: evidence
    that invalid packets stem from an authentication weakness rather
    than payload validation. Would require DC-05/DC-08 changes.
6.3 Automatic global blocklists (pre-shared or synced "bad device"
    lists): deferred indefinitely by default — contradicts the
    nothing-silent principle and risks coordinated false positives.
    TRIGGER: explicit owner request plus a revocation-style
    propagation design of its own.
6.4 Any of the above would be a NEW design contract, not an edit to
    this one.

==================================================
7. SUMMARY OF BINDING DECISIONS (for review)
==================================================

  D1  Detection bookkeeping exists locally: per-producer (keyed by
      senderDeviceId) invalid count AND invalid-ratio over a rolling
      window framed by DC-13 sweep_minutes; validation-rejections
      (stats.receivedQuarantined) feed it; transport/protocol errors
      do NOT. DECIDED.
  D2  TIERED STATE (v2): Tier-1 (misbehavior) decision state is
      in-memory and fails OPEN — restart clears suspicion. Tier-2
      (flood/DDoS) HARD BLOCK is DURABLE in the database and NOT
      self-clearing: it survives restart and quiet periods, and is
      removed ONLY by explicit user Unblock (Paired Devices menu,
      two-step confirmation) or by unpair/revocation. DECIDED
      (owner directive).
  D3  The action ladder is graduated and REVERSIBLE: observe/warn ->
      throttle (drop intake for a backoff window, requests still
      answered) -> suspend (session-scoped) -> recommend unpair via
      the EXISTING DC-10 revocation flow. No new unpair mechanism;
      no autonomous pair-ending or destructive action ever. The
      Tier-2 hard block sits ABOVE the ladder: exceeding the hard
      quota (> 5,000 invalid from one producer in any 10-min window)
      jumps directly to hard block from any level. DECIDED.
  D4  Ladder and blocks are strictly receive-side and silent: nothing
      new is sent on the wire; the peer is never notified or signaled.
      Any signaling is a DC-08 extension, out of scope here (O3).
      DECIDED (silence).
  D5  User visibility: per-peer state badge/dialog in Sync-Errors
      (level, metrics, drop counter, history); flood yields at most
      one aggregated UI line while throttled. PLUS (v2, owner): a
      Paired Devices menu — required regardless — listing all paired
      devices with display names, pairing metadata, ladder level,
      hard-block state, and per-device actions (Reset / Unblock with
      confirmation / Unpair via DC-10). DECIDED.
  D6  QUOTAS DECIDED (v2, owner): sized for a single-person calendar.
      Tier 1 soft ceiling: > 500 invalid from one producer in a
      10-min window AND ratio > 50%. Tier 2 hard trigger: > 5,000
      invalid from one producer in any rolling 10-min window,
      ratio-independent. Initial FULL_STATE_SNAPSHOT sync is exempt
      from both tiers (per-record quarantine only). Numbers ship as
      config; changing them later is a config change, not a contract
      change. DECIDED.
  D7  Whether Level 3 (suspend) auto-escalates to a Level-4
      recommendation after a time bound, or only ever surfaces the
      recommendation on user inspection, is OPEN for the owner.
  O3  Peer-notification/throttle-signaling on the wire (DC-08
      extension): OPEN — explicitly not designed here; silence is
      the default until the owner decides otherwise.
  O4  Implementation split of the Paired Devices menu (build with
      DC-16 vs. minimal list first): implementation-planning
      decision, OPEN at approval.