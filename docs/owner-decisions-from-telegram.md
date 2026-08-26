# Tide — Owner Decisions via Telegram
Append-only log. The main CLI session reads this file to pick up directives
made from work via Telegram. Format: [timestamp] DECISION/QUESTION/PREF: text.

<!-- entries below -->

2026-08-25 23:22 (via Telegram status session): Owner correction — cap parallelism at 2-3 streams max. Only run workstreams that don't collide or interrupt each other (separate files/worktrees, no shared src areas). Note: previous kickoff attempt felt like the workflow was adjusted without reading owner-decisions-from-telegram.md; main session MUST read this file first.
[ACK by relay 2026-08-25] Received: parallelism capped at 2-3 non-colliding workstreams (separate files/worktrees, no shared src areas). Main session will read this file FIRST at the start of each work session before any kickoff.
23:28 (via Telegram status session): RECEIPT — owner confirmed receiving the Telegram relay messages (connectivity check, direct test, ping). Relay pipeline telegram:SkinS verified working. Main CLI session: please print/echo this receipt to your terminal so the owner sees it there.
[ACK by relay 2026-08-25 23:28] Receipt confirmed: relay pipeline telegram:SkinS verified working end-to-end. Noted — main CLI session asked to print this receipt to its terminal at next work session start.
2026-08-26 08:14 (via Telegram status session): Owner instruction — start agentic work on the Tauri app shell now (visible calendar UI), if not already running.
[ACK by relay 2026-08-26 08:14] Received: owner wants agentic work on the Tauri app shell (visible calendar UI) started now. Status check at relay time: no src-tauri/ directory exists yet — Tauri shell not yet started. Main session will prioritize this at next work session, reading this file first, within the 2-3 parallel stream cap.
2026-08-26 08:35 (via Telegram status session): Owner decision — Tauri app shell (src-tauri/, new top-level directory, calendar UI) may start NOW in parallel; it touches no files in the current security-fix workstream (src/network, src/security), so no conflict. Flag: shell work must stay out of existing src/ modules until H-1 fix is committed.
[ACK by relay 2026-08-26 08:35] Received: Tauri app shell (src-tauri/, top-level, calendar UI) cleared to start in parallel with the security-fix workstream — no file overlap. Constraint noted: shell work stays out of existing src/ modules until the H-1 fix is committed. Main CLI session will implement at next work session, reading this file first.

## 2026-08-26 (CLI session, smoke-test round 2)
- Timezone-aware rendering postponed (owner decision). Scope is LAN/same-WiFi
  device sync; likelihood of diverging timezones across the user's devices
  judged low. Schema keeps tz_id column, so revisit only when a real
  cross-zone need appears.
- 12h/24h format toggle: acknowledged as future option, not a priority.
- UX fixes landed (commit 4876889): date-picker OK button + Enter commits,
  hourly ruler labels for all 24h, hour guide lines through day columns.

## 2026-08-26 (CLI session, UI sign-off)
- Owner approves current UI/UX (week view time-grid, dialog flow, dropdowns).
- Options menu (settings): LOW priority, deferred. Candidate contents when
  built: 12h/24h format, time-input style (type vs dropdown vs both),
  default event duration, first day of week. Sits after the sync/pairing
  milestone in the queue.
