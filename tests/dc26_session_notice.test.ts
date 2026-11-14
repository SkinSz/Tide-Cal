// DC-26 §3.1 at the real session choke point (SyncManager.runEngineSession):
// TR-1 (one notice iff data applied; none for idle or failed sessions),
// TR-2 (rows committed and visible to another connection at notice time),
// V1 (a conflict outcome counts as applied). Adopted from the 2026-11-14
// independent review's probe.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadOrCreateIdentity } from "../src/network/sync_runtime.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { SyncManager } from "../src/persistence/bridges/sidecar_server.ts";
import { createSyncEngine, type SyncTransport } from "../src/sync/sync_engine.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";
import { msgPipePair } from "./probes/sync_probe_helpers.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tide-dc26-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dev(tag: string) {
  const dir = mkdtempSync(join(root, tag + "-"));
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
  return { identity, core, dbPath: join(dir, "tide.db") };
}
type Dev = ReturnType<typeof dev>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrap = (raw: any): SyncTransport =>
  ({
    send: async (m: unknown) => {
      await raw.send(m);
    },
    receive: async () => (await raw.receive()) as never,
  }) as never;

async function session(a: Dev, mgrB: SyncManager): Promise<void> {
  const [rawA, rawB] = msgPipePair();
  const engA = createSyncEngine({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: a.core.db as any,
    selfDeviceId: a.identity.deviceId,
    mutateEntity: makeEntityMutator(),
  });
  const fake = {
    raw: { remoteStaticKey: () => new Uint8Array(32) },
    transport: wrap(rawB),
    done: () => rawB.close(),
    dialEndpoint: undefined,
  };
  const runA = engA.runSession(wrap(rawA)).then(
    () => rawA.close(),
    () => rawA.close(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runB = mgrB.runEngineSession(fake as any);
  await Promise.allSettled([runA, runB]);
}

const input = (title: string, t: number) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ({ title, description: "", startMs: t, endMs: t + 3_600_000, allDay: false }) as any;

describe("DC-26 notice at the session choke point", () => {
  test("TR-1/TR-2/V1: applied, conflicting, idle and failed sessions", { timeout: 60_000 }, async () => {
    const a = dev("A");
    const b = dev("B");
    const mgrB = new SyncManager(b.core, b.identity);
    const notices: Array<{ applied: number; events: number; conflicts: number }> = [];
    mgrB.onDataChanged = (applied) => {
      const r = new Database(b.dbPath, { readonly: true });
      const events = (r.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
      const conflicts = (
        r.prepare("SELECT COUNT(*) c FROM conflicts WHERE status = 'unresolved'").get() as {
          c: number;
        }
      ).c;
      r.close();
      notices.push({ applied, events, conflicts });
    };
    const t = Date.now();

    // S1: A creates an event -> B applies it -> one notice, row visible (TR-2).
    const ev = a.core.createEvent(input("base", t));
    await session(a, mgrB);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.applied).toBeGreaterThan(0);
    expect(notices[0]!.events).toBe(1);

    // S2: concurrent edits of the same field -> conflict on B -> notice (V1).
    a.core.updateEvent(ev.id, input("A-title", t));
    b.core.updateEvent(ev.id, input("B-title", t));
    notices.length = 0;
    await session(a, mgrB);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.conflicts).toBe(1);

    // S3: nothing new -> no notice.
    notices.length = 0;
    await session(a, mgrB);
    expect(notices).toHaveLength(0);

    // S4: peer dies at once -> session throws -> no notice.
    const [rawA, rawB] = msgPipePair();
    rawA.close();
    let threw = false;
    await mgrB
      .runEngineSession({
        raw: { remoteStaticKey: () => new Uint8Array(32) },
        transport: wrap(rawB),
        done: () => rawB.close(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .catch(() => {
        threw = true;
      });
    expect(threw).toBe(true);
    expect(notices).toHaveLength(0);
  });
});
