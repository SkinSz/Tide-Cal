// Tide DC-11 tests: pure discovery logic + adapter fallback + privacy statics.
// No real multicast networking is exercised anywhere (task constraint).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  EndpointCache,
  MAX_TXT_VALUE_BYTES,
  NoopMdnsAdapter,
  PROTOCOL_VERSION,
  TIDE_SERVICE_TYPE,
  buildInstanceName,
  buildTxtRecord,
  classifyDiscovered,
  createMdnsAdapter,
  instancePrefix,
  validateTxtRecord,
  type EndpointEntry,
} from "../src/network/discovery.ts";

// Deterministic clock for cache tests.
function makeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

describe("DC-11 §2.2 instance name", () => {
  const DEVICE_ID = "d-" + "ab".repeat(32);

  it("matches /^{8hex}-{4hex}$/", () => {
    for (let i = 0; i < 50; i++) {
      expect(buildInstanceName(DEVICE_ID)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}$/);
    }
  });

  it("prefix is deterministic for the same deviceId; only the suffix varies", () => {
    const a = buildInstanceName(DEVICE_ID);
    const b = buildInstanceName(DEVICE_ID);
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
    expect(instancePrefix(DEVICE_ID)).toBe(a.slice(0, 8));
  });

  it("different devices get different prefixes", () => {
    const other = instancePrefix("d-" + "cd".repeat(32));
    expect(other).not.toBe(instancePrefix(DEVICE_ID));
  });

  it("suffix space is exercised across samples", () => {
    const suffixes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      suffixes.add(buildInstanceName(DEVICE_ID).slice(9));
    }
    expect(suffixes.size).toBeGreaterThan(1);
  });

  it("prefix equals first 8 hex of SHA-256(device_id)", () => {
    // Independent recomputation with node crypto.
    const expected = createHash("sha256").update(DEVICE_ID, "utf8").digest("hex").slice(0, 8);
    expect(instancePrefix(DEVICE_ID)).toBe(expected);
  });
});

describe("DC-11 §2.3 TXT record", () => {
  it("pv is always present at the current protocol version", () => {
    expect(buildTxtRecord({})).toEqual({ pv: PROTOCOL_VERSION });
    expect(buildTxtRecord({ displayNameOptIn: false })).toEqual({ pv: PROTOCOL_VERSION });
  });

  it("dn appears ONLY when opted in", () => {
    expect(buildTxtRecord({ displayName: "Kitchen tab" })).toEqual({ pv: PROTOCOL_VERSION });
    const optedIn = buildTxtRecord({ displayName: "Kitchen tab", displayNameOptIn: true });
    expect(optedIn).toEqual({ pv: PROTOCOL_VERSION, dn: "Kitchen tab" });
    expect(Object.keys(optedIn).sort()).toEqual(["dn", "pv"]);
  });

  it("validateTxtRecord accepts well-formed records", () => {
    expect(validateTxtRecord({ pv: "1" }).ok).toBe(true);
    expect(validateTxtRecord({ pv: "1", dn: "Desk" }).ok).toBe(true);
  });

  it("rejects extra keys (no extension points, DC-11 §2.3)", () => {
    expect(validateTxtRecord({ pv: "1", notes: "hello" }).ok).toBe(false);
    expect(validateTxtRecord({ pv: "1", os: "win32" }).ok).toBe(false);
    expect(validateTxtRecord({ dn: "x" }).ok).toBe(false); // pv required
  });

  it("rejects hostname-like values", () => {
    expect(validateTxtRecord({ pv: "1", dn: "mybox.local" }).ok).toBe(false);
    expect(validateTxtRecord({ pv: "1", dn: "DESKTOP-ABC123.lan" }).ok).toBe(false);
    expect(validateTxtRecord({ pv: "1", dn: "host.example.com" }).ok).toBe(false);
    expect(validateTxtRecord({ pv: "1", dn: "192.168.1.10" }).ok).toBe(false);
  });

  it("rejects username/email-like values", () => {
    expect(validateTxtRecord({ pv: "1", dn: "alice@example.org" }).ok).toBe(false);
    expect(validateTxtRecord({ pv: "1", dn: "user@host" }).ok).toBe(false);
  });

  it("rejects calendar-derived values", () => {
    expect(validateTxtRecord({ pv: "1", dn: "2026-08-25T10:00:00Z" }).ok).toBe(false);
    expect(validateTxtRecord({ pv: "1", dn: "events:42" }).ok).toBe(false);
  });

  it(`rejects values over ${MAX_TXT_VALUE_BYTES} bytes`, () => {
    const okName = "a".repeat(MAX_TXT_VALUE_BYTES);
    expect(validateTxtRecord({ pv: "1", dn: okName }).ok).toBe(true);
    const tooLong = "a".repeat(MAX_TXT_VALUE_BYTES + 1);
    expect(validateTxtRecord({ pv: "1", dn: tooLong }).ok).toBe(false);
  });

  it("buildTxtRecord throws on forbidden display names (fail closed)", () => {
    expect(() =>
      buildTxtRecord({ displayName: "laptop.local", displayNameOptIn: true }),
    ).toThrow();
  });
});

