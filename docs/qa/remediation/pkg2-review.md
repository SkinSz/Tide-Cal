# Pkg 2 Independent Adversarial Review — Event Identity Contract (M-1 / BND-01 + BND-05)

**Reviewer:** independent adversarial reviewer (separate from lead QA and implementer)
**Date:** 2026-08-30
**Tree:** `/tmp/tide-remediation`, branch `remediation`, HEAD `83dedbf` + Pkg 1 committed; Pkg 2 UNCOMMITTED (`git diff`: `src/persistence/bridges/event_core.ts`, `src/persistence/bridges/sidecar_server.ts`; untracked: `tests/pkg2_identity.test.ts`, `docs/qa/remediation/pkg2-{report.md,phantom-detect.mjs}`)
**Method:** all probes below were executed by the reviewer against a freshly rebuilt `dist/sidecar.mjs` (`npm run sidecar:build`) over the raw stdio protocol — the same artifact the Rust shell spawns. Disposable probe scripts: `qa-review2-tmp/` (not part of the package). `docs/qa/remediation/pkg2-report.md` was NOT read before this assessment was written.

---

## 1. Mechanism assessment (from independent diff inspection)

Two independent layers, both enforcing the same contract:

1. **Dispatcher-level (`sidecar_server.ts`) — authoritative boundary.**
   - `validateEventInput(raw, op)`: input must be a non-null, non-array object; **any `id` key is rejected before anything else can use it**; unknown keys are rejected by explicit allowlist (`title, description, startMs, endMs, allDay`); every allowed field is strictly type-checked (`title`/`description` string, `startMs`/`endMs` finite number, `allDay` boolean). Returns a **newly constructed 5-field object** — no spread, no echo of raw input.
   - `requireEventId(raw, op)`: `args.id` must be a non-empty string for `update_event`/`delete_event`.
   - Rejections are `throw`n inside `handleLine`'s try → deterministic `ok:false` envelope with a message; no partial mutation is possible because validation happens **before** the dispatcher calls into the core.
2. **Domain-level (`event_core.ts`) — defense in depth.**
   - `assertNoInjectedId(input, op)` throws if `"id" in input` — reached only by callers bypassing the dispatcher (e.g. future in-process callers, sync-adjacent code).
   - `createEvent` / `updateEvent` build the persisted `CalendarEvent` by **explicit field pick** (5 fields), never `{id, ...input}` — so even without the guard, an injected id could not override the core-generated identity, and no unknown field can ride into the row or the change records.
   - `updateEvent` freezes identity to the op's `id` argument; `input.id === args.id` is also rejected (uniform contract, no benign-echo exception) — eliminates the ambiguous dual identity channel entirely.

**Assessment: the mechanism is correct and layered.** `"id" in input` also catches `id` arriving via the prototype chain; JSON-level `__proto__` smuggling is caught by the unknown-field allowlist (see §2). `list_events` additionally gained arg type validation (harmless tightening).

## 2. Falsification attempts (raw stdio, rebuilt dist)

Probe: `qa-review2-tmp/probe_identity.mjs` — 42 checks, **42 PASS** (one scenario re-tagged EXPECTED-ACCEPT, see below). State check after **every** request: full dumps of `events` + `changes` + `entity_versions` compared byte-identical (JSON.stringify of `SELECT *` ordered dumps).

### 2.1 Identity attacks on update_event

| Scenario | Result |
|---|---|
| `input.id` == target id | `ok:false` `input.id is not accepted`, state unchanged ✅ |
| `input.id` == ANOTHER existing event id | `ok:false`, state unchanged, both rows keep original titles ✅ |
| `input.id` = `""` / `"   "` | `ok:false`, state unchanged ✅ |
| `input.id` = `1.5` (float) | `ok:false`, state unchanged ✅ |
| `input.id` = `null` | `ok:false`, state unchanged ✅ |
| `input.id` = nested object `{deep:"x"}` | `ok:false`, state unchanged ✅ |
| `input.id` = 10 000-char string | `ok:false`, state unchanged ✅ |
| `args.id` = `42` / `"   "` | `ok:false` `args.id must be a non-empty string`, state unchanged ✅ |
| `args.id` = unknown nonempty id / 10k-char id | `ok:false` `event not found: …`, state unchanged (not-found path does NOT insert) ✅ |

### 2.2 Identity attacks on create_event

| Scenario | Result |
|---|---|
| `input.id` colliding with EXISTING event (UNIQUE path) | `ok:false`, state unchanged — never reaches the UNIQUE constraint ✅ |
| `input.id` fresh/unknown (`evt-fresh-attacker`) | `ok:false`, **no row inserted** ✅ |
| `input.id` = `""` / nested object | `ok:false` ✅ |

