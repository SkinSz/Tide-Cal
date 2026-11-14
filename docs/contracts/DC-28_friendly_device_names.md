# TIDE DESIGN CONTRACT DC-28
# Friendly Device Names
Status: APPROVED by project owner (2026-11-14).
        Owner approved P1-P11 as recommended ("all recommended").
Depends on: Architecture Spec v0.3 §15, §17; DC-05 §2.4, §3.1, §5.1,
            §6.1; DC-07 (peers table); DC-08 §2.2, §2.3; DC-11 §2.3,
            §5; DC-14 Appendix A.4; DC-16 §4.0; DC-20 §5, D3, D6;
            DC-21 §7
Unblocks:   readable device labels in Devices & sync, Paired Devices,
            Sync Errors and the conflict dialog; the DC-14 A.4 interim
            label retired; DC-27 panel text with real names.
Resolves:   TD-032 (long device ids truncated with "..." in Devices /
            Sync views); DC-14 A.4 "UNTIL the friendly-device-name
            contract exists".

==================================================================
1. PURPOSE
==================================================================

Every Tide installation is an equal peer identified by a long device
id ("d-" + 64 hex, DC-05 §2.2). People recognize "Windows PC", not
"d-7178a859...". DC-05 §3.1 already gives each trust-store entry a
"user-assigned label" (display_name) and DC-05 §5.1 already lets a
pairing payload carry an optional "name" suggestion, but the product
never lets anyone choose a name. This contract defines:

  - two kinds of name: the name a device gives itself, and a local
    nickname for a peer;
  - where each is set, its default, and its validation;
  - how a device's own name reaches its peers (authenticated pairing
    channel, never discovery broadcast);
  - one short-id fallback and one label rule used on every screen.

==================================================================
2. CURRENT STATE (VERIFIED IN REPO BY SOURCE READING, branch windows)
==================================================================

  S1  OBSERVED. The pairing payload has an optional "name" field
      (security/pairing.ts PairingPayload; decodePairingPayload
      accepts it, checks only typeof === "string"; no length or
      character limit). Unknown top-level keys are REJECTED
      (EXTRA_FIELD), so a new payload field would break pairing with
      older builds; reusing "name" does not.
  S2  OBSERVED. Both ceremony sides exchange their payloads over the
      encrypted Noise JSON channel after the handshake (pairing_
      manager.ts runDisplayerSide / acceptPairingPayload). The
      displayer stores the name from that encrypted payload; the
      scanner stores the name from the PASTED code text (remote.name),
      not from the encrypted payload it also received.
  S3  OBSERVED. The frontend never passes a name. The sidecar's
      pairing_offer defaults name to deviceId.slice(0, 12); stores
      fall back to device_id.slice(0, 12) when no name arrives.
      INFERRED: every existing peers.display_name is a 12-character
      id prefix such as "d-7178a859ab"; the "display_name ?? short id"
      fallbacks in the UI never fire, because the column is NOT NULL
      and always filled.
  S4  OBSERVED. mDNS "dn" (DC-11 §2.3): production builds the TXT
      record with buildTxtRecord({}), so "dn" is never announced.
      "dn" is unauthenticated LAN broadcast.
  S5  OBSERVED. Device ids are shortened inconsistently:
        frontend/devices.ts  renderDeviceInfo   self id: 18 chars + "..."
        frontend/devices.ts  renderDeviceInfo   peers:   16 chars + "..."
        frontend/devices.ts  acceptPairing      log line: 16 + "..."
        frontend/device-label.ts truncatedDeviceId: 16 + "..."
          (used by paired_devices.ts shapePairedDevices and by
           resolveDeviceLabel -> sync_errors.ts error cards)
        frontend/sync_errors.ts shapeQuarantineRows producer: 16 + "..."
        frontend/sync_errors.ts peer-state rows: display_name ?? 16 + "..."
        src/application/conflicts_ui.ts deviceName():
          display_name ?? FULL device id
        stored label fallback (pairing_manager.ts, sidecar
          pairing_offer): 12 chars, no "..."
        src-tauri lib.rs log "manual sync_now: peer <full id> ..."
          (log, not UI)
      DC-14 A.4 asks for "Device " + first 8 characters, but its
      example ("Device 2ee25c62") omits the "d-" prefix.
  S6  OBSERVED. DC-20 §5 / D3 explicitly EXCLUDE "device display
      naming" from the Options window inventory. DC-05 §2.4 forbids
      hostname in trust entries; discovery.ts rejects hostname-like
      "dn" values.

