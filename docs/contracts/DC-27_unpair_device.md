# TIDE DESIGN CONTRACT DC-27
# Unpair a Device (User Flow and Product Wiring of Revocation)
Status: APPROVED by project owner (2026-11-14).
        Owner approved P1-P12 as recommended ("all recommended").
AMENDED by project owner (2026-11-14). See Appendix A; supersedes
        §4.8 ("NOT told why") for the pairing ceremony only.
Depends on: Architecture Spec v0.3 §17, §18, §19, §25; DC-05 §2.2, §3.3,
            §7.1-§7.3; DC-06 §2.6; DC-07 T5/T6; DC-08 §2.2, §3.7, TR-7;
            DC-10 §2.1-§2.5, §3, E1-E3; DC-13 (Sync now fan-out);
            DC-16 §4.0, §4.2, §5.4, D3; DC-21 D3/D6; DC-25 §2, §4.2
Unblocks:   the "Unpair" action in the Paired Devices list (today a
            disabled placeholder); re-pairing a removed device under a
            new identity; DC-16 Level 4 ("recommend unpair") becoming
            actionable.
Resolves:   DC-10 §7 out-of-scope item "UI for revoking and re-pairing
            flows"; DC-16 §4.0 "Unpair (routes into the existing DC-10
            revocation flow, with its own confirmation)".

==================================================================
1. PURPOSE
==================================================================

Tide is peer-to-peer: every installation is an equal peer, and trust
is a local list of peers each device keeps for itself (DC-05 §3). The
revocation machinery (signed record, verification, gossip, ACKs) is
specified (DC-05 §7, DC-10) and exists as tested library code, but no
user can trigger it and the product does not enforce it. This contract
defines:

  - the user flow: where Unpair lives, the confirmation, the wording;
  - the local effect on this device: what changes, what is kept;
  - the product wiring that makes an unpair actually stop sync on this
    device and on the user's other devices (DC-10 propagation, DC-05
    §3.3 enforcement on every session path);
  - what the removed device sees, and what the user does on it;
  - the path to pair a removed device again.

It creates NO new unpair mechanism (DC-16 D3/§5.4): Unpair IS a DC-05
§7.1 revocation, propagated by DC-10.

==================================================================
2. CURRENT STATE (SOURCE READING, branch windows @ 94ab8d5 + dirty tree)
==================================================================

Labels: OBSERVED = read in source; INFERRED = follows from what was
read but not executed. Nothing in this section was proven at runtime.
Other work was editing the tree while this was read (e.g.
conflicts_ui.ts); code is cited by function name, not line number.

  S1  OBSERVED. src/security/revocation.ts provides createRevocation,
      verifyRevocation, acceptRevocation, RevocationQueue and a
      unit-level canSynchronize. Its header states "Pure logic - no DB
      wiring". RevocationQueue keeps per-peer ACKs in memory only.
  S2  OBSERVED. src/sync/sync_engine.ts sends and handles
      REVOCATION_RECORDS / REVOCATIONS_ACK only when the optional
      deps.revocations (RevocationChannel) is supplied. No production
      code supplies one: SyncManager.runEngineSession builds the
      engine with db, selfDeviceId, mutateEntity and misbehavior only.
  S3  OBSERVED. Nothing in src/ writes revocation_records or sets
      peers.status = 'revoked'. No RPC op exists for unpair.
  S4  OBSERVED (blocking gap). The DC-05 §3.3 gate is not applied on
      two of the three session paths:
        - inbound responder sessions (SyncManager.onInbound) call
          runEngineSession(session) with no expected peer;
        - the "sync_now" op (host, port) calls runEngineSession(session)
          with no expected peer;
        - only the scheduler path passes expectedDeviceId, and only
          that path checks the remote static key against a TRUSTED
          peers row before runSession.
      canSynchronize has no production caller. INFERRED consequence:
      setting peers.status = 'revoked' alone would stop this device
      from DIALING the removed peer (the dial list uses trusted rows
      only), but the removed peer could still dial IN and complete a
      full sync session. The same gap also admits never-paired keys
      on the inbound path (DC-05 Case A/C). To be proven by a test
      (V1) before any fix.
  S5  OBSERVED. On inbound and sync_now sessions the peer id is
      resolved only AFTER the session (resolveDeviceIdByRemoteKey, for
      endpoint recording). The engine therefore runs with
      peerDeviceId undefined; its revocation hooks would key every
      peer as "unknown".
  S6  OBSERVED. DC-05 §7.3 second bullet (reject change records whose
      producer is locally known-revoked) and DC-08 §3.7 / TR-7
      (mid-session cutoff) have no implementation in sync_engine.ts.
  S7  OBSERVED. The implementation's REVOCATION_RECORDS shape is
      { records: [{ record, signature_hex }] }; DC-08 §3.7 specifies
      { revocations: [{ record, signature (base64) }] }. Both ends run
      the same code today, so they interoperate, but the code does not
      match the approved wire contract (owned by DC-08, §9 below).
  S8  OBSERVED. pairing_manager.ts sqlPeerStore.store() upserts with
      "ON CONFLICT(device_id) DO UPDATE SET ... status = 'trusted'".
      peers.device_id is the PRIMARY KEY. A ceremony with a revoked
      device id would silently flip it back to trusted, and no
      "retained revoked entry" (DC-10 E3) can exist next to a fresh one.
  S9  OBSERVED. Key custody: the identity key is a 0600 file
      (device_identity.key) loaded by the Node sidecar
      (sync_runtime.ts loadOrCreateIdentity); the sidecar already holds
      the private key in memory for Noise. DC-25 (OS keystore) is
      approved but its trigger (DC-25 §3) is not met; under DC-25 §4.2
      the sidecar keeps receiving key material over stdio.
  S10 OBSERVED. The Noise static key is derived from the Ed25519
      identity key (noiseStaticsFromIdentity), and device_id =
      "d-" + hex(SHA-256(public key)) (DC-05 §2.2). INFERRED: a device
      that keeps its device_id keeps its handshake keys. DC-10 E3's
      phrase "same device_id, new handshake keys per ceremony" cannot
      hold under DC-05 §2.2; see §3.13 and §10 OPEN O1.
  S11 OBSERVED. frontend/paired_devices.ts renders "Unpair" as a
      disabled button per paired device. The Unblock action there is
      the in-repo two-step confirmation precedent (DC-16 §4.2:
      click 1 arms and shows the warning, click 2 executes, any
      re-render disarms). The server-side precedent for a confirmed
      destructive op is delete_quarantine, which refuses without
      { confirm: true } (TD-005). DC-15 §3.5 does not define a
      two-step confirmation; it requires a typed or checkbox
      confirmation for the data-destroying "Remove everything".

