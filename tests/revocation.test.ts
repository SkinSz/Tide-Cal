// Tide DC-10 / DC-05 §7 contract tests for the revocation propagation runtime.
// Pure unit level: trust stores are plain Maps, no DB or network.

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  acceptRevocation,
  canSynchronize,
  canonicalRevocationBytes,
  createRevocation,
  createRevocationState,
  recordTriple,
  RevocationQueue,
  verifyRevocation,
  type SignedRevocation,
  type TrustStoreEntry,
} from "../src/security/revocation.ts";
import { generateIdentity, deriveDeviceId, type DeviceIdentity } from "../src/security/identity.ts";

/** Simple in-memory trust store: deviceId -> entry. */
function makeTrustStore(...entries: Array<[DeviceIdentity, "trusted" | "revoked"]>) {
  const map = new Map<string, TrustStoreEntry>();
  for (const [id, status] of entries) {
    map.set(id.deviceId, { publicKey: id.publicKey, status });
  }
  const lookup = (deviceId: string) => map.get(deviceId);
  return { map, lookup };
}

let hlcCounter = 1724600030000;
function nextHlc(): number {
  return ++hlcCounter; // monotonic fake HLC — never compared to wall time
}

async function signRevoke(
  revoker: DeviceIdentity,
  revokedDeviceId: string,
  reason?: string,
): Promise<SignedRevocation> {
  return createRevocation(
    {
      revoked_device_id: revokedDeviceId,
      revoked_by_device_id: revoker.deviceId,
      revoked_at_hlc: nextHlc(),
      ...(reason !== undefined ? { reason } : {}),
    },
    revoker.privateKey,
  );
}

describe("DC-05 §7.1 createRevocation", () => {
  test("signature verifies under signer's stored public key over canonical bytes", async () => {
    const a = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore([a, "trusted"], [x, "trusted"]);
    const signed = await createRevocation(
      {
        revoked_device_id: x.deviceId,
        revoked_by_device_id: a.deviceId,
        revoked_at_hlc: nextHlc(),
        reason: "device lost",
      },
      a.privateKey,
    );
    expect(signed.record.v).toBe(1);
    expect(await verifyRevocation(signed, store.lookup)).toEqual({ valid: true });
  });

  test("canonical bytes are stable under key insertion order (exact byte form)", async () => {
    const a = generateIdentity();
    const x = generateIdentity();
    const fields = {
      reason: "stolen",
      revoked_by_device_id: a.deviceId,
      v: 1 as const,
      revoked_device_id: x.deviceId,
      revoked_at_hlc: 42,
    };
    // Build two objects with different insertion orders.
    const o1 = { ...fields };
    const o2 = {
      revoked_at_hlc: fields.revoked_at_hlc,
      revoked_device_id: fields.revoked_device_id,
      revoked_by_device_id: fields.revoked_by_device_id,
      v: fields.v,
      reason: fields.reason,
    };
    expect(canonicalRevocationBytes(o1)).toEqual(canonicalRevocationBytes(o2));
    // Sorted-key compact form, documented byte shape.
    const text = new TextDecoder().decode(canonicalRevocationBytes(fields));
    expect(text).toBe(
      `{"reason":"stolen","revoked_at_hlc":42,` +
        `"revoked_by_device_id":"${a.deviceId}",` +
        `"revoked_device_id":"${x.deviceId}","v":1}`,
    );
    const s1 = await createRevocation(fields, a.privateKey);
    const s2 = await createRevocation(fields, a.privateKey);
    expect(s2.signature).toEqual(s1.signature);
  });

  test("omitting vs undefined reason yields identical bytes and signatures", async () => {
    const a = generateIdentity();
    const x = generateIdentity();
    const base = {
      v: 1 as const,
      revoked_device_id: x.deviceId,
      revoked_by_device_id: a.deviceId,
      revoked_at_hlc: 7,
    };
    const withUndefined = { ...base, reason: undefined };
    expect(canonicalRevocationBytes(base)).toEqual(
      canonicalRevocationBytes(withUndefined),
    );
  });
});