describe("DC-11 §3.4 endpoint cache (TR-6)", () => {
  function entry(name: string): Omit<EndpointEntry, "lastSeen" | "expiresAt"> {
    return { instanceName: name, addresses: ["192.168.0.5"], port: 47471, interface: "wlan0" };
  }

  it("returns active entries and honors TTL expiry", () => {
    const clock = makeClock();
    const cache = new EndpointCache(clock.now);
    cache.add(entry("aaaaaaaa-bbbb"), 5000);
    expect(cache.get("aaaaaaaa-bbbb")).toBeDefined();
    expect(cache.listActive()).toHaveLength(1);
    clock.advance(5001);
    expect(cache.get("aaaaaaaa-bbbb")).toBeUndefined(); // reads as absent
    expect(cache.listActive()).toHaveLength(0); // never in active list
  });

  it("refresh extends expiry", () => {
    const clock = makeClock();
    const cache = new EndpointCache(clock.now);
    cache.add(entry("cccccccc-dddd"), 5000);
    clock.advance(4000); // nearly expired
    cache.add(entry("cccccccc-dddd"), 5000); // refresh
    clock.advance(4000); // would be past original TTL
    expect(cache.get("cccccccc-dddd")).toBeDefined();
    clock.advance(2000); // past refreshed TTL
    expect(cache.get("cccccccc-dddd")).toBeUndefined();
  });

  it("expire() removes exactly the stale entries", () => {
    const clock = makeClock();
    const cache = new EndpointCache(clock.now);
    cache.add(entry("11111111-aaaa"), 1000);
    cache.add(entry("22222222-bbbb"), 10000);
    clock.advance(1500);
    expect(cache.expire()).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.get("22222222-bbbb")).toBeDefined();
    expect(cache.expire()).toBe(0);
  });

  it("expired entries never feed connection candidates even before expire()", () => {
    const clock = makeClock();
    const cache = new EndpointCache(clock.now);
    cache.add(entry("33333333-cccc"), 100);
    clock.advance(101);
    expect(cache.listActive().map((e) => e.instanceName)).not.toContain("33333333-cccc");
  });
});

describe("DC-11 §4 trust firewall — classifyDiscovered (TR-7/TR-3)", () => {
  const name = "deadbeef-cafe";

  function frozenTrustStore(): { lookup: (n: string) => boolean; mutations: string[] } {
    const paired = new Set(["00000000-0001"]);
    return {
      lookup: (n: string) => paired.has(n),
      mutations: [], // would be appended by any write path — none exists
    };
  }

  it("paired peer classifies as paired via trust lookup", () => {
    expect(classifyDiscovered("00000000-0001", { pv: "1" }, () => true)).toBe("paired");
  });

  it("unknown peer stays unpaired — no trust mutation possible (Case C)", () => {
    const store = frozenTrustStore();
    const keysBefore = JSON.stringify(Object.keys(store));
    for (let i = 0; i < 25; i++) {
      expect(classifyDiscovered(`${i.toString(16).padStart(8, "0")}-ffff`, { pv: "1" }, store.lookup)).toBe(
        "unpaired",
      );
    }
    expect(JSON.stringify(Object.keys(store))).toBe(keysBefore);
    expect(store.mutations).toHaveLength(0);
  });

  it("foreign or malformed pv flags incompatible-version before any socket opens", () => {
    expect(classifyDiscovered(name, { pv: "2" }, () => false)).toBe("incompatible-version");
    expect(classifyDiscovered(name, {}, () => false)).toBe("incompatible-version");
    expect(classifyDiscovered(name, { pv: "garbage" }, () => false)).toBe("incompatible-version");
    expect(classifyDiscovered(name, { pv: "1", smuggled: "x" }, () => false)).toBe(
      "incompatible-version",
    );
  });

  it("classification is pure: same input -> same output, no state retained", () => {
    const txt = { pv: "1" };
    const once = classifyDiscovered(name, txt, () => false);
    const twice = classifyDiscovered(name, txt, () => false);
    expect(once).toBe(twice);
    expect(txt).toEqual({ pv: "1" }); // input not mutated
  });
});

