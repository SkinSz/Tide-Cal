import { test, expect } from "vitest";
import { handshakeOverTransport, FramingError } from "../src/network/noise_transport.ts";
import { generateIdentity } from "../src/security/identity.ts";
import type { FramedByteTransport } from "../src/network/noise_transport.ts";

class C implements FramedByteTransport {
  private q: Uint8Array[] = [];
  private waiter: ((f: Uint8Array | null) => void) | null = null;
  private closed = false;
  private failed = false;
  peer: C | null = null;
  async send(frame: Uint8Array): Promise<void> {
    if (this.peer && !(this.peer as unknown as C).closed) (this.peer as unknown as C).deliver(frame);
  }
  deliver(frame: Uint8Array): void {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(frame); }
    else this.q.push(frame);
  }
  receive(): Promise<Uint8Array | null> {
    const next = this.q.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed && this.failed) return Promise.reject(new FramingError("rst"));
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      // TD-018: the waiter must carry the failure outcome — a parked receive
      // woken by fail() REJECTS (this mirrors sync_runtime socketFraming,
      // whose receive() re-checks failed after wake).
      this.waiter = (f) => {
        if (f === null && this.failed) reject(new FramingError("rst"));
        else resolve(f);
      };
    });
  }
  fail(): void { this.failed = true; this.closed = true; const w = this.waiter; this.waiter = null; if (w) w(null); }
}

test("sanity: single carrier fail -> inbound null after reject", async () => {
  const ia = generateIdentity();
  const ca = new C();
  // One-sided handshake won't complete; instead directly check receive()
  // behavior after fail: must reject with FramingError.
  const p = ca.receive(); // parks
  ca.fail();
  await expect(p).rejects.toBeInstanceOf(FramingError);
  // After failure, a fresh receive also rejects.
  await expect(ca.receive()).rejects.toBeInstanceOf(FramingError);
  void handshakeOverTransport; void ia;
});
