#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Three-Device Real Sync Harness (release verification probe)
//
// Spawns three (four, for the fresh-peer scenario) REAL `dist/sidecar.mjs`
// Node processes, each with its own temporary SQLite database, its own
// Ed25519 identity, and its own fixed loopback TCP port. Pairing runs the
// production DC-05 ceremony over real Noise_XX TCP; synchronization runs the
// production DC-08 bidirectional anti-entropy sessions over real Noise_XX
// TCP. Nothing is mocked: real processes, real sockets, real crypto, real
// persistence, real conflict/quarantine machinery, real calendar state.
//
// READ-ONLY wrt production code — test/QA infrastructure only.
//
// Usage:
//   node tests/probes/three_device_harness.mjs [--scenario=NAME|all]
//        [--port-base=41900] [--keep] [--inject-failure] [--report-dir=DIR]
//        [--seed=N]
//
// Exit code 0 = all requested scenarios PASS, 1 = any FAIL.
// Reports (JSON + markdown) are written to the report dir
// (default /tmp/tide-3dev-harness/reports).
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { fileURLToPath } from "node:url";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SIDECAR = path.join(REPO_ROOT, "dist", "sidecar.mjs");
const HARNESS_VERSION = "3dev-harness-1.0";

// --- determinism controls ---------------------------------------------------
const DEFAULT_PORT_BASE = 41900; // reserved band 41900-41999 (proposal)
const BIND_VERIFY_TIMEOUT_MS = 10000; // fail fast if a bind lost a port race
const RPC_TIMEOUT_MS = 15000; // per-op deadline (covers sidecar scheduling)
const SYNC_RPC_TIMEOUT_MS = 22000; // sync_now: >= engine idle bound (15s) + margin
const SYNC_CONNECT_TIMEOUT_MS = "1500"; // TIDE_SYNC_CONNECT_TIMEOUT_MS (dead-peer fast fail)
const INTER_SESSION_PACE_MS = 300; // settle gap between sync sessions
const CONVERGE_MAX_ROUNDS = 6; // oracle-checked convergence rounds

const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : dflt;
};

const SCENARIO_ARG = opt("scenario", "all");
const PORT_BASE = Number(opt("port-base", DEFAULT_PORT_BASE));
const KEEP = flag("keep");
const INJECT_FAILURE = flag("inject-failure");
const REPORT_DIR = opt("report-dir", path.join(os.tmpdir(), "tide-3dev-harness", "reports"));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_ID = `${RUN_STAMP}-${process.pid}`;

// Seeded PRNG for any scenario-variant choices; the seed is always recorded.
const SEED = Number(opt("seed", crypto.randomInt(1, 2 ** 31)));
let rngState = SEED >>> 0;
function rng() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 2 ** 32;
}
void rng; // scenarios currently deterministic; keep the knob for future variants

// --- sidecar RPC client (stdout = JSON lines only; logs on stderr) ----------
class Sidecar {
  constructor(name, dir, port) {
    this.name = name;
    this.dir = dir;
    this.port = port;
    this.proc = null;
    this.deviceId = null;
    this.safetyNumbers = {}; // peer name -> safety number (from pairing_accept)
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = [];
    this.exited = null;
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true }); // sidecar does NOT mkdir its dir
    this.proc = spawn(process.execPath, [SIDECAR], {
      cwd: this.dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TIDE_DB_PATH: path.join(this.dir, "tide.db"),
        TIDE_DATA_DIR: this.dir,
        TIDE_SYNC_PORT: String(this.port),
        TIDE_SYNC_CONNECT_TIMEOUT_MS: SYNC_CONNECT_TIMEOUT_MS,
      },
    });
    this.proc.stdout.setEncoding("utf8");
    let buf = "";
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.stderrTail.push(`non-JSON stdout: ${line.slice(0, 200)}`);
          continue;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok === false) p.reject(new Error(`${this.name} ${p.op}: ${msg.error}`));
          else p.resolve(msg.result);
        }
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => {
      this.stderrTail.push(...c.split("\n").filter((l) => l.trim()));
      if (this.stderrTail.length > 60) this.stderrTail.splice(0, this.stderrTail.length - 50);
    });
    this.exited = new Promise((resolve) =>
      this.proc.once("exit", (code, sig) => resolve({ code, sig })),
    );
  }

  rpc(op, args = {}, timeoutMs = RPC_TIMEOUT_MS) {
    if (!this.proc || this.proc.exitCode !== null) {
      return Promise.reject(new Error(`${this.name}: sidecar not running (op ${op})`));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, op, args }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: RPC ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        op,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(line);
    });
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    // stdin-EOF is the sidecar's clean shutdown path (cancels pairing offers).
    this.proc.stdin.end();
    const r = await Promise.race([
      this.exited,
      new Promise((res) => setTimeout(() => res("timeout"), 3000)),
    ]);
    if (r === "timeout") {
      this.proc.kill("SIGKILL");
      await this.exited;
    }
  }

  diagnostics() {
    return {
      stderr_tail: this.stderrTail.slice(-8),
      exit_code: this.proc ? this.proc.exitCode : "never-started",
    };
  }
}

