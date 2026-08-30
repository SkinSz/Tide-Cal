// pkg1-review CHECK B: kill -9 the sidecar-process-equivalent during the
// schema v5->v6 migration, at timed offsets after a readiness handshake.
// After each kill: inspect raw DB state, then run a recovery open (unfixed
// timing) and verify integrity + backfill consistency.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const HERE = import.meta.dirname;
const OPEN_ONCE = join(HERE, "open_once.mjs");
const GEN = join(HERE, "..", "gen", "checkB");
const WORK = join(HERE, "..", "checkB-work");
const TIMINGS = [0, 2, 4, 6, 8, 12, 16, 20, 25]; // ms after "go"
const DBS = ["db1", "db2"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runChild(dbPath, { killAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPEN_ONCE, dbPath], {
      cwd: "/tmp/tide-remediation",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let armed = false;
    const timer = setTimeout(() => resolve({ out, killed: false, armed }), 60_000);
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (!armed && out.includes("READY")) {
        armed = true;
        if (killAfterMs === null) {
          child.stdin.write("go\n");
        } else {
          child.stdin.write("go\n");
          clearTimeout(timer);
          const killTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
          }, killAfterMs);
          killTimer.unref?.();
        }
      }
      if (out.includes("MIGRATED")) {
        clearTimeout(timer);
        resolve({ out, killed: false, armed });
        try { child.kill(); } catch {}
      }
    });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ out, killed: signal === "SIGKILL", code, armed });
    });
  });
}

function inspect(dbPath) {
  const db = new Database(dbPath); // raw open (also rolls back any hot journal)
  const res = { integrity: null, schemaVersion: null, hasEntityVersions: null, events: null, changes: null, evers: null };
  try { res.integrity = db.pragma("integrity_check", { simple: true }); } catch (e) { res.integrity = `ERR:${e.message}`; }
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    res.schemaVersion = t ? (db.prepare("SELECT version v FROM schema_version").get() ?? {}).v ?? null : "NO_TABLE";
  } catch (e) { res.schemaVersion = `ERR:${e.message}`; }
  try { res.hasEntityVersions = !!db.prepare("SELECT name FROM sqlite_master WHERE name='entity_versions'").get(); } catch { res.hasEntityVersions = null; }
  try { res.events = db.prepare("SELECT COUNT(*) c FROM events").get().c; } catch { res.events = "ERR"; }
  try { res.changes = db.prepare("SELECT COUNT(*) c FROM changes").get().c; } catch { res.changes = "ERR"; }
  try { res.evers = res.hasEntityVersions ? db.prepare("SELECT COUNT(*) c FROM entity_versions").get().c : 0; } catch { res.evers = "ERR"; }
  db.close();
  return res;
}

function verifyBackfill(dbPath, devA, nEvents) {
  const db = new Database(dbPath, { readonly: true });
  const out = { ok: true, problems: [] };
  const evers = db.prepare("SELECT COUNT(*) c FROM entity_versions").get().c;
  const distinct = db.prepare("SELECT COUNT(DISTINCT entity_id) c FROM changes").get().c;
  if (evers !== distinct) { out.ok = false; out.problems.push(`entity_versions ${evers} != distinct entities in changes ${distinct}`); }
  // element-wise max check on the multi-revision entity (revisions carry
  // seqs n+2..n+5, so the correct backfilled max is n+5 = 60005)
  const v0 = JSON.parse(db.prepare("SELECT version FROM entity_versions WHERE entity_id='evt-bulk-0'").get().version);
  if (v0[devA] !== nEvents + 5) { out.ok = false; out.problems.push(`evt-bulk-0 vector ${JSON.stringify(v0)} expected {${devA}:${nEvents + 5}}`); }
  const lp0 = db.prepare("SELECT latest_producer p, latest_seq s FROM entity_versions WHERE entity_id='evt-bulk-0'").get();
  if (lp0.p !== devA || lp0.s !== nEvents + 5) { out.ok = false; out.problems.push(`evt-bulk-0 latest producer ${JSON.stringify(lp0)}`); }
  // spot-check 3 random entities
  for (const eid of ["evt-bulk-1", "evt-bulk-25000", `evt-bulk-${nEvents - 1}`]) {
    const r = db.prepare("SELECT version, latest_seq FROM entity_versions WHERE entity_id=?").get(eid);
    if (!r) { out.ok = false; out.problems.push(`missing entity_versions row for ${eid}`); continue; }
    const seq = Number(eid.split("-")[2]) + 1;
    const vv = JSON.parse(r.version);
    if (vv[devA] !== seq || r.latest_seq !== seq) { out.ok = false; out.problems.push(`${eid} vector ${JSON.stringify(vv)} seq ${r.latest_seq} expected ${seq}`); }
  }
  db.close();
  return out;
}

