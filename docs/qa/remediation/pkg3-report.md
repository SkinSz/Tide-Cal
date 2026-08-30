# Package 3 Report — Centralized Authoritative Event-Input Validation (QA M-5/BND-02, M-6/BND-03, m-3/BND-04, QA-2 F-2)

Worktree `/tmp/tide-remediation`, branch `remediation`, base HEAD `cdece6f`
(Pkg 1 schema-v6 + Pkg 2 identity contract already landed).
**Changes left UNCOMMITTED for lead review.**

## 1. Diagnosis (re-verified at cdece6f)

- **BND-02 (M-5):** `endMs < startMs` accepted on create and update. The
  dispatcher echoed the written value, `derivedScheduleColumns` clamped the
  row (`utc_end_ms = Math.max(endMs, startMs)` → startMs), and the change
  record's `schedule` payload carried the raw inverted value — three
  different values for one logical write, and sync peers materialized the
  payload variant. Reachable from the typed Rust UI (i64s pass through).
- **BND-03 (M-6):** remaining scalar-coercion gap AFTER Pkg 2's type checks:
  the dispatcher rejected wrong primitive types, but fractional numbers
  still slipped through to the SQLite seam, where `utc_start_ms`/`utc_end_ms`
  (INTEGER affinity) silently stored REALs; `Infinity` (raw `1e999`) was
  already caught by the finite check (regression-locked here).
- **BND-04 (m-3):** closed for typed values by Pkg 2's `typeof` checks; the
  remaining hole was **presence**: a missing `allDay` (or any field) on
  update fell through to the SQLite seam and surfaced as
  `NOT NULL constraint failed: events.description` (QA-2 F-2) or silently
  defaulted (the baseline behavior).
- **QA-2 F-2:** partial `update_event` input crashed with the raw SQLite
  error over IPC.

## 2. Decided contract (F-2): FULL INPUT REQUIRED

For both `create_event` and `update_event`, `args.input` must carry **all
five fields**. Partial input is a deterministic `ok:false` naming the missing
fields; nothing is defaulted; no merge semantics. Rationale:

- The shipped Rust `EventInput` is serde-typed to exactly these five fields
  and always sends all of them — the valid wire shape is unchanged, and
  "full input required" never rejects a shipped caller.
- Field-merge (PATCH) semantics would have required *relaxing* Pkg 2's
  shape contract (missing fields were already rejected on update) and
  introduces merge-order questions for the `schedule` group payload. The
  campaign instruction is to extend Pkg 2, not renegotiate it.
- Every update re-materializes the complete event, so change-record
  payloads stay self-contained for peer replay (no read-modify-merge at
  the applier).

## 3. Contract table (field → rule → error)

Validation is TWO layers sharing ONE canonical value rule set:

- **Wire layer:** `validateEventInput` in `sidecar_server.ts` (dispatcher —
  the authoritative IPC boundary). Shape, presence, primitive types,
  identity (Pkg 2) — then delegates value rules.
- **Domain layer:** `validateEventValues` in `event_core.ts`, called by
  `createEvent`/`updateEvent` BEFORE any `createLocalChange` — defense in
  depth, holds even if a future caller bypasses the dispatcher. The
  dispatcher calls the SAME exported function, so both layers cannot drift.

