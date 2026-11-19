// DC-05 §3.3 / DC-10 canSynchronize at the real listener: a session whose
// handshake key is not a TRUSTED paired device is closed before any record
// is served or applied. Regression for the 2026-11-14 finding: Noise XX
// authenticates a key, not membership, and inbound sessions ran the engine
// for ANY key (a never-paired device read the calendar and injected events).
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, connectSync } from "../src/network/sync_runtime.ts";
import { EventCore } from "../src/persistence/bridges/event_core.ts";
import { SyncManager } from "../src/persistence/bridges/sidecar_server.ts";
import { createSyncEngine } from "../src/sync/sync_engine.ts";
import { makeEntityMutator } from "../src/persistence/bridges/sync_service.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tide-trustgate-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function dev(tag: string, title: string) {
  const dir = mkdtempSync(join(root, tag + "-"));
  const identity = loadOrCreateIdentity(dir);
  const core = new EventCore(join(dir, "tide.db"), identity.deviceId);
  const t = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  core.createEvent({ title, description: "", startMs: t, endMs: t + 3_600_000, allDay: false } as any);
  return { identity, core };
}
type Dev = ReturnType<typeof dev>;
const titles = (d: Dev) =>
  (d.core.db.prepare("SELECT title FROM events ORDER BY title").all() as Array<{ title: string }>).map(
    (r) => r.title,
  );

async function dialOnce(host: Dev, guest: Dev): Promise<void> {
  const mgr = new SyncManager(host.core, host.identity);
  mgr.ensureListener(0);
  let port = 0;
  for (let i = 0; i < 200 && !port; i++) {
    await new Promise((r) => setTimeout(r, 10));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    port = (mgr as any).host?.actualPort ?? 0;
  }
  expect(port).toBeGreaterThan(0);
  try {
    const s = await connectSync(guest.identity.privateKey, "127.0.0.1", port);
    const eng = createSyncEngine({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: guest.core.db as any,
      selfDeviceId: guest.identity.deviceId,
      mutateEntity: makeEntityMutator(),
    });
    await eng.runSession(s.transport).catch(() => undefined);
    s.done();
    await new Promise((r) => setTimeout(r, 300)); // host's engine run settles
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).host?.close();
  }
}

function addPeer(host: Dev, peer: Dev, status: "trusted" | "revoked"): void {
  host.core.db
    .prepare(
      "INSERT INTO peers (device_id, public_key, display_name, paired_at, status) VALUES (?, ?, ?, ?, ?)",
    )
    .run(peer.identity.deviceId, Buffer.from(peer.identity.publicKey), "p", Date.now(), status);
}

test("never-paired device: nothing served, nothing applied", { timeout: 30_000 }, async () => {
  const host = dev("host", "HOST-ONLY");
  const stranger = dev("stranger", "STRANGER");
  await dialOnce(host, stranger);
  expect(titles(host)).toEqual(["HOST-ONLY"]);
  expect(titles(stranger)).toEqual(["STRANGER"]);
});

test("revoked device: refused like a stranger", { timeout: 30_000 }, async () => {
  const host = dev("host", "HOST-ONLY");
  const gone = dev("gone", "GONE");
  addPeer(host, gone, "revoked");
  await dialOnce(host, gone);
  expect(titles(host)).toEqual(["HOST-ONLY"]);
  expect(titles(gone)).toEqual(["GONE"]);
});

test("trusted paired device: syncs both ways (control)", { timeout: 30_000 }, async () => {
  const host = dev("host", "HOST-ONLY");
  const friend = dev("friend", "FRIEND");
  addPeer(host, friend, "trusted");
  await dialOnce(host, friend);
  expect(titles(host)).toEqual(["FRIEND", "HOST-ONLY"]);
  expect(titles(friend)).toEqual(["FRIEND", "HOST-ONLY"]);
});

test("one malformed stored peer key does not refuse other paired devices", { timeout: 30_000 }, async () => {
  const host = dev("host", "HOST-ONLY");
  const friend = dev("friend", "FRIEND");
  host.core.db
    .prepare(
      "INSERT INTO peers (device_id, public_key, display_name, paired_at, status) VALUES ('d-bad', ?, 'x', 0, 'trusted')",
    )
    .run(Buffer.from([1, 2, 3]));
  addPeer(host, friend, "trusted");
  await dialOnce(host, friend);
  expect(titles(host)).toEqual(["FRIEND", "HOST-ONLY"]);
});
