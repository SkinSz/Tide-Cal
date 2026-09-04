# TIDE DESIGN CONTRACT DC-21
# mDNS-to-Sidecar Endpoint Plumbing (Discovery Bridge)
Status: APPROVED by project owner (2026-09-01) — implementation NOT
        yet authorized; awaiting owner go

OWNER AMENDMENT (2026-09-01) — D3 security boundary (binding):
live mDNS and last-known endpoints are ROUTING HINTS ONLY; neither
establishes peer identity or trust. Only successful authenticated
Noise_XX session establishment may confirm that an endpoint
corresponds to the expected device identity. Endpoint persistence
remains subject to D6. See D3 for the full binding text.

Depends on: Architecture Spec v0.3 §12, §21, §31 (INV 4, 5, 12);
            DC-05 §pairing (trust store, Noise handshake initiator);
            DC-07 §peers (schema); DC-11 §2-§7 (discovery lifecycle);
            DC-13 §2 (sidecar process model, scheduler runtime)
Unblocks: automatic (unattended) sync sessions; DC-13 scheduler
          actually dialing peers; discovery-driven "sync is
          automatic" release goal
Resolves: the endpoint gap between DC-11 (discovery works) and
          DC-13 (scheduler runs) — standing report §3.4, the main
          blocker between "sync works" and "sync is automatic"

==================================================
1. PURPOSE
==================================================

Today the pieces exist but do not connect:

  - DC-11 discovery is IMPLEMENTED (src/network/discovery.ts pure
    logic + src-tauri/src/discovery.rs mdns-sd adapter, feature-
    gated). Browse results go nowhere: nothing consumes them.
  - DC-13's scheduler runtime is LIVE in the sidecar (a18e5a4) and
    opens engine sessions via connectSync — but listPeers supplies
    no endpoints, so every automatic-session peer is skipped with
    a log line. Only manual "Sync now" works (explicit host/port).
  - The DC-07 peers table stores identity and trust, but no
    host/port (by design: DC-05 forbids identity depending on
    network addressing — INVARIANT 5).

This contract is the BRIDGE: how a discovered service becomes a
dialis endpoint for a paired peer, and how that endpoint reaches
the sidecar's scheduler. It adds NO discovery semantics (DC-11
owns those), NO trust semantics (DC-05 owns those), and NO
scheduling semantics (DC-13 owns those). It decides only the
plumbing, identification prefilter, and persistence of
last-known endpoints.

Core principle (unchanged from DC-11 §4, restated because it
governs every decision below): discovery produces CONNECTION
HINTS ONLY. Trust is established exclusively by the pairing
ceremony; a session is authorized exclusively by the Noise_XX
handshake result. Everything in this contract is an optimization
that decides WHICH candidates to dial, never WHETHER a peer may
be talked to.

==================================================
2. CURRENT-STATE AUDIT (facts this contract builds on)
==================================================

2.1  WHO OWNS WHAT TODAY (DECIDED — codifying existing reality)

     - The RUST SHELL (Tauri process) owns the multicast socket:
       src-tauri/src/discovery.rs wraps mdns-sd behind the `mdns`
       cargo feature; without the feature it is an explicit no-op
       that logs (honest fallback, review R3 M-1).
     - The SIDECAR (Node) owns the scheduler runtime and the sync
       engine (DC-13 §2.1: single-process sidecar, engine sessions
       via connectSync over TCP).
     - The boundary between them is the existing stdio NDJSON RPC
       channel (same one carrying sync_op/quarantine/settings
       traffic today).

2.2  IDENTIFICATION MATERIAL ALREADY EXISTS (DECIDED)

     DC-11 §2.2: instance_name = first 8 hex chars of
     SHA-256(device_id) + 4 random hex chars. After pairing, the
     local device KNOWS each paired peer's device_id (DC-07 peers
     table). Therefore each device can compute the EXPECTED
     instance prefix of every paired peer and prefilter browse
     results deterministically — no blind dialing of strangers.
     The handshake (DC-05 §4) remains the sole authority; the
     prefilter only avoids dialing instances that cannot be our
     paired peers.

==================================================
3. ARCHITECTURE DECISION
==================================================

3.1  OBSERVATION STAYS IN RUST; SIDECAR CONSUMES EVENTS (DECIDED)

     The Rust shell runs the mdns browser continuously (while the
     app is active, per DC-11 §3.2) and forwards browse events to
     the sidecar over the existing stdio NDJSON channel. The
     sidecar never touches multicast sockets.

     Justification: the mdns-sd adapter already lives in Rust
     (DC-11 §7 binding); duplicating a multicast stack in Node
     would be a second discovery implementation to keep compliant
     with DC-11 §2's strict wire rules. INVARIANT 12 (platform
     behavior does not leak into domain logic) is preserved: the
     sidecar consumes a platform-neutral event stream.