| Field | Rule | Rejection error (deterministic `ok:false`) |
|---|---|---|
| `input` | plain object | `input must be an object with fields …` |
| `input.id` | forbidden (Pkg 2) | `input.id is not accepted — event ids are assigned by the sidecar …` |
| unknown fields | forbidden (Pkg 2) | `unknown input field(s): <keys> — allowed: …` |
| presence | all 5 fields required (create AND update) | `input is missing required field(s): <keys> — the full event input (title, description, startMs, endMs, allDay) is required; partial updates are rejected without any state change` |
| `title` | `string` (Pkg 2) | `input.title must be a string` |
| `description` | `string` (Pkg 2) | `input.description must be a string` |
| `startMs`/`endMs` | `number`, finite (Pkg 2) | `input.<k> must be a finite number` |
| `startMs`/`endMs` | **integer** (`Number.isInteger`) | `input.<k> must be an integer number of epoch milliseconds (fractional/non-numeric values are rejected, never coerced)` |
| `startMs`/`endMs` | **`|v| ≤ MAX_EVENT_MS = 8_640_000_000_000_000`** | `input.<k> <v> is outside the epoch-ms domain (+/-8640000000000000); values beyond it are rejected because Date-derived columns and exact JSON round-trips cannot represent them` |
| schedule invariant | **`endMs >= startMs`** (create AND update) | `input.endMs (<v>) must be >= input.startMs (<v>) — inverted ranges are rejected without any state change` |
| `allDay` | strict `boolean` (Pkg 2); **required, never defaulted** (BND-04) | `input.allDay must be a boolean` / missing-field error above |
| `args.id` (update/delete) | non-empty string (Pkg 2) | `args.id must be a non-empty string` |

**Boundary decisions (documented per instruction):**

- `endMs == startMs` — VALID (zero-duration event; row stores
  `utc_end_ms == utc_start_ms`; no schema CHECK forbids it).
- `startMs == 0` and negative timestamps — **VALID, deliberately**. The
  domain has no historical lower bound; epoch ms is a signed integer;
  every path (row columns, derived wall/date strings, change payloads,
  sync replay) round-trips negatives exactly. Verified by test.
- `|v| ≤ 8.64e15` (ECMAScript Date range, ±100M days) — the epoch-ms
  domain bound. Note this REJECTS `2^53` **and** `2^53-1` even though they
  are exact integers: a value in `(8.64e15, 2^53]` would pass a pure
  safe-integer check but makes `Date` arithmetic return Invalid Date,
  silently writing `NaN-NaN-NaN` into `start_date`/`end_date` — the same
  silent-garbage class this package closes. The bound simultaneously
  guarantees exact JSON round-trips to peers. `±MAX_EVENT_MS` exactly is
  the accepted edge; `±(MAX_EVENT_MS+1)` rejected.