describe("DC-10 TRP-3 analog: forged records are rejected and never enter any queue", () => {
  test("self-signed record by the revoked device itself is rejected", async () => {
    const a = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore([a, "trusted"], [x, "revoked"]);
    const selfSigned = await createRevocation(
      {
        revoked_device_id: a.deviceId, // X claims A revoked... signed by X
        revoked_by_device_id: x.deviceId,
        revoked_at_hlc: nextHlc(),
      },
      x.privateKey, // X is locally REVOKED -> not an authorized revoker
    );
    const verdict = await verifyRevocation(selfSigned, store.lookup);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toBe("revoker_not_trusted");
  });

  test("record signed by an unknown key is rejected (unknown_revoker)", async () => {
    const a = generateIdentity();
    const attacker = generateIdentity(); // never paired
    const x = generateIdentity();
    const store = makeTrustStore([a, "trusted"], [x, "trusted"]);
    const forged = await createRevocation(
      {
        revoked_device_id: x.deviceId,
        revoked_by_device_id: a.deviceId, // claims to be A...
        revoked_at_hlc: nextHlc(),
      },
      attacker.privateKey, // ...but signed with an unknown key
    );
    const verdict = await verifyRevocation(forged, store.lookup);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toBe("bad_signature");
    void attacker;
  });

  test("bit-flipped valid record is rejected (bad_signature)", async () => {
    const a = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore([a, "trusted"], [x, "trusted"]);
    const valid = await signRevoke(a, x.deviceId);
    const flipped = new Uint8Array(valid.signature);
    if (flipped.length > 3) flipped[3] = (flipped[3] ?? 0) ^ 0x01;
    const verdict = await verifyRevocation({ record: valid.record, signature: flipped }, store.lookup);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toBe("bad_signature");
  });

  test("tampered record body invalidates the signature", async () => {
    const a = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore([a, "trusted"], [x, "trusted"]);
    const valid = await signRevoke(a, x.deviceId);
    const tampered = {
      record: { ...valid.record, reason: "innocent" },
      signature: valid.signature,
    };
    expect((await verifyRevocation(tampered, store.lookup)).valid).toBe(false);
  });

  test("forged records are never stored and downstream peers receive zero copies", async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const x = generateIdentity();
    // X is locally REVOKED (T5): it may not author revocations of others.
    const store = makeTrustStore([a, "trusted"], [b, "trusted"], [x, "revoked"]);
    const state = createRevocationState();
    const queue = new RevocationQueue(state);

    const unknownSigner = generateIdentity();
    const f1 = await createRevocation(
      {
        revoked_device_id: x.deviceId,
        revoked_by_device_id: a.deviceId,
        revoked_at_hlc: nextHlc(),
      },
      unknownSigner.privateKey,
    );
    const f2 = await createRevocation(
      {
        revoked_device_id: a.deviceId,
        revoked_by_device_id: x.deviceId,
        revoked_at_hlc: nextHlc(),
      },
      x.privateKey, // x signs while x is the target — self-signed per §7.2
    );

    const r1 = await acceptRevocation(state, f1, store.lookup);
    const r2 = await acceptRevocation(state, f2, store.lookup);
    expect(r1.accepted).toBe(false);
    expect(r1.valid).toBe(false);
    expect(r2.accepted).toBe(false);
    expect(r2.valid).toBe(false);
    expect(state.records.size).toBe(0);
    // No relay target ever receives a copy of either forgery.
    expect(queue.queue(b.deviceId)).toHaveLength(0);
    expect(queue.queue(a.deviceId)).toHaveLength(0);
    expect(queue.queue(x.deviceId)).toHaveLength(0);
  });

  test("verifyRevocation NEVER throws on garbage input", async () => {
    const a = generateIdentity();
    const store = makeTrustStore([a, "trusted"]);
    const junk: Array<[unknown, unknown]> = [
      [null, null],
      [{}, {}],
      [{ record: undefined, signature: undefined }, undefined],
      [
        {
          record: { v: 9, revoked_device_id: "", revoked_by_device_id: "" },
          signature: new Uint8Array(0),
        },
        undefined,
      ],
      [
        {
          get record(): never {
            throw new Error("boom");
          },
          signature: new Uint8Array([1]),
        },
        undefined,
      ],
    ];
    for (const [signed] of junk) {
      const verdict = await verifyRevocation(signed as SignedRevocation, store.lookup);
      expect(verdict.valid).toBe(false);
    }
  });
});

