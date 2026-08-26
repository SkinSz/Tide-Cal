// Tide DC-05 §5/§6.1 tests: QR payload codec, safety number, pairing session.
// Covers TR-9 (QR tampering), TR-5/TR-6 (MITM simulation), TR-10 (nonce freshness).

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { generateIdentity } from "../src/security/identity.ts";
import {
  makeLocalDuplexPair,
  ed25519ToX25519PublicKey,
} from "../src/network/noise_transport.ts";
import {
  PAIRING_NONCE_LRU_LIMIT,
  PairingError,
  PairingSession,
  createNonceStore,
  decodePairingPayload,
  encodePairingPayload,
  freshNonce,
  isKnownNonce,
  recordNonce,
  safetyNumber,
} from "../src/security/pairing.ts";

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = generateIdentity();
  return {
    v: 1,
    device_id: id.deviceId,
    public_key: Buffer.from(id.publicKey).toString("base64"),
    nonce: freshNonce(),
    ...overrides,
  };
}

describe("DC-05 §5.1 QR payload round-trip", () => {
  test("full payload (connect + name) survives encode -> decode", () => {
    const p = validPayload({
      connect: { ip: "192.168.1.20", port: 48710 },
      name: "Alice's Laptop",
    });
    const decoded = decodePairingPayload(encodePairingPayload(p as never));
    expect(decoded.v).toBe(1);
    expect(decoded.device_id).toBe(p.device_id);
    expect(decoded.public_key).toBe(p.public_key);
    expect(decoded.nonce).toBe(p.nonce);
    expect(decoded.connect).toEqual({ ip: "192.168.1.20", port: 48710 });
    expect(decoded.name).toBe("Alice's Laptop");
  });

  test("minimal payload (no connect/name) decodes with undefined optionals", () => {
    const p = validPayload();
    const decoded = decodePairingPayload(JSON.stringify(p));
    expect(decoded.connect).toBeUndefined();
    expect(decoded.name).toBeUndefined();
  });

  test("canonical encoding: key order independent of input property order", () => {
    const a = encodePairingPayload(validPayload() as never);
    const reordered = JSON.parse(a);
    const b = JSON.stringify(Object.fromEntries(Object.entries(reordered).reverse()));
    // Both orderings must produce the identical canonical string on re-encode.
    expect(decodePairingPayload(b)).toEqual(decodePairingPayload(a));
    expect(encodePairingPayload(decodePairingPayload(b))).toBe(a);
  });
});

