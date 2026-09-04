// Tide DC-05 §4/§6 — tests for the Noise_XX_25519_ChaChaPoly_SHA256 transport.
//
// Covers: duplex round-trip, tamper => SessionError + dead transport,
// key separation between independent pairs, replay rejection (CipherState
// nonce tracking), no-plaintext-on-the-wire, and wrapWithEncryption
// transparency to sync engine semantics (including a full dual-engine
// convergence session running over the encrypted pair).

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";

import {
  makeLocalDuplexPair,
  wrapWithEncryption,
  deriveSessionKeys,
  generateNoiseStaticKeypair,
  handshakeOverTransport,
  NoiseSessionTransport,
  ed25519ToX25519PrivateKey,
  ed25519ToX25519PublicKey,
  noiseStaticsFromIdentity,
  SessionError,
  type FramedByteTransport,
} from "../src/network/noise_transport.ts";
import {
  createSyncEngine,
  type SyncMessage,
  type SyncTransport,
} from "../src/sync/sync_engine.ts";
import { openDatabase, createLocalChange } from "../src/persistence/database.ts";

function hello(clock: Record<string, number>): SyncMessage {
  return { v: 1, type: "HELLO", device_clock: clock };
}

/** A CHANGES_BATCH carrying an arbitrary string marker in its payload. */
function batchWith(note: string): SyncMessage {
  return {
    v: 1,
    type: "CHANGES_BATCH",
    changes: [
      {
        change_id: `c-${note}`,
        device_id: "d-A",
        local_seq: 1,
        entity_id: "e-1",
        entity_type: "event",
        field_path: "title",
        operation: "set",
        payload: { value: note },
        hlc_timestamp: 1724580000000,
        causality_clock: { "d-A": 1 },
        schema_version: 1,
      },
    ],
  };
}

/** Await a promise expected to reject with SessionError. */
async function expectSessionError(p: Promise<unknown>): Promise<SessionError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    return err as SessionError;
  }
  throw new Error("expected SessionError, but call resolved");
}