3.2  EVENT CHANNEL (DECIDED)

     Two additions to the stdio RPC surface, both following the
     existing NDJSON conventions (sidecar logs to stderr only;
     Rust allow-list updated in the SAME commit — standing rule):

     (a) PUSH: `mdns_event` notifications. Rust -> sidecar, one
         per browse transition: { kind: "added" | "removed",
         instance_name, host, port, interface, observed_at }.
         The sidecar maintains an in-memory endpoint cache keyed
         by instance_name (DC-11 §3.4 shape: TTL-bound,
         non-authoritative, deletable without consequence).

     (b) PULL: `mdns_snapshot` op. Sidecar -> Rust request/response
         returning the current cache contents — used once at
         sidecar start so a restarted sidecar does not wait a full
         browse cycle for endpoints it could have immediately.
         No new state source: the snapshot reads the same live
         cache the push events maintain; there is exactly ONE
         cache, in the sidecar.

     The Rust allow-list gains mdns_snapshot (request path). The
     push direction needs no allow-list entry (it is an outbound
     notification, same as existing event wiring).

3.3  PREFILTER (DECIDED)

     On receiving an mdns_event, the sidecar computes
     expectedPrefix = SHA-256(device_id)[0..8] for each paired,
     trusted peer and matches the event's instance_name prefix.
     Matching candidates enter the endpoint cache tagged with
     their device_id. Non-matching instances are ignored —
     logged at debug level at most (privacy: never surfaced to
     UI or logs above debug).

     The cache entry's device_id tag is a HINT. Before dialing,
     the handshake confirms identity per DC-05; a mismatch
     aborts per DC-11 §4.6 (silent, no persistence beyond TTL).

3.4  REGISTRATION PORT (DECIDED)

     The Rust shell registers the service on the sync listener
     port from ensureListener (the same port the sidecar's sync
     server answers on). If the listener's port changes (retry
     path of the ensureListener fix), Rust re-registers with the
     new port (goodbye-first, per DC-11 §5.3). Registration is
     therefore driven by the sidecar's ACTUAL listening port —
     the shell asks the sidecar once at startup and on change
     (existing port already flows to Rust for tray/manual sync;
     no new channel needed).

==================================================
4. ENDPOINT PERSISTENCE (LAST-KNOWN-ENDPOINT)
==================================================

