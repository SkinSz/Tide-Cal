# TIDE — FROZEN ARCHITECTURE SPECIFICATION
Version: 0.3
Status: FROZEN

This document defines the architectural baseline for Tide.

Implementation agents MUST treat this document as authoritative.

Architectural changes require explicit user approval.

==================================================
1. PROJECT DEFINITION
==================================================

Tide is a privacy-first, local-first calendar application.

Calendar data belongs to the user's devices.

Tide must:

- operate fully offline
- require no cloud account
- require no permanently available central server
- synchronize device-to-device whenever practical
- preserve local calendar functionality without network connectivity

Initial platform:

1. Linux desktop

Future platforms:

2. Windows
3. Android

[AMENDMENT 2026-08-25, authorized by project owner: the original v0.3 text
named Windows as initial platform. The owner explicitly reopened this
frozen decision and reordered it: Linux is now the FIRST target platform
(the development machine runs Linux), with Windows and Android following.
This amendment changes ONLY platform ordering; all other frozen decisions
remain in force. Tauri 2's cross-platform nature makes this a scheduling
change, not an architectural one.]

The architecture must avoid unnecessary platform lock-in.

Tide is intentionally designed for LLM-assisted development.

Clear module boundaries, explicit interfaces, deterministic behavior,
strong typing, automated tests, and narrowly scoped implementation tasks
are architectural requirements.


==================================================
2. ARCHITECTURAL MODEL
==================================================

Conceptual stack:

┌──────────────────────────────────────────────┐
│                  Tide UI                     │
│             TypeScript / UI                  │
├──────────────────────────────────────────────┤
│             Application / Domain             │
├──────────────────────────────────────────────┤
│              Synchronization                 │
├──────────────────────────────────────────────┤
│          Network / Discovery / Transport     │
├──────────────────────────────────────────────┤
│             Security / Trust                 │
├──────────────────────────────────────────────┤
│                 Persistence                  │
│                  SQLite                     │
└──────────────────────────────────────────────┘

Responsibilities are separated.

The UI MUST NOT directly manipulate SQLite.

The UI MUST NOT implement synchronization.

Synchronization MUST NOT own calendar-domain semantics.

Persistence MUST NOT depend on UI behavior.

Network discovery MUST NOT establish trust.

Security/trust MUST be independent from network discovery.


==================================================
3. APPLICATION FRAMEWORK
==================================================

Preferred framework:

Tauri 2

Preferred UI/application language:

TypeScript

Tauri's native layer provides native functionality where appropriate,
including:

- operating-system integration
- native networking
- security-sensitive operations
- filesystem access
- background operation
- platform-specific functionality
- performance-sensitive functionality
- native library integration

TypeScript communicates with native functionality through explicit interfaces.

Platform-specific functionality MUST remain behind appropriate abstractions.

Tide MUST behave as a normal installed desktop application.

Tide MUST NOT require:

- a browser tab
- an externally accessible local web server
- a large standalone HTTP service

for normal operation.


==================================================
4. BACKGROUND OPERATION
==================================================

The Windows application consists conceptually of:

- Main calendar UI
- Lightweight background/tray operation

The background component may remain active after the main window closes.

Background responsibilities may include:

- mDNS discovery
- trusted peer detection
- synchronization
- receiving synchronization traffic
- maintaining pending synchronization state

The exact Windows process model is an implementation decision.

The architectural requirement is that synchronization can operate without
the main calendar window remaining open.


==================================================
5. LOCAL PERSISTENCE
==================================================

SQLite is the authoritative local persistence mechanism.

Every Tide device maintains its own local SQLite database.

SQLite stores:

- calendars
- events
- recurrence information
- instance overrides
- reminders
- metadata
- device-local synchronization state
- change history
- tombstones
- conflict information where required

The SQLite database is the local source of truth.

CRITICAL RULE:

SQLite database files MUST NEVER be synchronized directly.

Synchronization exchanges structured changes between independent SQLite
databases.

Architectural principle:

"SQLite stores state.
Synchronization exchanges changes."


==================================================
6. CALENDAR DOMAIN
==================================================

Tide's internal calendar model is independent of external calendar formats.

The model MUST support:

- calendars
- events
- stable identifiers
- start/end times
- all-day events
- descriptions
- time zones
- recurrence
- recurrence overrides
- reminders
- creation/modification metadata
- deletion state

Synchronizable entities MUST have stable identifiers.