==================================================================
3. DEFINITIONS
==================================================================

  own name     the name this device gives itself. Device-local
               setting; sent to a peer only during pairing (§4.5).
  announced    the own name a peer sent us during pairing, stored in
  name         its peers row. Untrusted text, even though it arrived
               on an authenticated channel (authenticated = we know
               WHO sent it, not that it is well-formed).
  nickname     a label the user typed on THIS device for a peer.
               Never sent anywhere.
  short id     the 8 lowercase hex characters that follow "d-" in a
               device id ("d-2ee25c62ab..." -> "2ee25c62").
  label        the one string shown for a device (§4.7).

==================================================================
4. RULES
==================================================================

4.1  TWO NAMES, ONE LABEL (PROPOSAL P1)

     A peer has at most one announced name (from it) and at most one
     nickname (from us). The nickname always wins. Renaming a peer
     locally never changes what the peer calls itself and is never
     sent. This mirrors DC-05 §3.1 ("user-assigned label") while
     keeping the peer's suggestion (DC-05 §5.1 "suggestion, not
     trust") separately, so clearing a nickname falls back to it.

4.2  DEFAULT OWN NAME (PROPOSAL P2) - privacy decision point

     Options weighed:
       a) OS hostname (e.g. "annas-laptop"): often contains a person's
          name; DC-05 §2.4 keeps hostnames out of trust entries;
          DC-11/discovery.ts treat hostname-like strings as leaks.
          Rejected.
       b) Random words ("Blue Heron"): private, but unrecognizable
          until the user renames it; little gain over the short id.
       c) NO name until the user sets one; the rename field is
          pre-filled with a SUGGESTION from the OS family only
          ("Linux PC", "Windows PC", later "Android phone") that the
          user must save explicitly.
     Recommended: c). Until a name is saved, nothing is sent and
     peers show "Device <short id>".

4.3  SENDING THE OWN NAME OFF THE DEVICE (PROPOSAL P3) - decision point

     The own name leaves the device ONLY inside the pairing ceremony,
     over the encrypted channel, to the one device being paired.
     Recommended default: saving an own name IS the consent; the
     field's help text says "Shown on devices you pair with from now
     on." No separate checkbox.
     Alternative (if the owner prefers): an explicit checkbox "Share
     this name when pairing", default OFF.
     Never: mDNS "dn" (stays OFF and unbuilt, DC-11 §5; this contract
     does not use it), the pasted pairing code (§4.5), logs, sync
     messages (§4.6).

4.4  WHERE NAMES ARE SET (PROPOSAL P4)

     - Own name: Devices & sync dialog, "This device" line:
         This device: Windows PC   [Rename]     (id 2ee25c62)
     - Nickname: Paired Devices row (DC-16 §4.0), [Rename] next to
       Unpair. Saving an empty field clears the nickname.
     - Not in the Options window: DC-20 D3 excludes device naming
       there; moving it would need a DC-20 amendment. Both places
       above are where devices are already managed.
     - Edit in place (input + Save/Cancel), no native dialog.

4.5  PAIRING EXCHANGE (DC-05 §5.1, §6.1)

       local payload.name = own name if set, else OMITTED
                            (the 12-char id default is removed)
       QR / pasted code:    "name" OMITTED (PROPOSAL P5): the code
                            travels through screens and clipboards,
                            and the peer gets the name from the
                            encrypted payload anyway
       on receive (both sides):
           n = validateName(encryptedPayload.name)      -- §4.8
           if n is a prefix of the sender's device_id: n = none
               (older builds send deviceId.slice(0, 12) as "name", S3)
           store announced name = n (or none if absent/invalid)
           invalid name: pairing still succeeds; debug log
           "pairing: peer name ignored (<rule>)", never the text
       scanner side: take the name from the ENCRYPTED payload,
           not from the pasted code (fixes S2)

     decodePairingPayload keeps accepting "name" (older builds still
     send it); the stored value comes only from the encrypted path.