4.1  SCHEMA (DECIDED — additive ALTER per DC-07 migration rules)

     peers table gains three nullable columns:

       last_endpoint_host TEXT      -- last SUCCESSFULLY used host
       last_endpoint_port INTEGER   -- ... and port
       last_endpoint_seen INTEGER   -- UTC epoch ms of last use

     NULL = never connected (or endpoints deliberately cleared).
     These are NON-AUTHORITATIVE connectivity conveniences, fully
     consistent with DC-11 §4.4's classification of endpoint data
     (ephemeral, deletable without consequence). They are NOT
     part of trust state and are NOT replicated (peers rows carry
     identity/trust; connectivity columns are device-local, per
     DC-07's device-local metadata class).

4.2  WRITE RULES (DECIDED)

     - Written ONLY after a successful, authenticated sync session
       with that peer (host/port that actually worked). Never
       written from a bare browse result — discovery data must not
       masquerade as proven connectivity.
     - Never cleared on browse removal (a peer that said goodbye is
       merely gone right now — the last-known endpoint is exactly
       the fallback for that situation).

4.3  READ RULES / SOURCE PRECEDENCE (DECIDED)

     The scheduler's listPeers sources endpoints per peer:

       1. LIVE mDNS cache entry for that device_id (fresh, TTL-
          valid) — preferred, it reflects the current network.
       2. LAST-KNOWN endpoint (peers table) — fallback when the
          peer is not currently discovered (asleep device, mDNS
          unavailable). Dialed opportunistically; connection
          failure is a normal, logged, non-fatal outcome (DC-13
          trigger semantics: unavailable peers never block).
       3. NEITHER -> skip with the existing log line (unchanged
          behavior; INVARIANT 1: offline-first, nothing breaks).

     Precedence note: a stale live entry (TTL expired) is dropped
     from the cache and does not shadow the last-known endpoint.

==================================================
5. LIFECYCLE
==================================================

5.1  STARTUP SEQUENCE (DECIDED)

     Sidecar start -> existing readiness path -> request
     mdns_snapshot -> seed cache -> scheduler's first sweep/debounce
     can dial. Rust start -> ensureListener resolves port -> sidecar
     supplies port -> Rust registers service -> browsing begins.
     Order-independent: either side may be ready first; the
     snapshot and the port exchange converge without a startup
     state machine (both are idempotent request/response pairs).

5.2  NETWORK CHANGES (DECIDED)

     DC-11 §5 already binds interface-change behavior (withdraw +
     re-register). This contract adds nothing except: re-register
     events carry the same instance name and the (possibly new)
     port; browse results on a new interface update cache entries
     in place (keyed by instance_name; host may differ per
     interface — cache keeps the MOST RECENTLY OBSERVED host per
     DC-11 §3.4's last_seen semantics).

5.3  SHUTDOWN (DECIDED)

     Sidecar exit (stdin EOF path) -> Rust performs the DC-11 §5.4
     goodbye withdrawal. The last-known endpoints in the peers
     table survive restart by design (they are the point of them).

==================================================
6. FAILURE BEHAVIOR (all DC-16 Tier-1: log, degrade, never crash)
==================================================

6.1  mdns FEATURE DISABLED / DAEMON ERROR (DECIDED)

     Rust discovery is an explicit no-op (existing behavior).
     Sidecar falls back to last-known endpoints only. The snapshot
     op returns an explicit empty/unavailable result — the sidecar
     never guesses why (platform detail stays behind the seam,
     INVARIANT 12).

6.2  DIAL FAILURES (DECIDED)

     Live-cache or last-known, a failed connection is the normal
     opportunistic-sync outcome (DC-13): log, skip, next trigger
     retries. No endpoint is written or cleared by a FAILED dial —
     only success updates last-known (§4.2).

6.3  SIDECAR RESTART (DECIDED)

     Cache is rebuilt from mdns_snapshot; last-known endpoints come
     from the DB. Idempotent: restarting Tide cannot create
     duplicate cache entries (keyed by instance_name) or duplicate
     sessions (DC-13 trigger debouncing unchanged).

==================================================
7. PRIVACY CONSTRAINTS (restating binding rules this bridge must not violate)
==================================================

  - No new TXT fields, no announced hostname/IP/username (DC-11
    §2.3 — unchanged, enforced fail-closed in discovery.rs).
  - Last-known endpoints never leave the device (not replicated,
    not exported, not logged above debug).
  - Non-paired browse results are never persisted anywhere
    (DC-11 §4.5/§4.6 — prefilter makes them sidecar-local and
    in-memory only).
  - INVARIANT 4/5/6 all hold: discovery still grants no trust;
    identity still does not depend on addressing (last-known is a
    convenience cache, not identity); untrusted devices still
    cannot synchronize (handshake + trust store unchanged).

==================================================
8. DEFERRED
==================================================

  - Enabling the `mdns` cargo feature by default in release builds
    (DC-15 packaging scope; feature stays opt-in for dev).
  - IPv6/interface-specific dial preferences (implementation agent
    may need to pick a concrete host from multi-address browse
    results; any deterministic choice within DC-11 §3.4 semantics
    is acceptable and must be documented in the PR).
  - Endpoint reachability probing before scheduling (v1 dials
    optimistically; no pre-probe).

==================================================
9. BINDING DECISIONS
==================================================

D1. The Rust shell owns the multicast socket and forwards browse
    events to the sidecar; the sidecar never touches mDNS.
    DECIDED (§3.1).
D2. Transport: `mdns_event` push notifications + `mdns_snapshot`
    one-shot op over the existing stdio NDJSON channel; exactly
    ONE endpoint cache, in the sidecar, keyed by instance_name.
    DECIDED (§3.2).
D3. Identification: instance-prefix prefilter from paired peers'
    device_ids; handshake remains the sole trust authority; the
    prefilter only prevents blind dialing. DECIDED (§2.2, §3.3).

    OWNER AMENDMENT (2026-09-01, binding — D3 security boundary):
    live mDNS cache entries AND last-known endpoints are ROUTING
    HINTS ONLY. Neither establishes, contributes to, or substitutes
    for peer identity or trust. Only successful authenticated
    Noise_XX pairing/session establishment (DC-05) may establish
    that a dialed endpoint actually corresponds to the expected
    device identity; any endpoint that fails authentication is
    silently dropped per DC-11 §4.6. Endpoint persistence remains
    subject to D6 (write only after a successful authenticated
    session). No code path may read host/port data as evidence of
    who is on the other end.
D4. Service registration port = the sidecar's actual ensureListener
    port, re-registered on change. DECIDED (§3.4).
D5. Peers table gains last_endpoint_host/port/seen (nullable,
    additive, non-authoritative, device-local, never replicated).
    DECIDED (§4.1).
D6. Last-known endpoints written ONLY after a successful
    authenticated session; never from browse results; never
    cleared on browse removal. DECIDED (§4.2).
D7. Endpoint source precedence: live mDNS cache > last-known
    endpoint > skip-with-log. Stale cache entries never shadow
    last-known. DECIDED (§4.3).
D8. Startup is order-independent via idempotent snapshot + port
    exchange; no startup state machine. DECIDED (§5.1).
D9. All failure modes degrade Tier-1 style: mdns off ->
    last-known-only; dial failure -> normal opportunistic skip;
    restart -> idempotent rebuild. DECIDED (§6).
D10. Privacy invariants restated as binding on this bridge: no new
    announced fields, no persistence of non-paired discoveries,
    endpoints never replicate. DECIDED (§7).