==================================================================
3. DEFINITIONS
==================================================================

  this device      the installation where the user presses Unpair.
  removed device   the peer being unpaired (status becomes 'revoked').
  other peers      every peer this device still trusts after the
                   unpair.
  record           one signed revocation record (DC-05 §7.1), key =
                   triple (revoked_device_id, revoked_at_hlc,
                   revoked_by_device_id) (DC-10 §2.5).
  gate             DC-05 §3.3 canSynchronize, evaluated against the
                   persisted trust store with the handshake's remote
                   static key, BEFORE any sync message is exchanged.
  told             a peer has ACKed the record (DC-10 §3).
  short id         the project's shortened device id used in UI and
                   logs (today truncatedDeviceId: first 16 characters
                   + "..."; DC-28 may redefine it; this contract uses
                   whatever form is current).
  fresh start      an installation that begins with a NEW identity
                   key (new device_id) and an EMPTY database
                   (Spec §25: new keypair, empty sync knowledge,
                   pair again).

==================================================================
4. RULES
==================================================================

4.1  ENTRY POINT AND WORDING (PROPOSAL P1)

     The "Unpair..." button in each Paired Devices row (DC-16 §4.0)
     becomes active. Nothing else in the product unpairs. DC-16
     Level 4 ("recommend unpair") links to this same button.

     Step-1 panel text (inline in the row, no native dialog):

       Unpair <label>?
       - <label> will stop syncing with this device and with your
         other paired devices.
       - Appointments already received from <label> stay here.
       - Changes made on <label> that have not synced yet will not
         arrive. If <label> is reachable, press Sync now first.
       - This cannot be undone. To use <label> with Tide again, it
         must start fresh and be paired again.
       [Cancel]  [Unpair <label>]

     <label> is the row's existing display label (DC-28 governs
     names; until then the current label). Text is set with
     textContent only.

4.2  CONFIRMATION (PROPOSAL P2; DC-16 §4.2 precedent)

     UI:  idle --click "Unpair..."--> confirm (panel shown)
          confirm --click "Unpair <label>"--> execute
          any re-render / Cancel / other row action --> idle
     RPC: sync_op("unpair_device", { device_id, confirm: true }).
          The sidecar REFUSES without confirm === true (TD-005
          delete_quarantine precedent), so no code path can unpair on
          a single call by accident.
     No typed confirmation: unpair is irreversible but destroys no
     calendar data (§4.4); the typed/checkbox safeguard of DC-15 §3.5
     stays reserved for data deletion ("Remove everything", §4.13
     fresh start).

4.3  LOCAL UNPAIR TRANSACTION (DC-05 §7.1, DC-07 T5)

     unpair_device(device_id, confirm):
       require confirm == true                else ERR_CONFIRM
       row = peers[device_id]
       if row absent:                         ERR_NOT_PAIRED
       if row.status == 'revoked':            return {already: true}
       hlc    = local HLC now                       -- V3
       cutoff = applied_upto[device_id] (0 if none) -- §4.14, P12 a)
       signed = createRevocation({ revoked_device_id: device_id,
                                   revoked_by_device_id: self,
                                   revoked_at_hlc: hlc,    -- no reason
                                   revoked_after_seq: cutoff }, -- P12
                                 identity private key)   -- §4.10
       BEGIN TRANSACTION                            -- DC-07 T5
         UPDATE peers SET status='revoked',
                last_endpoint_host=NULL, last_endpoint_port=NULL,
                last_endpoint_seen=NULL WHERE device_id=?
         INSERT revocation_records(..., verification_state='valid',
                record_bytes=canonicalRevocationBytes(record),
                signature, received_at_hlc=hlc)
         DELETE FROM hard_blocks        WHERE producer_device_id=?
         DELETE FROM peer_invalid_tally WHERE producer_device_id=?
         DELETE FROM pending_changes    WHERE device_id=?
                AND local_seq > cutoff                    -- P3, §4.14
       COMMIT                         -- any failure: ROLLBACK, no
                                      -- partial trust mutation
       misbehavior.forget(device_id)  -- Tier-1 in-memory (DC-16 §2.3)
       end any live session with device_id            -- DC-08 §3.7
       urgentPush()                                   -- §4.6
       return { ok: true, already: false, triple, peers_to_tell: N }

     - The record carries NO "reason" (P4): free text would be
       gossiped to every peer and kept forever (DC-10 §2.4 TTL-free).
     - Only records with verification_state 'valid' are ever stored
       (DC-10 TRP-3: invalid records are never stored).

