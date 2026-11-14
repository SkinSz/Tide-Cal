# TIDE DESIGN CONTRACT DC-05
# Device Identity, Pairing Ceremony, and Secure Transport
Status: APPROVED by project owner (2026-08-25)
AMENDED v2 by project owner (2026-11-14). See Appendix A; supersedes
        §7.1/§7.3 where they conflict.
AMENDED v3 by project owner (2026-11-14). See Appendix B; supersedes
        §5.1, §5.3 and §6.1 V2 where they conflict.
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

==================================================================
APPENDIX A — v2 AMENDMENT (owner-approved 2026-11-14, via DC-27)
==================================================================

A.1  §7.1: a signed revocation record gains the field
     "revoked_after_seq": the highest seq of the revoked device that the
     revoking device had applied when it signed. It is covered by the
     signature.
A.2  §7.3: a change record produced by a known-revoked device is
     accepted when its seq <= revoked_after_seq (legitimate history,
     including history relayed later) and rejected when seq >
     revoked_after_seq. With several revocations of the same device, the
     HIGHEST cutoff held applies.
A.3  Rationale and test requirements: DC-27 §4.14, TR-8, TR-12. Older
     builds' handling of the new signed field is an implementation-time
     verification item (DC-27 V11).


==================================================================
APPENDIX B — v3 AMENDMENT: CODE BINDING AND PROOF OF THE CODE
             Status: APPROVED by project owner (2026-11-14), with
             the changes recorded in B.D below.
==================================================================

Problem. Two gaps in the ceremony as implemented (src/network/
pairing_manager.ts, src/security/pairing.ts at the time of writing;
found by source reading, no exploit probe run):

  G1  The scanner (the device the code is pasted into) runs §6.1 V2
      against the payload the connected party sent over the encrypted
      channel, not against public_key of the pasted code, and then
      stores trust for the PASTED identity. Whoever answers at the
      hinted address completes the ceremony with any key it likes.
      §6.1 V2 requires the comparison with the pasted code. Tracked
      as TD-049 in docs/technical-debt.md.
  G2  The displayer (the device showing the code) sends its encrypted
      payload, including its saved name (DC-28 §4.5), to any party
      that completes a Noise handshake on the open offer port, before
      it knows that party holds the code. Tracked as TD-051 in
      docs/technical-debt.md.

Related observations that this appendix also closes:

  G3  Neither side runs the received encrypted payload through a
      strict decoder; it is used as cast. A null or non-object frame,
      extra fields, or a device_id that is not derived from public_key
      are not rejected.
  G4  decodePairingPayload checks only the FORMAT of device_id, not
      that device_id = "d-" + hex(SHA-256(public_key)) (§2.2). A code
      with a mutated device_id and an intact key is not rejected by
      the decoder (TR-9, TR-13).
  G5  The displayer consults the revocation store and may answer
      PAIRING_REFUSED (DC-27 Appendix A.2) for any connector, so a
      party without the code can learn whether an id is revoked here.
  G6  One failed ceremony closes the whole offer, so any connector
      that completes a Noise handshake and then fails ends a user's
      offer. (A failed handshake does not: the listener destroys
      that socket without starting a ceremony.)

Terms used below:
  displayer   the device that created the offer and shows the code;
              it LISTENS on the offer port.
  scanner     the device the code is pasted (or scanned) into; it
              CONNECTS to the hinted address.
  code        the §5.1 payload as shown and pasted.
  ceremony payload
              the payload each side sends over the encrypted channel
              after the handshake.
  h           the Noise handshake hash of the session (§6.1 V3).
  secret      the one-time pairing secret defined in B.2.

B.1  SCANNER BINDS THE SESSION TO THE CODE (owner decision, BINDING)

     After the Noise handshake and BEFORE sending any frame, the
     scanner verifies:

         S1  remote_static == X25519(code.public_key)     (§4, §6.1 V2)

     After receiving the displayer's ceremony payload P (B.4) and
     BEFORE sending its own payload, the scanner verifies:

         S2  P.device_id  == code.device_id
         S3  P.public_key == code.public_key  (decoded bytes compared)

     Any failure aborts the ceremony: the scanner sends nothing more
     (in particular no proof on S1 failure, no own payload and no own
     name on S2/S3 failure), closes the connection, and writes no
     trust entry (§6.3). The identity stored on success is the code
     identity, which by S1-S3 equals the session identity.

     This supersedes the wording of §6.1 V2 for the scanner only in
     that it adds S2/S3 and fixes the point in time (before any send).