4.6  UPDATES AFTER PAIRING (PROPOSAL P6)

     v1: the announced name is set at pairing only. If a device
     renames itself later, existing peers keep the old announced
     name; the user renames the peer locally there (nickname).
     Rationale: no wire change. Existing pairs (paired before this
     contract) start with no announced name (§4.9) and are named by
     nickname.
     Deferred (§8 T1): an optional HELLO field carrying the own name.
     DC-08 §2.2 says unknown fields are ignored, which would make it
     backward compatible, but it is a DC-08 amendment (DC-08 §2.3
     restricts identity claims in messages; a name is not identity,
     yet the amendment must say so).

4.7  LABEL RULE (one function, every surface)

       label(device_id):
           if device_id == self:   "This device"   (unchanged; the
                                   owner-approved precedence recorded in
                                   device-label.ts; conflict dialog keeps
                                   "This device (local)", DC-14 A.4).
                                   The own name appears only on the
                                   "This device:" line of Devices & sync
                                   (PROPOSAL P11).
           row = peers[device_id]
           if row.display_name:    return row.display_name -- nickname
           if row.announced_name:  return row.announced_name
           return "Device " + shortId(device_id)

       shortId(id) = id.slice(2, 10)  -- for ids matching ^d-[0-9a-f]{64}$
                     id.slice(0, 8)   -- any other shape (legacy dev-*)

     - No "..." anywhere: the short id is a complete token, not a
       truncation (resolves TD-032).
     - Duplicates (PROPOSAL P7): when two devices in the same list
       would show the same label, both get " (<short id>)" appended.
     - The short id is DIFFERENT from the mDNS instance prefix (DC-11
       §2.2 hashes the device id again); the two must never be
       compared or shown as the same thing.
     - Revoked peers (DC-27) keep their label in the Removed devices
       view.

4.8  VALIDATION (PROPOSAL P8; applies to own name, nickname and
     received names alike)

       validateName(s):
           if s is not a string: invalid
           s = NFC(s); trim; collapse internal whitespace runs to " "
           if s == "": none
           reject if any char is in Unicode categories Cc (controls),
               Zl, Zp, Co (private use), Cs (lone surrogates)
           reject if any char is in Cf (format) EXCEPT U+200C ZWNJ and
               U+200D ZWJ (needed by emoji sequences and several
               scripts); this rejects the bidi controls U+202A-202E,
               U+2066-2069, U+200E/U+200F, U+061C, and U+200B, U+FEFF
           reject if > 32 code points or > 64 UTF-8 bytes
           return s

     - 64 bytes matches DC-11 MAX_TXT_VALUE_BYTES, so a name can later
       serve as "dn" without a second rule.
     - Emoji (including ZWJ sequences) and all scripts are allowed,
       within the byte cap: 64 UTF-8 bytes is about 21 characters in
       most non-Latin scripts and fewer for long emoji sequences. The
       field shows the remaining room, not a character count.
     - Rendering: textContent / text nodes only, never innerHTML,
       never inside an attribute that is parsed (title= via the DOM
       property is fine). Applies to every surface in §4.10.
     - Received names that fail validation are dropped, not repaired
       (no partial truncation that could change meaning).

4.9  STORAGE AND MIGRATION (PROPOSAL P9; DC-07 amendment)

     - Own name: config.toml key "device_name" (DC-20 D6: machine-
       local preferences live in config.toml; DC-15 §3.2 path). Not
       a secret.
     - peers.display_name keeps its DC-05 §3.1 / DC-16 §4.0 meaning,
       the USER-ASSIGNED label: it becomes the nickname; "" = none.
     - peers: new column announced_name TEXT NULL (what the peer
       called itself at pairing).
     - Data migration (one time, idempotent): every existing
       display_name today holds what pairing stored (S3), so it moves
       to announced_name, then display_name = "". Values equal to the
       stored id prefix (device_id.slice(0, 12)) or failing
       validateName become NULL instead.
     - device_info / list_paired_devices return { device_id, label,
       nickname, announced_name, short_id }; label is computed in the
       sidecar with §4.7 so every surface agrees.