describe("DC-05 §7.2 store-once acceptance idempotence", () => {
  test("re-accepting the same record is a duplicate no-op with identical state", async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore([a, "trusted"], [b, "trusted"], [x, "trusted"]);
    const signed = await signRevoke(a, x.deviceId);
    const state = createRevocationState();

    const first = await acceptRevocation(state, signed, store.lookup);
    expect(first).toEqual({ accepted: true, duplicate: false, valid: true });
    const snapshot = [...state.records.entries()];

    // Redelivery (duplicated/reordered message, INVARIANT 14) is a no-op.
    const second = await acceptRevocation(state, signed, store.lookup);
    expect(second).toEqual({ accepted: false, duplicate: true, valid: true });
    expect([...state.records.entries()]).toEqual(snapshot);
    expect(state.records.size).toBe(1);
  });

  test("accepted record appears exactly once in every eligible peer queue until acked", async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const c = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore([a, "trusted"], [b, "trusted"], [c, "trusted"], [x, "trusted"]);
    const state = createRevocationState();
    const queue = new RevocationQueue(state);
    await acceptRevocation(state, await signRevoke(a, x.deviceId), store.lookup);

    expect(queue.queue(b.deviceId)).toHaveLength(1);
    expect(queue.queue(b.deviceId)).toHaveLength(1); // still one copy — derived state
    expect(queue.queue(c.deviceId)).toHaveLength(1);
  });
});

describe("DC-10 §2.1/§2.5/§3 queue + ACK bookkeeping (TRP-4)", () => {
  async function setupMesh() {
    const a = generateIdentity();
    const b = generateIdentity();
    const c = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore(
      [a, "trusted"],
      [b, "trusted"],
      [c, "trusted"],
      [x, "trusted"],
    );
    const state = createRevocationState();
    const queue = new RevocationQueue(state);
    // A revokes X; B accepts it via gossip from A.
    const recA = await signRevoke(a, x.deviceId);
    await acceptRevocation(state, recA, store.lookup);
    // C also revoked Y at some point; B holds both records.
    const y = generateIdentity();
    const recC = await signRevoke(c, y.deviceId);
    await acceptRevocation(state, recC, store.lookup);
    return { store, state, queue, recA, recC, a, b, c, x, y };
  }

  test("(a) after ackPeer, the record leaves that peer's queue permanently", async () => {
    const { queue, recA, recC, b } = await setupMesh();
    expect(queue.queue(b.deviceId)).toHaveLength(2);
    queue.ackPeer(b.deviceId, [recordTriple(recA.record)]);
    expect(queue.hasAck(b.deviceId, recordTriple(recA.record))).toBe(true);
    const remaining = queue.queue(b.deviceId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.record).toEqual(recC.record); // only unacked record left
    // Duplicate ACK is a harmless no-op (INVARIANT 14).
    queue.ackPeer(b.deviceId, [recordTriple(recA.record)]);
    expect(queue.queue(b.deviceId)).toHaveLength(1);
  });

  test("(b) lost ACK -> record stays queued for resend on a later session (at-least-once)", async () => {
    const mesh = await setupMesh();
    const { queue, recA, state, store, b } = mesh;
    // Session 1: A sends r to B; the REVOCATIONS_ACK is lost in transit.
    const session1 = queue.queue(b.deviceId);
    expect(session1.map((s) => s.record)).toContainEqual(recA.record);
    // No ackPeer call happens. Session N: A re-sends the same record.
    const sessionN = queue.queue(b.deviceId);
    expect(sessionN.map((s) => s.record)).toContainEqual(recA.record);
    // B's second acceptance is a byte-level no-op (extends DC-08 TR-12).
    const before = [...state.records.entries()];
    const again = await acceptRevocation(state, recA, store.lookup);
    expect(again.duplicate).toBe(true);
    expect([...state.records.entries()]).toEqual(before);
  });

  test("records naming the peer itself are excluded from that peer's queue (§2.1)", async () => {
    const { queue, recA, recC, x } = await setupMesh();
    // recA names X; X must NOT be queued for X (TR-7 cuts it off anyway).
    const forX = queue.queue(x.deviceId);
    expect(forX.map((s) => s.record)).not.toContainEqual(recA.record);
    expect(forX.map((s) => s.record)).toEqual([recC.record]);
  });
});

