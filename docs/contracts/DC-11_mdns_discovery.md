# TIDE DESIGN CONTRACT DC-11
# mDNS/Bonjour Service Discovery
Status: APPROVED by project owner (2026-08-25)

OWNER Q&A AMENDMENT (2026-08-25): pairing of two brand-new clients does
NOT depend on discovery — the QR ceremony (DC-05 §5) IS the initial
identification channel. Implementation note: for camera-less platforms
(desktop-to-desktop), the same QR payload MUST also be expressible as a
copy/paste text block or short alphanumeric code; semantics identical,
transport different. Discovery remains a convenience for already-paired
devices only.
Depends on: Architecture Spec v0.3 §16, §18, §20, §23, §31; frozen decisions
            [06], [08], [09]; DC-05; DC-08
Unblocks: network-layer implementation (Spec §20 transport flow entry point)
Resolves: none of the 14 deferred decisions in Spec §30. This is NOT a
          deferred decision from that list; it is an auxiliary design
          contract written because Spec [08] names mDNS as the discovery
          mechanism but leaves its concrete semantics undefined. It must be
          settled before network implementation begins.

==================================================
1. PURPOSE
==================================================

Defines the concrete mDNS/Bonjour discovery behavior for the Tide network
layer: service identity on the wire, registration/browsing lifecycle,
caching, and the trust firewall between discovery results and the
identity/trust system.

Frozen constraints this contract implements:

  - Spec [08]: mDNS/Bonjour is the primary local discovery mechanism.
  - Spec [09]/§16/INVARIANT 4: discovery does not imply trust. A discovered
    endpoint is UNTRUSTED until verified through the security/trust layer.
  - Spec §18 Case C: mutual strangers ignore each other. No user-facing
    noise from unpaired discoveries.
  - Spec §23 / INVARIANT 1: offline-first. Discovery must be optional and
    must never be required for calendar functionality.
  - INVARIANT 5: device identity never depends on network addressing;
    extended here to: discovery announcements must not leak identity-
    adjacent personal data either.
  - INVARIANT 12: platform specifics stay behind the platform-abstraction
    interface ([06]).

Core principle inherited unchanged from the whole contract series:
discovery answers ONLY "is another Tide synchronization endpoint present?"
It never answers "who is this?" or "may we sync?" Those belong to identity
and trust (DC-05), and messaging belongs to sessions (DC-08).

==================================================
2. SERVICE IDENTITY ON THE WIRE
==================================================

2.1  Service type

     "_tide-sync._tcp.local."

     Justification:
       - "_tcp" because Tide endpoints accept TCP transport connections
         after handshake (DC-05 transport binding).
       - Distinct, Tide-specific name; no collision with existing common
         service types; greppable in static tests.
       - The type string contains no version, platform, user, or host
         information — those change over time and would leak data.

2.2  Instance name

     DERIVED from device_id only:

       instance_name = first 8 hex chars of SHA-256(device_id)
                       + "-" + 4 random hex chars

     e.g. "9f2c41a7-b3e0"

     Rules:
       - The 8-hex prefix gives stable recognizability of the same device
         across restarts (endpoint cache keys can survive re-registration).
       - The 4-hex random suffix resolves the (astronomically unlikely)
         case of two devices colliding on prefix; on collision detection,
         re-register with a fresh suffix.
       - MUST NEVER contain hostname, user name, account name, OS computer
         name, model string, or any calendar-derived data. mDNS instance
         names are broadcast to every device on the LAN; they are treated
         as public.
       - The mapping instance_name -> full device_id is NOT derivable by an
         observer without brute-forcing the hash space; the instance name
         is an opaque identifier for privacy purposes.

2.3  TXT record

     Minimal. Exactly these keys, nothing else:

       key        value      presence     justification
       ---------------------------------------------------------------
       "pv"       "1"        required     Protocol version byte (decimal
                                           ASCII). Lets a future version
                                           refuse incompatible peers BEFORE
                                           opening a socket. One byte of
                                           information; no privacy cost.
       "dn"       display    OPTIONAL     Human-readable display-name hint,
                  name                    published ONLY if the user has
                                           explicitly opted in. Default
                                           OFF (see section 6). Exists so
                                           users who opt in can recognize
                                           their own devices in UI lists;
                                           absence must be fully supported
                                           by all UI.

     Prohibited in TXT forever:
       - hostnames, IPs beyond what mDNS already carries
       - usernames, real names, email addresses
       - calendar names, event counts, collection metadata, timestamps
       - pairing state, trust state, fingerprint material
       - free-form fields ("notes", vendor extensions) — extension points
         are a metadata-leak channel; adding one requires a new contract.