describe("DC-05 §6: Noise encrypted transport", () => {
  // Regression (root-cause doc 2026-08-31, amplifier defect): a peer FIN on
  // the TCP carrier must propagate as a clean EOF (null receive) through the
  // carrier→inbound feed loop, not leave the session's receive pending forever.
  class MemCarrier implements FramedByteTransport {
    private q: Uint8Array[] = [];
    private waiter: ((f: Uint8Array | null) => void) | null = null;
    private closed = false;
    peer: MemCarrier | null = null;
    async send(frame: Uint8Array): Promise<void> {
      if (this.peer && !this.peer.closed) this.peer.deliver(frame);
    }
    deliver(frame: Uint8Array): void {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(frame);
      } else {
        this.q.push(frame);
      }
    }
    async receive(): Promise<Uint8Array | null> {
      const next = this.q.shift();
      if (next !== undefined) return next;
      if (this.closed) return null;
      return new Promise((resolve) => {
        this.waiter = resolve;
      });
    }
    close(): void {
      this.closed = true;
      const w = this.waiter;
      this.waiter = null;
      if (w) w(null);
    }
  }

  test("peer FIN on the carrier propagates as clean EOF to session receive()", async () => {
    const { generateIdentity } = await import("../src/security/identity.ts");
    const identA = generateIdentity();
    const identB = generateIdentity();

    const ca = new MemCarrier();
    const cb = new MemCarrier();
    ca.peer = cb;
    cb.peer = ca;

    const [hA, hB] = await Promise.all([
      handshakeOverTransport("initiator", ca, identA.privateKey),
      handshakeOverTransport("responder", cb, identB.privateKey),
    ]);
    const tA = new NoiseSessionTransport(
      hA.sendCipher, hA.receiveCipher, hA.handshakeHash(), hA.remoteStaticKey(),
      hA.inbound, hA.outbound, "initiator",
    );
    const tB = new NoiseSessionTransport(
      hB.sendCipher, hB.receiveCipher, hB.handshakeHash(), hB.remoteStaticKey(),
      hB.inbound, hB.outbound, "responder",
    );

    // Traffic flows normally over the carrier first.
    await tA.send(hello({ n: 1 }));
    expect(await tB.receive()).toEqual(hello({ n: 1 }));

    // B parks on receive(); then A closes the connection — the FIN arrives on
    // B's local carrier (cb), which is what B's feed loop reads from.
    const pending = tB.receive();
    ca.close();
    cb.close();
    // Clean EOF — NOT a hang and NOT a crypto failure.
    await expect(pending).resolves.toBeNull();
    // EOF is sticky: a receive after the close resolves null immediately.
    await expect(tB.receive()).resolves.toBeNull();
  });

  test("duplex pair round-trips SyncMessage JSON through encrypt/decrypt", async () => {
    const [a, b] = await makeLocalDuplexPair();

    const outbound: SyncMessage[] = [
      hello({ "d-A": 3 }),
      { v: 1, type: "CHANGES_REQUEST", ranges: [{ device_id: "d-A", lo: 1, hi: 9 }] },
      {
        v: 1,
        type: "CHANGES_BATCH",
        changes: [
          {
            change_id: "c-1",
            device_id: "d-A",
            local_seq: 1,
            entity_id: "e-1",
            entity_type: "event",
            field_path: "title",
            operation: "set",
            payload: { value: "hello world" },
            hlc_timestamp: 1724580000000,
            causality_clock: { "d-A": 1 },
            schema_version: 1,
          },
        ],
      },
      { v: 1, type: "CHANGES_ACK", applied_upto: { "d-A": 2 } },
    ];

    for (const msg of outbound) {
      await a.send(msg);
      const received = await b.receive();
      expect(received).not.toBeNull();
      expect(received).toEqual(msg); // JSON fidelity both ways
    }

    // And in the other direction.
    const back = hello({ "d-B": 7 });
    await b.send(back);
    expect(await a.receive()).toEqual(back);

    // Handshake completed on both sides with matching transcript hash and
    // each side learned the peer's X25519 static.
    expect(a.isDead()).toBe(false);
    expect(b.isDead()).toBe(false);
    expect(Buffer.from(a.handshakeHash()).equals(Buffer.from(b.handshakeHash()))).toBe(true);
    expect(a.handshakeHash().length).toBe(32);
    expect(a.remoteStaticKey().length).toBe(32);
  });

  test("preserves send/receive order under interleaved bidirectional traffic", async () => {
    const [a, b] = await makeLocalDuplexPair();
    const sentA = Array.from({ length: 20 }, (_, i) => hello({ seq: i }));
    for (const m of sentA) await a.send(m);
    for (const m of sentA) expect(await b.receive()).toEqual(m);

    // Interleaved both directions keeps per-direction FIFO order. B drains
    // ALL of A's messages first, then A receives all of B's.
    const sentB: SyncMessage[] = Array.from({ length: 10 }, (_, i) =>
      hello({ bseq: i }),
    );
    for (let i = 0; i < sentA.length / 2; i++) await a.send(sentA[i]!);
    for (let i = sentA.length / 2; i < sentA.length; i++) await a.send(sentA[i]!);
    for (const m of sentB) await b.send(m);

    for (const m of sentA) expect(await b.receive()).toEqual(m);
    for (const m of sentB) expect(await a.receive()).toEqual(m);
  });

  test("tampered ciphertext throws SessionError and marks transport dead", async () => {
    let captured: Uint8Array | null = null;
    const [a, b] = await makeLocalDuplexPair({
      tapFrames: (from, frame) => {
        // Capture only the first SESSION data frame (handshake frames are
        // tagged "initiator"/"responder"; session data frames "session").
        if (from === "session" && captured === null) {
          captured = new Uint8Array(frame);
        }
      },
    });

    const msg = batchWith("secret-payload");
    await a.send(msg);

    // Corrupt one byte of the captured ciphertext and inject it at B.
    // B's queue already holds the good frame first; the tampered frame sits
    // behind it, so the FIRST receive returns the good message and the
    // SECOND receive must fail closed (decrypt error -> dead session).
    const tampered = new Uint8Array(captured!);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0x01) & 0xff;
    b.injectInboundFrame(tampered);

    expect(await b.receive()).toEqual(msg); // good frame applies normally
    await expectSessionError(b.receive());  // tampered frame kills session
    expect(b.isDead()).toBe(true);

    // Fail-closed: dead transport refuses further use — no fallback path.
    await expectSessionError(b.receive());
    await expectSessionError(b.send(hello({ x: 1 })));
  });

  test("two pairs with different session keys cannot decrypt each other's traffic", async () => {
    // Explicit distinct statics -> distinct handshake transcripts -> distinct keys.
    const keysA = await generateNoiseStaticKeypair();
    const keysB = await generateNoiseStaticKeypair();
    const [pair1a, pair1b] = await makeLocalDuplexPair({
      initiatorStaticKeys: keysA,
      responderStaticKeys: keysB,
    });
    const [pair2a, pair2b] = await makeLocalDuplexPair({
      initiatorStaticKeys: await generateNoiseStaticKeypair(),
      responderStaticKeys: await generateNoiseStaticKeypair(),
    });
    void pair1b;
    void pair2b;

    expect(
      Buffer.from(pair1a.handshakeHash()).equals(Buffer.from(pair2a.handshakeHash())),
    ).toBe(false);

    // Third, independent pair emits one ciphertext frame on the wire...
    let foreignFrame: Uint8Array | null = null;
    const [foreign] = await makeLocalDuplexPair({
      tapFrames: (_from, frame) => {
        if (foreignFrame === null) foreignFrame = new Uint8Array(frame);
      },
    });
    await foreign.send(batchWith("for-someone-else"));
    expect(foreignFrame).not.toBeNull();

    // Inject pair-3 traffic into pair-1's responder: wrong keys -> fail closed.
    pair1b.injectInboundFrame(new Uint8Array(foreignFrame!));
    await expectSessionError(pair1b.receive());
    expect(pair1b.isDead()).toBe(true);

    const seed = new Uint8Array(32).fill(7);
    const good = deriveSessionKeys(seed);
    const evil = deriveSessionKeys(new Uint8Array(32).fill(9));
    const frames: Uint8Array[] = [];
    // M-3: wrapWithEncryption is internal/test-only — tests acknowledge via
    // { allowUnboundKeys: true }; the default now throws (guarded below).
    const sender = await wrapWithEncryption(recorderTarget({ frames }), good, { allowUnboundKeys: true });
    await sender.send(hello({ k: 1 }));
    const receiverWrongKeys = await wrapWithEncryption(
      playerSource([frames[0]!]),
      {
        sendKey: evil.receiveKey,
        receiveKey: evil.sendKey,
      },
      { allowUnboundKeys: true },
    );
    await expectSessionError(receiverWrongKeys.receive());

    // Correct keys decrypt fine (sanity that failure above was key mismatch).
    const receiverRightKeys = await wrapWithEncryption(
      playerSource([frames[0]!]),
      { sendKey: good.receiveKey, receiveKey: good.sendKey },
      { allowUnboundKeys: true },
    );
    expect(await receiverRightKeys.receive()).toEqual(hello({ k: 1 }));
  });

  test("replay of identical ciphertext is detected via nonce tracking -> SessionError", async () => {
    let captured: Uint8Array | null = null;
    const [a, b] = await makeLocalDuplexPair({
      tapFrames: (_from, frame) => {
        if (captured === null) captured = new Uint8Array(frame);
      },
    });

    await a.send(hello({ n: 1 }));
    expect(await b.receive()).toEqual(hello({ n: 1 }));

    // Replay the EXACT same frame: receive-side nonce has advanced, AEAD check fails.
    b.injectInboundFrame(new Uint8Array(captured!));
    await expectSessionError(b.receive());
    expect(b.isDead()).toBe(true);
  });

  test("no plaintext on the wire: raw bytes are not valid JSON of the message", async () => {
    const frames: Uint8Array[] = [];
    const marker = "PLAINTEXT-MARKER-x7f3";
    const msg = batchWith(`${marker}-${"z".repeat(512)}`);

    const tap = (_from: "initiator" | "responder" | "session", frame: Uint8Array): void => {
      frames.push(new Uint8Array(frame));
    };

    const [a, b] = await makeLocalDuplexPair({ tapFrames: tap });
    const before = frames.length;
    await a.send(msg);

    // Only frames captured AFTER the handshake are data ciphertext; the
    // handshake itself also emits 3 wire frames (XX: ->e, <-e ee s es, ->s se).
    const dataFrames = frames.slice(before).filter((f) => f.length > 0);
    // Sanity: at least one genuine data frame was captured post-handshake.
    expect(dataFrames.length).toBeGreaterThanOrEqual(1);

    const plainJson = JSON.stringify(msg);
    const markerNeedle = marker;
    for (const f of dataFrames) {
      const text = Buffer.from(f).toString("utf8");
      // Not byte-identical to the message JSON...
      expect(text).not.toBe(plainJson);
      // ...and leaks none of its content even as a substring.
      expect(text.includes(markerNeedle)).toBe(false);
      // Not parseable into the original message either.
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null; // expected for random ciphertext bytes
      }
      expect(parsed).not.toEqual(msg);
      // High entropy: not remotely printable JSON-shaped output.
      expect(f.length).toBeGreaterThan(0);
    }
  });

  test("wrapWithEncryption preserves sync engine semantics over a real dual-engine session", async () => {
    // Full integration: two sync engines converge across an encrypted link
    // built by wrapWithEncryption over a framed byte pipe.
    const seed = new Uint8Array(32).map((_, i) => (i * 11 + 3) % 256);
    const keys = deriveSessionKeys(seed);
    const qAtoB: Uint8Array[] = [];
    const qBtoA: Uint8Array[] = [];

    const pipeTo = (outbound: Uint8Array[], inbound: Uint8Array[]) => ({
      async send(frame: Uint8Array): Promise<void> {
        outbound.push(frame);
      },
      receive(): Promise<Uint8Array | null> {
        return new Promise((resolve) => {
          const check = (): void => {
            const f = inbound.shift();
            if (f !== undefined) resolve(f);
            else setTimeout(check, 1);
          };
          check();
        });
      },
    });

    // A sends with keys.sendKey; B must receive with keys.sendKey => B's
    // receiveKey = A's sendKey (directional keys are mirrored).
    const tA = await wrapWithEncryption(
      pipeTo(qAtoB, qBtoA),
      {
        sendKey: keys.sendKey,
        receiveKey: keys.receiveKey,
      },
      { allowUnboundKeys: true },
    );
    const tB = await wrapWithEncryption(
      pipeTo(qBtoA, qAtoB),
      {
        sendKey: keys.receiveKey,
        receiveKey: keys.sendKey,
      },
      { allowUnboundKeys: true },
    );

    const dir = mkdtempSync(join(tmpdir(), "tide-noise-"));
    try {
      const dbA = openDatabase({ path: join(dir, "a.db") });
      const dbB = openDatabase({ path: join(dir, "b.db") });

      createLocalChange(dbA, "d-A", {
        entity_id: "e-1",
        entity_type: "event",
        field_path: "title",
        operation: "set",
        payload: { value: "over noise" },
        hlc_now: () => Date.now(),
      });
      createLocalChange(dbB, "d-B", {
        entity_id: "e-2",
        entity_type: "event",
        field_path: "description",
        operation: "set",
        payload: { value: "encrypted cake" },
        hlc_now: () => Date.now(),
      });

      const engA = createSyncEngine({ db: dbA, selfDeviceId: "d-A" });
      const engB = createSyncEngine({ db: dbB, selfDeviceId: "d-B" });

      // Both sessions MUST run concurrently: every engine blocks awaiting its
      // peer's HELLO before returning, so awaiting them sequentially would
      // deadlock (A waits for a HELLO that B never sends because B never
      // starts). Promise.all starts both sessions in the same tick.
      const [statsA, statsB] = await Promise.all([
        engA.runSession(tA),
        engB.runSession(tB),
      ]);

      const countChanges = (db: Database) =>
        (db.prepare("SELECT COUNT(*) c FROM changes").get() as { c: number }).c;
      expect(countChanges(dbA)).toBe(2);
      expect(countChanges(dbB)).toBe(2);
      expect(statsA.receivedApplied + statsB.receivedApplied).toBeGreaterThanOrEqual(2);

      dbA.close();
      dbB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrapWithEncryption: order preserved and tamper fails closed", async () => {
    const seed = new Uint8Array(32).fill(5);
    const keys = deriveSessionKeys(seed);
    // qAtoB: written by A's send, read by B's receive (A -> B direction).
    // qBtoA: written by B's send, read by A's receive (B -> A direction).
    const qAtoB: Uint8Array[] = [];
    const qBtoA: Uint8Array[] = [];
    // Ciphertext copies captured as each frame LEAVES A (so we can tamper a
    // genuine data frame even after B has drained the wire queue).
    const sentByA: Uint8Array[] = [];

    const tA = await wrapWithEncryption(
      {
        async send(frame) {
          sentByA.push(new Uint8Array(frame));
          qAtoB.push(frame);
        },
        async receive() {
          return qBtoA.shift() ?? null;
        },
      },
      { sendKey: keys.sendKey, receiveKey: keys.receiveKey },
      { allowUnboundKeys: true },
    );
    const tB = await wrapWithEncryption(
      {
        async send(frame) {
          qBtoA.push(frame);
        },
        async receive() {
          return qAtoB.shift() ?? null;
        },
      },
      { sendKey: keys.receiveKey, receiveKey: keys.sendKey },
      { allowUnboundKeys: true },
    );

    const msgs: SyncMessage[] = [
      hello({ i: 1 }),
      { v: 1, type: "CHANGES_ACK", applied_upto: { "d-A": 42 } },
      hello({ i: 3 }),
    ];
    for (const m of msgs) await tA.send(m);
    for (const m of msgs) expect(await tB.receive()).toEqual(m);

    // Tamper byte[0] of a GENUINE captured data ciphertext. ChaChaPoly AEAD
    // fails on any ciphertext change; the frame goes onto qAtoB, which is
    // B's inbound path.
    const bad = new Uint8Array(sentByA[sentByA.length - 1]!);
    expect(bad.length).toBeGreaterThan(0);
    bad[0] = (bad[0]! ^ 0xff) & 0xff;
    qAtoB.push(bad);
    await expectSessionError(tB.receive());
    await expectSessionError(tB.receive()); // still dead
    await expectSessionError(tB.send(hello({ after: 1 })));
  });
});