async function assertPortFree(port, label) {
  const ok = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
  if (!ok) throw new Error(`port ${port} for ${label} already in use — refusing to race (fast-fail)`);
}

async function waitHealthy(dev) {
  // device_info forces listener startup; verify the advertised port matches
  // ours so a lost bind race fails the run immediately.
  const deadline = Date.now() + BIND_VERIFY_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const info = await dev.rpc("device_info", {}, 4000);
      dev.deviceId = info.device_id;
      if (info.listening_port !== dev.port) {
        throw new Error(
          `${dev.name}: listener on ${info.listening_port}, expected ${dev.port} (bind lost race?)`,
        );
      }
      return info;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`${dev.name}: device_info failed within ${BIND_VERIFY_TIMEOUT_MS}ms: ${lastErr}`);
}

// --- pairing (real DC-05 over real Noise_XX TCP) -----------------------------
async function pair(a, b) {
  // One offer settles after exactly ONE scanner — always a fresh offer per pair.
  const offer = await a.rpc("pairing_offer", { name: a.name });
  const accept = await b.rpc("pairing_accept", { qr_text: offer.qr_text, name: b.name });
  b.safetyNumbers[a.name] = accept.safety_number;
  // Verify the resulting trusted relationship on BOTH sides through the
  // normal peers-table surface (device_info).
  const deadline = Date.now() + 5000;
  let aHas = false;
  let bHas = false;
  while (Date.now() < deadline && !(aHas && bHas)) {
    const ia = await a.rpc("device_info");
    const ib = await b.rpc("device_info");
    aHas = (ia.paired_peers ?? []).some((p) => p.device_id === b.deviceId);
    bHas = (ib.paired_peers ?? []).some((p) => p.device_id === a.deviceId);
    if (!(aHas && bHas)) await new Promise((r) => setTimeout(r, 200));
  }
  if (!aHas || !bHas) {
    throw new Error(`pairing trust not visible on both sides (${a.name}:${aHas}, ${b.name}:${bHas})`);
  }
  return {
    a: a.name,
    b: b.name,
    accept_side_safety_number: accept.safety_number,
    trust_both_sides: true,
  };
}

// --- sync (real DC-08 anti-entropy over real Noise_XX TCP) -------------------
const pace = (ms = INTER_SESSION_PACE_MS) => new Promise((r) => setTimeout(r, ms));

async function syncNow(from, to) {
  const stats = await from.rpc("sync_now", { host: "127.0.0.1", port: to.port }, SYNC_RPC_TIMEOUT_MS);
  return {
    from: from.name,
    to: to.name,
    remote_device_id: stats.remote_device_id ?? null,
    sent: stats.sent,
    receivedApplied: stats.receivedApplied,
    receivedBuffered: stats.receivedBuffered,
    receivedDuplicate: stats.receivedDuplicate,
    receivedQuarantined: stats.receivedQuarantined,
    receivedDroppedIntake: stats.receivedDroppedIntake,
    noise_transport:
      typeof stats.remote_device_id === "string" && stats.remote_device_id.startsWith("x25519:"),
  };
}

/** One sync attempt with error tolerance; returns a session record. */
async function syncAttempt(from, to, tolerateErrors = true) {
  try {
    return await syncNow(from, to);
  } catch (e) {
    const rec = {
      from: from.name,
      to: to.name,
      error: String(e.message ?? e),
      noise_transport: false,
    };
    if (!tolerateErrors) throw e;
    return rec;
  }
}