B.2  ONE-TIME SECRET IN THE CODE (owner decision, BINDING; format
     PROPOSAL P1, P2)

     Each offer generates a fresh secret from a CSPRNG. It is carried
     in the code and nowhere else:

       - held in memory only, never persisted, never logged, never
         sent over the network (only the proof of B.3 is sent);
       - single use: consumed by the first valid proof (B.5);
       - destroyed when the offer ends for any reason: success,
         failure, cancel, a newer offer, invalidation (B.6), expiry
         (B.6), shutdown. Destroying means dropping every reference
         and overwriting the buffer where the runtime allows it
         (best effort, see VB-6).

     PROPOSAL P1 (size and encoding). Recommended: 16 bytes (128
     bits), standard base64 with padding, canonical (24 characters),
     validated by the same strict base64 rule as public_key and
     nonce; exactly 16 decoded bytes, otherwise the code is
     rejected. Field name "secret". 128 bits is the floor: a proof
     sent to a wrong party must not let that party recover the
     secret offline (B.3 prevents sending it to a wrong party; the
     floor covers implementation slips).
     Alternative: 32 bytes (44 characters); no security need for
     it given single use and no offline exposure.

     PROPOSAL P2 (code version). Recommended: the code becomes
     "v": 2 with this canonical key order:

         {
           "v":          2,
           "device_id":  "<d-...>",
           "public_key": "<base64 ed25519 pk>",
           "nonce":      "<base64, >=128 bits>",
           "secret":     "<base64, exactly 16 bytes>",
           "connect":    { "ip": "<address>", "port": <port> }
         }

       - "secret" and "connect" are REQUIRED in a v2 code (a code
         without an address cannot start a ceremony today).
       - "name" is NOT allowed in a v2 code (EXTRA_FIELD). DC-28 P5
         already omits it; no v2 code with a name exists, so the
         compatibility allowance of DC-28 §4.5 does not carry over.
       - device_id MUST equal "d-" + hex(SHA-256(public_key)),
         checked at decode time (closes G4; new error code, e.g.
         ID_KEY_MISMATCH).
       - "nonce" keeps its §5.1 meaning.
     Alternative: keep "v": 1 and reuse "nonce" as the secret. Zero
     length cost, but an old code then looks valid to a new build
     and an old displayer never asks for a proof, so a new scanner
     cannot tell whether the other side enforces it. Not
     recommended.

     Length impact (illustrative, IPv4 hint, typical lengths):
       code without "name" today (v1)     about 239 characters
       code with "secret" (v2)            about 275 characters (+36)
     Today the code also carries "name" (about 20-35 more
     characters); DC-28 P5 removes it. The code is pasted text; it
     is never typed by hand. If a QR rendering is added later, its
     capacity is checked then (VB-5).

B.3  PROOF OF THE SECRET (owner decision, BINDING: bound to h,
     constant-time comparison; construction PROPOSAL P3)

     PROPOSAL P3. Recommended construction (standard HMAC, no new
     primitive, Spec §17):

         label = ASCII "tide-pairing-proof-v2" || 0x00
         proof = HMAC-SHA256(key = secret, data = label || h)

     where h is this session's handshake hash, obtained the same way
     §6.1 V3 obtains it. Both ends of one Noise session hold the
     same h (VB-1); two different sessions have different h. A party
     that relays between two sessions therefore cannot reuse a proof
     from one session in the other, and a recorded proof is useless
     in any later session.

     The scanner sends the proof as its FIRST frame on the encrypted
     channel, only after S1 passed:

         {"kind": "PAIRING_PROOF", "proof": "<base64, 32 bytes>"}

     The displayer accepts the frame only if ALL hold:
       - it is a JSON object with exactly the keys "kind" and
         "proof", kind == "PAIRING_PROOF";
       - proof is canonical base64 of exactly 32 bytes;
       - the offer's secret is still alive (not consumed, not
         destroyed);
       - constant-time equality of the received proof with the proof
         the displayer computes from its own secret and its own h.
         The comparison runs only on equal-length buffers (length is
         checked first; VB-2). No string or early-exit comparison is
         used anywhere on the proof.