describe("DC-10 TRP-8: TTL-free propagation (age plays no role)", () => {
  test("design assertion: no wall-clock source or age comparison exists in the module", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/security/revocation.ts", import.meta.url)),
      "utf8",
    );
    // Strip comments so prose mentions don't count as code usage.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden = [
      "Date.now",
      "performance.now",
      "process.hrtime",
      "setTimeout",
      "setInterval",
      "ttl",
    ];
    for (const token of forbidden) {
      expect(code.toLowerCase().includes(token.toLowerCase()), token).toBe(false);
    }
    // revoked_at_hlc appears ONLY as identity metadata — object keys,
    // type guards, the <0 sanity bound, and template key joins. Never in
    // an arithmetic/age comparison expression.
    for (const line of code.split("\n")) {
      if (!line.includes("revoked_at_hlc")) continue;
      const allowed =
        /^\s*(readonly\s+)?revoked_at_hlc\s*[:;]/.test(line) ||
        /typeof\s+[\w.]*\.revoked_at_hlc\b/.test(line) ||
        /Number\.isInteger\(\s*[\w.]*\.revoked_at_hlc\s*\)/.test(line) ||
        /\.revoked_at_hlc\s*<\s*0\b/.test(line) ||
        /\$\{[\w.]*\.?revoked_at_hlc\}/.test(line) ||
        /"[^"]*revoked_at_hlc[^"]*"/.test(line); // error-message strings
      expect(allowed, line.trim()).toBe(true);
    }
  });

  test("a 6-month-old record is accepted and forwarded identically to a fresh one", async () => {
    const a = generateIdentity();
    const returning = generateIdentity();
    const x = generateIdentity();
    const store = makeTrustStore(
      [a, "trusted"],
      [returning, "trusted"],
      [x, "trusted"],
    );
    const state = createRevocationState();
    const queue = new RevocationQueue(state);

    const ancient = await createRevocation(
      {
        revoked_device_id: x.deviceId,
        revoked_by_device_id: a.deviceId,
        revoked_at_hlc: 1700000000000, // ~Nov 2023 — months stale
      },
      a.privateKey,
    );
    const fresh = await signRevoke(a, x.deviceId, "fresh");

    expect(await acceptRevocation(state, ancient, store.lookup)).toEqual({
      accepted: true,
      duplicate: false,
      valid: true,
    });
    expect(await acceptRevocation(state, fresh, store.lookup)).toEqual({
      accepted: true,
      duplicate: false,
      valid: true,
    });
    // Both delivered intact to the long-offline returning peer on first contact.
    const out = queue.queue(returning.deviceId);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.record)).toEqual(
      expect.arrayContaining([ancient.record, fresh.record]),
    );
  });
});