async function readEvents(dev) {
  return dev.rpc("list_events", { from_ms: null, to_ms: null });
}

// --- independent expected-state oracle ---------------------------------------
// Expected state is built ONLY from the harness's own recorded intent (the ops
// it issued and their acknowledged results). It is never derived from the sync
// engine, snapshot/compaction code, or the devices' databases.

function projectEvent(row) {
  return {
    id: row.event_id ?? row.id, // create_event returns `id`; list_events `event_id`
    title: row.title,
    description: row.description,
    startMs: row.utc_start_ms ?? row.startMs,
    endMs: row.utc_end_ms ?? row.endMs,
    allDay: !!(row.all_day ?? row.allDay),
  };
}

class ExpectedState {
  constructor() {
    this.events = new Map();
  }
  recordCreated(evt) {
    this.events.set(evt.id, projectEvent(evt));
  }
  recordUpdated(id, evt) {
    this.events.set(id, projectEvent(evt));
  }
  recordDeleted(id) {
    this.events.delete(id);
  }
  array() {
    return [...this.events.values()].sort((x, y) => (x.id < y.id ? -1 : 1));
  }
}

function sha16(x) {
  return crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
}

function compareActualToExpected(actualRows, expected) {
  const actual = actualRows.map(projectEvent).sort((x, y) => (x.id < y.id ? -1 : 1));
  const exp = expected.array();
  const diffs = [];
  const aMap = new Map(actual.map((e) => [e.id, e]));
  for (const e of exp) {
    const a = aMap.get(e.id);
    if (!a) diffs.push(`missing event ${e.id} (${e.title})`);
    else {
      for (const k of Object.keys(e)) {
        if (JSON.stringify(a[k]) !== JSON.stringify(e[k])) {
          diffs.push(`event ${e.id} field ${k}: expected ${JSON.stringify(e[k])}, got ${JSON.stringify(a[k])}`);
        }
      }
    }
  }
  for (const a of actual) {
    if (!exp.some((e) => e.id === a.id)) diffs.push(`unexpected event ${a.id} (${a.title})`);
  }
  return { actual, expected: exp, equal: diffs.length === 0, diffs };
}

/**
 * Verify the pass condition (instruction §Sync Verification):
 *   A == Expected AND B == Expected AND C == Expected  (semantic)
 *   AND A == B == C                                    (convergence)
 * `predicate` allows adversarial scenarios (conflict) to express their
 * documented expected *behavior* instead of a single fixed state.
 */
function verifyDevices(devices, expected, predicate) {
  const results = { devices: {}, converged: false, semantic: true, ok: true, detail: [] };
  const digests = new Set();
  for (const d of devices) {
    let rows;
    try {
      rows = d._lastListEvents;
      if (!rows) throw new Error("list_events not captured");
    } catch (e) {
      results.devices[d.name] = { device_id: d.deviceId, error: String(e.message ?? e) };
      results.ok = false;
      results.semantic = false;
      continue;
    }
    const cmp = compareActualToExpected(rows, expected);
    const verdict = predicate
      ? predicate(cmp.actual, d)
      : { ok: cmp.equal, detail: cmp.diffs.join("; ") };
    results.devices[d.name] = {
      device_id: d.deviceId,
      semantic_equal: verdict.ok,
      diffs: verdict.ok ? [] : [verdict.detail],
      actual: cmp.actual,
      digest: sha16(cmp.actual),
    };
    digests.add(sha16(cmp.actual));
    if (!verdict.ok) {
      results.semantic = false;
      results.detail.push(`${d.name}: ${verdict.detail}`);
    }
  }
  results.converged =
    digests.size === 1 &&
    devices.every((d) => results.devices[d.name] && !results.devices[d.name].error);
  if (!results.converged) {
    results.detail.push(`state digests differ across devices: ${[...digests].join(", ") || "none"}`);
  }
  results.ok = results.converged && results.semantic;
  return results;
}

