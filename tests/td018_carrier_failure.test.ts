// TD-018 — a DEAD CARRIER must end the session LOUD (SessionError), not as a
// clean converged close. DC-05 §6.3: transport failure is terminal.
//
// Defect (independent review F1): the noise_transport feed loop mapped carrier
// error and clean FIN to the same null-EOF, and the outbound pump swallowed
// send failures — a peer RST mid-session reported a converged session.
// Fix: socketFraming distinguishes error (failed flag) from FIN; the feed
// loop pushes a sentinel frame on failure so the transport's AEAD check
// fails loudly; pump failures are logged, not swallowed.
//
// Contract pinned here (against the REAL handshake + feed loop):
//   1. Carrier FAILED (RST shape) → session transport.receive() THROWS
//      SessionError (sentinel frame fails AEAD by construction).
//   2. Carrier closed CLEANLY (FIN shape) → session transport.receive()
//      resolves null (stall-fix behavior preserved).
import { describe, expect, test } from "vitest";
import {
  FramingError,
  handshakeOverTransport,
  NoiseSessionTransport,
  SessionError,
  type FramedByteTransport,
} from "../src/network/noise_transport.ts";
import { generateIdentity } from "../src/security/identity.ts";

/**
 * MemCarrier with a FAILURE mode: close() is the clean FIN shape; fail() is
 * the RST shape (closed AND flagged failed) — mirroring sync_runtime's
 * socketFraming distinction (error → failed=true; close/end → failed=false).
 */
class FailableCarrier implements FramedByteTransport {
  private q: Uint8Array[] = [];
  private waiter: ((f: Uint8Array | null) => void) | null = null;
  private closed = false;
  private failed = false;
  peer: FailableCarrier | null = null;

  /** TD-018 contract hook: did the carrier FAIL (vs clean close)? */
  get __tideFramingFailed(): () => boolean {
    return () => this.failed;
  }

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
  receive(): Promise<Uint8Array | null> {
    const next = this.q.shift();
    if (next !== undefined) return Promise.resolve(next);
    // Mirror socketFraming exactly: wait for wake, THEN evaluate closed/failed
    // (a wake can arrive from fail() while we are pending — the decision is
    // made after the wait, not before).
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const settle = (): void => {
        if (this.q.length > 0) {
          resolve(this.q.shift()!);
          return;
        }
        if (this.closed && this.failed) {
          // TD-018 (pkg9 F1/F2): FAILED carrier rejects with FramingError —
          // the feed loop converts this into the loud sentinel. Clean close
          // still resolves null.
          reject(new FramingError("sync carrier failed (test RST shape)"));
          return;
        }
        if (this.closed) {
          resolve(null);
          return;
        }
        this.waiter = (f) => {
          if (f === null) settle();
          else resolve(f);
        };
      };
      settle();
    });
  }
  /** Clean FIN shape: closed, NOT failed. */
  close(): void {
    this.closed = true;
    this.wakeWaiter();
  }
  /** RST shape: closed AND failed. */
  fail(): void {
    this.failed = true;
    this.closed = true;
    this.wakeWaiter();
  }
  /**
   * Wake a pending receive. The woken settle() re-evaluates closed/failed —
   * pkg9: a pending receive woken by fail() must REJECT, not resolve null.
   * The wake token is always a frame (null token would short-circuit the
   * re-evaluation); settle() treats an empty queue + closed as the real
   * signal.
   */
  private wakeWaiter(): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w(null); // settle() re-runs and sees closed(+failed) state
  }
}

async function handshakenPair(): Promise<{
  tA: NoiseSessionTransport;
  tB: NoiseSessionTransport;
  ca: FailableCarrier;
  cb: FailableCarrier;
}> {
  const identA = generateIdentity();
  const identB = generateIdentity();
  const ca = new FailableCarrier();
  const cb = new FailableCarrier();
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
  return { tA, tB, ca, cb };
}

describe("TD-018: dead carrier ends the session LOUD, FIN stays clean", () => {
  test("carrier FAILED (RST shape) → pending + fresh receive() throw SessionError, not null", async () => {
    const { tA, tB, ca, cb } = await handshakenPair();

    // Sanity: session works before the failure.
    await tA.send({ v: 1, type: "HELLO", device_clock: { "d-a": 1 } });
    expect(await tB.receive()).toEqual({ v: 1, type: "HELLO", device_clock: { "d-a": 1 } });

    // B parks on receive(); then A's carrier FAILS (RST shape). The feed
    // loop on A's side observes the failure and pushes the sentinel —
    // A's transport must end LOUD, and B's parked receive must see a
    // clean EOF (its own carrier closed cleanly as part of the RST wake).
    const pendingB = tB.receive();
    ca.fail();
    cb.close(); // B's peer socket closes as a consequence of the RST

    await expect(tA.receive()).rejects.toBeInstanceOf(SessionError);
    await expect(pendingB).resolves.toBeNull(); // B's own carrier: clean
  });

  test("carrier closed CLEANLY (FIN shape) → session receive() resolves null", async () => {
    const { tA, ca } = await handshakenPair();

    ca.close(); // FIN shape — the stall-fix behavior must be preserved

    await expect(tA.receive()).resolves.toBeNull();
  });

  test("fresh receive() after failure rejects with SessionError (sentinel persists)", async () => {
    const { tA, ca } = await handshakenPair();

    ca.fail();
    // First receive throws (sentinel); a second receive must ALSO throw —
    // the transport is dead, never "clean EOF on retry".
    await expect(tA.receive()).rejects.toBeInstanceOf(SessionError);
    await expect(tA.receive()).rejects.toBeInstanceOf(SessionError);
  });
});