Identifiers MUST remain stable across devices and synchronization.


==================================================
7. TIME AND DATE MODEL
==================================================

Tide MUST use established date/time libraries.

Tide MUST correctly handle:

- leap years
- month lengths
- ISO week calculations
- IANA time zones
- daylight-saving transitions
- recurrence across DST transitions
- localized presentation

Recurring timed events MUST preserve:

- wall-clock time
- IANA timezone identifier

A fixed UTC offset MUST NOT replace the source timezone for recurring
calendar semantics.

UTC values may be derived when required for:

- transport
- comparison
- indexing
- display

but they are not the authoritative recurrence timezone representation.


==================================================
8. RECURRENCE MODEL
==================================================

Recurrence is a first-class domain concept.

Conceptually:

Series
 ├── base event
 ├── recurrence rule
 └── instance overrides

An individual occurrence override is identified by:

series_id + recurrence_id

where recurrence_id identifies the original occurrence.

The system MUST distinguish:

- series-level changes
- occurrence-level changes

Examples of occurrence-level changes:

- change one occurrence
- cancel one occurrence
- move one occurrence
- change one occurrence's title

Series recurrence rules and individual occurrence overrides are separate
conflict entities.

A series recurrence modification MUST NOT be silently merged with a
concurrent modification to an individual occurrence override.

Detailed recurrence conflict semantics are defined outside this frozen
architecture and require a dedicated design contract before implementation.


==================================================
9. REVISION / CHANGE MODEL
==================================================

Synchronization operates on changes rather than database files.

Each device has:

- persistent device identity
- local monotonically increasing revision/sequence
- globally unique change identifiers
- change records
- knowledge of revisions observed from other devices

Conceptual change record:

Device ID
+
Local Revision
+
Change ID
+
Entity ID
+
Entity Type
+
Field Path
+
Operation
+
Changed Data

Change records use field-level granularity where practical.

A change record identifies the affected logical field or collection member,
rather than merely identifying the entire entity.

This granularity exists to support:

- conflict detection
- independent-field merging
- deterministic change application

The exact change-record schema is defined by a separate design contract.


==================================================
10. VECTOR-CLOCK DEVICE KNOWLEDGE
==================================================

Tide uses a vector-clock-style device knowledge model.

Example:

Phone:
184

Desktop:
72

Tablet:
31

This means the device has knowledge of changes through those revisions from
the respective devices.

The model MUST support determining:

- which changes a peer is missing
- which changes have already been observed
- whether changes are causally related
- whether changes are concurrent

The model MUST support multi-device synchronization.

Example:

Phone ←→ Desktop
              ↓
           Tablet

Desktop may relay changes originally created by Phone to Tablet.

Every device does not need direct communication with every other device.

Vector-clock operations are defined by a separate design contract.


==================================================
11. CHANGE HISTORY AND COMPACTION
==================================================

Change history MUST NOT grow without bound.

The architecture supports:

- vector-clock compaction
- change-history cleanup
- tombstone compaction
- full-state resynchronization

A device that has been offline beyond an implementation-defined threshold
may perform a full-state synchronization rather than replaying an unbounded
historical change set.

Full-state synchronization represents current state.

It MUST include the current absence of deleted entities.

A full-state synchronization therefore does not require replaying every
historical deletion event.


==================================================
12. DELETIONS / TOMBSTONES
==================================================

Deleted entities require durable tombstones.

A deletion MUST NOT immediately remove all synchronization knowledge of the
entity.

Otherwise an offline device could reintroduce deleted state.

A tombstone may only be compacted when the synchronization knowledge model
proves that no trusted peer that may perform incremental replay can still
miss the deletion.

A trusted peer that has not acknowledged the deletion MUST remain protected
by the tombstone unless that peer is guaranteed to perform full-state
resynchronization instead of incremental replay.

Vector-clock knowledge is the mechanism used to establish this condition.

Exact compaction algorithms are implementation/design-contract work.


==================================================
13. CONFLICT PHILOSOPHY
==================================================

Tide prioritizes preventing silent data loss.

Silent last-write-wins MUST NOT be the default conflict behavior.

Conceptually:

Non-concurrent changes:
    automatically apply.

Concurrent changes to independent fields:
    may merge automatically.

Concurrent changes to the same logical field/conflict entity:
    preserve the conflict explicitly.

Example:

Phone:
title = "Dentist"

Desktop:
description = "Bring insurance card"

These may merge.

Example:

Phone:
title = "Dentist"

Desktop:
title = "Doctor"

These constitute a conflict.

Tide MUST NOT silently discard one value.

The exact conflict detection and resolution algorithms are defined by
separate design contracts.


==================================================
14. COLLECTION-VALUED FIELDS
==================================================

Collections are treated differently from scalar fields.

Examples:

- reminders
- attendees
- other future collection-valued properties

Default architectural semantics:

Concurrent addition of different members:
    union.

Concurrent modification of different members:
    independent.

Concurrent modification/deletion of the same member:
    conflict.

The exact definition of collection member identity and edge-case semantics
requires a separate design contract.


==================================================
15. DEVICE IDENTITY
==================================================

Every Tide installation has a unique persistent cryptographic device identity.

Device identity MUST NOT depend on:

- IP address
- hostname
- MAC address

Network addresses are connectivity information.

They are not identity.

Each installation owns its own cryptographic keypair.

Device identity is independent of:

- network location
- network interface
- hostname
- operating-system address


==================================================
16. DEVICE DISCOVERY
==================================================

Primary local discovery mechanism:

mDNS / Bonjour-compatible service discovery.

Discovery answers:

"Is another Tide synchronization endpoint available?"

Discovery MUST NOT establish trust.

A discovered Tide endpoint MUST NOT automatically become trusted.

Discovery information is considered untrusted until verified through the
security/trust layer.


==================================================
17. DEVICE PAIRING
==================================================

Pairing explicitly establishes cryptographic trust.

Preferred pairing mechanism:

QR code.

Conceptual flow:

Device A
  ↓
Generate pairing information
  ↓
Display QR code
  ↓
Device B scans QR
  ↓
Out-of-band authenticated identity exchange
  ↓
Both devices store trusted peer identity

The QR ceremony MUST provide an out-of-band authenticated trust mechanism.

The exact authenticated handshake protocol is an implementation decision.

An established cryptographic protocol/library such as the Noise Protocol
Framework SHOULD be evaluated.

Custom cryptographic primitives MUST NOT be implemented.


==================================================
18. TRUST MODEL
==================================================

Discovery, identity, trust, authentication, and synchronization are separate.

Case A:

Device A trusts Device B.

Device B does not recognize/trust Device A.

Result:

NO synchronization.

Manual intervention/re-pairing is required.

Case B:

Both devices recognize and trust each other.

Result:

Synchronization permitted.

Case C:

Devices discover each other but neither trusts the other.

Result:

Ignore.

Discovery MUST NEVER automatically create synchronization trust.


==================================================
19. TRUST REVOCATION
==================================================

Users must be able to revoke device trust.

Revocation supports:

- lost devices
- stolen devices
- device replacement
- devices no longer authorized for synchronization

Revoked devices MUST no longer be permitted to synchronize once revocation
knowledge has reached the relevant peer.

Revocation information propagates through the trusted synchronization mesh.

Revocation is eventually consistent.

A peer that has not learned about a revocation may temporarily continue to
trust the revoked device.

This is an accepted v1 architectural limitation.

Instantaneous global revocation is NOT a v1 requirement.

The exact revocation protocol is a separate design task.


==================================================
20. SECURE TRANSPORT
==================================================

Synchronization traffic MUST be:

- encrypted
- authenticated
- integrity protected

Conceptual flow:

mDNS discovery
      ↓
Device identity discovered
      ↓
Identity verified
      ↓
Mutual trust confirmed
      ↓
Authenticated encrypted connection
      ↓
Revision exchange
      ↓
Change exchange

Responsibilities remain separated:

Discovery:
    find endpoints.

Identity:
    identify cryptographic peers.

Trust:
    determine authorization.

Transport security:
    protect communication.

Synchronization:
    exchange and apply state changes.


==================================================
21. SYNCHRONIZATION TOPOLOGY
==================================================

Synchronization is peer-to-peer.

No permanently available central server is required.

No cloud service is required.

The system forms a trusted synchronization mesh.

Example:

             Desktop
            /       \
           /         \
       Phone         Tablet

Devices may synchronize directly.

Devices may also relay changes originating from other trusted devices.

Example:

Phone → Desktop → Tablet

The vector-clock model prevents duplicate application and allows devices
to determine missing knowledge.


==================================================
22. SYNCHRONIZATION TRIGGERS
==================================================

Synchronization is opportunistic and event-driven.

Synchronization opportunities include:

- application startup
- application foregrounding
- network change
- Wi-Fi availability
- peer discovery
- periodic discovery
- local calendar modification
- manual synchronization request

Startup:

Attempt discovery and synchronization with trusted peers.

Periodic operation:

Periodically discover trusted peers while background operation is active.

Change-triggered synchronization:

Attempt to push pending local changes to available trusted peers.

Changes SHOULD be batched/debounced.

Individual UI edits SHOULD NOT necessarily produce an individual network
transaction.

Unavailable peers do not block local operation.

Pending changes remain locally stored until synchronization becomes possible.


==================================================
23. OFFLINE OPERATION
==================================================

Tide MUST remain fully functional without network connectivity.

Example:

Phone offline
    ↓
Create events
    ↓
SQLite stores state
    ↓
Change records retained
    ↓
Phone joins home Wi-Fi
    ↓
mDNS discovers Desktop
    ↓
Mutual trust verified
    ↓
Encrypted synchronization
    ↓
Desktop receives changes

Network availability MUST NOT be required for calendar operation.


==================================================
24. SERIALIZATION / WIRE FORMAT
==================================================

Initial synchronization serialization format:

JSON

Reasons:

- human-readable
- easy to inspect
- widely supported
- easy to debug
- LLM-friendly
- convenient across TypeScript/native boundaries

The wire format MAY later change for:

- performance
- size
- compatibility
- protocol evolution
- security requirements

Changing serialization format MUST NOT alter the fundamental separation
between local SQLite state and synchronization changes.


==================================================
25. BACKUP / RESTORE
==================================================

Backup is separate from synchronization.

A backup represents recoverable calendar state.

A backup does NOT preserve synchronization identity/history as authoritative
device state.

Restore creates a NEW device identity.

The restored installation MUST:

- generate a new cryptographic keypair
- receive a new device identity
- start with empty synchronization knowledge
- pair again with existing trusted devices

The restored installation MUST NOT reuse the backed-up device identity.

Reason:

The original device may still exist.

Two installations must never legitimately claim the same device identity.

Architectural principle:

"Backup = recover my calendar.
Sync history = disposable infrastructure."


==================================================
26. EXTERNAL CALENDAR FORMATS
==================================================

The internal Tide model is independent of external calendar formats.

Future interoperability may include:

iCalendar / .ics

External calendar formats MUST NOT dictate:

- SQLite schema
- revision model
- vector-clock model
- conflict model
- synchronization protocol

Import/export belongs behind an interoperability boundary.


==================================================
27. LLM DEVELOPMENT ARCHITECTURE
==================================================

The project is intentionally structured for LLM-assisted development.

Architecture MUST favor:

- small modules
- explicit interfaces
- strong typing
- deterministic behavior
- limited hidden state
- automated tests
- low cross-layer coupling
- explicit contracts

An implementation agent should be able to receive a narrowly scoped task such
as:

"Implement event deletion in the repository layer.
Do not modify synchronization."

and determine:

- permitted files
- required interface
- relevant specification
- required tests
- completion criteria

Critical infrastructure requires automated tests.

Particular attention is required for:

- persistence
- date/time
- recurrence
- revision tracking
- vector clocks
- change application
- conflict detection
- tombstones
- device identity
- synchronization
- pairing/security boundaries


==================================================
28. ARCHITECTURAL BOUNDARY
==================================================

The following are architectural boundaries.

Persistence:
    SQLite owns local state.

Domain:
    Calendar semantics live here.

Application:
    Coordinates user-facing operations.

Synchronization:
    Exchanges and applies changes.

Network:
    Discovers and communicates with peers.

Security:
    Owns device identity, authentication, trust, and secure transport.

UI:
    Presents and invokes application behavior.

No layer should silently absorb responsibilities belonging to another layer.


==================================================
29. FROZEN ARCHITECTURAL DECISIONS
==================================================

The following decisions are FROZEN:

[01] SQLite is the local source of truth.

[02] SQLite database files are never synchronized directly.

[03] Synchronization exchanges structured changes.

[04] TypeScript is the preferred UI/application language.

[05] Tauri 2 is the leading application framework.

[06] Native/platform-specific functionality is isolated behind interfaces.

[07] Linux is the first target platform (owner amendment 2026-08-25;
     originally Windows — see §1 amendment note). Windows follows,
     then Android.

[08] mDNS/Bonjour is the primary local discovery mechanism.

[09] Discovery does not imply trust.

