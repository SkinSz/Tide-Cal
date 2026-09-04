// DC-21 — mDNS-to-sidecar endpoint plumbing (discovery bridge) tests.
//
// Contract: docs/contracts/DC-21_mdns_endpoint_plumbing.md. Binding owner
// amendment D3: live mDNS and last-known endpoints are ROUTING HINTS ONLY —
// only authenticated Noise_XX establishment confirms identity. D6: endpoints
// written ONLY after a successful authenticated session. D7: live cache >
// last-known > skip.
import { describe, expect, test } from "vitest";
import {
  EndpointCache,
  matchInstanceToPeer,
  resolveEndpoint,
  type MdnsEvent,
  type PeerEndpointSource,
} from "../src/network/endpoint_bridge.ts";
import { instancePrefix } from "../src/network/discovery.ts";

const mkEvent = (over: Partial<MdnsEvent> & { instance_name: string }): MdnsEvent => ({
  kind: "added",
  host: "192.168.1.50",
  port: 47471,
  interface: "wlan0",
  observed_at: 1_000,
  ttl_ms: 60_000,
  ...over,
});

describe("DC-21 D3: instance-prefix prefilter", () => {
  test("matches an instance to its paired peer by SHA-256 prefix", () => {
    const deviceId = "d-abc123";
    const instance = `${instancePrefix(deviceId)}-a1b2`;
    expect(matchInstanceToPeer(instance, [deviceId])).toBe(deviceId);
  });

  test("non-paired instances return undefined (dropped, never persisted)", () => {
    const stranger = "ffffffff-a1b2";
    expect(matchInstanceToPeer(stranger, ["d-abc123"])).toBeUndefined();
  });

  test("prefix derivation matches the DC-11 §2.2 rule", () => {
    // instancePrefix is the 8-hex SHA-256(device_id) prefix.
    expect(instancePrefix("d-abc123")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("DC-21 D2: endpoint cache — one cache, keyed by instance_name", () => {
  test("added event is attributed and resolvable; removed deletes the entry", () => {
    const cache = new EndpointCache();
    const deviceId = "d-abc123";
    const instance = `${instancePrefix(deviceId)}-a1b2`;
    cache.applyEvent(mkEvent({ instance_name: instance }), deviceId);
    expect(cache.getForDevice(deviceId)).toEqual({ host: "192.168.1.50", port: 47471 });

    cache.applyEvent(mkEvent({ instance_name: instance, kind: "removed" }), deviceId);
    expect(cache.getForDevice(deviceId)).toBeUndefined();
  });

  test("TTL expiry: a stale cache entry never resolves (D7 — no shadowing)", () => {
    let now = 1_000;
    const cache = new EndpointCache(() => now);
    const deviceId = "d-abc123";
    cache.applyEvent(mkEvent({ instance_name: `${instancePrefix(deviceId)}-a1b2`, ttl_ms: 5_000 }), deviceId);
    now += 6_000; // TTL expired
    expect(cache.getForDevice(deviceId)).toBeUndefined();
  });

  test("restart re-seeding is idempotent (no duplicate entries, §6.3)", () => {
    const cache = new EndpointCache();
    const deviceId = "d-abc123";
    const prefixes = new Map([[instancePrefix(deviceId), deviceId]]);
    const entries = [{ instance_name: `${instancePrefix(deviceId)}-a1b2`, host: "10.0.0.2", port: 47471, interface: "eth0", observed_at: 1, ttl_ms: 60_000 }];
    expect(cache.applySnapshot(entries, prefixes)).toBe(1);
    expect(cache.applySnapshot(entries, prefixes)).toBe(1);
    expect(cache.size()).toBe(1);
  });

  test("snapshot entries from NON-paired instances are dropped (privacy §7)", () => {
    const cache = new EndpointCache();
    const deviceId = "d-abc123";
    const prefixes = new Map([[instancePrefix(deviceId), deviceId]]);
    const applied = cache.applySnapshot(
      [
        { instance_name: "deadbeef-ffff", host: "10.9.9.9", port: 1, interface: "", observed_at: 1, ttl_ms: 1000 },
        { instance_name: `${instancePrefix(deviceId)}-a1b2`, host: "10.0.0.2", port: 47471, interface: "", observed_at: 1, ttl_ms: 60_000 },
      ],
      prefixes,
    );
    expect(applied).toBe(1);
    expect(cache.size()).toBe(1);
  });
});

describe("DC-21 D7: endpoint precedence — live cache > last-known > skip", () => {
  const deviceId = "d-abc123";

  function makeSource(lastKnown: { host: string; port: number; seen: number } | null): PeerEndpointSource {
    return {
      deviceIds: () => [deviceId],
      lastKnown: (id) => (id === deviceId ? lastKnown : null),
    };
  }

  test("live cache entry wins over last-known", () => {
    let now = 1_000;
    const cache = new EndpointCache(() => now);
    cache.applyEvent(mkEvent({ instance_name: `${instancePrefix(deviceId)}-a1b2`, host: "10.0.0.9", port: 9999 }), deviceId);
    const resolution = resolveEndpoint(cache, makeSource({ host: "10.0.0.2", port: 47471, seen: 500 }), deviceId);
    expect(resolution).toEqual({ deviceId, endpoint: { host: "10.0.0.9", port: 9999 } });
    void now;
  });

  test("stale cache entry falls back to last-known (never shadows)", () => {
    let now = 1_000;
    const cache = new EndpointCache(() => now);
    cache.applyEvent(mkEvent({ instance_name: `${instancePrefix(deviceId)}-a1b2`, host: "10.0.0.9", port: 9999, ttl_ms: 1_000 }), deviceId);
    now += 2_000; // cache entry expired
    const resolution = resolveEndpoint(
      cache,
      makeSource({ host: "10.0.0.2", port: 47471, seen: 500 }),
      deviceId,
    );
    expect(resolution).toEqual({ deviceId, endpoint: { host: "10.0.0.2", port: 47471 } });
  });

  test("no cache + no last-known → undefined (skip with log, INVARIANT 1)", () => {
    const cache = new EndpointCache();
    expect(resolveEndpoint(cache, makeSource(null), deviceId)).toBeUndefined();
  });
});

// NOTE (pkg10 review F5): the live D3 verification lives in
// SyncManager.runEngineSession (sidecar_server.ts) — enforced against the
// trust store on the real scheduler path. The pure helper that used to live
// here was removed as dead code; the x25519-vs-ed25519 conversion pitfall is
// documented in endpoint_bridge.ts.