4.4  WHAT IS KEPT, WHAT IS REMOVED (PROPOSAL P3)

     KEPT on this device:
       - all calendar data, including events, series, reminders and
         tombstones that the removed device produced earlier (they
         were applied under trust that was valid at the time; the
         Spec has no rule to un-apply them, DC-05 §7.3 rejects only
         ARRIVING records);
       - the changes log, device_clock, applied_upto entries for the
         removed producer (sync knowledge other peers still rely on);
       - unresolved conflicts that involve the removed device; the
         user can still resolve them (a resolution is a new local
         change, DC-14);
       - quarantine rows whose sender was the removed device (history;
         TD-005 retention applies unchanged);
       - the peers row itself, status 'revoked' (audit trail, DC-10
         E3; its public key verifies records it signed earlier).
     REMOVED / CLEARED:
       - last-known endpoint columns (no reason to keep network data
         for a peer that will never be dialed again, DC-21 §4);
       - hard_blocks and peer_invalid_tally rows (DC-16 §2.4: "removed
         ... by unpair/revocation"); Tier-1 in-memory state;
       - pending_changes rows produced by the removed device with a
         seq above the record's cutoff (§4.14): buffered, not yet
         applied, and not allowed to apply after revocation.
     NOT TOUCHED: anything on the removed device itself.

4.5  ENFORCEMENT ON EVERY SESSION PATH (DC-05 §3.3/§7.3, DC-08 §3.7;
     approved behavior, implementation missing per S4-S6)

     For inbound, Sync now and scheduler sessions alike, after the
     Noise handshake and BEFORE runSession:

       peerId = resolveDeviceIdByRemoteKey(remoteStaticKey) over ALL
                peers rows (trusted and revoked)
       decision = canSynchronize(trustStore, peerId, claimedKey)
       if decision != ALLOW:
           close the connection; send nothing; write nothing
           log once at info: "sync refused: <decision> <short id>"
           (unknown keys: "sync refused: DENY_UNPAIRED", no id)
       else:
           createSyncEngine({ ..., peerDeviceId: peerId,
                              revocations: dbRevocationChannel })

     Plus, inside the engine:
       - a change record whose producer is locally 'revoked' is
         handled per §4.14 (P12); a rejected record is dropped without
         a quarantine row and without blocking other producers'
         streams (V5);
       - a VALID record naming the current peer ends the session
         (DC-08 §3.7, TR-7).

     This contract does not change those rules; it makes them a
     precondition: Unpair MUST NOT ship before the gate is wired on
     all three paths, or the button would claim an effect that does
     not happen (S4).

4.6  PROPAGATION (DC-10 §2.2, §2.3, §2.5, §3)

     - dbRevocationChannel implements RevocationChannel over
       revocation_records (record store) and the ACK store (P5):
         queueFor(peer)     = valid records minus ACKed by peer, minus
                              records naming peer (DC-10 §2.1);
         acceptInbound(...) = verifyRevocation against the persisted
                              trust store; on valid: one transaction
                              inserting the record AND flipping
                              peers.status for revoked_device_id if it
                              is a known peer (DC-07 T6); invalid:
                              dropped, logged as a security event;
         acceptedTriples()  = all stored valid triples;
         recordAck(...)     = ACK store upsert.
     - Urgent push (DC-10 §2.3): right after the transaction commits,
       this device starts one session to every other peer it can
       reach, using the existing Sync now fan-out (DC-13 manual
       trigger semantics: immediate, not debounced, ignores backoff).
       Unreachable peers get the record in their next ordinary
       session (§4.7).
     - Relays forward on their normal schedule only (DC-10 §2.2).

4.7  OFFLINE PEERS (DC-10 E2)

     A peer that is offline at unpair time is told in its first
     session with ANY device that holds the record. Until then it may
     still sync with the removed device (accepted v1 limitation,
     Spec §19). The "Removed devices" view (§4.11) shows such a peer
     as "waiting". Nothing times out (DC-10 §2.4).

4.8  WHAT THE REMOVED DEVICE SEES

     DC-10 §2.1 does not queue a record to the device it names, and
     DC-16 D4 keeps refusals silent on the wire. The removed device
     is therefore NOT told why. It sees its syncs with this device
     (and, once told, with the other peers) fail right after the
     handshake: the TCP connection and the Noise handshake succeed,
     then the connection is closed with no sync message. That is
     locally distinguishable from "unreachable" (no TCP connect or no
     handshake), which is what P6 relies on (V8); it is NOT an
     explanation. Telling it explicitly would be a DC-08 extension:
     OPEN O2, not designed here.

     What the user does on the removed device:
       (a) to retire it: nothing is required; uninstall if wanted
           (DC-15 / DC-24: data is kept unless removed explicitly);
       (b) to pair it again: fresh start (§4.13), then pair.
     Pressing Unpair on the removed device for the remaining peers is
     allowed but NOT recommended; see §4.9.

4.9  UNPAIRING FROM THE OTHER SIDE (DC-10 E1)

     The same button works on both sides; each side signs its own
     record. Mutual revocation is valid and terminal (DC-10 E1).

     Hazard (INFERRED from DC-10 E1 + §2.4): with three devices L, W,
     P, the user unpairs W on L, then unpairs L on W. If P has not
     yet learned "L revoked W", W can still sync with P and deliver
     "W revoked L"; P accepts it (W is still trusted on P at arrival)
     and stops syncing with L too. That is DC-10 working as designed,
     but not what the user wanted. Mitigations in this contract:
       - the Step-1 text says the effect reaches "your other paired
         devices" (§4.1);
       - §4.8 recommends fresh start, not Unpair, on the removed
         device;
       - (PROPOSAL P6) when this device's last session attempts with
         a peer were refused at connection time, the Unpair panel for
         THAT peer adds one line: "<label> may already have unpaired
         this device. Unpairing it here also removes it from devices
         this one can still reach." Information only, no blocking.

4.10 KEY CUSTODY (PROPOSAL P7)

     The record is signed in the sidecar with the identity key it
     already holds for Noise (S9). No new key material, no new
     storage, no key leaves the process. When DC-25 lands, the key
     arrives over stdio (DC-25 §4.2) and this call site is unchanged.
     Note: DC-05 §2.1 places key operations in the Rust layer; the
     sidecar already deviates for Noise (DC-25 §2 records this), and
     signing here extends the same accepted interim. Moving signing
     to the shell is DC-25 territory, not this contract.

4.11 FAILURE VISIBILITY (PROPOSAL P8)

     - The local step either fully succeeds or changes nothing (§4.3);
       a failure shows inline in the row: "Unpair failed: <reason>.
       Nothing was changed."
     - After success the row leaves the Paired Devices list (the list
       shows trusted rows only) and a "Removed devices" section below
       it shows each revoked peer once:
         <label>  removed <date>
         Other devices told: Phone - done; Tablet - waiting
       "told" = ACK received (DC-10 §3). With no other peers: "No
       other devices to tell." The section has no actions (no
       un-revoke exists, DC-05 §7.2).
     - A refused session (§4.5) is logged and counts as a failed sync
       for the existing sync-status surfaces; it is never written to
       Sync Errors (quarantine is for records, not sessions).