### 2.3 Prototype / exotic-key smuggling (literal raw JSON, verified with real own keys)

| Scenario | Result |
|---|---|
| `input.__proto__: {id:"evt-evil"}` (JSON.parse own key) | `ok:false` `unknown input field(s): __proto__` ✅ |
| `input.__proto__` scalar + own `id` field also present | `ok:false` `input.id is not accepted` (id check fires first) ✅ |
| `input.constructor: {id:…}` | `ok:false` `unknown input field(s): constructor` ✅ |

Note: the reviewer's first attempt used a JS object literal (`{__proto__: x}`), which sets the *prototype* instead of creating an own key and is dropped by `JSON.stringify` — the request then legitimately succeeded as a plain 5-field create. This was a **probe bug, not a product bug**; re-tested with literal JSON strings above.

### 2.4 Unknown-field rejection

| Scenario | Result |
|---|---|
| bogus scalar / nested object value / array value | `ok:false` naming the exact unknown field(s), state unchanged ✅ |
| unknown fields mixed WITH `input.id` | rejected (id check first), state unchanged ✅ |
| unknown field mixed with a VALID rename on update | rejected — valid fields do **not** partially apply when an unknown field is present (all-or-nothing), state unchanged ✅ |

### 2.5 Type confusion (post-fix)

| Scenario | Result |
|---|---|
| `title: 42` / `description: null` | `ok:false` must-be-string, state unchanged ✅ |
| `startMs: "abc"` / `startMs: null` | `ok:false` must-be-finite-number ✅ (verified deterministic in isolation) |
| `allDay: "yes"` / `allDay: 1` | `ok:false` must-be-boolean ✅ |
| all five fields missing (`input: {}`) | `ok:false` ✅ |
| `input: null` / array / string | `ok:false` must-be-object ✅ |
| `endMs < startMs` | **ACCEPTED** (`ok:true`, state changes). Pre-existing BND-02/03 behavior, explicitly out of Pkg 2 scope (Pkg 3). The Pkg 2 diff does not add or remove any ordering check, so this is neither fixed nor worsened by Pkg 2. |

### 2.6 State-unchanged & restart

- Every rejection in §2.1–2.5: `events`/`changes`/`entity_versions` **byte-identical** before/after.
- After the full battery + one legitimate update + **sidecar restart on the same DB**: exactly 2 event rows (the two legitimate ids), titles correct, no row/record/version referencing any phantom id. The only non-event change-log entity is `local` (the calendar bootstrap — legitimate, pre-existing).
- Valid updates continue to apply correctly before, during, and after the battery (identity preserved on result, change records only under the real entity).

### 2.7 Sync divergence (raw stdio + REAL TCP pairing)

Probe: `qa-review2-tmp/probe_sync.mjs` — 18 checks, **18 PASS**. Two independent sidecar processes (distinct `TIDE_SYNC_PORT`s), paired via `pairing_offer`/`pairing_accept` over an actual TCP Noise ceremony:

- A: legit create + rename → A: identity attack (`input.id` phantom on update AND on create) → both `ok:false`, A's DB **byte-identical** across each attack.
- B → A `sync_now`: session completes; **B materializes exactly 1 event with the renamed title**; no phantom row, no change records, no `entity_versions` under the phantom id on B.
- Second B → A sync: `receivedApplied: 0` — nothing new flows B→A; A's DB unchanged.
- **Both peers restarted** on the same DBs: each lists exactly the 1 legitimate event, no phantom. The baseline divergence (3 bogus records under the target's entity propagating to peers) cannot occur because rejected attacks write nothing.

### 2.8 Differential sensitivity check (does the probe actually detect the original bug?)

The exact baseline M-1 payload was run against **both builds** (`qa-review2-tmp/probe_differential.mjs`):

| Build | Attack result | Rows after | Change records under target |
|---|---|---|---|
| Pkg 2 applied | `ok:false` | 1 (target only) | 1 (create only) |
| Pre-fix (stashed) | **`ok:true`** | **2 — incl. `evt-PHANTOM-9 "HACKED"`** | 2 (create + bogus "update" record claiming a change the row never received) |

The pre-fix run reproduces the exact reported record/row divergence, confirming both the original finding and probe sensitivity.

### 2.9 Phantom-detect script (`pkg2-phantom-detect.mjs`) independently verified

- Run against a pre-fix corrupted DB: **S1 fires** (`evt-PHANTOM-9, title="HACKED", rows with NO creation change record`), exit 1. ✅
- Run against a fixed-build DB where the same attack was rejected: clean, exit 0. ✅
- (S2 did not fire in this repro — expected: the baseline bug writes bogus records under the TARGET's entity, which has a row; S2 targets the complementary divergence shape. S1 covers the shipped repro.)

### 2.10 Compatibility with the Rust layer

- `src-tauri/src/lib.rs` `EventInput` = exactly 5 fields, `#[serde(rename_all = "camelCase")]` → `title, description, startMs, endMs, allDay` — the **exact allowlist** of `validateEventInput`; serde enforces all fields present, so the Rust caller can never omit one. Verified end-to-end over raw stdio: create + update with that exact shape → `ok:true`, identity preserved, correct change records. ✅
- No other in-repo caller constructs event input (frontend calls arrive via Tauri typed commands). The sync apply path (`makeEntityMutator`) does not route through `validateEventInput` (internal, trusted records — revalidation is the sync layer's own concern).

## 3. Test quality assessment (`tests/pkg2_identity.test.ts` — 12 tests, all pass)

**Strong — tests assert the real invariant, not just `ok:false`:**
- Every rejection test compares a full state snapshot (events + changes + entity_versions) before/after (`expectUnchanged`) — tests CANNOT pass if the product corrupts state but returns `ok:false`.
- Layer A (in-process dispatcher): id matrix incl. id==target, id==other-existing, malformed `args.id` types; unknown fields on create AND update; type confusion matrix; repeated legitimate updates keep identity and produce exactly 5 title records.
- Layer B (raw stdio on an esbuild bundle of the actual source — same artifact class the Rust layer spawns): the full baseline attack battery over the wire, then DB inspection, then **restart on the same DB** asserting no phantom rows/records survive.
- Layer C (sync): two engines, pipe-pair sessions; injected-id attempt must write nothing; convergence asserts B ends with exactly the real event and zero phantom-entity records.
- Defense-in-depth test: `EventCore` itself throws on `input.id` (dispatcher bypass), with state snapshot intact.
- Bundle is built from source at test time (`buildSidecarBundle`), so the test cannot pass against a stale artifact.

**Gaps (minor, non-blocking):**
1. No `__proto__`/`constructor` key-smuggling cases (reviewer covered them here; deterministic allowlist rejection).
2. `delete_event` id validation has no dedicated test (only `requireEventId` shared with update, which is covered).
3. `endMs < startMs` is untested — acceptable, that is BND-02/03 (Pkg 3) scope.
4. Layer C uses pipe pairs, not TCP — but the reviewer's independent TCP probe (§2.7) covers that.

**Could tests pass while the product is wrong?** No realistic path found: any corruption of rows/change log/entity_versions fails the snapshot assertions; any syncable bogus record fails Layer C; any behavior difference between source and spawned artifact is excluded because Layer B bundles the source under test.

## 4. Scope check

`git diff` touches exactly: `src/persistence/bridges/event_core.ts` (+41/−8) and `src/persistence/bridges/sidecar_server.ts` (+117/−8). Untracked additions: `tests/pkg2_identity.test.ts`, `docs/qa/remediation/pkg2-report.md`, `docs/qa/remediation/pkg2-phantom-detect.mjs`. No other production file, no schema change, no Rust change (none needed — Rust already sends the conforming 5-field shape). **In scope.** Reviewer scratch: `qa-review2-tmp/` (disposable, not part of the package).

## 5. Full suite

`npx vitest run`: **476 passed / 479** (3 failed), matching the documented expectation. The 3 failures were independently confirmed **pre-existing**: `tests/month_view_clicks.test.ts` (frontend chip selection) and `qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts` SC6/SC7 (SC6 duplicate-quarantine count, SC7 5s timeout) — the latter verified by stashing the Pkg 2 diff and re-running (same failures at base). `tests/pkg2_identity.test.ts`: 12/12 pass.

## 6. Verdict

**PASS.**

The required invariant holds under all falsification attempts: event identity is assigned and owned by the sidecar at two independent layers; client input cannot create, redirect, or duplicate an identity through any of 30+ attack shapes including prototype smuggling; every invalid request returns a deterministic explicit `ok:false` with byte-identical persistent state; nothing syncable is produced; restarts are clean; peers never diverge; the Rust 5-field shape works unchanged. The one observed lenient behavior (`endMs < startMs` accepted) is pre-existing BND-02/03 territory, unchanged by this package, and is already tracked for Pkg 3.

**Recommendations (non-blocking):**
1. Pkg 3 should also decide whether the strict all-5-fields requirement should later become partial-update friendly (today a caller must always send all five; currently fine — the only caller is the Rust shell, which always does).
2. Fold the `__proto__`/`constructor` key-smuggling cases from this review into `tests/pkg2_identity.test.ts` (one-line additions to the badInputs matrix) before or after commit, at the lead's discretion.
3. The reverse-direction TCP sync session (A→B outbound) hung in the reviewer's probe harness while the B→A direction and the in-process test both terminate normally; not attributed to Pkg 2 (no identity data involved), but worth a glance if sync session termination is ever revisited.