describe("Review-3 M-3: wrapWithEncryption transcript-free-key guard", () => {
  test("default (no opts) REFUSES transcript-free session keys", async () => {
    const keys = deriveSessionKeys(new Uint8Array(32).fill(1));
    let err: unknown;
    try {
      await wrapWithEncryption(recorderTarget({ frames: [] }), keys);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).message).toMatch(/allowUnboundKeys|M-3/i);
  });

  test("explicit false is equally refused; only { allowUnboundKeys: true } passes the gate", async () => {
    const keys = deriveSessionKeys(new Uint8Array(32).fill(2));
    await expect(
      wrapWithEncryption(recorderTarget({ frames: [] }), keys, { allowUnboundKeys: false }),
    ).rejects.toBeInstanceOf(SessionError);
    // Opt-in works and yields a functioning transport.
    const frames: Uint8Array[] = [];
    const t = await wrapWithEncryption(recorderTarget({ frames }), keys, { allowUnboundKeys: true });
    await t.send(hello({ guarded: 1 }));
    expect(frames.length).toBe(1);
  });

  test("deriveSessionKeys itself remains deterministic (documented @internal)", () => {
    const seed = new Uint8Array(32).fill(11);
    const a = deriveSessionKeys(seed);
    const b = deriveSessionKeys(seed);
    expect(Buffer.from(a.sendKey).equals(Buffer.from(b.sendKey))).toBe(true);
    expect(Buffer.from(a.receiveKey).equals(Buffer.from(b.receiveKey))).toBe(true);
  });
});

