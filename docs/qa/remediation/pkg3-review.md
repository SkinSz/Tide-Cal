# Pkg 3 Review — Independent Adversarial Assessment (authoritative input validation)

Reviewer: independent adversarial reviewer (Pkg 3 falsification attempt).
Date: 2026-08-30. Tree: `/tmp/tide-remediation`, branch `remediation`, HEAD `cdece6f`
+ committed Pkg1/Pkg2; Pkg 3 changes uncommitted at review time.
Method: independent raw-stdio probes (own client, own state oracle), own
two-peer sync probe, own HEAD-worktree check of the "pre-existing failures"
claim — all written fresh for this review under `qa-review3-tmp/`, independent
of `tests/pkg3_validation.test.ts`. `docs/qa/remediation/pkg3-report.md` was
NOT read before this assessment was written.

## 1. Scope verification

`git status` / `git diff --stat`: exactly two modified production files
(`src/persistence/bridges/event_core.ts` +68, `src/persistence/bridges/sidecar_server.ts`
+51/-2); untracked: `tests/pkg3_validation.test.ts`, `docs/qa/remediation/pkg3-report.md`,
`qa-review2-tmp/` (reviewer scratch, not production code). No other production
file touched. `dist/` is gitignored; `npm run sidecar:build` re-run before all
raw probes (bundle 222.0 kb).

Domain decisions verified present in code comments (not only the report):
- integer-only rule + rejection of fractional values (never rounded), with the
  INTEGER-affinity rationale — `event_core.ts` Pkg 3 block and
  `validateEventValues` error text;
- ±8.64e15 (MAX_EVENT_MS, ECMAScript Date range) with the Invalid-Date /
  derived-column and exact-JSON-roundtrip rationale, and the explicit
  statement that 2^53 / 2^53-1 are exact integers that are nevertheless
  rejected deliberately — `event_core.ts` comment block + exported
  `MAX_EVENT_MS = 8_640_000_000_000_000`;
- negatives/0 valid (pre-1970/epoch-0) — comment + tests.

## 2. Falsification results

### 2.1 Value matrix over raw stdio (probe1, 28 cases × create AND update)

All rejected with `ok:false`, named-field deterministic errors, and logical
state (events / changes / entity_versions / device_clock / applied_upto)
byte-identical before→after for EVERY case, on both ops:

| Case | Result | Error |
|---|---|---|
| title: 42 / 3.14 / true / null | REJECT | `input.title must be a string` |
| description: 7 / null | REJECT | `input.description must be a string` |
| startMs/endMs: `"abc"`, numstr, null, bool | REJECT | `input.<k> must be a finite number` |
| startMs: START+0.5 (fractional) | REJECT | `must be an integer number of epoch milliseconds …` |
| startMs/endMs: 1e999 (wire) | REJECT | `must be a finite number` (probe2, literal token) |
| startMs: 2^53, 2^53−1, −2^53 | REJECT | `is outside the epoch-ms domain` |
| endMs: 8640000000000001; startMs: −8640000000000001 | REJECT | `outside the epoch-ms domain` |
| endMs < startMs | REJECT | `endMs (…) must be >= input.startMs (…)` — no clamp |
| allDay: 1 / 0 / `"yes"` / null | REJECT | `input.allDay must be a boolean` |
| missing title / allDay / desc+allDay | REJECT | `missing required field(s): …` (names ALL missing) |

Determinism: repeating an identical invalid request returns a byte-identical
error string. No `NOT NULL` / `SQLITE` / `constraint failed` text in any
response across the whole battery.

### 2.2 Accepted values (boundary) with one-value-everywhere check

- `endMs == startMs` → ACCEPT; echo == row == record, storage `integer`.
- `startMs: 0, endMs: 1` and negative (pre-1970) → ACCEPT, exact round-trip.
- `startMs: −8.64e15, endMs: +8.64e15` → ACCEPT, exact, `integer` storage.
- Valid create (exact shipped Rust shape: 5 camelCase fields) and valid update
  with title/allDay changes → response echo == stored row == latest change
  record payload for every field (probe2 AGREE: true). No-op update writes 0
  new change records (DC-01 field-level semantics intact).
- BND-04 closed: missing allDay is an error, never a silent `false`.

### 2.3 Partial input / F-2 (probe1 + probe2)

- Update `{title}`-style partial and every single-field omission, both ops →
  deterministic `missing required field(s): <names>`; the exact F-2 baseline
  shape (update missing description) no longer surfaces
  `NOT NULL constraint failed: events.description`. Full 5-field update works.