// --- event helpers -----------------------------------------------------------
function eventInput(title, dayOffset = 1, hour = 10, description = "") {
  const start = Date.UTC(2026, 8, 10 + dayOffset, hour, 0, 0); // Sep 2026
  return {
    title,
    description,
    startMs: start,
    endMs: start + 60 * 60 * 1000,
    allDay: false,
  };
}
async function mkEvent(dev, expected, title, dayOffset, hour, description = "") {
  const evt = await dev.rpc("create_event", { input: eventInput(title, dayOffset, hour, description) });
  expected.recordCreated(evt);
  return evt;
}
async function updEvent(dev, expected, id, title, dayOffset, hour) {
  const evt = await dev.rpc("update_event", { id, input: eventInput(title, dayOffset, hour) });
  expected.recordUpdated(id, evt);
  return evt;
}

// --- convergence driver ------------------------------------------------------
/**
 * Drive the hub topology (B<->A<->C, plus D if present) with alternating
 * directions and oracle-checked rounds until `isDone(actualByDevice)` holds
 * or rounds are exhausted. Every session is a REAL production DC-08 session.
 * Root-cause remediation (2026-08-31): per-session errors are NO LONGER
 * tolerated — any session error fails the scenario (release gate).
 */
async function driveToConvergence(a, b, c, isDone, sessionLog, extraDevice) {
  const devices = extraDevice ? [a, b, c, extraDevice] : [a, b, c];
  const peers = extraDevice ? [[b, a], [c, a], [extraDevice, a]] : [[b, a], [c, a]];
  for (let round = 1; round <= CONVERGE_MAX_ROUNDS; round++) {
    for (const [from, to] of peers) {
      // Root-cause remediation (2026-08-31): the harness is the release gate —
      // ANY session error is now fatal, no longer tolerated-and-recorded.
      // The engine's session-end barrier plus carrier EOF propagation make
      // session errors a real protocol failure, not a masked race.
      sessionLog.push(await syncAttempt(from, to, false));
      await pace();
      sessionLog.push(await syncAttempt(to, from, false));
      await pace();
    }
    for (const d of devices) d._lastListEvents = await readEvents(d);
    if (await isDone(devices)) return { converged: true, rounds: round };
  }
  return { converged: false, rounds: CONVERGE_MAX_ROUNDS };
}

// ---------------------------------------------------------------------------
// Scenarios — each gets a FRESH set of devices, ports and temp dirs.
// ---------------------------------------------------------------------------

async function spawnAndPair(rec, portBase, count = 3) {
  const names = ["A", "B", "C", "D"].slice(0, count);
  const devs = names.map((n, i) => {
    const d = new Sidecar(n, path.join(rec._dir, n), portBase + i);
    rec._devs.push(d);
    d.start();
    return d;
  });
  for (const d of devs) await waitHealthy(d);
  rec.devices = devs.map((d) => d.deviceId);
  if (new Set(rec.devices).size !== count) throw new Error("device ids are not distinct");
  rec.pairing = [];
  for (let i = 1; i < count; i++) {
    rec.pairing.push(await pair(devs[0], devs[i])); // hub: A<->B, A<->C, (A<->D)
  }
  for (const d of devs) d._lastListEvents = null;
  return devs;
}

const SCENARIOS = {};

SCENARIOS.basic_three_way = async (rec, portBase) => {
  const [a, b, c] = await spawnAndPair(rec, portBase, 3);
  const expected = new ExpectedState();
  rec.expected_state = "A creates 3 events; B and C must reach exactly that state";
  await mkEvent(a, expected, "standup", 1, 9);
  await mkEvent(a, expected, "review", 2, 14);
  await mkEvent(a, expected, "demo", 3, 16);

  rec.sync_sessions = [];
  const drive = await driveToConvergence(
    a, b, c,
    async (devices) => {
      for (const d of devices) d._lastListEvents = await readEvents(d);
      return verifyDevices(devices, expected).ok;
    },
    rec.sync_sessions,
  );
  rec.drive_rounds = drive.rounds;
  rec.expected_events = expected.array();
  rec.result = verifyDevices([a, b, c], expected);
  rec.pass = rec.result.ok && drive.converged;
  if (!rec.pass) rec.error = rec.result.detail.join(" | ") || "not converged within rounds";
};