describe("adapter layer degrades gracefully without multicast backend", () => {
  it("NoopMdnsAdapter registers/browses/withdraws without throwing", async () => {
    const logs: string[] = [];
    const adapter = new NoopMdnsAdapter((m) => logs.push(m));
    await adapter.register({
      instanceName: "9f2c41a7-b3e0",
      serviceType: TIDE_SERVICE_TYPE,
      txt: { pv: PROTOCOL_VERSION },
    });
    await adapter.browse(() => {
      throw new Error("noop adapter must never discover anything");
    });
    await adapter.withdraw();
    expect(logs.length).toBeGreaterThanOrEqual(3);
  });

  it("createMdnsAdapter returns a working adapter even when mdns-sd cannot load", async () => {
    const adapter = createMdnsAdapter(() => {});
    await expect(
      adapter.register({
        instanceName: "12345678-abcd",
        serviceType: TIDE_SERVICE_TYPE,
        txt: { pv: PROTOCOL_VERSION },
      }),
    ).resolves.toBeUndefined();
  });

  it("service type constant matches the contract verbatim", () => {
    expect(TIDE_SERVICE_TYPE).toBe("_tide-sync._tcp.local.");
  });
});

// ---------------------------------------------------------------------------
// TR-2a static privacy check: grep-level assertions on the module source.
// ---------------------------------------------------------------------------

describe("privacy static checks (DC-11 TR-2a / INVARIANT 5 extension)", () => {
  const modulePath = fileURLToPath(new URL("../src/network/discovery.ts", import.meta.url));
  const rawSource = readFileSync(modulePath, "utf8");
  /** Strip block + line comments so prose can never trip content checks. */
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  /** Extract parameter lists of every function/method signature. */
  function paramLists(src: string): string[] {
    const lists: string[] = [];
    // function declarations & expressions
    for (const m of src.matchAll(/\bfunction\s+\w*\s*\(([^)]*)\)/g)) lists.push(m[1] ?? "");
    // arrow functions (single-line params incl. typed)
    for (const m of src.matchAll(/(?:const|let)\s+\w+\s*=\s*\(([^)]*)\)\s*(?::[^=]*)?=>/g)) {
      lists.push(m[1] ?? "");
    }
    // interface/class method signatures
    for (const m of src.matchAll(/^\s+(?:readonly\s+)?\w+\s*\(([^)]*)\)\s*(?::[^;]*)?;/gm)) {
      lists.push(m[1] ?? "");
    }
    return lists;
  }

  it("no function accepts hostname/username/calendar/env-style parameters", () => {
    const banned =
      /\b(hostname|hostName|userName|username|email|osUser|computerName|machineName|calendarData|eventName|ipAddress|ipAddr)\b/;
    const offenders = paramLists(source).filter((p) => banned.test(p));
    expect(offenders).toEqual([]);
  });

  it("no environment-variable or OS-hostname feeds identity construction", () => {
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/os\s*\.\s*hostname\s*\(/);
    expect(source).not.toMatch(/require\(\s*["']node:os["']\s*\)/);
    expect(source).not.toMatch(/from\s+["']node:os["']/);
  });

  it("instance-name/TXT construction uses only SHA-256(device_id) and randomness", () => {
    const construction = source.slice(
      source.indexOf("export function instancePrefix"),
      source.indexOf("function txtValueByteLength"),
    );
    expect(construction).toMatch(/createHash\(\s*["']sha256["']\s*\)/);
    expect(construction).toMatch(/randomBytes/);
    expect(construction).not.toMatch(/\bhostname\b|\busername\b|\bcalendar\b/i);
  });

  it("TXT keys are limited to {pv,dn} by an explicit allowlist in code", () => {
    // The allowlist is built from two named constants; verify both bindings
    // hold exactly "pv" and "dn" and nothing else is in the Set literal.
    expect(source).toMatch(
      /ALLOWED_TXT_KEYS[^=]*=\s*new Set\(\[\s*TXT_KEY_PV\s*,\s*TXT_KEY_DN\s*\]\)/,
    );
    expect(source).toMatch(/const TXT_KEY_PV\s*=\s*["']pv["']/);
    expect(source).toMatch(/const TXT_KEY_DN\s*=\s*["']dn["']/);
  });
});
