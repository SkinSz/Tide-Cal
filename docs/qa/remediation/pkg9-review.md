# pkg9 Review — TD-017/018 Sync-Layer Transport Honesty Fix

Blind adversarial review of uncommitted diff. Scope: DC-08 Appendix A, sync_runtime.ts socketFraming `failed` flag, noise_transport.ts sentinel + pump logging, tests/td018_carrier_failure.test.ts.

**VERDICT: UNSOUND** — the RST→loud fix is dead code on the real TCP path (accessor attached to the wrong object); it works only in tests because the test mock re-implements the accessor itself.

## Findings

### F1 — CRITICAL: `__tideFramingFailed` is set on `sock` but read from `inner`; production RST path never triggers (fix is dead code)
- **Files:** src/network/sync_runtime.ts:86 (setter), src/network/noise_transport.ts:633-635 (reader)
- **Evidence:** `socketFraming()` attaches the accessor to the raw `net.Socket`:
  ```ts
  (sock as Socket & { __tideFramingFailed?: () => boolean }).__tideFramingFailed = () => failed;
  ```
  But `handshakeOverTransport`'s feed loop reads it off `inner`, which is the **framing transport object** returned by `socketFraming(sock)` (sync_runtime.ts:185, 247) — a different object that does NOT have the accessor. The optional-chain `?.() ?? false` therefore evaluates **false on every real TCP connection**. Consequence: on a genuine RST / socket error / over-MAX_FRAME, the feed loop sees null + failed=false → breaks without pushing the sentinel → `NoiseSessionTransport.receive()` resolves **null** — exactly the clean-EOF masquerade TD-018 was created to eliminate. DC-05 §6.3 fail-closed is still violated on the real carrier.
- **Fix:** attach the accessor to the returned framing object (`return { ..., __tideFramingFailed: () => failed }`) instead of `sock`, or have the framing object's `receive()` re-throw `FramingError` (see F2) and catch it in the feed loop.
- **Why tests missed it:** `FailableCarrier` in tests/td018_carrier_failure.test.ts:37-39 implements `__tideFramingFailed` on the carrier itself, so the reader-side shape matches the mock but not the production wiring. No test exercises the real `socketFraming` adapter.

### F2 — HIGH: `FramingError` is exported dead code; its doc comment describes a nonexistent mechanism
- **File:** src/network/noise_transport.ts:710-717
- **Evidence:** The class doc says "The framing adapter sets `failed` on its receive() rejection path" — no path in `socketFraming.receive()` ever throws `FramingError` (it resolves null or waits; grep confirms zero throw sites and zero catch sites repo-wide). The comment would mislead the next maintainer into assuming the loud path is delivered via an exception rather than the (broken, per F1) accessor probe.
- **Fix:** either actually throw `FramingError` from `socketFraming.receive()` on a failed close and catch it in the feed loop (this would also fix F1 more robustly than the accessor), or delete the class and correct the comment.

### F3 — MEDIUM: no test covers the real `socketFraming` ↔ feed-loop wiring
- **File:** tests/td018_carrier_failure.test.ts (whole file)
- **Evidence:** All 3 tests run against a hand-rolled `FailableCarrier` that mirrors the *intended* contract, not the *actual* adapter. The single most important integration property — "socketFraming surfaces `failed` through the interface handshakeOverTransport probes" — is unpinned, which is precisely where F1 hides. A real-socket test (open TCP pair, `sock.destroy()` on one side, assert SessionError) would have failed.
- **Fix:** add a socket-backed test using `socketFraming` over a real `net` pair (or expose `socketFraming` for test).

### F4 — LOW: comment/name drift in sync_runtime
- **File:** src/network/sync_runtime.ts:78
- **Evidence:** Comment says "Exposed via the __tideCarrierFailed accessor"; the actual property is `__tideFramingFailed`. Cosmetic, but name drift in the exact sentence describing the fix's contract invites the class of bug F1 already represents. Also "(getter; call with true to force-fail from the outbound pump)" describes nothing implemented — the outbound pump never force-fails.