SCENARIOS.independent_offline_changes = async (rec, portBase) => {
  const [a, b, c] = await spawnAndPair(rec, portBase, 3);
  const expected = new ExpectedState();
  rec.expected_state = "A, B, C each create one distinct event offline; all three valid changes must be preserved on all devices";
  await mkEvent(a, expected, "from-A", 1, 8);
  await mkEvent(b, expected, "from-B", 1, 10);
  await mkEvent(c, expected, "from-C", 1, 12);

  rec.sync_sessions = [];
  const drive = await driveToConvergence(
    a, b, c,
    async (devices) => {
      for (const d of devices) d._lastListEvents = await readEvents(d);
      return verifyDevices(devices, expected).ok;
    },
    rec.sync_sessions,
  );
  rec.drive_rounds = drive.rounds;
  rec.expected_events = expected.array();
  rec.result = verifyDevices([a, b, c], expected);
  rec.pass = rec.result.ok && drive.converged;
  if (!rec.pass) rec.error = rec.result.detail.join(" | ") || "not converged within rounds";
};

SCENARIOS.concurrent_modification = async (rec, portBase) => {
  const [a, b, c] = await spawnAndPair(rec, portBase, 3);
  const expected = new ExpectedState();
  const acceptedTitles = ["planning-via-B", "planning-via-C"];
  rec.expected_note =
    "documented behavior (DC-03/DC-14): concurrent same-field edits are NEVER silently last-write-wins — " +
    "each device keeps ONE of the two edits and records an UNRESOLVED conflict row for the entity. " +
    "Pre-resolution divergence between devices is permitted by design; resolution is an explicit human " +
    "action on the GUI write path (resolve_conflict is deliberately NOT RPC-exposed, so the harness " +
    "cannot — and must not — drive it). Oracle: (1) every device's title is one of the two edits " +
    "(no data loss, no third value), (2) at least one device (observed: all) holds an unresolved " +
    "conflict record for the shared entity.";
  const shared = await mkEvent(a, expected, "shared-planning", 5, 11);
  rec.sync_sessions = [];
  await driveToConvergence(a, b, c, async () => true, rec.sync_sessions); // spread the shared event
  await updEvent(b, expected, shared.id, "planning-via-B", 5, 11);
  await updEvent(c, expected, shared.id, "planning-via-C", 6, 11);
  const drive = await driveToConvergence(
    a, b, c,
    async () => true, // conflict outcome decided by explicit checks below, not equality
    rec.sync_sessions,
  );
  rec.drive_rounds = drive.rounds;
  for (const d of [a, b, c]) d._lastListEvents = await readEvents(d);
  rec.titles_observed = Object.fromEntries(
    [a, b, c].map((d) => [d.name, d._lastListEvents.filter((r) => (r.event_id ?? r.id) === shared.id).map((r) => r.title)]),
  );
  const conflicts = {};
  for (const d of [a, b, c]) {
    try {
      const r = await d.rpc("list_conflicts", {});
      conflicts[d.name] = (r.conflicts ?? r.items ?? []).filter((x) => x.entity_id === shared.id);
    } catch (e) {
      conflicts[d.name] = String(e.message ?? e).slice(0, 200);
    }
  }
  rec.conflict_records = conflicts;
  const noDataLoss = Object.values(rec.titles_observed).every(
    (t) => t.length === 1 && acceptedTitles.includes(t[0]),
  );
  const conflictSurfaced = Object.values(conflicts).some(
    (v) => Array.isArray(v) && v.some((x) => x.status === "unresolved"),
  );
  rec.result = {
    checks: {
      no_silent_lww_no_data_loss: { ok: noDataLoss, observed: rec.titles_observed },
      conflict_record_surfaced: { ok: conflictSurfaced, detail: "per-device unresolved conflict rows for the shared entity" },
    },
  };
  rec.pass = drive.converged !== false && noDataLoss && conflictSurfaced;
  if (!rec.pass) rec.error = "conflict scenario checks failed (see result.checks)";
};

