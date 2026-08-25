# TIDE DESIGN CONTRACT DC-05
# Device Identity, Pairing Ceremony, and Secure Transport
Status: APPROVED by project owner (2026-08-25)
Depends on: Architecture Spec v0.3 §15–§20, §25, §29, §30, §31; DC-01 §7;
            DC-02 §4
Unblocks: sync protocol implementation, network/transport layer,
          trust-revocation propagation (deferred decision #8)
Resolves: deferred decision #9 from Spec §30
          (exact secure-handshake protocol/pattern)

==================================================
1. PURPOSE
==================================================

Defines the concrete cryptographic design for:

  - persistent per-installation device identity (Spec §15)
  - the local trust store and mutual-trust gate (Spec §18)
  - the QR pairing ceremony and its authenticated handshake (Spec §17)
  - session transport security for all post-pairing traffic (Spec §20)
  - authenticated trust revocation records (Spec §19)

HARD CONSTRAINT (Spec §17): "Custom cryptographic primitives MUST NOT be
implemented." Every cryptographic operation in this contract is performed
by an established, widely audited library using standard constructions.
No hand-rolled ciphers, hashes, KDFs, signatures, or handshake logic.

This contract defines SEMANTICS AND REQUIREMENTS ONLY. It does not define
mDNS service details, wire framing, SQLite schema, revocation propagation
algorithms, or identity rotation mechanics (see §11).

==================================================
2. DEVICE IDENTITY
==================================================

2.1  Keypair generation

     Each Tide installation generates exactly one Ed25519 keypair at
     first launch, before any network activity.

     Recommended libraries (established only):
       - Rust / Tauri-native side (PRIMARY owner of all key operations):
           ed25519-dalek v2 (+ rand_core OS rng), OR
           libsodium via libsodium-sys / sodiumoxide APIs
             (crypto_sign_keypair / crypto_sign_detached)
       - TypeScript side (if ever needed, e.g. fingerprint display):
           @noble/ed25519 + @noble/hashes, OR libsodium.js
             (crypto_sign APIs)
     The TypeScript side MUST NOT generate or store keys; all signing,
     verification of stored material, and key custody live in the Rust
     layer behind a Tauri command interface (Spec [06]).

2.2  device_id derivation

         device_id = "d-" + hex( SHA-256( raw_ed25519_public_key ) )

     - Deterministic: same public key always yields the same device_id.
     - Collision-resistant: SHA-256 preimage/collision resistance.
     - No PII: derived solely from key material. Never from IP address,
       hostname, MAC address, OS install ID, timestamps, or user input
       (Spec [11], DC-01 §7).
     - Stable forever for the life of the installation; regenerated only
       when a new keypair is generated (backup restore — Spec §25).

2.3  Key storage policy

     Preference order:
       1. OS-protected credential storage where available:
          Windows Credential Manager / DPAPI-protected file (primary
          target platform); Android Keystore; libsecret/keyring on Linux.
       2. Fallback (no OS keystore available): private key stored in an
          application-data file with restrictive filesystem permissions
          (owner-only), documented as weaker protection in the threat
          model (§8). Fallback MUST be logged at pairing time so users
          can see their protection level.

     The private key NEVER leaves the device, is never synchronized, and
     is never included in backups (Spec §25: restore = new identity).

2.4  Identity/addressing independence (INVARIANT 5)

     Identity structures (device_id, public key, trust entries) MUST NOT
     contain or be influenced by: IP address, port, hostname, interface
     name, MAC address, mDNS instance name. Network addresses appear
     ONLY in ephemeral connectivity hints (§5.2) marked UNTRUSTED, never
     in persisted identity or trust data.

==================================================
3. TRUST STORE
==================================================

3.1  Peer entry structure

     Local durable list of known peers. Entry fields:

         device_id    string   derived per §2.2
         public_key   bytes    Ed25519 public key; MUST hash to
                               device_id (verified on load)
         display_name string   user-assigned label ("Alice's Phone")
         paired_at    integer  UTC ms when pairing completed
         status       enum     "trusted" | "revoked"

     Storage mechanism = deferred decision #10 (SQLite schema). The
     trust store MUST be durable across restarts. The trust store lives
     in the Security layer; Sync and Network layers access it only
     through the gate function (§3.3).

3.2  Case A/B/C semantics as enforceable rules (Spec §18)

     Synchronization requires MUTUAL trust (Spec [12]):
       Case A: A trusts B, B does not trust A -> NO synchronization.
               A connection attempt from an untrusted peer is refused
               before any application payload is exchanged.
       Case B: both trust each other            -> synchronization OK.
       Case C: neither trusts the other         -> ignore silently.
               Discovery events create NO state and NO log noise beyond
               debug level.

3.3  Gate function (authoritative pseudocode)

     remoteClaim = { device_id, public_key } asserted by the peer during
     handshake after channel binding (§6.3).

         function canSynchronize(localTrust, remoteClaim):
             entry = localTrust[remoteClaim.device_id]
             if entry == absent:            return DENY_UNPAIRED      // Cases A/C
             if hash(remoteClaim.public_key) != idDigest(entry.device_id):
                                            return DENY_KEY_MISMATCH  // impostor
             if entry.status == "revoked":  return DENY_REVOKED
             if entry.public_key != remoteClaim.public_key:
                                            return DENY_KEY_MISMATCH
             // local trusts remote. Remote's mirror check happens on the
             // peer running the same function symmetrically; the handshake
             // completes only if BOTH sides pass.
             return ALLOW

     Rule: no code path may exchange any change record, clock state, or
     trust metadata except downstream of canSynchronize returning ALLOW
     on BOTH devices (DC-02 §4: clock merge only over authenticated
     channels).

==================================================
4. CRYPTOGRAPHIC CHOICE — ANALYSIS AND DECISION
==================================================

Candidates considered:

  Option 1: Noise Protocol Framework, implemented via `snow` (Rust)
  Option 2: TLS 1.3 with client certificates (rustls)

Decision: PRIMARY = Noise_XX pattern via the `snow` crate.

Justification:
  - Noise is purpose-built for peer-to-peer mutual authentication with
    static long-term keys and no certificate authority — exactly Tide's
    model. TLS 1.3 client certs assume a PKI-style deployment; managing
    self-signed certs, SANs, and cert parsing adds surface without
    adding guarantees here.
  - Noise_XX exchanges and authenticates both static keys inside the
    handshake transcript itself, giving natural channel binding to the
    QR-exchanged keys (§6.3).
  - `snow` is the established, audited Rust reference implementation;
    we use its standard patterns only (no custom handshake composition
    beyond choosing a published pattern).
  - TLS 1.3 remains an ACCEPTED ALTERNATIVE if a platform constraint
    forces it, provided the binding requirements of §6.3 are met by
    comparing client-cert public keys against the QR-announced key.
    Any deviation requires a new contract revision.

Pattern choice within Noise: XX vs KK.
  - KK assumes both static keys are KNOWN to each other beforehand.
    The QR code already delivers the initiator's static key out-of-band,
    but the responder's key is NOT yet known to the initiator (the
    initiator displays the QR; it cannot embed the responder's key).
    Therefore full pre-knowledge does not exist at handshake time.
  - DECISION: Noise_XX (both sides transmit static keys encrypted under
    progressively derived handshake keys). The initiator's static key
    transmitted in XX is verified against the key announced in the QR
    (§6.3), which recovers the security KK would have offered while
    remaining correct for the actual information flow.
  - Cipher suite (fixed for v1): Noise_XX_25519_ChaChaPoly_SHA256.
    Identity keys are Ed25519; snow operates on Curve25519 DH keys.
    Standard practice applies: each device derives its static
    Curve25519 DH keypair deterministically from the Ed25519 key using
    a standard conversion (SHA-512 clamped Ed25519->X25519 conversion,
    as used by established libraries e.g. libsodium
    crypto_sign_ed25519_pk_to_curve25519 / libsodium-sys equivalent),
    performed entirely inside the established library. The QR announces
    the Ed25519 identity key; the X25519 static key is bound to it by
    this deterministic conversion and verified accordingly (§6.3).

==================================================
5. PAIRING CEREMONY (QR)
==================================================

Conceptual flow is fixed by Spec §17. Concrete specification:

5.1  QR pairing payload

     UTF-8 JSON, encoded as QR:

     {
       "v":        1,                          // payload version
       "device_id": "<d-...>",                 // initiator's identity
       "public_key": "<base64 ed25519 pk>",    // initiator's identity key
       "nonce":     "<base64, >=128 bits fresh random>",
       "connect": {                            // OPTIONAL, UNTRUSTED
         "ip":   "<address>",                  // connectivity hint ONLY
         "port": <port>
       },
       "name":    "<optional self-label>"      // suggestion, not trust
     }

     Rules:
       a) nonce MUST be fresh per ceremony (CSPRNG); never reused.
       b) connect.* is UNTRUSTED connectivity information. It may be
          stale or hostile (attacker-supplied QR); the scanner treats
          it as a hint only and MUST NOT derive any trust from it.
       c) The payload is NOT itself authenticated at scan time —
          authentication comes from the handshake binding + fingerprint
          confirmation (§5.4, §6.3). Tampering detection is defined in
          §7/TR-9.