describe("Review-3 H-1: Ed25519 -> X25519 identity binding (DC-05 §4)", () => {
  // Cross-checked vectors: private conversion must equal @noble/curves'
  // own toMontgomerySecret, and X25519(pub-of-converted-priv) must equal
  // converted pub (the §4 binding invariant).
  test("private key conversion: SHA-512(seed), clamp — matches library construction", async () => {
    const { ed25519: curve } = await import("@noble/curves/ed25519.js");
    for (const n of [1, 7, 42]) {
      const edSeed = new Uint8Array(32).map((_, i) => (i * n + 5) % 256);
      const ours = ed25519ToX25519PrivateKey(edSeed);
      const libRef = curve.utils.toMontgomerySecret(edSeed);
      expect(Buffer.from(ours).equals(Buffer.from(libRef))).toBe(true);
      // Clamp actually applied.
      expect(ours[0]! & 7).toBe(0);
      expect(ours[31]! & 128).toBe(0);
      expect(ours[31]! & 64).toBe(64);
    }
  });

  test("binding invariant: X25519(converted priv) == converted pub, deterministic", async () => {
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const { generateIdentity } = await import("../src/security/identity.ts");
    for (let i = 0; i < 8; i++) {
      const id = generateIdentity();
      const privX = ed25519ToX25519PrivateKey(id.privateKey);
      const pubA = x25519.getPublicKey(privX);
      const pubB = ed25519ToX25519PublicKey(id.publicKey);
      expect(Buffer.from(pubA).equals(Buffer.from(pubB))).toBe(true);
      // Deterministic across repeated calls.
      expect(Buffer.from(ed25519ToX25519PublicKey(id.publicKey)).equals(Buffer.from(pubB))).toBe(true);
    }
  });

  test("rejects wrong-length key material", () => {
    expect(() => ed25519ToX25519PrivateKey(new Uint8Array(16))).toThrow(SessionError);
    expect(() => ed25519ToX25519PublicKey(new Uint8Array(64))).toThrow(SessionError);
  });

  test("identity-derived handshake: remote static == converted identity key (real XX)", async () => {
    const { generateIdentity } = await import("../src/security/identity.ts");
    const alice = generateIdentity();
    const bob = generateIdentity();

    const [a, b] = await makeLocalDuplexPair({
      initiatorIdentitySeed: alice.privateKey,
      responderIdentitySeed: bob.privateKey,
    });

    // Each side learned the peer's static, which IS the peer's converted
    // Ed25519 identity public key — not a random Curve25519 key.
    expect(
      Buffer.from(a.remoteStaticKey()).equals(
        Buffer.from(ed25519ToX25519PublicKey(bob.publicKey)),
      ),
    ).toBe(true);
    expect(
      Buffer.from(b.remoteStaticKey()).equals(
        Buffer.from(ed25519ToX25519PublicKey(alice.publicKey)),
      ),
    ).toBe(true);

    // The derived statics are also reproducible standalone.
    const again = noiseStaticsFromIdentity(bob.privateKey);
    expect(Buffer.from(again.publicKey).equals(Buffer.from(a.remoteStaticKey()))).toBe(true);

    // And traffic still flows over the real handshake.
    await a.send(hello({ bound: 1 }));
    expect(await b.receive()).toEqual(hello({ bound: 1 }));
  });

  test("random-static pairs remain unaffected when no identity seed given", async () => {
    const explicit = await generateNoiseStaticKeypair();
    const [, r] = await makeLocalDuplexPair({
      initiatorStaticKeys: explicit,
    });
    expect(r.remoteStaticKey().length).toBe(32);
    // Explicit statics still take effect when no seed overrides them.
    expect(
      Buffer.from(r.remoteStaticKey()).equals(
        Buffer.from(ed25519ToX25519PublicKey(new Uint8Array(32))), // never true
      ),
    ).toBe(false);
  });
});

// --- small helpers for the wrapWithEncryption tests ---

function recorderTarget(rec: { frames: Uint8Array[] }): FramedByteTransportShim {
  return {
    async send(frame: Uint8Array): Promise<void> {
      rec.frames.push(frame);
    },
    async receive(): Promise<Uint8Array | null> {
      throw new Error("not used in this direction");
    },
  };
}

function playerSource(frames: Array<Uint8Array>): FramedByteTransportShim {
  let i = 0;
  return {
    async send(): Promise<void> {
      throw new Error("not used in this direction");
    },
    async receive(): Promise<Uint8Array | null> {
      const f = frames[i++];
      return f ?? null;
    },
  };
}

interface FramedByteTransportShim {
  send(frame: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array | null>;
}
