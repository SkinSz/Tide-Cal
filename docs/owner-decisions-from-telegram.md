# Tide — Owner Decisions via Telegram
Append-only log. The main CLI session reads this file to pick up directives
made from work via Telegram. Format: [timestamp] DECISION/QUESTION/PREF: text.

<!-- entries below -->

2026-08-25 23:22 (via Telegram status session): Owner correction — cap parallelism at 2-3 streams max. Only run workstreams that don't collide or interrupt each other (separate files/worktrees, no shared src areas). Note: previous kickoff attempt felt like the workflow was adjusted without reading owner-decisions-from-telegram.md; main session MUST read this file first.
[ACK by relay 2026-08-25] Received: parallelism capped at 2-3 non-colliding workstreams (separate files/worktrees, no shared src areas). Main session will read this file FIRST at the start of each work session before any kickoff.
23:28 (via Telegram status session): RECEIPT — owner confirmed receiving the Telegram relay messages (connectivity check, direct test, ping). Relay pipeline telegram:SkinS verified working. Main CLI session: please print/echo this receipt to your terminal so the owner sees it there.
[ACK by relay 2026-08-25 23:28] Receipt confirmed: relay pipeline telegram:SkinS verified working end-to-end. Noted — main CLI session asked to print this receipt to its terminal at next work session start.