4.10 SURFACES (TD-032 resolution)

     Every place in S5 switches to label() / shortId():
       Devices & sync: self line, peers list, "paired with <label>"
       Paired Devices rows (label + "id <short id>" in muted text)
       Sync Errors: error-card producer, peer-state rows
       Conflict dialog: candidate device (replaces "Device " + first
         8 chars of DC-14 A.4 and the full-id fallback in
         conflicts_ui.ts deviceName)
       DC-27 Unpair panel and Removed devices view
     Logs keep using ids, never names (names may be personal; DC-27
     §4.12). The full-id log line in the shell is out of scope here.

==================================================================
5. WORKED EXAMPLES
==================================================================

  (a) Pairing, Windows has own name "Windows PC", Linux has none.
      Encrypted payload Windows -> Linux:
        {"v":1,"device_id":"d-7178a859...","public_key":"...",
         "nonce":"...","name":"Windows PC"}
      Encrypted payload Linux -> Windows: same shape, no "name".
      Linux shows "Windows PC"; Windows shows "Device 2ee25c62".

  (b) Pasted pairing code shown on Windows (P5): no "name" key:
        {"v":1,"device_id":"d-7178a859...","public_key":"...",
         "nonce":"...","connect":{"ip":"192.168.1.20","port":47471}}

  (c) Existing pair, after migration: the rows held display_name
      "d-7178a859ab" / "d-2ee25c62ab" (id prefixes) -> display_name ""
      and announced_name NULL. Labels "Device 7178a859" and
      "Device 2ee25c62". User sets nickname "Office laptop" on
      Linux -> Linux shows "Office laptop"; Windows unchanged.

  (d) list_paired_devices row:
        {"device_id":"d-7178a859...","short_id":"7178a859",
         "announced_name":"Windows PC","nickname":null,
         "label":"Windows PC"}

  (e) Received name "Bob‮exe.cod": contains U+202E (Cf) ->
      dropped; label "Device 7178a859"; pairing succeeds.

  (f) Two peers both announce "Laptop": list shows
      "Laptop (7178a859)" and "Laptop (03cd91fe)".

==================================================================
6. TESTABLE REQUIREMENTS
==================================================================

  TR-1  validateName: table test covering NFC, trim, whitespace
        collapse, each rejected category (incl. U+202E, U+200B,
        U+0007, U+2028), 32-code-point and 64-byte limits, a ZWJ
        emoji sequence accepted, empty -> none.
  TR-2  Pairing: a valid own name arrives on the peer from the
        ENCRYPTED payload on both displayer and scanner sides; a
        different "name" in the pasted code is ignored by the scanner.
  TR-3  No own name set -> no "name" key in either payload or in the
        pasted code; peer label is "Device <short id>".
  TR-4  Invalid received name -> pairing succeeds, announced name
        empty, log line contains no part of the name.
  TR-5  Label precedence: nickname > announced name > "Device <short
        id>"; self -> "This device"; a received name that is a prefix
        of the sender's id is stored as none.
  TR-6  shortId("d-" + 64 hex) returns 8 hex chars; no UI string in
        §4.10 surfaces contains "..." after a device id (DOM test
        per surface).
  TR-7  Migration: id-prefix placeholders become ""; real names kept;
        running the migration twice changes nothing.
  TR-8  Nickname is local: setting it changes no outbound payload,
        sync message or log line (wire capture in two-instance test).
  TR-9  Rendering: a name containing "<b>x</b>" is shown literally on
        every §4.10 surface (no element created).
  TR-10 Duplicate labels get " (<short id>)" in the same list.
  TR-11 mDNS TXT stays {"pv"} only after setting an own name
        (DC-11 TR-2 unchanged).
  TR-12 Owner acceptance: name both machines, pair (or nickname an
        existing pair); every Devices / Sync / conflict surface shows
        names, no truncated ids.