describe("DC-10 E1 / TRP-5: simultaneous mutual revocation", () => {
  test("both records stored independently on both devices regardless of arrival order; gate denies both ways; both relay both onward", async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const witness = generateIdentity(); // third party both devices gossip to

    // Each side trusts the other AT ARRIVAL TIME (E1): A's own pending
    // revocation of B does not invalidate B's ability to verify A's record,
    // and vice versa — verification checks the signer against the receiver's
    // trust store at arrival, where the other is still status=trusted.
    const storeOnA = makeTrustStore([a, "trusted"], [b, "trusted"], [witness, "trusted"]);
    const storeOnB = makeTrustStore([a, "trusted"], [b, "trusted"], [witness, "trusted"]);

    const recFromA = await createRevocation(
      {
        revoked_device_id: b.deviceId,
        revoked_by_device_id: a.deviceId,
        revoked_at_hlc: nextHlc(),
      },
      a.privateKey,
    );
    const recFromB = await createRevocation(
      {
        revoked_device_id: a.deviceId,
        revoked_by_device_id: b.deviceId,
        revoked_at_hlc: nextHlc(),
      },
      b.privateKey,
    );

    // Deterministic outcome independent of arrival order: run BOTH orders.
    for (const order of [
      [recFromA, recFromB],
      [recFromB, recFromA],
    ] as const) {
      const state = createRevocationState();
      for (const rec of order) {
        expect(await acceptRevocation(state, rec, storeOnA.lookup)).toEqual({
          accepted: true,
          duplicate: false,
          valid: true,
        });
      }
      expect(state.records.size).toBe(2);
    }

    // Steady state on device A: holds both records, enforces DENY_REVOKED.
    const stateA = createRevocationState();
    await acceptRevocation(stateA, recFromA, storeOnA.lookup);
    await acceptRevocation(stateA, recFromB, storeOnA.lookup);
    const trustAfter = makeTrustStore(
      [a, "trusted"],
      [b, "revoked"],
      [witness, "trusted"],
    );
    expect(canSynchronize(trustAfter.map, b.deviceId)).toBe("DENY_REVOKED");
    expect(canSynchronize(trustAfter.map, a.deviceId)).toBe("ALLOW");

    // Same on device B (mirrored).
    const stateB = createRevocationState();
    await acceptRevocation(stateB, recFromA, storeOnB.lookup);
    await acceptRevocation(stateB, recFromB, storeOnB.lookup);
    const trustOnB = makeTrustStore(
      [a, "revoked"],
      [b, "trusted"],
      [witness, "trusted"],
    );
    expect(canSynchronize(trustOnB.map, a.deviceId)).toBe("DENY_REVOKED");

    // Both devices propagate BOTH records onward to third parties (§2.4),
    // excluding each other (records naming the peer are not queued for it).
    const queueA = new RevocationQueue(stateA);
    const queueB = new RevocationQueue(stateB);
    expect(queueA.queue(witness.deviceId).map((s) => s.record)).toEqual(
      expect.arrayContaining([recFromA.record, recFromB.record]),
    );
    expect(queueB.queue(witness.deviceId)).toHaveLength(2);
    // A forwards B's record onward; B is cut off by TR-7 before delivery
    // could matter, and per §2.1 only records NAMING the peer are excluded
    // from its queue — so B's queue holds exactly the record naming A.
    expect(queueA.queue(b.deviceId).map((s) => s.record)).toEqual([recFromB.record]);
    expect(queueB.queue(a.deviceId).map((s) => s.record)).toEqual([recFromA.record]);
  });
});

