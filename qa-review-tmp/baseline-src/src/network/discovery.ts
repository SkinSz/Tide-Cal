// Tide DC-11: mDNS/Bonjour service discovery — pure logic + thin adapter.
//
// Layers (DC-11 §7 / INVARIANT 12): everything below except the adapter
// factory is pure, deterministic-except-explicitly-random logic that is
// unit-testable without real multicast networking. The adapter layer is the
// ONLY place a multicast library is touched, and it degrades to NoopAdapter
// when none is loadable (DC-11 §6: discovery must be optional, never
// required; INVARIANT 1: offline-first).
//
// Trust firewall (DC-11 §4, CRITICAL): this module produces CONNECTION
// HINTS only. It never creates or mutates trust state. classifyDiscovered()
// reads the local trust store through an injected lookup and returns a
// classification; no code path here writes identity/trust data (DC-11 §4.5/4.6).
//
// Privacy (DC-11 §2/§5/TR-2a): instance names derive from SHA-256(device_id)
// only. TXT keys are exactly {"pv","dn"}. Hostnames, usernames, IPs,
// calendar data are forbidden in any announced field.

import { createHash, randomBytes } from "node:crypto";

/** DC-11 §2.1 — fixed service type; contains no version/platform/user/host info. */
export const TIDE_SERVICE_TYPE = "_tide-sync._tcp.local.";

/** DC-11 §2.3 — current protocol version byte (decimal ASCII). */
export const PROTOCOL_VERSION = "1";

/** Maximum byte length of any single TXT value (conservative mDNS hygiene). */
export const MAX_TXT_VALUE_BYTES = 64;

const TXT_KEY_PV = "pv";
const TXT_KEY_DN = "dn";
const ALLOWED_TXT_KEYS: ReadonlySet<string> = new Set([TXT_KEY_PV, TXT_KEY_DN]);

export interface ServiceIdentity {
  /** Opaque wire name, e.g. "9f2c41a7-b3e0" (DC-11 §2.2). */
  instanceName: string;
  serviceType: string;
  txt: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Pure layer 1a: service identity (DC-11 §2)
// ---------------------------------------------------------------------------

/** Stable 8-hex SHA-256 prefix of device_id (no randomness). */
export function instancePrefix(deviceId: string): string {
  return createHash("sha256").update(deviceId, "utf8").digest("hex").slice(0, 8);
}

/**
 * DC-11 §2.2: instance_name = first 8 hex of SHA-256(device_id) + "-" +
 * 4 random hex chars. Never derives from hostname/user/model/calendar data.
 */
export function buildInstanceName(deviceId: string): string {
  return `${instancePrefix(deviceId)}-${randomBytes(2).toString("hex")}`;
}

function txtValueByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Forbidden-content detector for TXT values (DC-11 §2.3 prohibited list):
 * hostname-like strings, IP addresses, usernames/emails, calendar entity
 * data (names, ISO timestamps/event counts), free-form URL material.
 * Returns null when clean, otherwise a short reason.
 */
export function findForbiddenTxtContent(value: string): string | null {
  if (value.length === 0) return "empty value";
  if (txtValueByteLength(value) > MAX_TXT_VALUE_BYTES) {
    return `value exceeds ${MAX_TXT_VALUE_BYTES} bytes`;
  }
  // IPv4 / IPv4-like dotted quad.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return "looks like an IP address";
  // Hostname-like: two-plus dot-separated labels (e.g. "box.lan", "mac.local").
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\.?$/.test(value)) {
    return "looks like a hostname";
  }
  // Usernames / email addresses.
  if (value.includes("@")) return "contains '@' (email/username material)";
  // Calendar-derived data: ISO dates/timestamps, event-count shapes.
  if (/\d{4}-\d{2}-\d{2}/.test(value)) return "contains a calendar-style date/timestamp";
  if (/^(?:events?|calendars?|collection)\b/i.test(value)) return "calendar metadata keyword";
  if (/^\d+\s+(?:events?|calendars?|entries)/i.test(value)) return "event/collection count";
  // URLs smuggle hostnames/paths.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return "looks like a URL";
  return null;
}