B.4  WHAT THE DISPLAYER DOES BEFORE A VALID PROOF (owner decision,
     BINDING; ordering PROPOSAL P4, P10)

     Until a valid proof has been accepted on a connection, the
     displayer, on that connection:
       - sends NO application frame: no ceremony payload, no name, no
         PAIRING_REFUSED, no error code, no PAIRING_OK;
       - parses no ceremony payload, records no nonce in the TR-10
         memory, and consults neither the trust store nor the
         revocation store (closes G5);
       - on a wrong, malformed, oversize or missing proof: closes the
         connection without a message, and logs one fixed line with a
         counter only, for example
             "[tide] pairing: connection without valid proof closed (2)"
         The line never contains the secret, the proof, h, the remote
         key or the remote address.

     PROPOSAL P4 (frame order after the proof). Recommended: keep
     today's order unchanged after the proof:

         scanner   -> PAIRING_PROOF
         displayer -> ceremony payload (with own name, DC-28 §4.5)
         scanner   -> ceremony payload (after S2/S3 passed)
         displayer -> PAIRING_OK | PAIRING_REFUSED
     Smallest change; both sides still see both payloads (§5.2).
     Alternative: the scanner sends proof and payload in one frame.
     Saves one message, changes more code, no security gain.

     PROPOSAL P10 (DC-27 Appendix A.2 ordering). A.2 says the
     refusal is sent "before any check or trust write". Recommended
     reading on the displayer, in this order after a valid proof:
         1. strict decode of the ceremony payload (B.7);
         2. DC-27 A.2 revocation refusal;
         3. binding checks (§6.1 V2 displayer side, V3) and trust.
     The refusal therefore reaches only a party that holds the code.
     Recorded under B.12 for DC-27 to confirm.

B.5  SINGLE USE (owner decision, BINDING; details PROPOSAL P5)

     The first valid proof consumes the secret at once, in the same
     synchronous step that verifies it, so two connections cannot
     both succeed. At that moment the displayer:
       - stops accepting new connections on the offer port;
       - closes every other open connection of this offer without a
         message (counted as in B.4 only if they had sent a wrong
         proof);
       - destroys the secret (B.2).
     If the ceremony fails after the proof (S2/S3, V2, V3, refusal,
     store error), the offer is over and a new code is needed.

     PROPOSAL P5. Recommended as stated. Alternative: keep the
     secret alive until the ceremony succeeds. Not recommended: it
     lets a party that holds the code retry after a failure.

B.6  BOUNDS ON AN OPEN OFFER (PROPOSAL P6, P7, P8)

     The secret has 128 bits, so guessing it online is not a
     realistic attack; these bounds limit how long a leaked code
     stays usable and keep stray connections from holding the offer
     open. Denial of service stays out of scope (§8 N4).

     PROPOSAL P6 (proof wait). Recommended: a connection that has
     completed the handshake must deliver its proof frame within
     10 s, otherwise it is closed as in B.4 and counted as a bad
     proof. A connection that fails the Noise handshake is closed as
     today and is NOT counted. Together with P7 this replaces G6
     (today one post-handshake failure ends the offer).

     PROPOSAL P7 (invalidation). Recommended: after 3 bad proofs the
     offer ends: the listener closes, the secret is destroyed, and
     the displayer's UI shows that the code is no longer valid
     (wording in P13). A single bad proof is silent towards the
     user. Alternative: end the offer on the first bad proof (as
     G6 does today for any failure). Not recommended: any device on
     the network could then cancel every offer with one connection.

     PROPOSAL P8 (offer lifetime). Recommended: an offer ends 10
     minutes after it was created, with the same effect as P7.
     Comparable to the validity window of a one-time password.
     Alternative: no lifetime (today; the offer lives until used,
     cancelled or superseded).

B.7  VALIDATION OF THE CEREMONY PAYLOAD (owner decision, BINDING;
     schema PROPOSAL P9)

     Both sides decode the received ceremony payload with a strict
     decoder before using any field. Failure aborts with zero
     trust-store mutation (§6.3), and the scanner sends nothing more.

     PROPOSAL P9. Recommended schema:

         {
           "v":          2,
           "device_id":  "<d-...>",
           "public_key": "<base64 ed25519 pk, 32 bytes>",
           "nonce":      "<base64, >=128 bits>",
           "name":       "<optional, DC-28 §4.8 rules>"
         }

       - the received frame must be a JSON object (null, arrays,
         numbers, strings and a closed channel abort);
       - no other key; in particular "secret" and "connect" are
         rejected (EXTRA_FIELD);
       - device_id MUST equal "d-" + hex(SHA-256(public_key));
       - "name" is handled by DC-28 §4.5/§4.8 (an invalid name is
         dropped, pairing continues); it never affects identity.

     Checks after decoding:
       scanner    S2, S3 of B.1.
       displayer  §6.1 V2 for the displayer becomes a real binding:
                  remote_static == X25519(P.public_key); mismatch
                  aborts. The proof (B.3) shows that the peer holds
                  the code; this check shows that the payload's
                  identity is the session's identity.
     Only after these checks does the TR-10 nonce memory record
     P.nonce.