2.4  Port

     The TXT record carries no port; the SRV record carries the listening
     port of the DC-05 transport listener. The listener accepts connections
     but grants NOTHING until Noise_XX completes (DC-05 TR-7 semantics).

==================================================
3. DISCOVERY LIFECYCLE
==================================================

3.1  Registration

     - Register the service when the application starts AND background
       activity is enabled (Spec §22 opportunistic triggers).
     - If discovery is disabled by the user (section 6), NO registration
       ever occurs — not even with an empty TXT.
     - Re-register on every network interface change: Wi-Fi up/down, IP
       change, VPN tunnel up/down. Old registrations are withdrawn
       (goodbye packets) before new ones are announced. A stale
       announcement on a dead interface must not outlive it.

3.2  Browsing

     - Browse continuously while the app/background layer is active. The
       exact wake/sleep scheduling of browsing is owned by the Windows
       background architecture (#13) and interval parameters (#14); this
       contract only fixes the SEMANTICS: while browsing is active, newly
       appearing Tide services are observed within one browse cycle.

3.3  Rate limiting

     - All announcements, responses, and re-announcements follow standard
       mDNS rate rules (multicast TTL/dup suppression, randomized delays,
       goodbye packets). No proprietary aggressive beaconing. An observer
       should not be able to distinguish Tide traffic volume from any
       other Bonjour service on the network.

3.4  Endpoint cache

     - Discovered endpoints are cached as ephemeral connectivity data:
         { instance_name, resolved addresses+port, interface, last_seen,
           expires_at }
       TTL = the mDNS record TTL. Entries expire at TTL unless refreshed
       by observation.
     - Stale entries (expired): removed from active candidate sets; kept
       at most for debug diagnostics if the implementation finds that
       useful, but they MUST NOT feed connection attempts once expired.
     - The cache is a connectivity aid for the handshake initiator ONLY
       (section 4). It lives outside the domain database (INVARIANT 2 is
       untouched — SQLite remains authoritative for calendars, not
       network gossip).

==================================================
4. TRUST FIREWALL (CRITICAL SECTION)
==================================================

The entire purpose of discovery is to produce CONNECTION HINTS for the
handshake initiator. Nothing more. The complete pipeline:

    discover endpoint (this contract)
        -> attempt Noise_XX handshake (DC-05, initiator role)
        -> peer identity revealed cryptographically
        -> canSynchronize gate consults local trust store (DC-05)
        -> Case B: session opens, DC-08 messages flow
           Case A/C: abort, silent ignore (below)

Hard rules:

4.1  Discovery results confer ZERO trust. A discovered endpoint is a
     socket address plus an opaque name. It cannot create, modify, or
     rank trust entries, cannot mark a device "known", cannot increment
     any reputation-like counter.

4.2  Case C handling: a discovered-but-unpaired device produces NO
     user-facing noise. No notification, no toast, no "Found nearby Tide
     device — add it?" prompt, no badge. Debug log only. Pairing is
     initiated EXCLUSIVELY via the QR ceremony (DC-05); there is no
     discovery-driven path into pairing.

4.3  Case A handling (we trust them, they don't know us): also silent.
     Handshake fails per DC-05 TR-4; discovery does not retry
     aggressively — backoff applies.

4.4  What MAY be persisted:
       - endpoint cache entries (section 3.4): ephemeral, TTL-bound,
         non-authoritative, deletable without consequence.

4.5  What MUST NOT be persisted anywhere:
       - any structure inside the identity/trust subsystem derived from
         discovery alone
       - "seen devices" histories that outlive the cache TTL
       - discovered fingerprints/public keys observed before a completed
         handshake — pre-handshake key material from an unauthenticated
         channel is attacker-controllable and must be discarded.

4.6  INVARIANT 5 static-check extension: the existing lint/static rule
     that forbids network-address-derived identity (DC-05 TR-2) is
     extended so that no code path may write discovery-derived data
     (instance_name, addresses, TXT fields) into identity or trust
     storage modules. Module-boundary enforcement, same mechanism.

==================================================
5. PRIVACY CONSIDERATIONS
==================================================

What a passive LAN observer learns from default Tide mDNS traffic:
  - that a Tide synchronization endpoint exists on this network
  - an opaque identifier and protocol version byte
Nothing else.

  - Default announcements carry no display name, hostname, username, or
    any calendar-derived data (calendar metadata never appears in
    discovery at any setting — this is unconditional, unlike the opt-in
    display hint which is user-chosen text).
  - The opt-in "dn" hint is exactly that: user-chosen text. The settings
    copy must make clear it is broadcast to the whole local network.
  - Discovery can be disabled entirely (section 6), reducing observable
    presence to zero.
  - Unicast/multicast profile differences across platforms are an
    implementation concern; the semantic floor is: disabling discovery
    produces zero Tide packets (TR-4).

==================================================
6. DISABLEMENT (OFFLINE-FIRST RESPECT, SPEC §23)
==================================================

  - Settings expose "Network discovery": default ON for the primary use
    case, fully disableable.
  - When disabled: no service registration, no browsing, no responses to
    mDNS queries for "_tide-sync._tcp.local.", and any existing
    registration is withdrawn immediately.
  - Calendar functionality is completely unaffected (INVARIANT 1). Paired
    devices can still connect by cached/manual addressing if such a path
    exists later; discovery being off never blocks already-established
    trust.
  - Discovery is never a prerequisite for sync: direct-IP connection
    attempts against known paired peers remain legal (they still pass the
    same handshake/gate).

==================================================
7. PLATFORM NOTES (SPEC [06], INVARIANT 12)
==================================================

  - Windows first (target platform). Android and Linux follow.
  - All mDNS behavior sits behind the platform-abstraction interface:
    the domain/network layer sees only
      register(service_identity) / browse() -> events / withdraw()
    Concrete socket/multicast handling is platform code.
  - Implementation library candidates (suggestions, NOT decisions):
      Rust: `mdns-sd` crate (pure-Rust responder/browser, no system
            daemon dependency — attractive for a background process),
      `zeroconf` crate (wraps Avahi/Bonjour system services where
            available),
      platform natives later: NSDNSService/Bonjour on Apple/Windows
            dnssd API, NsdManager on Android.
    Final choice = implementation decision, CONSTRAINED by this
    contract's semantics: whichever library is chosen must support
    explicit withdrawal, custom instance naming, minimal TXT, interface
    change callbacks, and record-TTL exposure. A library that cannot
    meet TR-1..TR-7 is disqualified regardless of convenience.

==================================================
8. TESTABLE REQUIREMENTS
==================================================

TR-1  Mutual discovery: two Tide instances on a simulated network
      (loopback/containerized mDNS) discover each other's service
      records within one browse cycle.

TR-2  No PII leakage: (a) STATIC — grep/lint asserts no hostname/
      username/environment-variable/calendar-field feeds instance-name
      or TXT construction; TXT keys limited to {"pv","dn"} by test.
      (b) BEHAVIORAL — captured wire traffic from two running instances
      contains neither machine hostname, nor user name, nor any calendar
      entity data (with "dn" opt-in OFF).

TR-3  Discovered-unpaired exclusion (extends DC-05 TR-3): a discovered
      endpoint with no shared pairing may exchange NOTHING beyond the
      failed Noise_XX handshake; no trust-store mutation, no persistent
      record beyond the TTL-bound endpoint cache; zero user-facing
      events emitted (Case C).

TR-4  Disablement silence: with discovery disabled, packet capture shows
      zero Tide registrations, queries, or responses; previously
      registered service is withdrawn within a bounded window after the
      setting flips.

TR-5  Interface flap resilience: toggling the network interface down/up
      results in withdrawal + re-registration, and the peer observes the
      refreshed record; no duplicate concurrent registrations remain.

TR-6  Cache TTL/staleness: expired cache entries stop feeding connection
      attempts; refresh observations extend expiry; stale entries never
      appear as live candidates.

TR-7  Trust-table isolation: automated test performs discovery of an
      arbitrary number of unpaired peers and asserts the identity/trust
      tables are byte-identical before and after (extends INVARIANT 4/5
      and DC-05 TR-13 consistency checks).

TR-8  Display-name opt-in: with "dn" opted in, the hint round-trips to
      the peer's UI; turning it off removes it from subsequent
      announcements without restarting the service.

==================================================
9. OUT OF SCOPE
==================================================

  - Handshake/pairing mechanics ............ DC-05
  - Sync messaging and session flow ........ DC-08
  - Background-process architecture ......... deferred decision #13
  - Browsing intervals/batching parameters .. deferred decision #14
  - NAT traversal, WAN/internet discovery ... explicitly OUT OF SCOPE for
    v1. Local-network link-scope multicast only. Any wide-area variant
    (e.g. DNS-SD over unicast DNS) is forbidden without a new contract.
  - Conflict UI, schema, clocks, etc. ....... DC-01..DC-04, DC-06, DC-07

==================================================
10. OPEN ITEMS OWNED ELSEWHERE
==================================================

  - Exact library selection ................ implementation decision
    (constrained by §7 and TR-1..TR-8)
  - Whether paired-peer manual/direct connect surfaces in UI .. separate
    UX decision; not required by this contract