describe("DC-05 TR-9 malformed/tampered payloads rejected", () => {
  function expectCode(raw: string | Record<string, unknown>, code: string) {
    let err: unknown;
    try {
      decodePairingPayload(typeof raw === "string" ? raw : JSON.stringify(raw));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PairingError);
    expect((err as PairingError).code).toBe(code);
  }

  test("bad version -> BAD_VERSION", () => {
    expectCode(validPayload({ v: 2 }), "BAD_VERSION");
    expectCode(validPayload({ v: 0 }), "BAD_VERSION");
    expectCode(validPayload({ v: "1" }), "BAD_VERSION");
  });

  test("short nonce (<128 bits) -> SHORT_NONCE", () => {
    expectCode(validPayload({ nonce: Buffer.alloc(8).toString("base64") }), "SHORT_NONCE");
  });

  test("empty nonce -> SHORT_NONCE", () => {
    expectCode(validPayload({ nonce: "" }), "SHORT_NONCE");
  });

  test("extra top-level field -> EXTRA_FIELD", () => {
    expectCode(validPayload({ evil: true }), "EXTRA_FIELD");
  });

  test("extra nested connect field -> EXTRA_FIELD", () => {
    expectCode(
      validPayload({ connect: { ip: "10.0.0.1", port: 8080, mac: "aa:bb" } }),
      "EXTRA_FIELD",
    );
  });

  test("bad base64 public_key -> BAD_BASE64", () => {
    expectCode(validPayload({ public_key: "not*valid!!base64" }), "BAD_BASE64");
  });

  test("wrong-length base64 public_key -> BAD_PUBLIC_KEY", () => {
    expectCode(validPayload({ public_key: Buffer.alloc(16).toString("base64") }), "BAD_PUBLIC_KEY");
  });

  test("bad base64 nonce -> BAD_BASE64", () => {
    expectCode(validPayload({ nonce: "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@" }), "BAD_BASE64");
  });

  test("malformed device_id -> BAD_DEVICE_ID", () => {
    expectCode(validPayload({ device_id: "x-not-hex" }), "BAD_DEVICE_ID");
    expectCode(validPayload({ device_id: `d-${"g".repeat(64)}` }), "BAD_DEVICE_ID");
  });

  test("missing required field -> MISSING_FIELD", () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).nonce;
    expectCode(p, "MISSING_FIELD");
  });

  test("invalid JSON -> MALFORMED_JSON", () => {
    expectCode("{not json", "MALFORMED_JSON");
  });

  test("invalid connect port -> BAD_CONNECT", () => {
    expectCode(validPayload({ connect: { ip: "10.0.0.1", port: 99999 } }), "BAD_CONNECT");
    expectCode(validPayload({ connect: { ip: "10.0.0.1", port: 1.5 } }), "BAD_CONNECT");
  });

  test("tampered value never enters trust flow: decode throws before any use", () => {
    const good = validPayload();
    const tampered = { ...good, device_id: `d-${"a".repeat(64)}`, extra: 1 };
    expect(() => decodePairingPayload(JSON.stringify(tampered))).toThrow(PairingError);
  });
});

describe("DC-05 §5.4 safety number", () => {
  const a = generateIdentity();
  const b = generateIdentity();

  test("40 digits rendered as five groups of 8", () => {
    const sn = safetyNumber(a.publicKey, b.publicKey);
    expect(sn).toMatch(/^\d{8}-\d{8}-\d{8}-\d{8}-\d{8}$/);
    expect(sn.replaceAll("-", "")).toHaveLength(40);
  });

  test("symmetric: (A,B) == (B,A)", () => {
    expect(safetyNumber(a.publicKey, b.publicKey)).toBe(safetyNumber(b.publicKey, a.publicKey));
  });

  test("deterministic across calls and inputs of same keys", () => {
    const once = safetyNumber(a.publicKey, b.publicKey);
    expect(safetyNumber(a.publicKey, b.publicKey)).toBe(once);
    expect(safetyNumber(new Uint8Array([...a.publicKey]), b.publicKey)).toBe(once);
  });

  test("different key pairs yield different numbers", () => {
    const c = generateIdentity();
    expect(safetyNumber(a.publicKey, c.publicKey)).not.toBe(safetyNumber(a.publicKey, b.publicKey));
  });

  test("transcript-mixed variant is deterministic and differs from plain §5.4 number", () => {
    const t = new Uint8Array(createHash("sha256").update("handshake").digest());
    const mixed = safetyNumber(a.publicKey, b.publicKey, t);
    expect(mixed).toMatch(/^\d{8}-\d{8}-\d{8}-\d{8}-\d{8}$/);
    expect(mixed).toBe(safetyNumber(a.publicKey, b.publicKey, t));
    expect(mixed).not.toBe(safetyNumber(a.publicKey, b.publicKey));
  });
});