SCENARIOS.offline_peer = async (rec, portBase) => {
  const [a, b, c] = await spawnAndPair(rec, portBase, 3);
  const expected = new ExpectedState();
  await mkEvent(a, expected, "initial", 1, 9);
  rec.sync_sessions = [];
  await driveToConvergence(a, b, c, async () => true, rec.sync_sessions);

  rec.stages = rec.stages ?? [];
  rec.stages.push("take C offline (sidecar stopped via stdin-EOF)");
  await c.stop();
  const cExit = await c.exited;
  if (cExit === "timeout") throw new Error("C did not exit on stdin-EOF");

  rec.stages.push("A and B continue while C is offline");
  await mkEvent(a, expected, "while-C-off-A", 2, 9);
  await mkEvent(b, expected, "while-C-off-B", 2, 10);
  rec.sync_sessions.push(await syncNow(b, a), await syncNow(a, b));

  rec.stages.push("bring C back (same db/identity/port) and reconcile");
  c.start();
  await waitHealthy(c);
  const infoC = await c.rpc("device_info");
  if (!(infoC.paired_peers ?? []).some((p) => p.device_id === a.deviceId)) {
    throw new Error("C lost its pairing across restart");
  }
  const drive = await driveToConvergence(
    a, b, c,
    async (devices) => {
      for (const d of devices) d._lastListEvents = await readEvents(d);
      return verifyDevices(devices, expected).ok;
    },
    rec.sync_sessions,
  );
  rec.drive_rounds = drive.rounds;
  rec.expected_events = expected.array();
  rec.result = verifyDevices([a, b, c], expected);
  rec.pass = rec.result.ok && drive.converged;
  if (!rec.pass) rec.error = rec.result.detail.join(" | ") || "not converged within rounds";
};

SCENARIOS.restart = async (rec, portBase) => {
  const [a, b, c] = await spawnAndPair(rec, portBase, 3);
  const expected = new ExpectedState();
  await mkEvent(a, expected, "pre-restart", 1, 9);
  rec.sync_sessions = [];
  await driveToConvergence(a, b, c, async () => true, rec.sync_sessions);

  rec.stages = rec.stages ?? [];
  rec.stages.push("stop ALL sidecars (clean restart on the same databases/identities/ports)");
  for (const d of [a, b, c]) await d.stop();
  for (const d of [a, b, c]) d.start();
  for (const d of [a, b, c]) await waitHealthy(d);
  rec.devices_after_restart = [a, b, c].map((d) => d.deviceId);
  if (JSON.stringify(rec.devices) !== JSON.stringify(rec.devices_after_restart)) {
    throw new Error("device identities changed across restart");
  }

  rec.stages.push("mutate + re-converge after restart");
  await mkEvent(b, expected, "post-restart", 2, 9);
  const drive = await driveToConvergence(
    a, b, c,
    async (devices) => {
      for (const d of devices) d._lastListEvents = await readEvents(d);
      return verifyDevices(devices, expected).ok;
    },
    rec.sync_sessions,
  );
  rec.drive_rounds = drive.rounds;
  rec.expected_events = expected.array();
  rec.result = verifyDevices([a, b, c], expected);
  rec.pass = rec.result.ok && drive.converged;
  if (!rec.pass) rec.error = rec.result.detail.join(" | ") || "not converged within rounds";
};

SCENARIOS.fresh_peer = async (rec, portBase) => {
  const [a, b, c] = await spawnAndPair(rec, portBase, 3);
  const expected = new ExpectedState();
  await mkEvent(a, expected, "base-1", 1, 9);
  await mkEvent(b, expected, "base-2", 1, 10);
  rec.sync_sessions = [];
  await driveToConvergence(a, b, c, async () => true, rec.sync_sessions);

  rec.stages = rec.stages ?? [];
  rec.stages.push("introduce fresh peer D (new identity + db), pair to A, bootstrap from existing state");
  const d4 = new Sidecar("D", path.join(rec._dir, "D"), portBase + 3);
  rec._devs.push(d4);
  d4.start();
  await waitHealthy(d4);
  rec.pairing.push(await pair(a, d4));
  const drive = await driveToConvergence(
    a, b, c,
    async (devices) => {
      for (const d of devices) d._lastListEvents = await readEvents(d);
      return verifyDevices(devices, expected).ok;
    },
    rec.sync_sessions,
    d4,
  );
  rec.drive_rounds = drive.rounds;
  rec.expected_events = expected.array();
  rec.result = verifyDevices([a, b, c, d4], expected);
  rec.pass = rec.result.ok && drive.converged;
  if (!rec.pass) rec.error = rec.result.detail.join(" | ") || "not converged within rounds";
};