5.2  Connection establishment

     Scanner connects to the hinted address (or to a discovered endpoint
     matching nothing but network-level criteria — discovery confers no
     trust, Spec [08]/[09]). Over this TCP connection the two devices
     run the Noise_XX handshake (§4) as the transport handshake.

5.3  Handshake roles

     QR displayer = Noise INITIATOR; scanner = RESPONDER (roles chosen
     arbitrarily; symmetry holds because XX authenticates both statics).

5.4  Mutual confirmation (fingerprint / safety number)

     Before either device stores a trusted-peer entry, BOTH UIs display
     and BOTH humans compare a short safety number:

         safety_number = decimal digits of
             SHA-256( concat( sort( [pkA_bytes, pkB_bytes] ) ) )[0..40]
         rendered as five groups of 8 digits

     (Same construction on both sides; sorting makes it symmetric.)
     Pairing proceeds to trust storage only when both users confirm the
     numbers match. Mismatch aborts; no trust entry is written.

==================================================
6. CHANNEL BINDING AND SESSION TRANSPORT
==================================================

6.1  Post-handshake verification steps (explicit)

     After Noise_XX completes, each party executes ALL of:

     V1  remote_static_identity =
             X25519_to_Ed25519(remote static s) per §4 conversion
     V2  If this party was the SCANNER:
             verify V1 == QR payload public_key (byte compare).
             Failure => abort, delete any partial state.
         If this party was the DISPLAYER:
             verify V1 matches our own identity key knowledge of what
             we announced (sanity/self-check); the scanner-side QR
             comparison is the authoritative OOB binding.
     V3  Compute transcript_hash = handshakehash from snow and mix it
         into the confirmation step: the displayed safety number of
         §5.4 is additionally HMAC'd with the handshake hash so that a
         MITM who substituted keys produces DIFFERENT safety numbers on
         the two screens even if the human comparison were skipped.
     V4  Only then run canSynchronize (§3.3) against the verified claim.

