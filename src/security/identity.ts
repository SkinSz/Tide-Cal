// Tide DC-05 §2: Device identity — Ed25519 keypair, deterministic device_id.
// Uses @noble/ed25519 v3 + @noble/hashes v2 (established, audited libraries).
// No custom cryptography (Spec §17).

import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

export interface DeviceIdentity {
  deviceId: string; // "d-" + hex(sha256(publicKey)) per DC-05 §2.2
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function deriveDeviceId(publicKey: Uint8Array): string {
  return "d-" + toHex(sha256(publicKey));
}

// Configure noble's synchronous hash providers (v3 API: ed.hashes.sha512)
(ed as unknown as { hashes: { sha512: typeof sha512 } }).hashes.sha512 = sha512;

/** Generate a fresh identity (once per installation). */
export function generateIdentity(): DeviceIdentity {
  const privateKey = randomBytes(32);
  const publicKey = ed.getPublicKey(privateKey);
  return { deviceId: deriveDeviceId(publicKey), publicKey, privateKey };
}

/** Reconstruct identity from stored key material (OS keystore load path). */
export function identityFromPrivateKey(privateKey: Uint8Array): DeviceIdentity {
  const publicKey = ed.getPublicKey(privateKey);
  return { deviceId: deriveDeviceId(publicKey), publicKey, privateKey };
}

/**
 * Ed25519 detached signature (DC-05 §7.1 revocation signing).
 * Async variant of noble v3.
 */
export async function signAsync(
  message: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey);
}

export async function verifyAsync(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

export { concat };