[10] QR pairing establishes explicit device trust.

[11] Cryptographic device identity is independent of network identity.

[12] Only mutually trusted devices synchronize.

[13] Synchronization is peer-to-peer.

[14] No central server is required for normal operation.

[15] JSON is the initial synchronization wire format.

[16] Synchronization uses change records rather than database replication.

[17] Device knowledge uses a vector-clock-style model.

[18] Deleted entities use tombstones.

[19] Tombstone compaction is governed by synchronization knowledge.

[20] Full-state synchronization exists as a mechanism for sufficiently stale
     peers.

[21] Silent last-write-wins is not the default conflict policy.

[22] Change records have field-level granularity.

[23] Collection members may merge independently.

[24] Recurrence series and occurrence overrides are separate conflict entities.

[25] Recurring events retain IANA timezone information.

[26] Trust revocation exists.

[27] Trust revocation is eventually consistent.

[28] Backup restoration creates a new device identity.

[29] External calendar formats are isolated from the internal data model.

[30] LLM-assisted development is an explicit architectural consideration.

[31] Design contracts are required before implementing unresolved algorithms.


==================================================
30. NON-ARCHITECTURAL / DEFERRED DECISIONS
==================================================

The following MUST NOT be invented during implementation.

They require dedicated design contracts:

1. Field-level change record schema
2. Vector-clock comparison / merge / advancement
3. Scalar conflict detection
4. Collection merge semantics
5. Recurrence-specific conflict handling
6. Tombstone compaction algorithm
7. Full-state synchronization algorithm
8. Trust-revocation propagation protocol
9. Exact secure-handshake protocol/pattern
10. Exact SQLite schema
11. Exact synchronization message protocol
12. Exact conflict-resolution UI
13. Exact Windows background-process architecture
14. Exact synchronization intervals and batching parameters

These decisions may be made later without changing the frozen architecture,
provided they remain compatible with this document.


==================================================
31. ARCHITECTURAL INVARIANTS
==================================================

The following must remain true regardless of implementation details:

INVARIANT 1:
Calendar functionality works offline.

INVARIANT 2:
SQLite remains authoritative local state.

INVARIANT 3:
SQLite database files are never replicated directly.

INVARIANT 4:
Network discovery never establishes trust.

INVARIANT 5:
Device identity does not depend on network addressing.

INVARIANT 6:
Untrusted devices cannot synchronize.

INVARIANT 7:
Synchronization cannot silently discard concurrent user changes.

INVARIANT 8:
Deleted entities cannot be reintroduced merely because a peer was offline.

INVARIANT 9:
Recurring event semantics preserve timezone information.

INVARIANT 10:
A restored backup cannot create duplicate device identity.

INVARIANT 11:
Synchronization does not require a central server.

INVARIANT 12:
Platform-specific behavior does not leak unnecessarily into domain logic.

INVARIANT 13:
Deferred architectural decisions are not silently invented by implementation
agents.

INVARIANT 14:
Every synchronization operation must be safe under offline, delayed,
duplicated, and reordered communication.


==================================================
32. ARCHITECTURAL SUMMARY
==================================================

Tide is:

A local calendar system with a distributed synchronization layer.

It is NOT:

- a cloud calendar
- a client/server calendar
- database replication over Wi-Fi
- a browser application
- a calendar that trusts network discovery
- a last-write-wins distributed database

The fundamental architecture is:

                ┌──────────────────────┐
                │     TypeScript UI    │
                └──────────┬───────────┘
                           │
                ┌──────────▼───────────┐
                │ Application / Domain │
                └──────────┬───────────┘
                           │
              ┌────────────▼────────────┐
              │     Synchronization     │
              │                          │
              │ Changes / Vector Clocks │
              │ Conflicts / Tombstones  │
              └──────┬──────────┬───────┘
                     │          │
             ┌───────▼─────┐ ┌──▼───────────┐
             │ Network /   │ │ Security /   │
             │ mDNS /      │ │ Trust /      │
             │ Transport   │ │ Cryptography │
             └───────┬─────┘ └──────┬───────┘
                     │              │
                     └──────┬───────┘
                            │
                   ┌────────▼────────┐
                   │     SQLite      │
                   │ Local Authority │
                   └─────────────────┘

This architecture is FROZEN.

Implementation work must proceed through explicit design contracts and
narrowly scoped implementation tasks.

No implementation agent may modify this architecture without explicit
authorization from the project owner.