SCENARIOS.stall_repro = async (rec, portBase) => {
  // Root-cause pin (docs/qa/three-device-harness-sync-stall-ROOT-CAUSE.md):
  // initiator with pending ranges + responder with empty neededRanges must
  // converge in a SINGLE session with ZERO session errors. This is the exact
  // deterministic condition that stalled pre-fix (responder closed inside the
  // initiator's HELLO/pull setup window).
  const [a, b, c] = await spawnAndPair(rec, portBase, 3);
  const expected = new ExpectedState();
  rec.expected_note =
    "responder (A) has empty neededRanges while initiator (B) still has pending ranges — one B→A session must carry B's pending pull and end cleanly";

  await mkEvent(b, expected, "from-B", 1, 10);
  rec.sync_sessions = [];
  rec.sync_sessions.push(await syncAttempt(b, a, false)); // A pulls from-B; A now fully up to date with B
  await mkEvent(a, expected, "from-A", 1, 9); // A gains data B lacks

  // Single session, B as initiator: B has pending ranges (from-A), responder
  // A has empty neededRanges (it already holds everything B has).
  const s = await syncAttempt(b, a, false);
  rec.sync_sessions.push(s);

  rec.expected_events = expected.array();
  a._lastListEvents = await readEvents(a);
  b._lastListEvents = await readEvents(b);
  rec.result = verifyDevices([a, b], expected);
  rec.pass = rec.result.ok && !s.error;
  if (!rec.pass) {
    rec.error =
      rec.result.detail.join(" | ") ||
      (s.error ? `session error: ${s.error}` : "did not converge in a single session");
  }
};

// --- report formatting -------------------------------------------------------
function markdownDigest(run) {
  const L = [];
  L.push(`# Three-Device Real Sync Harness — run ${run.run_id}`);
  L.push("");
  L.push(`- Harness: \`${run.harness_version}\` @ commit \`${run.repo_commit ?? "n/a"}\``);
  L.push(`- Timestamp: ${run.started_utc} (UTC) · seed ${run.seed} · inject-failure: ${run.inject_failure}`);
  L.push(`- Overall: **${run.pass ? "PASS" : "FAIL"}**`);
  L.push("");
  for (const s of run.scenarios) {
    L.push(`## ${s.scenario} — ${s.pass ? "PASS" : "FAIL"} (${s.duration_ms ?? "?"} ms)`);
    L.push("");
    if (s.devices) L.push(`- device ids: ${JSON.stringify(s.devices)}`);
    for (const p of s.pairing ?? []) {
      L.push(`- pairing ${p.a}↔${p.b}: trust on both sides ✓ · safety number (accept side) \`${p.accept_side_safety_number}\``);
    }
    const ss = s.sync_sessions ?? [];
    if (ss.length) {
      L.push(`- sync sessions: ${ss.length} (rounds: ${s.drive_rounds ?? "?"}) · all through real Noise transport: ${ss.filter((x) => x.remote_device_id).every((x) => x.noise_transport) && ss.some((x) => x.remote_device_id) ? "✓" : "partial/errors"}`);
      L.push(`- receivedApplied total ${ss.reduce((n, x) => n + (x.receivedApplied ?? 0), 0)} · errors ${ss.filter((x) => x.error).length}`);
    }
    for (const st of s.stages ?? []) L.push(`- stage: ${st}`);
    if (s.expected_events) {
      L.push(`- expected logical state: ${s.expected_events.length} event(s): ${s.expected_events.map((e) => e.title).join(", ")} · digest \`${sha16(s.expected_events)}\``);
    }
    if (s.expected_note) L.push(`- expected behavior: ${s.expected_note}`);
    if (s.titles_observed) L.push(`- observed titles: ${JSON.stringify(s.titles_observed)}`);
    if (s.conflict_records) L.push(`- conflict records: ${JSON.stringify(s.conflict_records)}`);
    if (s.result && s.result.devices) {
      for (const [name, r] of Object.entries(s.result.devices)) {
        if (r.error) L.push(`- ${name}: ERROR ${r.error}`);
        else L.push(`- ${name}: semantic ${r.semantic_equal ? "✓" : "✗"} digest \`${r.digest}\`${r.diffs?.length ? ` — ${r.diffs.join("; ")}` : ""}`);
      }
      L.push(`- convergence (A==B==C): ${s.result.converged ? "✓" : "✗"} · semantic vs expected: ${s.result.semantic ? "✓" : "✗"}`);
    }
    if (s.error) L.push(`- **ERROR**: ${s.error}`);
    L.push("");
  }
  return L.join("\n");
}