==================================================================
7. OUT OF SCOPE
==================================================================

  - mDNS "dn" opt-in UI and announcement (DC-11 §5; untouched).
  - Propagating renames after pairing (deferred, §8 T1).
  - Names for calendars, attendees or anything other than devices.
  - Using names in identity, trust, routing or matching: names are
    display-only (DC-05 §2.4, DC-08 §2.3).
  - The Options window (DC-20 D3 unchanged).

==================================================================
8. DEFERRED ITEMS AND TRIGGER CONDITIONS
==================================================================

  T1  Own-name updates via an optional HELLO field (DC-08
      amendment). TRIGGER: a third paired device, or the owner
      reports that a renamed device shows its old name on peers.
  T2  Own-name suggestion for Android ("Android phone"). TRIGGER:
      Android port starts.

==================================================================
9. OPEN ITEMS OWNED ELSEWHERE
==================================================================

  O1  DC-07 amendment: peers.announced_name column + migration
      (§4.9); display_name semantics unchanged (user-assigned).
  O2  DC-14 A.4: replace the interim "Device " + 8 chars rule with
      §4.7 (and its "d-" ambiguity).
  O3  DC-20: confirm config.toml may hold "device_name" although the
      key is edited outside the Options window (D3 excludes the UI,
      not the file; D6 covers machine-local preferences).
  O4  DC-27 panel and Removed devices view use label() (§4.10).
  O5  Shell log line printing a full device id (lib.rs, manual
      sync_now): log policy, not this contract.

==================================================================
10. BINDING DECISIONS
==================================================================

  DECIDED (carried from approved contracts / owner request)
    D1  Names are display-only; identity stays the device id
        (Spec §15, DC-05 §2.2/§2.4).
    D2  Nothing is broadcast by default; "dn" stays opt-in and OFF
        (DC-11 §2.3, §5).
    D3  Owner request: the paired-devices list shows a short id or a
        friendly name instead of truncated ids (TD-032); whether a
        name is sent off the device is an owner decision (P3).

  DECIDED 2026-11-14 (owner approved every recommended default,
  shown in brackets)
    P1  Own name + local nickname, nickname wins [yes].
    P2  Default own name [none; OS-family suggestion pre-filled, saved
        only on user action; hostname rejected].
    P3  Sending the own name [saving a name = consent, pairing only,
        encrypted channel; alternative: checkbox default OFF].
    P4  Where to set [Devices & sync (own), Paired Devices (nickname);
        not Options].
    P5  Pasted pairing code carries no name [omit].
    P6  Name updates after pairing [not propagated in v1; T1].
    P7  Duplicate labels disambiguated with short id [yes].
    P8  Validation [§4.8: NFC, trim, no Cc/Cf/Zl/Zp/Co/Cs, <= 32
        code points and <= 64 bytes].
    P9  Storage [config.toml device_name; display_name = nickname
        (DC-05 §3.1 meaning kept); new announced_name column;
        migration moves today's values to announced_name].
    P10 Short id = 8 hex after "d-", label "Device <short id>", no
        "..." [yes].
    P11 Self label stays "This device" everywhere except the "This
        device: <own name>" line [yes; keeps the approved precedence].

  IMPLEMENTATION-TIME VERIFICATION (not asserted here)
    V1  Confirm the engine's message parsing ignores unknown fields
        before T1 relies on DC-08 §2.2.
    V2  Confirm Unicode category support for §4.8 in the sidecar's
        Node version (\p{Cc}, \p{Cf} ... with the "u" flag) and the
        same result in the frontend's WebKitGTK / WebView2.
    V3  Confirm the OS-family source for the P2 suggestion
        (process.platform in the sidecar or the shell) and that it
        never reads the hostname.
    V4  Confirm how config.toml writes from the Devices dialog
        coexist with the Options window Save-all (DC-20 §4.2) without
        clobbering each other.