4.12 LOGGING (PROPOSAL P9)

     One info line per event, short id only, no names:
       unpair: <short id> revoked; record stored; telling <N> peers
       unpair: <short id> already revoked; no-op
       revocation: accepted record for <short id> from <short id>
       revocation: rejected record (<reason code>) from <short id>
       sync refused: <DENY_*> <short id>
     NEVER logged: private or public keys, signatures, record bytes,
     display names, IP addresses above debug level (DC-21 §7). Existing
     full-id log lines elsewhere (e.g. the shell's "manual sync_now:
     peer <device_id> ...") are outside this contract.

4.13 RE-PAIR PATHS (PROPOSAL P10, P11; owner intent: re-pair the
     removed Windows PC with a fresh key)

     Path A - same identity, same device id (DC-10 E3 as written).
       Blocked by S8 and S10: the PK upsert would silently un-revoke,
       the old handshake keys come back unchanged, and this device's
       own record keeps propagating and revoking the device elsewhere.
       P10: in v1, a pairing ceremony whose remote device_id is
       'revoked' on this device is REFUSED before trust is stored:
         "This device was unpaired earlier. To pair it again, start
          it fresh first."
       This narrows DC-10 E3 and needs a DC-10 amendment (OPEN O1).

     Path B - fresh start of the removed device (RECOMMENDED).
       The removed device gets a NEW key, hence a NEW device_id
       (DC-05 §2.2), and an empty database; it pairs like a new
       device; its first syncs bring over what the remaining peers
       hold (incremental or full-state per the DC-09 triggers, V9).
       Its old, revoked id stays revoked everywhere, harmlessly.
       PRECONDITION: data the OLD id authored is only carried over if
       §4.14 does not reject it; under a literal DC-05 §7.3 reading
       it would be refused on the fresh device (§4.14 hazard).
       User steps (two devices, Linux "L" keeps, Windows "W" returns):
         1. On W, if anything was created there after the unpair and
            should be kept: Export .ics (DC-18).
         2. Quit Tide on W (tray: Quit).
         3. Rename W's Tide data folder (do not delete it; it is the
            only copy of W's old database and key) - V6.
         4. Start Tide on W: it creates a new identity and an empty
            calendar.
         5. Pair W with L (Devices & sync). Sync.
         6. If step 1 exported something: Import .ics on W (DC-23);
            entries that already came back by sync must not be
            duplicated (V10).
       P11: v1 ships Path B as the documented procedure above; an
       in-app "Start fresh" action is deferred (§8, trigger T1).

     Path C - keep W's database, new key only (in-place identity
       reset). No mechanism exists; DC-25 excludes key rotation; it
       would need rules for re-attributing W's existing data (Spec
       §25 backup/restore mechanics, no contract). OUT OF SCOPE.