/**
 * DC-11 §2.3: build the TXT record with EXACTLY the allowed keys.
 * "pv" always present; "dn" only when displayNameOptIn is explicitly true
 * (default OFF per DC-11 §5/§6). Throws on forbidden display-name content so
 * leaks fail closed at construction time, not on the peer's validator.
 */
export function buildTxtRecord(opts: {
  displayName?: string;
  displayNameOptIn?: boolean;
}): Record<string, string> {
  const txt: Record<string, string> = { [TXT_KEY_PV]: PROTOCOL_VERSION };
  const displayName = opts.displayName;
  if (displayName !== undefined && opts.displayNameOptIn === true) {
    const reason = findForbiddenTxtContent(displayName);
    if (reason !== null) {
      throw new Error(`display name rejected as TXT value: ${reason}`);
    }
    txt[TXT_KEY_DN] = displayName;
  }
  return txt;
}

export type TxtValidation =
  | { ok: true; txt: Record<string, string> }
  | { ok: false; reason: string };

/**
 * Validate a received TXT record against DC-11 §2.3: only {pv,dn} keys,
 * pv required and matching a known protocol version byte, no oversized
 * values, no forbidden content anywhere. Never throws.
 */
export function validateTxtRecord(txt: Record<string, string>): TxtValidation {
  for (const key of Object.keys(txt)) {
    if (!ALLOWED_TXT_KEYS.has(key)) {
      return { ok: false, reason: `disallowed TXT key "${key}"` };
    }
  }
  const pv = txt[TXT_KEY_PV];
  if (pv === undefined) return { ok: false, reason: "missing required key \"pv\"" };
  if (!/^\d+$/.test(pv)) return { ok: false, reason: "\"pv\" is not a decimal version byte" };
  for (const [key, value] of Object.entries(txt)) {
    const reason = findForbiddenTxtContent(value);
    if (reason !== null) return { ok: false, reason: `"${key}": ${reason}` };
  }
  return { ok: true, txt };
}

// ---------------------------------------------------------------------------
// Pure layer 1b: endpoint cache with TTL (DC-11 §3.4 / TR-6)
// ---------------------------------------------------------------------------

export interface EndpointEntry {
  instanceName: string;
  addresses: string[];
  port: number;
  interface: string;
  lastSeen: number;
  expiresAt: number;
}

/**
 * TTL-bound ephemeral connectivity cache. Lives OUTSIDE the domain database
 * (INVARIANT 2); deletable without consequence (DC-11 §4.4). Expired entries
 * never feed connection attempts: get()/listActive() filter them, expire()
 * physically removes them.
 */
export class EndpointCache {
  private readonly entries = new Map<string, EndpointEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Add or refresh an endpoint; refresh extends expiry from now + ttlMs. */
  add(entry: Omit<EndpointEntry, "lastSeen" | "expiresAt"> & { ttlMs?: number }, ttlMs?: number): EndpointEntry {
    const ts = this.now();
    const ttl = entry.ttlMs ?? ttlMs ?? 0;
    const record: EndpointEntry = {
      instanceName: entry.instanceName,
      addresses: [...entry.addresses],
      port: entry.port,
      interface: entry.interface,
      lastSeen: ts,
      expiresAt: ts + ttl,
    };
    this.entries.set(record.instanceName, record);
    return record;
  }

  /** Active (non-expired) entry, or undefined. Expired entries read as absent. */
  get(instanceName: string): EndpointEntry | undefined {
    const entry = this.entries.get(instanceName);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) return undefined;
    return entry;
  }

  /** Physically remove stale entries. Returns how many were removed. */
  expire(): number {
    const ts = this.now();
    let removed = 0;
    for (const [name, entry] of this.entries) {
      if (entry.expiresAt <= ts) {
        this.entries.delete(name);
        removed += 1;
      }
    }
    return removed;
  }

  /** Live candidates only — expired entries are never returned. */
  listActive(): EndpointEntry[] {
    const ts = this.now();
    const active: EndpointEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.expiresAt > ts) active.push(entry);
    }
    return active.sort((a, b) => a.instanceName.localeCompare(b.instanceName));
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Pure layer 1c: discovery filter / trust firewall read side (DC-11 §4)
// ---------------------------------------------------------------------------