describe("DC-05 §6.1 V3 / TR-5+TR-6 MITM simulation", () => {
  // Noise_XX gives both honest sides the SAME handshake hash; a key-substituting
  // MITM produces DIFFERENT handshake hashes per side (different transcripts).
  const alice = generateIdentity();
  const bob = generateIdentity();
  const attacker = generateIdentity();

  function transcript(label: string): Uint8Array {
    return new Uint8Array(createHash("sha256").update(label).digest());
  }

  test("honest run: same keys + shared handshake hash => numbers MATCH", () => {
    const shared = transcript("noise-xx-honest-handshake-hash");
    const atAlice = safetyNumber(alice.publicKey, bob.publicKey, shared);
    const atBob = safetyNumber(alice.publicKey, bob.publicKey, shared);
    expect(atAlice).toBe(atBob);
  });

  test("MITM run: substituted key + per-side transcripts => numbers DIFFER", () => {
    // Alice sees attacker's key; Bob sees attacker's key; each side's
    // handshake hash differs because the transcripts differ under MITM.
    const atAlice = safetyNumber(alice.publicKey, attacker.publicKey, transcript("mitm-transcript-A"));
    const atBob = safetyNumber(attacker.publicKey, bob.publicKey, transcript("mitm-transcript-B"));
    expect(atAlice).not.toBe(atBob);
  });

  test("MITM with equalized transcripts STILL differs via substituted keys", () => {
    const t = transcript("same-transcript");
    const atAlice = safetyNumber(alice.publicKey, attacker.publicKey, t);
    const atBob = safetyNumber(attacker.publicKey, bob.publicKey, t);
    expect(atAlice).not.toBe(atBob);
  });

  test("V3 mixing binds the number to the transcript: same keys, differing handshake hashes => DIFFER", () => {
    // Under MITM each side ends the XX handshake with a DIFFERENT handshake
    // hash; V3 mixes it in so even identical key views cannot collide.
    const tA = transcript("mitm-transcript-A");
    const tB = transcript("mitm-transcript-B");
    const m = generateIdentity();
    expect(safetyNumber(m.publicKey, bob.publicKey, tA)).not.toBe(
      safetyNumber(m.publicKey, bob.publicKey, tB),
    );
  });
});

describe("DC-05 TR-10 nonce freshness", () => {
  test("consecutive calls differ", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(freshNonce());
    expect(seen.size).toBe(1000);
  });

  test("freshNonce is valid >=128-bit base64 accepted by the decoder", () => {
    const p = validPayload({ nonce: freshNonce() });
    expect(decodePairingPayload(JSON.stringify(p)).nonce).toBe(p.nonce);
  });
});