mkdirSync(WORK, { recursive: true });
const results = [];
let pass = 0, total = 0;
for (const dbName of DBS) {
  const template = join(GEN, dbName, "tide.db");
  const devA = dbName === "db1" ? "devA-gen-1" : "devA-gen-2";
  const N = 60_000;
  for (const t of TIMINGS) {
    total++;
    const workDb = join(WORK, `${dbName}-t${t}.db`);
    for (const ext of ["", "-wal", "-shm"]) rmSync(workDb + ext, { force: true });
    copyFileSync(template, workDb);
    for (const ext of ["-wal", "-shm"]) {
      try { copyFileSync(template + ext, workDb + ext); } catch { /* not present */ }
    }
    const r = await runChild(workDb, { killAfterMs: t });
    const preRecovery = inspect(workDb);
    // Recovery open (completes or retries migration cleanly)
    const rec = await runChild(workDb, { killAfterMs: null });
    const post = inspect(workDb);
    let backfill = { ok: true, problems: ["migration incomplete"] };
    if (post.schemaVersion === 6 && post.evers > 0) backfill = verifyBackfill(workDb, devA, N);
    const consistent =
      post.integrity === "ok" &&
      post.events === N &&
      (post.schemaVersion === 6 ? backfill.ok : post.schemaVersion === 5 && post.evers === 0);
    if (consistent) pass++;
    const phase = r.out.includes("MIGRATED") ? "after-commit" : (r.killed ? "killed-during-open" : `other(${r.code})`);
    results.push({ db: dbName, t, phase, killed: r.killed, pre: preRecovery, postSchema: post.schemaVersion, postEvents: post.events, postIntegrity: post.integrity, backfill: backfill.ok ? "ok" : backfill.problems, consistent });
    console.log(`[${dbName} t=${t}ms] phase=${phase} killed=${r.killed} pre={v:${preRecovery.schemaVersion},evers:${preRecovery.evers},ev:${preRecovery.events}} post={v:${post.schemaVersion},evers:${post.evers},ev:${post.events},integ:${post.integrity}} backfill=${JSON.stringify(backfill)} => ${consistent ? "PASS" : "FAIL"}`);
  }
  // control: no kill
  total++;
  const workDb = join(WORK, `${dbName}-control.db`);
  for (const ext of ["", "-wal", "-shm"]) rmSync(workDb + ext, { force: true });
  copyFileSync(template, workDb);
  for (const ext of ["-wal", "-shm"]) {
    try { copyFileSync(template + ext, workDb + ext); } catch { /* not present */ }
  }
  const r = await runChild(workDb, { killAfterMs: null });
  const post = inspect(workDb);
  const backfill = post.schemaVersion === 6 ? verifyBackfill(workDb, devA, N) : { ok: false, problems: ["no v6"] };
  const consistent = post.integrity === "ok" && post.events === N && post.schemaVersion === 6 && backfill.ok;
  if (consistent) pass++;
  results.push({ db: dbName, t: "control", phase: r.out.includes("MIGRATED") ? "completed" : "other", post, backfill: backfill.ok ? "ok" : backfill.problems, consistent });
  console.log(`[${dbName} control] out=${r.out.trim().split("\n").pop()} post={v:${post.schemaVersion},evers:${post.evers},ev:${post.events}} backfill=${JSON.stringify(backfill)} => ${consistent ? "PASS" : "FAIL"}`);
}
console.log(`\nRESULT: ${pass}/${total} consistent`);
console.log(JSON.stringify(results, null, 1));