B.8  WHAT THE SECRET DOES AND DOES NOT REPLACE (DC-27 O4)

     Today both sides auto-confirm the §5.4 safety number (a
     TODO(ui) in pairing_manager.ts); no human compares the screens.

     With B.1-B.7, a party WITHOUT the code:
       - cannot pair with the scanner: S1 fails, because it cannot
         present the displayer's key;
       - cannot pair with the displayer: it cannot produce the proof;
       - learns nothing at the application layer (B.4).
     Against this party the auto-confirm no longer leaves a gap.

     A party that HAS the code (seen on screen, read from a shared
     clipboard, or copied from the channel used to move the code
     between two desktops, such as a chat or e-mail) and is on the
     network:
       - can pair with the displayer as itself if it proves first;
         the real scanner then fails (the secret is consumed);
       - still cannot pose as the displayer to the scanner (S1).
     A party that can REPLACE the code in transit (for example in
     that chat or e-mail) with a code of its own pairs the scanner
     with itself: S1 passes against the substituted key and the
     secret is the attacker's own. §5.1 b)/c) already concede that
     the code is not authenticated at scan time.

     Only a human comparison of the safety numbers detects these
     cases at pairing time; afterwards the unexpected entry is
     visible in Paired Devices and can be unpaired (DC-27). The
     secret does NOT replace the comparison.

     DEFERRED, owned by DC-05 / pairing UI (unchanged from DC-27
     O4): show both safety numbers and require the user to confirm
     the match. PROPOSAL P12: keep deferred. TRIGGER CONDITIONS
     (any one):
       - a user report of an unexpected paired device;
       - a QR or camera path, or any built-in way to send a code
         to another device, is added;
       - the Devices dialog's pairing flow is next redesigned.

B.9  RESIDUALS (proposed for acceptance, PROPOSAL P14)

     R1  Noise handshake disclosure. In the implementation the
         displayer is the Noise RESPONDER (it listens), so it sends
         its static key in handshake message 2 to any party that
         connects, before any proof can run. A connector without
         the code therefore learns the displayer's X25519 static
         key. The key is the same on every connection, so it
         identifies the device; it is not a secret and confers no
         trust (§3.3). The standing sync listener runs the same
         handshake with the same identity (sidecar listener built on
         serveSync), so it discloses the same key whenever it is
         reachable; the offer port adds no new kind of exposure.
         Mirror case: the scanner, as Noise INITIATOR, sends its own
         static key in handshake message 3 to whoever answers at the
         hinted address, before S1 can abort.
     R2  A party that holds or replaces the code (B.8).
     R3  Denial of service on the offer port (§8 N4); P6-P8 bound
         it, they do not prevent it.

     PROPOSAL P14. Recommended: accept R1 as stated; "learns
     nothing" in this appendix means nothing at the application
     layer. Alternative: a Noise PSK pattern keyed by the secret,
     which would hide the handshake from parties without the code.
     Not recommended now: it changes the §4 suite, and support in
     the Noise library used is unverified (VB-7).

     Threat model (open source). The attacker reads this contract
     and the code: the label, the frame format, P6-P8 and the log
     line are public. Secrecy rests only on the per-offer secret.
       - Pacing gains nothing: the bad-proof counter never resets
         within an offer, and every offer has a fresh secret.
       - Bursting at line rate ends the offer after P7 connections:
         an availability effect only (N4); the user creates a new
         code.
       - Every protection here is self-clearing: it lives and dies
         with one offer. Nothing is durable or needs the user to
         clear it.