4.14 HISTORY AUTHORED BY THE REMOVED DEVICE (PROPOSAL P12;
     interpretation of DC-05 §7.3 - OPEN O7)

     DC-05 §7.3 says: "Change records whose producing device_id is
     locally known-revoked are rejected on arrival." Read literally,
     this rejects ALL records the removed device ever authored,
     including old, legitimate history relayed later. INFERRED
     hazard (from DC-10 §2.1/§2.2: the revocation queue is pushed at
     session start, before data):
       - a fresh-started W (Path B) learns "L revoked old-W" in its
         first session and then rejects every appointment old-W
         created, although L still holds and shows them;
       - any device paired later (a new phone) has the same gap;
       - the mesh diverges: old devices show the data, new ones don't.
     This contradicts §4.4 ("data stays") and Path B.

     Options:
       a) Cutoff in the record [RECOMMENDED]: the revoker adds
          "revoked_after_seq" = the highest seq of the removed device
          it has applied (applied_upto) at revocation time. Records
          with seq <= cutoff are legitimate history and are accepted
          everywhere; seq > cutoff are rejected. Needs a DC-05 §7.1
          amendment (new signed field; older builds would fail to
          verify such records, V11). With several revokers, a device
          uses the HIGHEST cutoff it holds (more history kept; a
          revoker only signs what it already accepted itself).
       b) No producer rejection in v1: rely on the session gate
          (§4.5) and gossip only. Simple; leaves the Spec §19 window
          for records relayed by unaware peers.
       c) Literal DC-05 §7.3: reject all. Not recommended (hazard
          above).
     Until O7 is decided, TR-8 and TR-12 below are written for a).

4.15 IDEMPOTENCE (DC-10 §2.4, INVARIANT 14)

     - Unpair of an already revoked peer: success, {already: true},
       no new record, no push.
     - Double click / repeated RPC: the second call sees 'revoked' and
       is a no-op (the status check and the transaction run under the
       sidecar's single-threaded dispatcher - V4).
     - Two devices unpairing the same peer: two valid records with
       different triples; both propagate; result identical.
     - Receiving a record already stored: no-op, ACK sent (DC-10 §2.4).

==================================================================
5. THREAT MODEL (open source: the attacker reads this code)
==================================================================

  T-a  Removed device keeps dialing in. Without §4.5 it syncs
       freely (S4). With §4.5 it is refused after the handshake,
       before any message; cost to us = one handshake per attempt,
       same as any unpaired key today.
  T-b  Removed device forges a record revoking others. Rejected:
       a revoked signer is not trusted (DC-05 §7.2) on any device
       that has learned the revocation. Before that, see T-d.
  T-c  Removed device restores itself. Impossible: transitions over
       the mesh are trusted -> revoked only (DC-05 §7.2); P10 also
       blocks the local ceremony path.
  T-d  Gossip window. A peer that has not learned the record still
       trusts the removed device (Spec §19 accepted limitation);
       urgent push bounds it for reachable direct peers (DC-10 §2.3).
  T-e  Stolen device. Unpair from any remaining device; the thief's
       copy holds the data already synced to it - unpair cannot
       recall data (no remote wipe in v1; Spec has none).
  T-f  Record flood from a trusted-but-buggy peer: store-once by
       triple, records are tiny; DC-16 ladder applies to change
       records only; no new limit proposed (records are rare and
       signature-verified).

  All protections here are DURABLE (database rows), never
  self-clearing; nothing in this contract is in-memory except the
  Tier-1 state that unpair clears.

==================================================================
6. WORKED EXAMPLES
==================================================================

  (a) RPC, first call without confirm:
      -> {"op":"unpair_device","args":{"device_id":"d-7178...a859"}}
      <- {"error":"ERR_CONFIRM: confirm:true required"}

  (b) RPC, confirmed:
      -> {"op":"unpair_device",
          "args":{"device_id":"d-7178...a859","confirm":true}}
      <- {"ok":true,"already":false,
          "triple":{"revoked_device_id":"d-7178...a859",
                    "revoked_at_hlc":1763140000000,
                    "revoked_by_device_id":"d-2ee2...c62f"},
          "peers_to_tell":1}

  (c) Stored record body (canonical bytes, keys sorted, no reason;
      "revoked_after_seq" only if P12 a) and O7 are approved):
      {"revoked_after_seq":412,"revoked_at_hlc":1763140000000,
       "revoked_by_device_id":"d-2ee2...c62f",
       "revoked_device_id":"d-7178...a859","v":1}

  (d) Removed-devices listing (new read op, P8):
      <- {"removed":[{"device_id":"d-7178...a859",
                      "label":"Windows PC",
                      "removed_at":1763140000000,
                      "told":[{"device_id":"d-91ab...","done":true},
                              {"device_id":"d-03cd...","done":false}]}]}

  (e) Three devices L, W, P all online; user unpairs W on L:
      L commits, pushes to P; P accepts, ACKs, refuses W from its
      next attempt. W's next sync with L and with P fails at
      connection time. L's Removed devices: "P - done".

  (f) Same, P offline: L shows "P - waiting". W may sync with P
      until P next talks to L (or to any device holding the record).

  (g) Re-pair W (Path B): W renames its data folder and restarts as
      d-55e0...; L pairs with d-55e0...; W's first sessions bring
      L's data, including events old-W authored (P12 a);
      L's peers table holds d-7178... 'revoked' and d-55e0...
      'trusted'. Pairing L with the OLD W id would be refused (P10).