- Fractional ms — rejected, never rounded (INTEGER affinity would store
  REALs; BND-03's mechanism).

## 4. No-silent-coercion / byte-identical guarantees

- All rejection paths throw BEFORE `hlc.now()` consumption and before any
  `createLocalChange`/row write → rows + change log + `entity_versions`
  are byte-identical after every rejection (verified with FULL-row,
  FULL-change-log snapshots, plus `typeof()` column checks).
- Values bind to SQLite exactly as validated: strings, booleans→0/1,
  integers (so INTEGER affinity is a no-op — no REAL, no `""`→0, no
  `NULL` fill-ins). The response echo, the stored row, and the
  change-record payload all carry the SAME values (asserted by test,
  closing BND-02's three-values split at its sync-disagreement root).

## 5. Files changed (surface limits respected)

| File | Change |
|---|---|
| `src/persistence/bridges/event_core.ts` | +`MAX_EVENT_MS`, +`validateEventValues` (canonical value rules); called in `createEvent`/`updateEvent` before any write |
| `src/persistence/bridges/sidecar_server.ts` | `validateEventInput` extended: presence check (full-input-required, F-2), delegation to shared `validateEventValues`; boundary comment updated. No Pkg 2 rule removed |
| `tests/pkg3_validation.test.ts` | NEW — 10 tests, 3 layers (below) |
| `docs/qa/remediation/pkg3-report.md` | this report |

No schema changes, no `src/sync/**` changes, no Rust changes.

## 6. Compat matrix

- **Shipped Rust `EventInput`** (`src-tauri/src/lib.rs`, read-only
  inspection): sends exactly `title: String, description: String,
  startMs: i64, endMs: i64, allDay: bool` (serde camelCase) → all five
  fields present, integral i64s (integers by construction), strict bool.
  **Fully compatible — no shipped request shape changes.** The typed Rust
  layer CANNOT send any rejected shape by construction (serde type
  errors surface in Rust before the sidecar is called).
- **Raw stdio clients** — new explicit failure modes for previously
  accepted/partially-accepted garbage: inverted ranges (was clamped
  write + 3-value split), fractional ms (was REAL storage), missing
  fields (was raw `NOT NULL constraint failed` / silent `allDay=false`),
  out-of-domain integers (was Invalid-Date garbage in derived columns).
  All messages are stable, single-line, and name the field.

## 7. Regression coverage (`tests/pkg3_validation.test.ts`, 10 tests)

- **A. in-process dispatcher:** wrong scalar types per field (title
  number/float/bool/null; description number/null; startMs string/
  numeric-string/null/bool/fractional/Infinity/NaN; endMs variants;
  allDay string/number/null), `input` null/string/array; missing each of
  the 5 fields on create AND update + exact F-2 baseline (partial update
  error contains "full event input" and NOT "NOT NULL"); BND-02 inverted
  range on create+update with post-valid-update echo==row==payload
  assertion; boundaries (`endMs==startMs`, `startMs 0`, pre-1970
  negatives, `±MAX_EVENT_MS` accepted; `2^53`, `2^53-1`, `±(MAX+1)`
  rejected); BND-03 regression (zero rows after the garbage battery);
  Pkg-2 malformed-id regression; interleave test (rejections never poison
  the next valid request); domain-layer bypass tests.
- **B. raw sidecar stdio** — `dist/sidecar.mjs` REBUILT in `beforeAll`
  via `npm run sidecar:build` (the exact artifact the Rust layer spawns):
  8-attack battery + adjacent valid create + not-found update; full-row
  verification (exact values, `typeof = integer`, exactly bootstrap+create
  change records); second session: inverted-range update rejected,
  `endMs==startMs` update lands, restart `list_events` exact, schedule
  payload matches the row.
- **C. two-peer sync:** create at epoch-0 + legit `allDay`/schedule
  update + rejected inverted-range attempt on A → two engine sessions →
  peer B materializes the EXACT final values (row columns byte-checked);
  no inverted payload ever exists in A's change log.

## 8. Focused results

```
COMMAND: node_modules/.bin/tsc -p tsconfig.json --noEmit        → exit 0
COMMAND: node_modules/.bin/vitest run tests/pkg2_identity.test.ts
         → 12/12 passed (exit 0)   [Pkg 2 contract intact on top of Pkg 3]
COMMAND: node_modules/.bin/vitest run tests/pkg3_validation.test.ts
         → 10/10 passed (exit 0)
```

Full suite (`node_modules/.bin/vitest run`): **486 passed / 3 failed /
489 total**. The 3 failures are ALL in `qa-tmp/probes/
sc5_snap_quar_restart.qa.test.ts` (SC5/SC6/SC7) and were verified
PRE-EXISTING by stashing this package's diff and re-running the same
subset at clean HEAD cdece6f (same 3 failures). `month_view_clicks`
(documented flake) passed in this run.

## 9. Remaining uncertainty / notes for the lead

1. **Test-harness discovery (pre-existing, Pkg 2 scope):** the sidecar
   dispatcher answers requests asynchronously per line, so raw-stdio
   RESPONSES CAN ARRIVE OUT OF ORDER relative to requests. `pkg3` orders
   by request id in its harness; `tests/pkg2_identity.test.ts`'s
   `runSidecar` does NOT and its 6-line battery happens to be robust only
   because its valid op is last. Latent flake risk, one-line fix — left
   untouched (Pkg 2 file, not this package's surface).
2. **`Math.max(e.endMs, e.startMs)` clamps in
   `derivedScheduleColumns`** are now dead code (the invariant is
   enforced at entry) but were left in place — removing them is an
   unrelated refactor of the row-derivation path.
3. **`list_events` still accepts `from_ms > to_ms`** (returns empty set).
   Read-only, deterministic, no state impact — flagged as a hygiene item
   for Pkg 6, not changed here.
4. qa-review2-tmp/ was already untracked in the worktree before this
   package started; left as found.
