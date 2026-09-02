// DC-21 — schema v7 migration test: peers table gains last_endpoint_host/
// port/seen (D5: nullable, additive, non-authoritative, device-local).
import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/persistence/database.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPeerEndpoint, listTrustedPeers } from "../src/network/pairing_manager.ts";

describe("DC-21 D5: peers last-known endpoint columns", () => {
  test("v6 database migrates to v7 with nullable endpoint columns", () => {
    // Build a v6-shaped db manually, then open (which migrates).
    const dir = mkdtempSync(join(tmpdir(), "tide-dc21-"));
    try {
      const raw = new Database(join(dir, "m.db"));
      raw.exec(`
        CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at_hlc INTEGER NOT NULL);
        CREATE TABLE peers (
          device_id TEXT PRIMARY KEY,
          public_key BLOB NOT NULL,
          display_name TEXT NOT NULL,
          paired_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('trusted','revoked')),
          last_known_clock TEXT NOT NULL DEFAULT '{}'
        );
        INSERT INTO peers (device_id, public_key, display_name, paired_at, status)
          VALUES ('d-x', x'0011', 'Peer X', 1000, 'trusted');
        INSERT INTO schema_version (id, version, applied_at_hlc) VALUES (1, 6, 1);
      `);
      raw.close();

      const db = openDatabase({ path: join(dir, "m.db") });
      const cols = (
        db.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain("last_endpoint_host");
      expect(cols).toContain("last_endpoint_port");
      expect(cols).toContain("last_endpoint_seen");

      // NULL = never connected.
      const peers = listTrustedPeers(db);
      expect(peers[0]!.last_endpoint_host).toBeNull();

      // D6 write path works.
      recordPeerEndpoint(db, "d-x", "192.168.1.7", 47471, Date.now());
      const after = listTrustedPeers(db);
      expect(after[0]!.last_endpoint_host).toBe("192.168.1.7");
      expect(after[0]!.last_endpoint_port).toBe(47471);
      expect(after[0]!.last_endpoint_seen).toBeGreaterThan(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