==================================================================
7. TESTABLE REQUIREMENTS
==================================================================

  TR-1  Gate, all paths: after unpairing W on L, (a) W dialing L
        inbound, (b) L's sync_now to W's endpoint, (c) the scheduler
        path, each end after the handshake with zero sync messages
        and zero DB writes on L. A never-paired key gets the same
        result on the inbound path. (DC-05 §3.3, Case A/C)
  TR-2  Atomicity: fault injection inside the §4.3 transaction
        leaves peers, revocation_records, hard_blocks,
        peer_invalid_tally and pending_changes byte-identical to
        before. (DC-07 T5)
  TR-3  Record validity: the stored record verifies with
        verifyRevocation on a third device that trusts L; it has no
        "reason" key. (DC-05 §7.1/§7.2)
  TR-4  Confirmation: unpair_device without confirm:true fails and
        changes nothing; the UI state machine needs two clicks and
        any re-render returns it to idle. (DC-16 §4.2 pattern)
  TR-5  Idempotence: a second unpair returns {already:true}, adds no
        record, starts no push. (INVARIANT 14)
  TR-6  Propagation (three-instance harness): with P online, P
        refuses W after L's urgent push session; with P offline, P
        refuses W after its first later session with L. (DC-10
        TRP-2, E2)
  TR-7  Data kept: events W produced before the unpair are still
        listed on L after the unpair and after a restart; counts
        equal. (§4.4)
  TR-8  Producer rejection (P12 a): a W-produced change with seq
        above the cutoff, relayed by an unaware P, is not applied on
        L, creates no quarantine row, and does not stall other
        producers; a W-produced change at or below the cutoff IS
        applied on a device that never saw it. (DC-05 §7.3 as
        amended, O7)
  TR-9  Cleanup: after unpair, hard_blocks / peer_invalid_tally rows
        for W are gone, Tier-1 state for W is Level 0, last_endpoint_*
        are NULL, W is absent from the DC-21 prefilter and from Sync
        now / scheduler dial lists.
  TR-10 Mid-session cutoff: a valid record naming the current peer
        ends the session with no further messages. (DC-08 TR-7)
  TR-11 Same-id re-pair refused (P10): a ceremony with a revoked id
        stores nothing and leaves the row 'revoked'.
  TR-12 Fresh-start re-pair (Path B): W started on a renamed data
        folder has a new device_id, pairs with L, and after its first
        sessions lists ALL of L's events, including events authored
        by the old W id; the same holds for a third device paired
        with L after the unpair.
  TR-13 ACK durability (P5): after a restart, a record already ACKed
        by P is not sent to P again.
  TR-14 Logging: unpair, accept, reject and refusal log lines contain
        no key, signature, record bytes, display name, or full
        device id (static + runtime grep).
  TR-15 Owner acceptance (two machines): unpair Windows on Linux;
        Windows can no longer sync with Linux; Linux keeps all
        appointments; Windows fresh start + pair works.

==================================================================
8. DEFERRED ITEMS AND TRIGGER CONDITIONS
==================================================================

  T1  In-app "Start fresh" action (new identity + empty database,
      old data kept as a renamed backup, DC-15 §3.5 checkbox
      safeguard). TRIGGER: before DC-25 is implemented (once the key
      lives in the OS keystore, renaming the data folder no longer
      produces a new identity, so Path B's manual steps break), or
      on owner request, whichever comes first.
  T2  Telling the removed device it was removed (DC-08 extension).
      TRIGGER: owner reports confusion on a removed device, or a
      product release that targets non-technical users.
  T3  Distributed forgiveness / un-revoke. TRIGGER: per DC-10 §7
      (new contract), never inside this one.

==================================================================
9. OUT OF SCOPE
==================================================================

  - Device names and labels: DC-28.
  - Remote wipe of the removed device's data: not in the Spec.
  - In-place identity reset keeping the database (Path C): Spec §25
    backup/restore mechanics, no contract.
  - "Remove everything" uninstall flow: DC-15 §3.5 / DC-24.
  - Changes to the DC-16 ladder, thresholds or Level 4 trigger.
  - Compaction: DC-06 §2.6 already drops revoked peers from the
    constraint set; sweep() has no production caller today, which
    is DC-06 implementation work.

==================================================================
10. OPEN ITEMS OWNED ELSEWHERE
==================================================================

  O1  DC-10 E3 amendment: re-pairing a revoked device under the SAME
      device_id (needed only if P10 is approved; it narrows E3).
      Also corrects E3's "new handshake keys" wording (S10).
  O2  DC-08: an explicit "you were removed" signal to the removed
      device (§4.8). Today: silence (DC-16 D4).
  O3  DC-08 §3.7 wire shape vs implementation (S7): either amend
      DC-08 to the implemented { records, signature_hex } or change
      the code; owned by DC-08.
  O4  DC-05 §5.4: the safety-number comparison is auto-confirmed in
      pairing_manager.ts (TODO(ui)). Path B relies on a sound
      ceremony; owned by DC-05 / pairing UI.
  O5  DC-07: peers.paired_at is documented as epoch ms; the code
      stores seconds (pairing_manager.ts, peerStateSnapshot * 1000).
      Consistent in code, inconsistent with DC-07 text.
  O6  DC-25: key custody; signing call site per §4.10.
  O7  DC-05 §7.3 / §7.1: which history of a revoked producer is
      still accepted (§4.14, P12). Option a) amends the signed
      record format, so it also touches DC-10 (record identity stays
      the §2.5 triple).