describe("DC-05 §6.1 pairing session state machine", () => {
  function makeSession(local: ReturnType<typeof generateIdentity>, remotePayload: string) {
    const s = new PairingSession();
    const localPayload = decodePairingPayload(
      encodePairingPayload({
        v: 1,
        device_id: local.deviceId,
        public_key: Buffer.from(local.publicKey).toString("base64"),
        nonce: freshNonce(),
      }),
    );
    s.exchangePayloads(localPayload, decodePairingPayload(remotePayload));
    return s;
  }

  function qrFor(id: ReturnType<typeof generateIdentity>): string {
    return encodePairingPayload({
      v: 1,
      device_id: id.deviceId,
      public_key: Buffer.from(id.publicKey).toString("base64"),
      nonce: freshNonce(),
    });
  }

  test("happy path: idle -> payload_exchanged -> verified -> trusted_stored", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const s = makeSession(alice, qrFor(bob));
    expect(s.state).toBe("payload_exchanged");

    s.bindTranscript(new Uint8Array(32).fill(7));
    s.verifyRemoteStatic(ed25519ToX25519PublicKey(bob.publicKey)); // H-1: X25519 form
    const displayed = s.displaySafetyNumber();
    s.confirmSafetyNumber(displayed, displayed);
    expect(s.state).toBe("verified");

    const store: string[] = [];
    s.storeTrust(() => store.push("entry"));
    expect(s.state).toBe("trusted_stored");
    expect(store).toEqual(["entry"]);
  });

  test("out-of-order transitions are refused (§6.1 verification ORDER enforced)", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();

    // confirm before exchange
    const early = new PairingSession();
    expect(() => early.confirmSafetyNumber("00000000-00000000", "00000000-00000000")).toThrow(PairingError);

    const s = makeSession(alice, qrFor(bob));

    // display before transcript bound / static verified
    expect(() => s.displaySafetyNumber()).toThrow(PairingError);
    // confirm before verifyRemoteStatic
    expect(() => s.confirmSafetyNumber("1".repeat(40), "1".repeat(40))).toThrow(PairingError);
    // storeTrust before verified
    expect(() => s.storeTrust(() => "nope")).toThrow(PairingError);

    s.bindTranscript(new Uint8Array(32).fill(1));
    // double bind refused
    expect(() => s.bindTranscript(new Uint8Array(32).fill(2))).toThrow(PairingError);

    // still nothing stored
    expect(s.state).toBe("payload_exchanged");
  });

  test("V2 failure (remote static != QR key) aborts and clears partial state", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const impostor = generateIdentity();
    const s = makeSession(alice, qrFor(bob));
    s.bindTranscript(new Uint8Array(32).fill(9));

    expect(() => s.verifyRemoteStatic(ed25519ToX25519PublicKey(impostor.publicKey))).toThrow(/BAD_PUBLIC_KEY/);
    expect(s.state).toBe("aborted");
    expect(s.isCleared).toBe(true);
  });

  test("TR-6 safety-number mismatch aborts; zero trust-store mutation", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const s = makeSession(alice, qrFor(bob));
    s.bindTranscript(new Uint8Array(32).fill(3));
    s.verifyRemoteStatic(ed25519ToX25519PublicKey(bob.publicKey)); // H-1: X25519 form

    const displayed = s.displaySafetyNumber();
    const forged = displayed === "12345678-12345678-12345678-12345678-12345678"
      ? "87654321-87654321-87654321-87654321-87654321"
      : "12345678-12345678-12345678-12345678-12345678";

    expect(() => s.confirmSafetyNumber(displayed, forged)).toThrow(PairingError);
    expect(s.state).toBe("aborted");

    const store: string[] = [];
    expect(() => s.storeTrust(() => store.push("entry"))).toThrow(PairingError);
    expect(store).toEqual([]); // zero trust-store mutation
    expect(s.isCleared).toBe(true);
  });

  test("abort() leaves zero state from every reachable phase", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();

    const s0 = new PairingSession();
    s0.abort();
    expect(s0.state).toBe("aborted");
    expect(s0.isCleared).toBe(true);

    const s1 = makeSession(alice, qrFor(bob));
    s1.abort();
    expect(s1.isCleared).toBe(true);

    const s2 = makeSession(alice, qrFor(bob));
    s2.bindTranscript(new Uint8Array(32).fill(4));
    s2.verifyRemoteStatic(ed25519ToX25519PublicKey(bob.publicKey)); // H-1: X25519 form
    s2.abort();
    expect(s2.state).toBe("aborted");
    expect(s2.isCleared).toBe(true);
    // aborted session cannot proceed anywhere
    expect(() => s2.storeTrust(() => "x")).toThrow(PairingError);
    expect(() => s2.displaySafetyNumber()).toThrow(PairingError);
  });

  test("end-to-end MITM through sessions: V3 numbers differ, neither side stores trust (TR-5)", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const attacker = generateIdentity();
    const trustA: string[] = [];
    const trustB: string[] = [];

    // Under a key-substituting MITM each side sees the attacker's static and
    // ends the Noise_XX handshake with a DIFFERENT handshake hash.
    const txA = new Uint8Array(createHash("sha256").update("mitm-side-A").digest());
    const txB = new Uint8Array(createHash("sha256").update("mitm-side-B").digest());
    const announcedPk = (id: ReturnType<typeof generateIdentity>) =>
      Buffer.from(id.publicKey).toString("base64");

    // Drive both sessions through §6.1 order (V2 passes byte-compare against
    // what was actually announced — modeling the human skipping comparison;
    // V3 is what exposes the attack).
    function runMitmSide(
      local: ReturnType<typeof generateIdentity>,
      tx: Uint8Array,
      peerDisplayed: string,
      store: string[],
    ): void {
      const s = new PairingSession();
      s.exchangePayloads(
        {
          v: 1,
          device_id: local.deviceId,
          public_key: announcedPk(local),
          nonce: freshNonce(),
        },
        {
          v: 1,
          device_id: `d-${createHash("sha256").update(attacker.publicKey).digest("hex")}`,
          public_key: announcedPk(attacker),
          nonce: freshNonce(),
        },
      );
      s.bindTranscript(tx);
      s.verifyRemoteStatic(ed25519ToX25519PublicKey(attacker.publicKey)); // matches announcement (converted), byte-for-byte
      const shown = s.displaySafetyNumber().replaceAll("-", "");
      // Programmatic mismatch detection against the OTHER screen's number:
      expect(shown).not.toBe(peerDisplayed.replaceAll("-", ""));
      expect(() => s.confirmSafetyNumber(shown, peerDisplayed)).toThrow(PairingError);
      expect(() => s.storeTrust(() => store.push(local.deviceId))).toThrow(PairingError);
      expect(s.state).toBe("aborted");
      expect(s.isCleared).toBe(true);
    }

    const shownAtBob = safetyNumber(bob.publicKey, attacker.publicKey, txB);
    const shownAtAlice = safetyNumber(alice.publicKey, attacker.publicKey, txA);
    expect(shownAtAlice).not.toBe(shownAtBob); // V3 property: DIFFERENT on the two screens

    runMitmSide(alice, txA, shownAtBob, trustA);
    runMitmSide(bob, txB, shownAtAlice, trustB);

    expect(trustA).toEqual([]); // zero trust-store mutation on both devices
    expect(trustB).toEqual([]);
  });
});

