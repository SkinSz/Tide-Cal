# Package 2 Report — Event Identity Contract at the Sidecar Boundary (QA M-1 / BND-01, CRITICAL; companion BND-05)

Worktree `/tmp/tide-remediation`, branch `remediation`, base HEAD `83dedbf`.
**Changes left UNCOMMITTED for lead review.**

## 1. Diagnosis (independently re-verified at 83dedbf before fixing)

Live stdio repro against a fresh bundle at 83dedbf:

```
create_event {input}              -> ok:true  id=evt-<uuid>          (row: REAL)
update_event {id: evt-<uuid>,
              input:{id:"evt-PHANTOM-9", title:"HACKED", ...}}
                                  -> ok:true  result.id=evt-PHANTOM-9
events table:  evt-<uuid> (title untouched "REAL") + evt-PHANTOM-9 ("HACKED")
changes table: title-set record written under evt-<uuid> claiming "HACKED"
```

Root cause confirmed exactly as the QA finding stated:

- `EventCore.updateEvent` (src/persistence/bridges/event_core.ts) built the
  row payload and the return value as `{ id, ...input }` — the spread put
  `input.id` LAST, so the client-injected id **overrode the real target id**.
- `insertEventRow(db, {id, ...input}, hlc, /*upsert=*/true)` then checked
  existence of the *phantom* id, found none, and took the INSERT branch →
  phantom row inserted while the target row was never touched.