==================================================================
11. BINDING DECISIONS
==================================================================

  DECIDED (carried from approved contracts / owner request)
    D1  Unpair is a DC-05 §7.1 revocation propagated by DC-10; no
        new unpair mechanism (DC-16 D3, §5.4).
    D2  Unpair needs explicit user confirmation; nothing unpairs
        automatically (DC-16 §4.2, Level 4).
    D3  Revocation is one-way; no un-revoke in v1 (DC-05 §7.2,
        DC-10 E3).
    D4  Enforcement is DC-05 §3.3/§7.3 + DC-08 §3.7; this contract
        makes wiring it on all session paths a precondition for
        shipping Unpair (§4.5).
    D5  Owner request: Unpair works, and the removed Windows PC can
        be paired again afterwards with a fresh key.

  DECIDED 2026-11-14 (owner approved every recommended default,
  shown in brackets)
    P1  Entry point and wording [§4.1 text, Paired Devices row only].
    P2  Two-step in-window confirmation + server-side confirm:true
        [yes; no typed confirmation].
    P3  Keep calendar data, history, conflicts, quarantine; clear
        endpoints, block/tally rows, pending_changes [as §4.4].
    P4  No "reason" in the record [omit].
    P5  ACK store persisted (new table, DC-07 amendment) [persist;
        alternative: in-memory, re-send once per restart, which
        deviates from DC-10 §2.5 "never reset"].
    P6  Hint line when the peer already refused us [show].
    P7  Sign in the sidecar with the key it already holds [yes].
    P8  "Removed devices" section with per-peer "told" state [show].
    P9  Log format and exclusions [§4.12].
    P10 Refuse same-id re-pair in v1 [refuse; needs O1].
    P11 Path B as a documented manual procedure now; in-app "Start
        fresh" deferred to T1 [yes].
    P12 History authored by the removed device [cutoff seq in the
        record, §4.14 a); needs O7].

  IMPLEMENTATION-TIME VERIFICATION (not asserted here)
    V1  Prove S4 with a failing test before fixing: an unpaired key
        completes an inbound session today.
    V2  Confirm the engine tolerates being handed peerDeviceId for
        inbound sessions without changing DC-09 trigger keying
        (derivePeerKey fallback, sync_engine.ts).
    V3  Identify the sidecar's HLC source for revoked_at_hlc (must be
        the same HLC that stamps change records).
    V4  Confirm the sidecar dispatcher serializes unpair_device calls
        (or add a guard) so the status check and transaction cannot
        interleave.
    V5  Confirm that dropping a revoked producer's record does not
        leave a sequence gap that blocks applied_upto for that
        producer in a way that later retries forever.
    V6  Confirm the data folder path on Windows and Linux (TIDE_DATA_DIR
        / dirname of TIDE_DB_PATH as set by the shell) and that
        renaming it yields a new identity and an empty database while
        config.toml (separate directory) is kept.
    V7  Confirm how the shell's Sync now fan-out can be invoked from
        the sidecar after unpair (or move the push into the sidecar).
    V8  Confirm the removed device can tell "closed after handshake"
        from "unreachable" in its session result (needed for P6).
    V9  Confirm which DC-09 trigger fires for a freshly paired empty
        device (full-state vs incremental) and that either path
        delivers all entities.
    V10 Confirm DC-23 import behavior for entries already present by
        sync (UID match: skip/overwrite/duplicate) before step 6 of
        Path B is documented to users.
    V11 Confirm how older builds treat a record with an extra signed
        field (validateRevocationRecord drops unknown keys, so the
        canonical bytes and the signature check would differ).

==================================================================
APPENDIX A — PAIRING REFUSAL NAMES ITS CAUSE (owner-approved 2026-11-14)
==================================================================

Problem: §4.8 keeps the removed device uninformed. With P10, a pairing
attempt by a removed device (same device_id) is refused, and without a
cause the user cannot tell that a fresh start (§4.13) is the remedy.

A.1  SCOPE. Only the pairing ceremony (DC-05 §5) changes. Sync
     sessions keep §4.8 and DC-16 D4 unchanged: a refused sync
     session is still closed after the handshake with no message.
A.2  WIRE. When the device performing the ceremony finds the remote
     device_id revoked (P10), before any check or trust write, it
     sends {"kind":"PAIRING_REFUSED","code":"revoked"} on the pairing
     channel and ends the ceremony. The message carries a fixed code
     only: no text, no reason, no device ids.
A.3  DISPLAY. A device that receives this code shows its own local
     text, never peer-supplied text:
       "This device was unpaired earlier. To pair it again, start it
        fresh first."
     Any other kind or code is handled as before (pairing fails).
A.4  DISCLOSURE. The signal is sent only inside a ceremony the user
     started on both devices, after the Noise handshake. It tells
     the removed device nothing that a refused ceremony would not
     already imply, plus the remedy.
A.5  RESIDUAL. The device that refuses shows no notice of the
     refusal (tracked in docs/technical-debt.md).
A.6  EFFECT ON OTHER ITEMS. T2 and O2 stay open for sync sessions
     ("you were removed" outside the pairing ceremony). This
     appendix closes them for the pairing ceremony only.

==================================================================
APPENDIX B — PROPOSAL (not approved): FULL-STATE SNAPSHOTS AND THE
             HISTORY CUTOFF (TD-041)
==================================================================

Problem: DC-05 Appendix A.2 filters CHANGE RECORDS of a revoked
producer above its cutoff. A DC-09 full-state snapshot carries entity
STATE, not change records, and its application (DC-09 §5) has no such
filter. Under §4.4 a peer P that applied the removed device's
above-cutoff changes during the gossip window keeps them; a later
snapshot from P then delivers them to a device that holds the record,
even after P itself has learned the revocation.