describe("Review-3 H-1: REAL Noise_XX handshake bound to Ed25519 identities", () => {
  // The QR announces the Ed25519 identity key; the Noise static is derived
  // from that identity via the DC-05 §4 conversion. verifyRemoteStatic must
  // therefore pass for the TRUE peer's handshake static (converted) and fail
  // for a MITM-substituted key.
  function qrPayloadFor(id: ReturnType<typeof generateIdentity>): string {
    return encodePairingPayload({
      v: 1,
      device_id: id.deviceId,
      public_key: Buffer.from(id.publicKey).toString("base64"),
      nonce: freshNonce(),
    });
  }

  test("true peer: handshake remoteStatic == X25519(QR public_key) -> verification PASSES", async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();

    // Real XX handshake with identity-derived statics on both sides.
    const [aliceTransport, bobTransport] = await makeLocalDuplexPair({
      initiatorIdentitySeed: alice.privateKey,
      responderIdentitySeed: bob.privateKey,
    });

    // Scanner side (Bob): scanned ALICE's QR, verifies what his transport learned.
    const sessionAtBob = new PairingSession();
    const localAtBob = decodePairingPayload(qrPayloadFor(bob));
    const scannedQr = decodePairingPayload(qrPayloadFor(alice));
    sessionAtBob.exchangePayloads(localAtBob, scannedQr);
    sessionAtBob.bindTranscript(bobTransport.handshakeHash());
    // V1/V2 in the SAME key space: convert the QR's Ed25519 key, compare to
    // the X25519 remote static from the REAL handshake.
    expect(() =>
      sessionAtBob.verifyRemoteStatic(
        ed25519ToX25519PublicKey(alice.publicKey),
        // ^ equals bobTransport.remoteStaticKey() — asserted first:
      ),
    ).not.toThrow();
    expect(
      Buffer.from(bobTransport.remoteStaticKey()).equals(
        Buffer.from(ed25519ToX25519PublicKey(alice.publicKey)),
      ),
    ).toBe(true);
    expect(sessionAtBob.state).toBe("payload_exchanged");
    sessionAtBob.abort();
  });

  test("MITM-substituted key: verification FAILS and aborts with zero state", async () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const attacker = generateIdentity();

    // Bob = scanner = Noise RESPONDER. The MITM connects toward him as
    // INITIATOR carrying its own (substituted) identity-derived static.
    const [, bobTransport] = await makeLocalDuplexPair({
      initiatorIdentitySeed: attacker.privateKey,
    });

    const sessionAtBob = new PairingSession();
    sessionAtBob.exchangePayloads(
      decodePairingPayload(qrPayloadFor(bob)),
      decodePairingPayload(qrPayloadFor(alice)), // Bob scanned ALICE's QR...
    );
    sessionAtBob.bindTranscript(bobTransport.handshakeHash());

    // ...but the wire carries the ATTACKER's static. Converted comparison
    // must reject it (and would also reject the raw Ed25519 bytes — the
    // old H-1 defect where no comparison could ever succeed).
    expect(() =>
      sessionAtBob.verifyRemoteStatic(bobTransport.remoteStaticKey()),
    ).toThrow(/BAD_PUBLIC_KEY/);
    expect(sessionAtBob.state).toBe("aborted");
    expect(sessionAtBob.isCleared).toBe(true);

    // Sanity: the substituted static really is the attacker's converted key.
    expect(
      Buffer.from(bobTransport.remoteStaticKey()).equals(
        Buffer.from(ed25519ToX25519PublicKey(attacker.publicKey)),
      ),
    ).toBe(true);
  });
});