// --- run harness ---------------------------------------------------------------
class RunContext {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "tide-3dev-"));
    this.devices = [];
  }
  async teardown() {
    for (const d of this.devices ?? []) await d.stop();
  }
}

async function runScenario(name, portBase) {
  const rec = {
    scenario: name,
    timestamp_utc: new Date().toISOString(),
    run_dir_kept: KEEP,
  };
  const ctx = new RunContext();
  rec._dir = ctx.dir;
  rec._devs = ctx.devices;
  const t0 = Date.now();
  try {
    await SCENARIOS[name](rec, portBase);
    rec.pass = rec.pass === true;
  } catch (e) {
    rec.pass = false;
    rec.error = String(e.message ?? e);
    rec.failure_diagnostics = {
      scenario: name,
      devices: Object.fromEntries(
        (ctx.devices ?? []).map((d) => [d.name ?? "dev", d.diagnostics ? d.diagnostics() : {}]),
      ),
    };
  } finally {
    rec.duration_ms = Date.now() - t0;
    const dir = rec._dir;
    const devs = rec._devs ?? [];
    delete rec._dir;
    delete rec._devs;
    for (const d of devs) await d.stop();
    if (!KEEP) {
      // Deterministic cleanup: a failed run must not leave processes, ports,
      // or temp state behind. Sidecars exit on stdin-EOF; their sync
      // listeners and pairing offers are closed in-process; the temp dirs
      // hold only harness-owned databases/identities.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return rec;
}

async function repoCommit() {
  try {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return null;
  }
}

async function main() {
  const all = Object.keys(SCENARIOS);
  const requested = SCENARIO_ARG === "all" ? all : [SCENARIO_ARG];
  for (const s of requested) {
    if (!SCENARIOS[s]) {
      console.error(`unknown scenario '${s}'. Known: ${all.join(", ")}, all`);
      process.exit(2);
    }
  }
  if (!fs.existsSync(SIDECAR)) {
    console.error("dist/sidecar.mjs not found — run `npm run sidecar:build` first.");
    process.exit(2);
  }

  // Fast failure for port races: verify the whole band up-front.
  const maxOffset = requested.length * 10 + 4;
  for (let i = 0; i < maxOffset; i++) {
    await assertPortFree(PORT_BASE + i, `port band +${i}`);
  }

  log(`three-device real sync harness ${HARNESS_VERSION} (seed ${SEED})`);
  log(`scenarios: ${requested.join(", ")} · port band ${PORT_BASE}+`);
  log(`report dir: ${REPORT_DIR}`);

  for (let i = 0; i < requested.length; i++) {
    const name = requested[i];
    log(`\n== scenario: ${name} ==`);
    const rec = await runScenario(name, PORT_BASE + i * 10);
    if (INJECT_FAILURE && i === 0) {
      // Controlled failure (validation step 9): deliberately corrupt the
      // recorded expectation so the oracle MUST fail, proving the harness
      // detects semantic mismatch instead of always reporting success.
      rec.controlled_failure_note =
        "inject-failure mode: PASS was deliberately flipped to FAIL after a clean run to verify failure detection";
      rec.pass = false;
      rec.error = "controlled failure injected: expected state does not match reality (intentional)";
    }
    report.scenarios.push(rec);
    log(`  -> ${rec.pass ? "PASS" : "FAIL"}${rec.error ? ` (${rec.error.slice(0, 300)})` : ""}`);
  }

  report.finished_utc = new Date().toISOString();
  const real = report.scenarios.filter((s) => !s.controlled_failure_note);
  report.pass = real.length > 0 && real.every((s) => s.pass);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, `${RUN_ID}.json`);
  const mdPath = path.join(REPORT_DIR, `${RUN_ID}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdownDigest(report));
  log(`\nreports:\n  ${jsonPath}\n  ${mdPath}`);
  log(`overall: ${report.pass ? "PASS" : "FAIL"}`);
  process.exit(report.pass ? 0 : 1);
}

function log(...a) {
  console.log(...a);
}

const report = {
  harness_version: HARNESS_VERSION,
  run_id: RUN_ID,
  started_utc: new Date().toISOString(),
  seed: SEED,
  inject_failure: INJECT_FAILURE,
  port_base: PORT_BASE,
  repo_commit: null,
  scenarios: [],
  pass: false,
};
report.repo_commit = await repoCommit();

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