export type DiscoveredClassification =
  | "paired"
  | "unpaired"
  | "incompatible-version";

/**
 * Classify a discovered endpoint based ONLY on its pv byte and the local
 * trust store, consulted through `trustLookup`. This function is the entire
 * write-side surface of the trust firewall: it performs NO mutation, keeps
 * NO state, and cannot create or rank trust entries (DC-11 §4.1/§4.5).
 *
 *   - invalid TXT or foreign pv byte -> "incompatible-version" (refuse
 *     before opening a socket, DC-11 §2.3)
 *   - known to local trust store     -> "paired"
 *   - otherwise                      -> "unpaired" (Case C: silent ignore)
 */
export function classifyDiscovered(
  instanceName: string,
  txt: Record<string, string>,
  trustLookup: (instanceName: string) => boolean,
): DiscoveredClassification {
  const check = validateTxtRecord(txt);
  if (!check.ok) return "incompatible-version";
  if (check.txt[TXT_KEY_PV] !== PROTOCOL_VERSION) return "incompatible-version";
  // The instance name is an opaque cache/trust-store key (DC-11 §2.2); it is
  // only ever CONSULTED here, never recorded into any persistent structure.
  return trustLookup(instanceName) ? "paired" : "unpaired";
}

// ---------------------------------------------------------------------------
// Thin layer 2: mDNS adapter. REAL mDNS lives in Rust: src-tauri/src/discovery.rs
// (mdns-sd crate, cargo feature `mdns`), exposed as Tauri commands per DC-11
// §7. This seam stays so non-Tauri/test contexts have a defined interface.
//
// HONEST FALLBACK (review R3 M-1): when the Rust backend is not wired in,
// createMdnsAdapter returns NoopMdnsAdapter and SAYS SO — it never logs
// "backend available" or "would register" as if real multicast happened.
// The npm package "mdns-sd@0.0.1" is an unrelated placeholder with no JS API
// and has been removed from devDependencies; do not re-add it.
// ---------------------------------------------------------------------------

export interface DiscoveredService {
  instanceName: string;
  txt: Record<string, string>;
  addresses: string[];
  port: number;
  ttlMs: number;
}

export interface MdnsAdapter {
  register(identity: ServiceIdentity): Promise<void>;
  browse(onDiscovered: (service: DiscoveredService) => void): Promise<void>;
  withdraw(): Promise<void>;
}

type MdnsLogger = (message: string) => void;

function defaultLogger(message: string): void {
  console.log(`[tide-discovery] ${message}`);
}

/** Inert adapter used when no multicast library is available (or discovery is disabled, DC-11 §6). */
export class NoopMdnsAdapter implements MdnsAdapter {
  constructor(private readonly log: MdnsLogger = defaultLogger) {}

  async register(identity: ServiceIdentity): Promise<void> {
    this.log(`noop adapter: would register ${identity.instanceName} (${TIDE_SERVICE_TYPE})`);
  }

  async browse(onDiscovered: (service: DiscoveredService) => void): Promise<void> {
    void onDiscovered;
    this.log("noop adapter: browsing unavailable (no multicast backend)");
  }

  async withdraw(): Promise<void> {
    this.log("noop adapter: withdraw is a no-op");
  }
}

/**
 * Adapter factory. There is intentionally NO JavaScript multicast backend:
 * real mDNS is implemented in Rust (src-tauri/src/discovery.rs, `mdns` cargo
 * feature) and reaches this layer through Tauri command registration. Until
 * that wiring lands, every caller gets an explicit NoopMdnsAdapter whose log
 * messages state that discovery is unavailable — never a misleading success.
 */
export function createMdnsAdapter(log: MdnsLogger = defaultLogger): MdnsAdapter {
  log("discovery unavailable in this build: real mDNS requires the Tauri Rust backend (src-tauri/src/discovery.rs, --features mdns); using inert noop adapter");
  return new NoopMdnsAdapter(log);
}