## Verified-sound aspects

### 1. Sentinel correctness — SOUND (given the flag actually fires)
- `SESSION_KILL_FRAME` = 23 ASCII bytes fed as a ciphertext frame to `receiveCipher.DecryptWithAd(EMPTY_AD, frame)` (noise_transport.ts:380). A ChaChaPoly ciphertext must carry a 16-byte auth tag; a 23-byte blob cannot authenticate against the live nonce/key state except by ~2^-256 chance. No loop: the feed loop `break`s immediately after the push (noise_transport.ts:638).
- `receive()` maps decrypt failure → `markDead(err)` + `SessionError` (lines 381-386); subsequent receives hit `assertAlive` → SessionError. Loud and terminal. ✔
- No leak into quarantine/pending: the sentinel is pushed only into the session `FrameQueue`; quarantine and pending buffers live above `receive()` and only ever see decrypted JSON. The sentinel cannot pass decryption, so it never reaches them. ✔
- Over-MAX_FRAME ordering: `failed = true` then `sock.destroy()` → later `'close'` → `fail()` without arg does not reset the sticky `failed` flag. ✔

### 2. FIN preservation — SOUND
- Clean FIN: `'close'`/`'end'` → `fail()` → `closed=true`, `failed` stays false → feed loop pushes nothing → `inbound.close()` → transport `receive()` resolves null (line 374). Stall-fix behavior preserved. ✔
- Accessor *shape* is consistent where it exists (getter returning `() => boolean` on both sides); the defect is object identity, not shape (F1).

### 3. Edge cases — SOUND (with caveats noted)
- Sentinel while engine mid-receive: sentinel lands in the FrameQueue and the pending receive resolves with the sentinel frame → decrypt fail → loud. ✔ (test 3 pins fail-then-close ordering).
- Multiple sentinel pushes: impossible — single feed loop, breaks after first push. ✔
- Sentinel + subsequent close: `failed` is sticky; close after fail cannot downgrade to null (test 3 covers). ✔
- Handshake-phase failure: feed loop is active during `runXxHandshake`; a mid-handshake failure with the flag set would push the sentinel as a handshake frame → handshake AEAD fails → `SessionError` (fail-closed, correct). ✔
- Pump `.catch`: attached synchronously, no unhandledRejection (vitest confirmed clean); only logs — no flush-semantics change. ✔

### 4. Amendment text — SOUND
- Appendix A is internally consistent and accurately describes implemented semantics: A.2.1 one ACK joint terminator, A.2.3 bounded poll-count drain (TD-020), A.3 stash consult + clear, A.2.5 INVARIANT 14 idempotence, A.2.4 honestly records the barrier-ACK delay trade. ✔
- §3.4 rule 3 conflict: superseding clause appears twice (Status header "Amendment supersedes §3.4 rule 3 and §5.4" and A preamble "THIS APPENDIX WINS") — adequate; no dangling contradiction. ✔
- Status header correctly reflects owner approval date 2026-09-02 and matches the TD-017 RESOLVED entry.

## Test results
| Command | Exit |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npx vitest run tests/td018_carrier_failure.test.ts` | 0 (3 passed) |
| `npx vitest run tests/noise_transport.test.ts` | 0 (17 passed) |
| `node tests/probes/three_device_harness.mjs` | 0 (overall: PASS) |

All green — which itself is a finding: every suite passes while the production loudness path is inert (F1/F3).

## Final Verdict
**UNSOUND** — merge blocked on F1. The sentinel machinery, FIN preservation, pump logging, and amendment text are individually sound, but the flag never reaches the reader on real TCP, so the package's stated purpose (DC-05 §6.3 loud carrier failure) is not delivered. F1 is a two-line fix; F2+F3 should land in the same commit.
