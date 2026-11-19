# Tide

Local-first, peer-to-peer calendar (no server). Linux is the primary target;
the Windows port (NSIS) is on branch `windows`.

## Stack
- Shell: Rust + Tauri 2 (`src-tauri/`); tray, options window, mDNS (mdns-sd,
  cargo feature `mdns`, default-on), Windows firewall.
- Domain core: TypeScript run as a Node **sidecar** (`dist/sidecar.mjs`,
  entry `src/persistence/bridges/sidecar_server.ts`), spoken to over stdio
  NDJSON. SQLite via better-sqlite3. Noise_XX (noise-c.wasm) + Ed25519.
- Frontend: vanilla TS + Vite, root `frontend/` (two entries: index, options).
- Tests: vitest (`tests/`, `tests/probes/`).

## Commands
```bash
npm test                      # vitest, full suite
npx tsc --noEmit              # type gate
npm run sidecar:build && cp dist/sidecar.mjs src-tauri/resources/sidecar.mjs
npm run ui:build              # webview loads the BUILT bundle; rebuild before judging UI changes
cd src-tauri && cargo check && cargo check --target x86_64-pc-windows-gnu
npm run ui:dev                # dev UI on :5173 (never bare `npx vite`)
npx tauri dev                 # no `npm run tauri` script exists
```
- Before tests: no stray `target/debug/app` / `sidecar.mjs` may hold port
  47471, or `ensure_listener_port.test.ts` fails. Kill by PID, never
  `pkill -f target/debug/app` (it matches your own shell).
- Long builds (`tauri build`, Windows cargo check) run in the background.

## Authority (highest first)
1. Owner instruction  2. `docs/specs/ARCHITECTURE_SPEC_v0.3.md` (FROZEN)
3. `docs/contracts/DC-*.md`  4. task scope  5. existing tested code.
Conflict between sources → stop and report. Never implement a deferred item
before its contract is APPROVED. Open work: contract `Status:` headers +
`docs/technical-debt.md` + Spec §30, not grepping source.

## Conventions that prevent known bugs
- A new frontend→backend op has three seams, all in the same commit: sidecar
  dispatcher case, Rust `sync_op` `ALLOWED` list, and (if invoked directly)
  a `#[tauri::command]` in `generate_handler!`.
- Tauri arg casing: commands use `rename_all = "snake_case"`, and the JS
  `invoke` args must match. Check the attribute before writing the call.
- New payload field → Rust input struct (serde drops unknown fields
  silently). New column → fresh DDL **and** migration, plus an idempotent
  repair at the `== SCHEMA_VERSION` branch.
- Recurring chips are occurrences, not the base row: edit series as deltas.
- Sidecar logs go to stderr only (stdout is the NDJSON channel).
- No internal jargon (DC-, §, "sidecar", "contract") in user-visible strings.
- `docs/` is public and neutral in wording. Process/owner material goes in
  `internal/` (gitignored, never pushed).

@CLAUDE.local.md