B.10 COMPATIBILITY (PROPOSAL P2; text PROPOSAL P13)

     Recommended: fail closed in every mixed case. A downgrade to
     an unproven ceremony is refused (§6.3).

       code / builds                        result
       ---------------------------------    -------------------------
       v2 code into an older build          refused at paste by the
                                            older decoder (EXTRA_FIELD
                                            or BAD_VERSION; VB-3); no
                                            connection
       v1 code into a newer build           refused at paste
                                            (BAD_VERSION); no
                                            connection
       older scanner reaching a newer       sends no proof; closed
       displayer (hand-edited code)         after P6 wait, counted
       newer scanner reaching an older      only with a hand-made v2
       displayer                            code: the older displayer
                                            sends its v1 payload
                                            first; the newer scanner
                                            rejects it at the B.7
                                            decode (BAD_VERSION) and
                                            sends nothing more (VB-8)

     Existing pairs and sync sessions are not affected: this
     appendix changes the pairing ceremony only. Both devices must
     run a newer build to pair a NEW device.

     DECIDED P13 (user-visible text, no internal terms): one text
     for every refused code (older format, expired, used up, ended
     by P7/P8, or malformed):
         "This pairing code is no longer valid. Create a new one."

B.11 HANDSHAKE ROLES (§5.3) (PROPOSAL P11)

     §5.3 says the displayer is the Noise INITIATOR. The
     implementation does the reverse: the displayer listens and is
     the RESPONDER, the scanner connects and is the INITIATOR
     (src/network/sync_runtime.ts, serveSync / connectSync). XX
     authenticates both static keys either way, and nothing in this
     appendix depends on the Noise role; all rules name the
     ceremony role (displayer, scanner).
     PROPOSAL P11. Recommended: amend §5.3 to the implemented roles
     (displayer = responder, scanner = initiator). Alternative:
     change the code to match §5.3; no benefit, larger change.

B.12 OPEN ITEMS OWNED ELSEWHERE

     OB-1  DC-27 Appendix A.2: confirm the ordering of P10 (refusal
           after the proof and the strict decode, before binding).
     OB-2  DC-28 §4.5: the "name" compatibility allowance applies to
           v1 codes only; v2 codes reject "name" (P2).
     OB-3  DC-27 O4: the safety-number UI (B.8, P12).