6.2  Session keys

     All post-pairing synchronization traffic runs over the Noise
     transport cipher state derived from the same handshake (ChaCha20-
     Poly1305, replay-protected by snow's nonce handling). Rekeying
     follows snow's standard mechanisms; specifics belong to the sync
     protocol contract.

6.3  Fail-closed rules

     - No plaintext fallback. If a secure session cannot be
       established, the connection is dropped.
     - Protocol/version downgrade attempts fail closed: unknown or
       lower version => refuse connection.
     - Any verification failure (V1–V4) aborts with zero trust-store
       mutation.
     - Sessions exist only between mutually trusted devices; a session
       that has not completed §6.1 cannot carry ANY change record
       (INVARIANT 6; DC-02 §4).

==================================================
7. TRUST REVOCATION
==================================================

Per Spec §19 ([26], [27] — exists, eventually consistent):

7.1  User action

     User revokes a device on any trusted device. That device sets the
     peer entry status="revoked" locally and creates a signed revocation
     record:

         revocation_record = {
           "v": 1,
           "revoked_device_id": "<d-...>",
           "revoked_by_device_id": "<d-...>",
           "revoked_at_hlc": <hlc>,
           "reason": "<optional free text>"
         }
         signature = Ed25519 sign(revocation_record bytes,
                                  revoking device's private key)

7.2  Authentication requirement

     Revocation records are synchronizable metadata carried over
     authenticated sessions like any change. A record is accepted only
     if:
       a) revoked_by_device_id is a locally TRUSTED peer, and
       b) the signature verifies under that peer's stored public key.
     A revoked device CANNOT forge valid revocations of others, and
     CANNOT un-revoke itself: status transitions accepted over the mesh
     are trusted->revoked only; a record signed by the revoked device_id
     claiming restoration is ignored (it is not signed by a distinct
     trusted revoker and conflicts with the existing record).

7.3  Enforcement rule (precise)

     - A device refuses new sync sessions with any peer whose latest
       known status is "revoked" (canSynchronize returns DENY_REVOKED).
     - Change records whose producing device_id is locally known-
       revoked are rejected on arrival, not applied.
     - Propagation algorithm details (how records travel the mesh) ->
       deferred decision #8 / sync protocol contract.
     - ACCEPTED v1 LIMITATION (Spec §19): a peer that has not yet
       LEARNED the revocation may temporarily continue syncing with the
       revoked device. This window closes once the record arrives; no
       global real-time guarantee exists in v1.

==================================================
8. THREAT MODEL
==================================================

Protected against (v1):

  T1  Passive LAN eavesdropper: all traffic encrypted + integrity
      protected (Noise ChaChaPoly). Nothing readable.
  T2  Active MITM during pairing: attacker intercepts the TCP flow and
      substitutes keys. Noise_XX detects substitution (handshake MAC
      failure) OR, if the attacker relays honestly but re-encrypts to
      themselves with substituted statics, the two safety numbers
      differ (V3 binds them to the transcript + true keys) and/or the
      scanner's QR key comparison fails. Fails closed.
  T3  Impostor device without QR-established trust: cannot pass
      canSynchronize; handshake with an unknown peer yields
      DENY_UNPAIRED / DENY_KEY_MISMATCH; no payload exchanged.
  T4  Replay of recorded sync traffic: AEAD nonces + Noise transport
      state reject replayed/reordered ciphertext.
  T5  Forged revocation by the revoked device: rejected (§7.2).