B.1  EVIDENCE (PROVEN, tests/dc27_unpair.test.ts, "TD-041 ..." tests)
     Setup: L unpairs W (cutoff 2); W's event created at seq 3 reaches
     the unaware P; P then learns the record in a session with L.
       a) New entity: P's snapshot puts W's seq-3 event on L, and L's
          applied_upto[W] becomes 3 (above the cutoff). Same result
          when the snapshot enters L's session engine from P as a
          trusted peer.
       b) Delete: W deletes an at-or-below-cutoff event at seq 3; P's
          snapshot carries no tombstone for it, and L's absence rule
          (DC-09 §5.2) deletes L's legitimate copy.
       c) Merged entity: W edits the title at seq 3, P later edits the
          description. P's entry names P as latest producer while its
          state carries W's above-cutoff title.
       d) Causal context: an event P created after applying W's seq 3
          has clock[W] = 3 although it holds no state of W.
       e) Clock: L never applied W's seq 3 (applied_upto[W] = 2), yet
          L's own snapshot_clock[W] is 3. snapshot_clock comes from
          device_clock, which takes in causal context (d). So an
          untainted L raises a receiver's applied_upto[W] above the
          cutoff too, and snapshot_clock cannot tell a peer that holds
          W's above-cutoff state from one that only saw it cited.

B.2  WHY NO RULE FOLLOWS FROM APPENDIX A.2 ALONE
     A snapshot entry carries the whole row, ONE latest producer
     (device_id, seq) and the entity's version vector (DC-09 §4.2);
     the snapshot carries one snapshot_clock. The latest producer
     misses B.1 c); the version vector over-matches B.1 d); absence
     (B.1 b) carries no producer; snapshot_clock over-matches B.1 e).
     Changes are field-level (DC-01), so one row can mix fields from
     several producers. Any rule is a new decision.

B.3  OPTIONS
     For each: new entity / merged entity / delete / clocks / sender.
     "C" is the highest cutoff held for W (Appendix A.2). "Tainted"
     means the sender's applied_upto[W] > C: it applied W above C.

     a) Declared applied frontier, refuse tainted snapshots
        [RECOMMENDED].
        FULL_STATE_OFFER and FULL_STATE_SNAPSHOT gain an additive
        field "applied_upto" (the sender's applied frontier). A
        receiver holding C declines the offer (silent, DC-09 §7.4) or
        does not apply the snapshot (whole snapshot, atomic, DC-09
        §5.1) when the declared applied_upto[W] > C, or when the field
        is missing. It never raises its own applied_upto[W] above C
        from a snapshot.
        New entity, merged entity, delete: none arrive by snapshot,
        also from an unaware sender. Clocks: applied_upto[W] stays <= C.
        Sender: always declares; a tainted sender that holds the record
        may skip offering. Cost: a tainted peer can no longer serve
        full state to record holders; incremental sync keeps working
        (TR-8) and untainted peers still serve full state. A Trigger A
        or C condition toward that peer re-evaluates every session
        (DC-09 §7.4). The declaration is trusted like any other field
        from a paired peer (§5). Touches DC-08 §3.6 (additive field),
        DC-09 §5 and §5.4; no schema change.

     b) Sender self-restraint, no wire change.
        A sender that holds C and is tainted neither offers nor answers
        with full state. A receiver never raises applied_upto[W] above
        C from a snapshot. Closes the case "after P learns the record";
        an UNAWARE tainted sender still delivers B.1 a-c to a record
        holder (the TD-041 window stays open until the record reaches
        that sender). Touches DC-09 §3 and §5.4.

     c) Latest-producer filter plus clock clamp.
        Skip entries whose latest producer is W with seq > C (keep the
        local state); clamp applied_upto[W] to C. New entity: blocked.
        Merged entity: W's fields still arrive (B.1 c). Delete: still
        arrives (B.1 b). Partial; the residual joins TD-045. Touches
        DC-09 §5.2, §5.4.

     d) Version-vector or snapshot_clock filter. Skip entries with
        clock[W] > C, or whole snapshots with snapshot_clock[W] > C.
        Drops other producers' legitimate state (B.1 d) and, by B.1 e),
        blocks full state from nearly every peer once W's above-cutoff
        changes are cited anywhere. Not recommended.

     e) Per-field provenance. The snapshot carries, per field, the
        last writer (device_id, seq), and a delete carries its remover;
        the receiver keeps its local value for fields last written by
        W above C. Most precise (a tainted peer still serves the rest),
        but needs a DC-09 §4.2 / DC-08 §3.6 wire change and a durable
        per-field store (DC-07): the change log that holds this today
        is removed by compaction (DC-06). Candidate for a later
        revision.

     f) Accept the gap. Document it as a residual of P12, bounded like
        TD-045 by the gossip window and by how rarely snapshots fire.
        No code. Leaves TR-8's intent open for the snapshot path.

B.4  ITEMS COMMON TO a) TO c)
     - §4.4 KEPT is not changed: nothing already applied is removed.
     - A declined user-requested resync (DC-09 Trigger B) shows no
       reason today; whether to show one is a separate UI decision.
     - Older builds: a missing declaration counts as tainted in a),
       only on a receiver that holds a cutoff (V11 posture).

B.5  TEST REQUIREMENTS (for the chosen option)
     TR-16 the three "TD-041 repro" tests pass as ordinary tests (with
           a); with b) for an aware sender only); a snapshot from an
           untainted peer still delivers W's at-or-below-cutoff state
           and other producers' state, and leaves applied_upto[W] at
           or below C; each new guard has a mutation proof.