- Raw-wire oddities (probe2): literal `1e999` token on the wire, duplicate
  JSON keys (`startMs` twice, last-wins `"abc"` → rejected as non-finite),
  `__proto__` and `constructor` injected keys → all rejected, state identical.

### 2.4 Two-peer sync agreement — BND-02's mode (probe3, own pipes/engines)

A creates (startMs 0), updates to (START, FINAL_END, allDay true); an inverted
`endMs = START−1` update is rejected with A's changes/entity_versions
byte-identical; after two sync sessions B materializes EXACTLY A's values —
`A list == B list`, B row (utc_start_ms/utc_end_ms/all_day=1) == response ==
change-record payload. PEER AGREEMENT: **true**. Boundary event
(−8.64e15…+8.64e15) syncs byte-exact with `integer` storage on the peer.
No clamped/divergent schedule record exists on either side.

### 2.5 Rust compatibility

`src-tauri/src/lib.rs` `EventInput`: serde `rename_all = "camelCase"`, exactly
5 typed fields (String/String/i64/i64/bool) → wire shape is precisely what
validation accepts; valid create/update probes in that exact shape pass.
`endMs == startMs` accepted. Note (deliberate, documented): i64 can express
8.64e15…i64::MAX, which the epoch-ms domain bound now rejects — no legitimate
calendar instant lives there, and the bound is justified in code comments
(Invalid Date / derived columns / exact JSON round-trips).

### 2.6 Test quality (tests/pkg3_validation.test.ts, 10/10 pass)

Strong: asserts state-unchanged via full snapshots (events+changes+versions,
`expectUnchanged`) on every rejection — not just `ok:false`; asserts
response/row/record equality and `typeof(col)=='integer'`; layer A
in-process matrix, layer B raw rebuilt-dist stdio battery with adjacent valid
ops and a no-SQLite-text scan, layer C two-peer sync. Re-runs
`npm run sidecar:build` itself (probe hygiene). Oracles are constants
(START/END/MAX_EVENT_MS), not re-derived from the code under test —
reasonably independent. Minor nit, non-blocking: some error regexes are loose
(`/must be a string|…/` alternation in the type matrix accepts any of several
messages); the `changes`-LIKE `'%-1,%'` assertion in layer C is a weak
heuristic (harmless; the exact-value assertions carry the proof).

### 2.7 Full suite

`npx vitest run`: **486 passed / 489, 3 failed** — exactly
`tests/month_view_clicks.test.ts` (1) and
`qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts` SC6+SC7 (2). Independently
confirmed pre-existing: a clean `git worktree` at HEAD `cdece6f` (no Pkg 3
diff) fails the same 3 tests. Pkg 3 adds 10 passing tests.

## 3. Verdict

**PASS.**

The required invariant holds under falsification: every create/update request
is validated at the sidecar boundary against the documented canonical contract
(full 5-field input, strict types, integral epoch ms within ±8.64e15,
endMs ≥ startMs, Pkg 2 identity/unknown-field rules intact); invalid input
yields deterministic, named, non-SQLite errors with byte-identical persistent
state (verified per-request across the whole battery, including device_clock /
applied_upto); valid input yields response echo == stored row == change-record
payload == synced peer materialization, with INTEGER storage class preserved;
the shipped Rust 5-field camelCase shape is accepted unchanged.

Top falsification attempts (all failed to break the fix):
1. 28-case raw-stdio value matrix (both ops), each request bracketed by full
   logical-state snapshots — every rejection state-identical and named.
2. Raw-wire exotica: literal `1e999` token, duplicate JSON keys, `__proto__` /
   `constructor` key injection — all caught before any write.
3. Independent two-peer sync of boundary values after a rejected inverted
   update — peer converged byte-exactly; no divergence vector left.

Concerns (none blocking):
- Behavior change: previously "accepted" garbage (e.g. i64-range timestamps
  beyond 8.64e15) is now a hard reject — correct per contract, but any
  non-shell client relying on the old coercion would break; the domain bound
  and integer-only rule are documented in code comments and tests.
- Loose error-message regexes in the shipped test (see 2.6) — tightening
  would improve future-regression precision; cosmetic.
- `qa-review2-tmp/` scratch dir sits untracked in the tree (not production
  code; same pattern Pkg 1 already cleaned up once — consider removing before
  commit).

Review artifacts: `qa-review3-tmp/probe1_value_matrix.mjs`,
`probe2_raw_wire.mjs`, `probe3_sync_agreement.mjs` (+ bundled runner).