- The change records were written with `entity_id: id` (the real target) but
  payload `value: input.*` (the phantom's fields) → **record/row divergence**
  that survives restart and makes sync peers applying those records diverge
  cross-device.
- Companion BND-05 in the same file: `createEvent` built
  `{ id: `evt-${randomUUID()}`, ...input }` — same ordering bug, so a client
  `input.id` overrode the generated UUID, and unknown `input` fields were
  silently spread into the event object.

**Violated invariant:** the entity identity (`event.id`) is the sync key
(change records, `entity_versions`, peer convergence all key on it). It must
be assigned by the domain core (create) or taken solely from the op's target
argument (update) — never client-settable via `input`.

**Authoritative layer:** the TS domain core + sidecar dispatcher
(`src/persistence/bridges/event_core.ts`,
`src/persistence/bridges/sidecar_server.ts`). NOT the frontend, NOT the Rust
wrapper (verified: `src-tauri/src/lib.rs` builds `EventInput` from five
typed fields and never sends `input.id` or extra fields — the typed Rust
layer was already safe; the raw stdio protocol was the hole).

## 2. Implemented contract (deterministic rejections; no silent acceptance)

`update_event {id, input}`:
- `args.id` must be a non-empty string → else `ok:false "update_event: args.id must be a non-empty string"`. It is the SOLE identity.
- `input.id` present (ANY value, **including one equal to `args.id`**) →
  `ok:false "... input.id is not accepted — event ids are assigned by the sidecar ..."`.
  Rationale for rejecting even the benign equal-id echo: one unambiguous
  identity channel; clients that echo full event objects must strip `id`.
  Documented semantics — there is NO accepted form of `input.id`.

`create_event {input}`:
- `input.id` present → `ok:false` (same message). No legitimate use exists:
  the id IS the sync identity and is allocated by the core (`evt-<uuid>`).
  Client id allocation would reintroduce cross-device identity collisions —
  no schema/versioning knob can make that safe, so it is simply rejected.

`input` shape (both ops):
- must be a plain object; **unknown fields rejected**
  (`"unknown input field(s): <keys> — allowed: title, description, startMs, endMs, allDay"`); nothing is echoed or persisted.
- types enforced: `title`/`description` strings, `startMs`/`endMs` finite
  numbers, `allDay` boolean.

`delete_event`: `args.id` must be a non-empty string (previously any junk
no-opped). `list_events`: `from_ms`/`to_ms` must be number or null.

Defense-in-depth (`EventCore` itself, holds even if the dispatcher is
bypassed by a future caller):
- `assertNoInjectedId()` throws on any `input` carrying `id` in BOTH
  `createEvent` and `updateEvent`;
- both methods now build the event object by **explicit field pick** instead
  of spreading `input` — an injected id can never reach the row writer;
  `updateEvent` writes/returns the prebuilt `updated` object (id frozen to
  the target argument).

Every rejection is thrown before any `createLocalChange` call, so a rejected
request is transactionally a no-op — verified by row/change-log/`entity_versions`
snapshot equality in every regression test.

## 3. Compatibility behavior (per campaign instruction)

- **Shipped Rust layer (Tauri `src-tauri/src/lib.rs`)**: fully compatible.
  It constructs `EventInput {title, description, start_ms, end_ms, all_day}`
  (serde camelCase) and sends exactly `{input}` / `{id, input}` / `{id}` —
  no `input.id`, no extra fields. It never trips a rejection.
- **Frontend `frontend/store.ts`**: calls the core with the five-field input;
  compatible (existing `event_store_bridge.test.ts` passes unchanged).
- **Older raw-protocol peers/clients** (anything speaking newline-JSON to
  the sidecar directly that relied on the permissive shape — e.g. the QA
  boundary probes, or a hypothetical third-party client): **explicit new
  failure mode** — `update_event` with `input.id` now returns
  `ok:false "update_event: input.id is not accepted …"` (previously
  `ok:true` + silent corruption); `create_event` with `input.id` or unknown
  fields returns `ok:false` (previously `ok:true` + silent acceptance).
  Migration for such a client: drop `id` from `input` (update targets come
  from `args.id`), drop unknown fields. No deprecation window is possible
  without a protocol version bump.
- **Schema/versioning**: NOT needed and NOT added — the wire schema of valid
  requests is unchanged (the five fields were always the documented shape;
  the fix only stops accepting out-of-contract extras). Per instruction, if
  a versioned permissive mode had been required we would have stopped and
  documented; diagnosis found no legitimate use for client-supplied ids
  (identity allocation is core-owned by design, DC-07), so rejection is
  total. **No schema changes were made.**

## 4. Files changed (surface compliance)

| File | Change |
|---|---|
| `src/persistence/bridges/event_core.ts` | `assertNoInjectedId` guard; `createEvent`/`updateEvent` explicit field pick (no `...input` spread); `updateEvent` writes/returns frozen-identity object |
| `src/persistence/bridges/sidecar_server.ts` | `validateEventInput` (id/unknown-field/type rejection), `requireEventId`, `list_events` arg validation; dispatcher wired to validated inputs |
| `tests/pkg2_identity.test.ts` | NEW — 12 regression tests (layers A/B/C below) |
| `docs/qa/remediation/pkg2-phantom-detect.mjs` | NEW — QA-only phantom-row detector (see §6) |

No other files touched. No commits made.

## 5. Regression coverage + results

`tests/pkg2_identity.test.ts`, 12 tests:

- **A. In-process dispatcher matrix** (each rejection verified against a full
  snapshot of `events` rows + `changes` log + `entity_versions`, all equal
  before/after): normal update works (id preserved, correct change records);
  arbitrary injected `input.id` → explicit error, zero state delta, target
  intact; `input.id` equal to target → rejected (uniform contract, tested);
  `input.id` = another EXISTING event id → rejected, both rows untouched;
  missing/`null`/number/object/empty/whitespace `args.id` → explicit error,
  zero delta; `create` with injected id → rejected; unknown fields rejected
  on create AND update; malformed types (title number, null description,
  string startMs, NaN, Infinity, non-bool allDay, missing allDay) rejected;
  5 repeated updates → identity stable, exactly 5 title records (no drift);
  `EventCore`-level guard throws when the dispatcher is bypassed.
- **B. Raw sidecar stdio E2E** (esbuild-bundled `sidecar_server.ts` — the
  same artifact the Rust layer spawns, real `main()`): exact baseline M-1
  attack battery over raw protocol (phantom injection, equal-id echo,
  create-with-id, unknown-field create, numeric target id) → all 5
  `ok:false`, one legit update `ok:true`; DB has exactly ONE event row
  (renamed), NO row or change record or entity_version for the phantom id;
  **restart on the same DB** → exactly 1 event, list matches, phantom
  counts still 0 (no divergence persists).
- **C. Sync divergence**: two in-process devices (distinct identities/DBs),
  legit create + update on A, injected-id attempt rejected at the core
  (nothing syncable written — the baseline wrote 3 bogus records here), two
  engine sessions A⇄B → peer B materialized exactly the real renamed event,
  row sets identical, zero phantom entities on B.

Focused: `npx vitest run tests/pkg2_identity.test.ts` → **EXIT 0, 12/12 passed**.

Full suite: `npm test` (vitest run) → **EXIT 0**, 479 tests: **476 passed, 3 failed** — the failures are EXACTLY the three documented pre-existing ones in
PHASE0-BASELINE.md: `tests/month_view_clicks.test.ts` (date-flake),
`qa-tmp/probes/sc5_snap_quar_restart.qa.test.ts` SC6 (m-1 duplicate
quarantine row on replay), SC7 (F3-hang timeout). No new failures;
`npx tsc -p tsconfig.json --noEmit` clean.

## 6. Data safety (record per instruction)

**PRE-RELEASE WIPE ACCEPTABLE** (per PHASE0-BASELINE.md, M-1 decision): the
corruption path requires the raw sidecar protocol (the typed Rust layer
never sent `input.id`), existing DBs are developer/QA machines, and the loss
is silent so no repair path is attempted. Reset: delete
`~/.local/share/com.tide.app/tide-domain.db*`.

Detection of pre-existing phantom rows in dev DBs (QA script, NOT product
code): `docs/qa/remediation/pkg2-phantom-detect.mjs <db-path>` —
- S1: event rows whose `event_id` never appears as `entity_id` of an event
  creation record (`field_path='event', operation='set'`) → phantom rows;
- S2: change-log event entities with no row and no explaining `remove`
  record → false records.
Exit 1 = corruption signatures found. NOTE: the script was written and
reviewed this session but NOT live-executed (a command used to smoke-test it
was denied by the user); its SQL is straight-line SELECTs validated by
inspection — lead should run it once against a QA DB before relying on it.

## 7. Package dependency check (Pkg 2 vs Pkg 1)

`git show 4dbb516 --stat`: Pkg 1 touched `src/persistence/{database,schema}.ts`,
`src/sync/{full_state,sync_engine,compaction}.ts` (+ tests/docs). Pkg 2
touched only `src/persistence/bridges/event_core.ts` +
`src/persistence/bridges/sidecar_server.ts`. Shared code paths: both call
the PRE-EXISTING `openDatabase`/`createLocalChange` APIs from
`database.ts`, but Pkg 2 modifies neither those functions nor schema v6 nor
any sync-surface file; no signature or semantic Pkg 1 introduced is consumed
or altered by Pkg 2 (the only Pkg-1 artifact Pkg 2 touches is the
`entity_versions` TABLE — read-only, in tests, as a corruption canary).
**Conclusion: independent. No overlap; no schema touch; no stop condition
triggered.** (Pkg 3 will rebase onto this validated dispatcher state, as
already sequenced — it shares these boundary files.)

## 8. Remaining uncertainty

- The sync-divergence regression (layer C) exercises the engine over
  in-process message pipes, not the Noise/TCP transport; transport-layer
  behavior is covered by the existing noise/pairing suites, and the
  divergence-relevant path (what records get WRITTEN before sync) is fully
  covered here.
- The rejection message strings are now part of the observable contract;
  the Rust layer surfaces them verbatim to the frontend. If Pkg 3/UI wants
  friendlier copy, that is a presentation concern on top of these stable
  strings.
- `delete_event` id validation is a (deliberate) behavior change: junk ids
  now `ok:false` instead of silently no-opping. The shipped Rust layer
  always sends a string, so no in-tree caller is affected.
- pkg2-phantom-detect.mjs not live-run this session (see §6).
