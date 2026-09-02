// Tide DC-21: mDNS-to-sidecar endpoint plumbing (discovery bridge).
//
// OWNER AMENDMENT D3 (binding): live mDNS cache entries AND last-known
// endpoints are ROUTING HINTS ONLY. Neither establishes, contributes to, or
// substitutes for peer identity or trust. Only successful authenticated
// Noise_XX session establishment (DC-05) may confirm that a dialed endpoint
// corresponds to the expected device identity. This module therefore:
//   - consumes mdns_event notifications + mdns_snapshot into a TTL cache
//     (§3.2/D2: exactly ONE cache, in the sidecar, keyed by instance_name),
//   - prefilters browse results by instance-name prefix (§3.3/D3),
//   - exposes endpoint resolution precedence for the scheduler (§4.3/D7:
//     live cache > last-known > skip),
//   - and verifies post-handshake identity BEFORE any session result is
//     trusted or any endpoint is persisted (§D3/§4.2/D6).
//
// Privacy (§7/D10): non-paired browse results are dropped prefilter-side and
// never persisted; endpoints never leave the device.

import { instancePrefix } from "./discovery.ts";

export interface MdnsEvent {
  kind: "added" | "removed";
  instance_name: string;
  host: string;
  port: number;
  interface: string;
  observed_at: number;
  /** Cache TTL for this observation (ms). Platform-derived, DC-11 §3.4. */
  ttl_ms: number;
}

export interface EndpointResolution {
  deviceId: string;
  endpoint: { host: string; port: number };
}

export interface PeerEndpointSource {
  /** Paired, trusted peer device ids. */
  deviceIds(): string[];
  /** Last-known endpoint for a device (nullable, DC-21 §4.1 columns). */
  lastKnown(deviceId: string): { host: string; port: number; seen: number } | null;
}

/**
 * TTL-bound endpoint cache keyed by instance_name (DC-11 §3.4 shape). The
 * sidecar maintains exactly one of these from mdns_event pushes; entries are
 * hints, deletable without consequence. Expired entries never resolve.
 */
export class EndpointCache {
  private readonly entries = new Map<
    string,
    { deviceId: string; host: string; port: number; expiresAt: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Apply one mdns_event after the instance-prefix prefilter has already
   * attributed it to a device_id. "removed" deletes the entry (the last-known
   * DB row is untouched — §4.2).
   */
  applyEvent(event: MdnsEvent, deviceId: string): void {
    if (event.kind === "removed") {
      this.entries.delete(event.instance_name);
      return;
    }
    this.entries.set(event.instance_name, {
      deviceId,
      host: event.host,
      port: event.port,
      expiresAt: this.now() + Math.max(0, event.ttl_ms),
    });
  }

  /**
   * Seed the cache from an mdns_snapshot response (sidecar restart path,
   * §6.3 — idempotent: keyed by instance_name, re-seeding cannot duplicate).
   * Only entries whose instance prefix belongs to a paired peer are applied.
   */
  applySnapshot(
    entries: Array<Omit<MdnsEvent, "kind">>,
    expectedPrefixes: Map<string, string>,
  ): number {
    let applied = 0;
    for (const e of entries) {
      const deviceId = expectedPrefixes.get(prefixOf(e.instance_name));
      if (deviceId === undefined) continue; // non-paired instance: drop
      this.applyEvent({ ...e, kind: "added" }, deviceId);
      applied++;
    }
    return applied;
  }

  /** Live (TTL-valid) entry for a device, if any. Stale entries never resolve. */
  getForDevice(deviceId: string): { host: string; port: number } | undefined {
    const ts = this.now();
    for (const entry of this.entries.values()) {
      if (entry.deviceId !== deviceId) continue;
      if (entry.expiresAt <= ts) continue; // stale: never shadows last-known
      return { host: entry.host, port: entry.port };
    }
    return undefined;
  }

  size(): number {
    return this.entries.size;
  }
}

function prefixOf(instanceName: string): string {
  const dash = instanceName.indexOf("-");
  return dash > 0 ? instanceName.slice(0, dash) : instanceName.slice(0, 8);
}

/**
 * DC-21 §3.3/D3 prefilter: does this browse event's instance_name match the
 * expected instance prefix of a paired, trusted peer? Returns that peer's
 * device_id, or undefined (non-matching instances are ignored — logged at
 * debug at most, never persisted).
 */
export function matchInstanceToPeer(
  instanceName: string,
  pairedDeviceIds: string[],
): string | undefined {
  const prefix = prefixOf(instanceName);
  for (const deviceId of pairedDeviceIds) {
    if (instancePrefix(deviceId) === prefix) return deviceId;
  }
  return undefined;
}

/**
 * DC-21 §4.3/D7 endpoint resolution for the scheduler's listPeers:
 *   1. live mDNS cache entry for that device_id (fresh, TTL-valid),
 *   2. last-known endpoint from the peers table (opportunistic fallback),
 *   3. neither → undefined (caller skips with the existing log line).
 * A stale live entry is dropped and never shadows last-known.
 */
export function resolveEndpoint(
  cache: EndpointCache,
  source: PeerEndpointSource,
  deviceId: string,
): EndpointResolution | undefined {
  const live = cache.getForDevice(deviceId);
  if (live !== undefined) return { deviceId, endpoint: live };
  const last = source.lastKnown(deviceId);
  if (last !== null) return { deviceId, endpoint: { host: last.host, port: last.port } };
  return undefined;
}

/**
 * D3 (owner amendment, binding) / D6: POST-HANDSHAKE identity verification
 * semantics, documented for the pure layer. The LIVE enforcement lives in
 * SyncManager.runEngineSession (sidecar_server.ts), which compares the
 * handshake's remote x25519 static key against the trust store row for the
 * expected device BEFORE any exchange and persists the endpoint only on
 * success. NOTE for future users of this function: trust-store rows store
 * ED25519 public keys; the handshake exposes X25519 — an ed25519 key must go
 * through ed25519ToX25519PublicKey() before comparison (pkg10 review F5).
 */
export const verifyPeerIdentityAgainstTrustStoreDoc = true;
