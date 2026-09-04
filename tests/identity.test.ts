import { describe, expect, test } from "vitest";
import {
  generateIdentity,
  deriveDeviceId,
  identityFromPrivateKey,
  signAsync,
  verifyAsync,
} from "../src/security/identity.ts";

describe("DC-05 TR-1 device_id derivation", () => {
  test("deterministic and stable", () => {
    const id = generateIdentity();
    expect(deriveDeviceId(id.publicKey)).toBe(id.deviceId);
    expect(deriveDeviceId(id.publicKey)).toBe(deriveDeviceId(id.publicKey));
  });

  test("different keys yield different ids (property over 1000)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateIdentity().deviceId);
    }
    expect(seen.size).toBe(1000);
  });

  test("id format: d- + 64 hex chars", () => {
    const id = generateIdentity();
    expect(id.deviceId).toMatch(/^d-[0-9a-f]{64}$/);
  });

  test("restore path: same private key -> same identity", () => {
    const id = generateIdentity();
    const restored = identityFromPrivateKey(id.privateKey);
    expect(restored.deviceId).toBe(id.deviceId);
    expect(restored.publicKey).toEqual(id.publicKey);
  });
});

describe("DC-05 §7.2 signatures", () => {
  test("sign/verify round-trips; tampering rejected", async () => {
    const a = generateIdentity();
    const msg = new TextEncoder().encode("revoke d-tablet");
    const sig = await signAsync(msg, a.privateKey);
    expect(await verifyAsync(msg, sig, a.publicKey)).toBe(true);
    const tampered = new TextEncoder().encode("revoke d-someoneElse");
    expect(await verifyAsync(tampered, sig, a.publicKey)).toBe(false);
  });

  test("forged signature from wrong key fails (TRP-3 analog)", async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const msg = new TextEncoder().encode("x");
    const forgedByB = await signAsync(msg, b.privateKey);
    expect(await verifyAsync(msg, forgedByB, a.publicKey)).toBe(false);
  });
});