describe("Review-3 M-4 / TR-10 second clause: session-layer nonce-reuse memory", () => {
  function payloadWith(nonce: string, id = generateIdentity()): string {
    return encodePairingPayload({
      v: 1,
      device_id: id.deviceId,
      public_key: Buffer.from(id.publicKey).toString("base64"),
      nonce,
    });
  }

  test("crafted payload reusing a previously seen nonce is REJECTED (NONCE_REUSE)", () => {
    const local = generateIdentity();
    const remote = generateIdentity();

    // Ceremony #1: fresh payload accepted; its nonce enters the memory.
    const s1 = new PairingSession();
    const first = decodePairingPayload(payloadWith(freshNonce(), remote));
    s1.exchangePayloads(decodePairingPayload(payloadWith(freshNonce(), local)), first);
    expect(s1.state).toBe("payload_exchanged");

    // Ceremony #2: crafted replay of the SAME nonce (fresh everything else).
    const s2 = new PairingSession();
    const reused = decodePairingPayload(payloadWith(first.nonce, generateIdentity()));
    expect(() =>
      s2.exchangePayloads(decodePairingPayload(payloadWith(freshNonce(), local)), reused),
    ).toThrow(PairingError);
    try {
      new PairingSession().exchangePayloads(
        decodePairingPayload(payloadWith(freshNonce(), local)),
        reused,
      );
    } catch (e) {
      expect((e as PairingError).code).toBe("NONCE_REUSE");
    }
    expect(s2.state).toBe("aborted");
  });

  test("isKnownNonce / recordNonce behave as a bounded LRU", () => {
    const store = createNonceStore();
    expect(isKnownNonce("n0", store)).toBe(false);
    recordNonce("n0", store);
    expect(isKnownNonce("n0", store)).toBe(true);
    // Fill past capacity; oldest entry evicted.
    for (let i = 1; i <= PAIRING_NONCE_LRU_LIMIT; i++) recordNonce(`n${i}`, store);
    expect(store.size).toBeLessThanOrEqual(PAIRING_NONCE_LRU_LIMIT);
    expect(isKnownNonce("n0", store)).toBe(false); // evicted
    expect(isKnownNonce(`n${PAIRING_NONCE_LRU_LIMIT}`, store)).toBe(true);
    // Re-sighting refreshes recency.
    recordNonce(`n${PAIRING_NONCE_LRU_LIMIT}`, store);
    for (let i = 1000; i < 1010; i++) recordNonce(`m${i}`, store);
    expect(isKnownNonce(`n${PAIRING_NONCE_LRU_LIMIT}`, store)).toBe(true);
  });
});