describe("DC-05 §7.3 enforcement gate: canSynchronize", () => {
  test("trusted => ALLOW, revoked => DENY_REVOKED, unknown => DENY_UNPAIRED", () => {
    const trusted = generateIdentity();
    const revoked = generateIdentity();
    const store = makeTrustStore([trusted, "trusted"], [revoked, "revoked"]);
    expect(canSynchronize(store.map, trusted.deviceId)).toBe("ALLOW");
    expect(canSynchronize(store.map, revoked.deviceId)).toBe("DENY_REVOKED");
    expect(canSynchronize(store.map, "d-never-paired")).toBe("DENY_UNPAIRED");
  });

  test("accepting a revocation flips the gate from ALLOW to DENY_REVOKED (store-once, then enforce)", async () => {
    const a = generateIdentity();
    const x = generateIdentity();
    let entry: TrustStoreEntry = {
      publicKey: x.publicKey,
      status: "trusted",
    };
    const store = makeTrustStore([a, "trusted"], [x, "trusted"]);
    const mutableLookup = (id: string) =>
      id === x.deviceId ? entry : store.lookup(id);
    const map = new Map<string, TrustStoreEntry>(store.map);
    const setEntry = (e: TrustStoreEntry) => {
      entry = e;
      map.set(x.deviceId, e);
    };

    expect(canSynchronize(map, x.deviceId)).toBe("ALLOW");

    const rec = await signRevoke(a, x.deviceId, "compromised");
    const state = createRevocationState();
    const result = await acceptRevocation(state, rec, mutableLookup);
    expect(result.accepted).toBe(true);

    // Local enforcement step (DC-05 §7.1): apply the accepted record to the
    // trust entry. One-way transition trusted->revoked only (no un-revoke).
    setEntry({ publicKey: x.publicKey, status: "revoked" });
    expect(canSynchronize(map, x.deviceId)).toBe("DENY_REVOKED");

    // Replaying the same record changes nothing further (idempotence).
    expect(await acceptRevocation(state, rec, mutableLookup)).toEqual({
      accepted: false,
      duplicate: true,
      valid: true,
    });
    expect(canSynchronize(map, x.deviceId)).toBe("DENY_REVOKED");
  });
});

describe("Review-3 M-5 / DC-05 §3.3: DENY_KEY_MISMATCH via claimed public key", () => {
  test("matching claim (hashes to peerId AND equals stored key) => ALLOW", () => {
    const a = generateIdentity();
    const store = makeTrustStore([a, "trusted"]);
    expect(canSynchronize(store.map, a.deviceId, a.publicKey)).toBe("ALLOW");
  });

  test("claim whose SHA-256 digest does NOT reproduce peerId => DENY_KEY_MISMATCH", () => {
    const a = generateIdentity();
    const impostor = generateIdentity(); // different key -> different device_id
    const store = makeTrustStore([a, "trusted"]);
    // Impostor presents its own (valid) key while claiming A's device_id.
    expect(canSynchronize(store.map, a.deviceId, impostor.publicKey)).toBe(
      "DENY_KEY_MISMATCH",
    );
  });

  test("claim hashes to peerId but differs from the STORED entry key => DENY_KEY_MISMATCH", () => {
    // Pathological store inconsistency: entry keyed by B's device_id but
    // holding someone else's key. The byte-equality clause catches it.
    const b = generateIdentity();
    const other = generateIdentity();
    const map = new Map<string, TrustStoreEntry>([
      [b.deviceId, { publicKey: other.publicKey, status: "trusted" }],
    ]);
    expect(canSynchronize(map, b.deviceId, b.publicKey)).toBe("DENY_KEY_MISMATCH");
  });

  test("key-mismatch check precedes status: mismatch on a REVOKED peer reports DENY_KEY_MISMATCH", () => {
    const a = generateIdentity();
    const impostor = generateIdentity();
    const store = makeTrustStore([a, "revoked"]);
    expect(canSynchronize(store.map, a.deviceId, impostor.publicKey)).toBe(
      "DENY_KEY_MISMATCH",
    );
    // Matching claim against a revoked peer still yields DENY_REVOKED.
    expect(canSynchronize(store.map, a.deviceId, a.publicKey)).toBe("DENY_REVOKED");
  });

  test("unpaired peer with a claimed key remains DENY_UNPAIRED; two-arg calls unchanged", () => {
    const stranger = generateIdentity();
    const store = makeTrustStore();
    expect(canSynchronize(store.map, stranger.deviceId, stranger.publicKey)).toBe(
      "DENY_UNPAIRED",
    );
    // Backward-compatible two-argument form still works everywhere.
    const known = generateIdentity();
    const store2 = makeTrustStore([known, "trusted"]);
    expect(canSynchronize(store2.map, known.deviceId)).toBe("ALLOW");
    expect(deriveDeviceId(known.publicKey)).toBe(known.deviceId); // sanity
  });
});