B.13 IMPLEMENTATION-TIME VERIFICATION (not asserted as facts)

     VB-1  Both ends of one session obtain byte-identical h from the
           Noise library's handshake-hash call, and the call happens
           before the handshake state is freed; two sessions yield
           different h.
     VB-2  The constant-time comparison function in the runtime
           (e.g. node:crypto timingSafeEqual) and its behaviour on
           unequal lengths; lengths are checked before calling it.
     VB-3  The last released build rejects a v2 code at paste
           (expected from the current decoder's version and
           extra-field rules); check against the installed package.
     VB-4  Closing the offer listener stops new connections and
           leaves the accepted ceremony connection open.
     VB-5  If a QR rendering is added: capacity at the chosen error
           correction level for a ~275-character code.
     VB-6  Whether the secret buffer can be overwritten in place in
           the runtime; otherwise "destroy" means dropping all
           references.
     VB-7  Whether the Noise library used supports a PSK pattern
           (relevant only if R1's alternative is ever taken up).
     VB-8  The newer scanner's order with an older displayer: S1
           passes, the first frame received is not a proof
           acknowledgement but a v1 payload, and the scanner aborts
           at decode after having sent only its proof.
     VB-9  Every layer that carries the code or a proof keeps the
           secret out of logs: the encrypted-channel debug trace
           (it prints the start of each frame when enabled), the
           local link that hands the code to the user interface,
           the shell and the webview console.

B.14 TESTABLE REQUIREMENTS

     TR-B1  Connector without the code learns nothing. A test peer
            completes the Noise handshake with an open offer and
            then (a) sends nothing, (b) sends a random 32-byte
            proof, (c) sends a proof under a wrong secret, (d) sends
            a malformed or oversize frame, (e) sends a ceremony
            payload instead of a proof. In every case it receives
            zero application frames (no payload, no name, no
            PAIRING_REFUSED, no PAIRING_OK), the connection closes,
            the trust store and the TR-10 nonce memory are
            unchanged, and the revocation store was not queried.
            Beyond the Noise handshake itself (R1) nothing is
            disclosed.
     TR-B2  MITM with a different key is aborted. The scanner is
            pointed at a listener holding its own key, which sends a
            ceremony payload claiming the code's device_id and
            public_key. The scanner aborts at S1; the listener
            receives zero application frames (no proof, no payload,
            no name); no trust entry is written on either side.
     TR-B3  Payload mismatch is aborted. A listener holding the
            code's key (test harness) sends a ceremony payload whose
            device_id or public_key differs from the code; the
            scanner aborts at S2/S3 before sending its own payload.
     TR-B4  Replayed proof refused. (a) A proof computed with the
            correct secret over another session's h is refused on a
            new session while the secret is alive. (b) After a valid
            proof was accepted, a second connection is refused (port
            closed) and a valid-for-its-own-session proof achieves
            nothing.
     TR-B5  Old codes refused. A v1 code pasted into a newer build
            fails with BAD_VERSION and no TCP connection is opened.
            A v2 code fails the v1 decoding rules (VB-3).
     TR-B6  Code tampering. Mutating device_id (key intact), the
            secret, or removing secret or connect fails at decode;
            a v2 code containing "name" fails with EXTRA_FIELD.
     TR-B7  Ceremony payload validation, both sides: null, a
            non-object, an extra key, "secret" or "connect" present,
            device_id not derived from public_key, and a public_key
            that does not match the session key each abort with zero
            trust-store mutation.
     TR-B8  Single use. Two connectors with valid proofs for their
            own sessions race; exactly one proceeds, the other is
            closed without a message.
     TR-B9  Bounds. Silence after the handshake closes the
            connection after the P6 wait and counts as one bad
            proof; the P7-th bad proof ends the offer; a failed
            Noise handshake is not counted; the offer ends at the
            P8 lifetime. Each end destroys the secret.
     TR-B10 Nothing secret in logs. Over all TR-B paths, captured
            stderr contains neither the secret, the proof nor h in
            base64 or hex, also with the encrypted-channel debug
            trace enabled; the bad-proof line carries only the
            counter.
     TR-B11 Constant-time comparison. Code inspection: the proof is
            compared only with the constant-time function on
            equal-length buffers.
     TR-B12 Honest path. Two real instances pair through a v2 code:
            both store the correct identity and announced name, and
            later sync as before (TR-3, TR-4 unchanged).

B.15 OUT OF SCOPE

     - The safety-number comparison UI (deferred, B.8).
     - QR rendering and camera scanning.
     - How users move the code between two desktops.
     - Denial of service beyond P6-P8 (§8 N4).
     - Name rules (DC-28) and key custody (DC-25).
     - Sync sessions between paired devices (unchanged).
     - The cipher suite (§4) and Noise PSK patterns (R1).

B.16 BINDING DECISIONS

     DECIDED (owner decisions, both to be in place before v0.2)
       DB1  The scanner aborts unless the session's remote static
            key, the payload's device_id and the payload's
            public_key all match the pasted code (B.1).
       DB2  Both sides strictly validate the received ceremony
            payload before using it (B.7).
       DB3  The code carries a one-time secret; the scanner proves
            knowledge of it before the displayer sends anything
            identifying (B.2-B.4).
       DB4  The proof is bound to the handshake hash and compared in
            constant time (B.3).
       DB5  A wrong or missing proof: silent close, a fixed counter
            line in the log, never the secret (B.4).
       DB6  The secret is single-use and ends with the offer (B.2,
            B.5).

     DECIDED 2026-11-14 (owner approved every recommended default
     shown in brackets, with the changes in B.D)
       P1   Secret size/encoding [16 bytes, base64, field "secret"].
       P2   Code version [v2; secret and connect required; no name;
            device_id checked against public_key].
       P3   Proof construction [HMAC-SHA256(secret, label || h),
            first frame PAIRING_PROOF].
       P4   Frame order after the proof [unchanged].
       P5   Secret consumed by the first valid proof [yes; a failed
            ceremony needs a new code].
       P6   Proof wait [10 s; handshake failures not counted].
       P7   Offer ends after bad proofs [3].
       P8   Offer lifetime [10 minutes].
       P9   Ceremony payload schema [v2, no secret/connect, id
            derivation checked].
       P10  DC-27 A.2 ordering [after proof and decode, before
            binding].
       P11  §5.3 roles [amend text to implementation].
       P12  Safety-number UI [deferred with B.8 triggers].
       P13  User-visible texts [one text for every refused code,
            B.10].
       P14  Handshake-level key disclosure (R1) [accept; no PSK
            pattern now].

B.D  OWNER DECISIONS (2026-11-14)

     P1   Approved on the condition that the secret is never entered
          by a person and is short-lived. Binding: the secret is
          generated by the displaying device, travels only inside
          the pasted (or, later, scanned) code, is never shown for
          typing and is never typed; it dies with the offer (P5 single
          use, P8 at most 10 minutes). Any future way to enter a code
          by hand needs a new amendment.
     P13  No separate text for older codes: builds older than this
          amendment are not supported for pairing, and every refused
          code shows the single B.10 text.
     P2-P12, P14 approved as recommended.