Explicitly NOT covered (v1):

  N1  Compromised endpoint: malware on a trusted device sees plaintext
      and holds the private key. Out of scope.
  N2  Post-revocation pre-propagation window (§7.3): accepted v1
      limitation per Spec §19/[27].
  N3  Weak-fallback key storage (§2.3 case 2): local attacker with disk
      access may extract the key. Documented, accepted for platforms
      lacking OS keystores.
  N4  Denial of service (jamming mDNS, connection flooding): availability
      attacks are out of scope for v1.
  N5  Quantum adversaries: Ed25519/X25519 classical security only.

==================================================
9. TESTABLE REQUIREMENTS
==================================================

TR-1  device_id derivation determinism/stability: deriving device_id
      from the same public key N times yields identical results;
      different public keys yield different device_ids (property test
      over >=1000 random keys).
TR-2  No network-derived identity: static analysis (grep/lint rule +
      unit test) proves no identity/trust structure contains or is
      computed from IP, hostname, MAC, interface name, or mDNS name
      (DC-01 §7, INVARIANT 5).
TR-3  Unpaired device exclusion: a discovered-but-unpaired peer that
      initiates a handshake receives DENY_UNPAIRED; zero change
      records, clock state, or trust metadata are exchanged; no trust
      entry is created (Cases A/C, INVARIANT 6).
TR-4  One-sided trust exclusion (Case A): A trusts B, B wiped its trust
      of A => no session carries payloads; both sides deny.
TR-5  MITM simulation: automated test inserts an attacker proxy that
      substitutes its own static key into the handshake => handshake
      aborts or the post-handshake verifications V1–V3 fail; both
      devices end with unchanged trust stores and no session.
TR-6  Fingerprint mismatch aborts pairing: test drives two devices
      through pairing with a key-substituting MITM and confirms the UIs
      display DIFFERENT safety numbers and that confirming mismatch
      (simulated user error path is impossible; programmatic mismatch
      detection) writes no trust entry.
TR-7  Session gating: a socket/session that has not completed the
      authenticated handshake + canSynchronize=ALLOW cannot deliver any
      change record; injected frames are discarded and logged
      (INVARIANT 6; DC-02 §4 precondition).
TR-8  Downgrade/plaintext refusal: client attempting protocol downgrade
      or plaintext connection is refused; no fallback path exists
      (code inspection test asserts absence of unencrypted send path).
TR-9  QR tampering detected: mutating any field of the QR payload
      (device_id, public_key, nonce, version) causes either scan-time
      validation failure or handshake/binding failure; the tampered
      value never enters the trust store. Swapping the public_key
      specifically trips TR-5 behavior.
TR-10 Nonce freshness: two consecutive pairing ceremonies produce
      different nonces; reuse of a nonce in a crafted payload is
      detectable and rejected.
TR-11 Revocation stops sync once learned: after a device processes a
      valid revocation record, subsequent connection attempts from the
      revoked peer return DENY_REVOKED and its arriving changes are
      rejected (Spec §19, INVARIANT 6 extension).
TR-12 Revocation forgery rejected: a revocation record signed by the
      revoked device, by an unknown key, or over modified fields fails
      verification and is discarded without state change.
TR-13 Trust-store consistency: every stored peer entry satisfies
      SHA-256(public_key) digest == device_id at load time; corrupt
      entries cause a fail-closed load error, not silent acceptance.

==================================================
10. OUT OF SCOPE
==================================================

- mDNS service naming/TXT/details        -> deferred decision under the
                                            network layer; separate contract
- Sync message framing/envelope           -> deferred decision #11
- Exact SQLite schema incl. trust tables  -> deferred decision #10
- Revocation propagation algorithm        -> deferred decision #8 /
                                            sync protocol contract
- Backup/restore identity rotation        -> Spec §25 statement stands
                                            (new keypair, re-pair);
                                            mechanics deferred, separate
                                            contract if needed
- Conflict-resolution semantics           -> DC-03/DC-04
- Rekey intervals, session timeouts       -> sync protocol contract

==================================================
11. OPEN ITEMS OWNED ELSEWHERE
==================================================

- How revocation records ride the sync mesh          -> deferred #8/#11
- Exact Tauri command surface exposing key ops to TS -> implementation
- Platform keystorage adapters (Win/Android/Linux)   -> implementation,
  constrained by §2.3 preference order
- UX copy for safety-number screens                  -> UI task
