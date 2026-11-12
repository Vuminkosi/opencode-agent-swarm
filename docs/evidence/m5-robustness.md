# M5 robustness evidence — crash replay + rate limiting (M5-01/M5-02)

> **Document status: IMPLEMENTED (FakeHarness + tmp-Git/tmp-SQLite simulations) / COMMITTED at `69f40a9`.**
> All behavior below is code-observed at the recorded HEAD and covered by
> committed **FakeHarness + disposable tmp-Git/tmp-SQLite simulations** —
> deterministic fakes and `git init` tmp repos, never live inference, never
> the canonical checkout as a test subject. **Live-server turns and live
> inference remain NOT VERIFIED** (no live server, no inference spend, no
> credentials). Design intent is never described as shipped, released, or
> production-proven. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Baseline HEAD:** `69f40a9726876411e77b8f81848e62b2681b6311` —
  `feat(m5): crash replay + rate limiting (M5-01/M5-02)` [PROBE — `git rev-parse HEAD`, inspected read-only in the DOC-M5-01 session]
- **Commit scope:** 8 files, 3527 insertions, 21 deletions
  (`git show --stat HEAD`). [PROBE — inspected, not re-executed beyond the stat read]
- **Prior chain (oldest → newest):** `7330e0e` (M4) → `698171b` (DOC-M4-01) → `b54c50c` (M105-FIX-COMMIT-01, m105 cleared) → `c10e0be` (M4-INT-FIX-01, M4 S2-1…S2-3 follow-ups committed) → `69f40a9` (M5-01/M5-02, HEAD). [PROBE — `git log --oneline`, inspected]
- **Git status at inspection:** clean working tree (no staged, unstaged, or untracked changes observed) before this doc was authored. [PROBE]
- **M5 constraints honored:** M0/M1/M2/M3/M4 source behavior preserved — the only
  existing-source file the commit touches is `packages/git-workspaces/src/worktree-manager.ts`
  (M5 delta, 209 lines changed: fencing high-water + CAS acquire + fail-closed
  tokened release, `leases`-row contract untouched); **no protocol change**
  (no `packages/protocol` file in the commit); **no migration file** —
  `session_executions`, `usage_ledger`, and `lease_fencing_high_water` are
  service-owned and ensured idempotently (`CREATE TABLE IF NOT EXISTS` on the
  shared DB handle, same precedent as M4-03 `integration_runs`), because
  `store.ts` and its migration registry are owned by another lane and an
  unwired `.sql` file would be dead schema. [DESIGN — `git show --stat HEAD` file list]

Related records: [spec](../plan/spec.md) §§13 (failure-injection matrix), 14 (M5 gate), 6 (follow-on tables incl. `usage_ledger`), 8, 12 ([DESIGN] contract source), [m4-safe-coding](m4-safe-coding.md) (M4 baseline this slice builds on), [m2-wake-engine](m2-wake-engine.md) (quota/idempotency this slice reuses), [m3-coordination](m3-coordination.md) (verifier/defect-loop convention), [compatibility-report](../compatibility-report.md) (M5 addendum), [milestone-matrix](../milestone-matrix.md).

Evidence-label key: **[DESIGN]** approved contract / code-observed claim, **[PROBE]** needs (or has, when noted) executable confirmation.

## 1. Commit file list (exact, from `git show --stat HEAD`) [PROBE]

| File | Change (stat) | Role [DESIGN] |
|---|---|---|
| `packages/git-workspaces/src/worktree-manager.ts` | 209 lines changed (M5 delta) | M5-01 delta: `lease_fencing_high_water` high-water table + CAS acquire (`MAX_CAS_ATTEMPTS = 10`, loser retries higher) + fail-closed tokened release + NaN-clamped `read()`; `leases`-row contract untouched, git compare-and-swap stays the backstop |
| `packages/runtime/src/services/__tests__/rate-limit.test.ts` | 488 insertions | M5-02 rate-limiter tests (35 tests, supplied) |
| `packages/runtime/src/services/__tests__/recovery.test.ts` | 808 insertions | M5-01 recovery tests (19 tests, supplied) |
| `packages/runtime/src/services/rate-limiter.ts` | 516 insertions | M5-02 provider rate limiter + quota/auth gate: caps, 429 bounded exp-backoff + full jitter + retry budget then terminal, 402 quota-paused zero-retry, 401/403 auth-blocked zero-retry, BlockRegistry, documented resume triggers only, zero speculative spend |
| `packages/runtime/src/services/recovery.ts` | 418 insertions | M5-01 crash replay + durable leases recovery: bounded outbox replay (ack-gated), unsettled-wake reconcile via M2 `InboxReconciler`, integration reconcile via M4 `IntegrationService.reconcile`, `session_executions` admission-vs-ack tracking; never blind-resubmits, never submits model turns |
| `packages/runtime/src/services/usage-ledger.ts` | 262 insertions | M5-02 provider usage ledger: service-owned `usage_ledger` table + read-only per-provider/model totals; task attempts stay in `tasks.attempt` + `verification_evidence` rows — explicitly no separate table |
| `tests/fault-injection/crash-replay.test.ts` | 563 insertions | §13 FI-1…FI-5 + FIX-01 FI-6/FI-7 + FIX-02 FI-8 (8 tests, supplied) |
| `tests/fault-injection/rate-quota.test.ts` | 284 insertions | caps / 429 storm / 402 freeze / 401 block + concurrency cap (4 tests, supplied) |

Total: **8 files, 3527 insertions, 21 deletions.** [PROBE]

## 2. Component map (all paths inspected at HEAD, read-only) [DESIGN]

| Component | File | Role |
|---|---|---|
| Crash-replay recovery | `packages/runtime/src/services/recovery.ts` | Bounded replay (`maxPerRun` default 100, hard cap 1000, `created_at` order — no unbounded fan-out); `replayOutbox` fans out only to acking consumers and marks delivered ONLY after ack (a throwing consumer leaves the row pending, attempts untouched, never a hot-loop retry); ambiguous admissions quarantine via the reconciler and surface through `listAmbiguousExecutions` for operator review; wake/turn recovery delegates to the reconciler (expiry-gated re-acquire, generation/killed guards); canonical-lock recovery delegates to `IntegrationService.reconcile` (stale lease + fencing bump, live foreign lease quarantines); integration idempotency rests on the M4 `integration_runs` `task_id PRIMARY KEY` dedupe. Owns no paid path (no harness calls, no inference). |
| Admission-vs-ack tracking | `recovery.ts` (`SESSION_EXECUTIONS_DDL`, `ensureSessionExecutionsSchema`) | Service-owned `session_executions` table (`wake_id PRIMARY KEY`, `dedupe_key UNIQUE`, receipt → ack → outcome) for the admission-vs-ack crash window; F-D3 per-swarm scope (`swarm_id`, nullable back-compat). Idempotent ensure on every open. |
| Rate limiter | `packages/runtime/src/services/rate-limiter.ts` | Per-model/provider concurrency semaphore + bounded FIFO pending queues (overflow rejects the newcomer, never drops committed work); 429 → bounded exp-backoff (`base * 2^attempts` + full jitter, M2 shape reused) with retry budget, then terminal; 402 → `quota-paused`, exactly one transport attempt, zero retries, resume only on documented triggers (new post / model switch / user input) — never elapsed time; 401/403 → `auth-blocked`, exactly one attempt, zero retries, never auto-approved; status-less auth shapes (`UNAUTHENTICATED`/`PERMISSION_DENIED`/401/403-bearing code or message) classify auth-blocked BEFORE the transient fallback so they can never retry ×3 as transient (F-C03). Carries only `{ providerID, id }` refs — never keys, prompts, bodies, or secrets. |
| Block registry | `rate-limiter.ts` (`BlockRegistry`) | Pause bookkeeping with no elapsed-time auto-retry; traffic triggers cannot clear auth blocks (auth resume split, S3). |
| Usage ledger | `packages/runtime/src/services/usage-ledger.ts` | Service-owned `usage_ledger` table (provider/model refs, tokens, `cost_micro` where observed, outcome, correlation id) + read-only rollups (per-provider/model totals, cost-per-verified-task telemetry); invalid refs and negative counts fail closed; no estimates. Consumers read; this module never mutates swarm/member/task/wake state. |
| Fencing high-water + CAS | `packages/git-workspaces/src/worktree-manager.ts` (`IntegrationLock`, M5 delta) | `release()` DELETEs the `leases` row so `observe()` stays null-after-release, but the monotonic high-water persists per `resource_key` in `lease_fencing_high_water` so the next `acquire()` strictly exceeds every previously issued token — including across release cycles. Acquire is read → reserve-high-water → conditional write (`WHERE fencing_token=<read>` UPDATE / `WHERE NOT EXISTS` INSERT, bounded `MAX_CAS_ATTEMPTS = 10` retries, loser retries higher; crash between reserve and write leaves a gap, never a reuse). Any high-water DDL/read/write failure is fail-closed (throws, never a silent `0` fallback). Tokenless `release(holder)` is a fail-closed no-op (F1); mismatched-token and raced-row (`changes = 0`) releases return false. Non-finite/corrupt tokens are NaN-clamped to `0` (S3). |
| Fault-injection suites | `tests/fault-injection/crash-replay.test.ts`, `tests/fault-injection/rate-quota.test.ts` | §13 matrix rows FI-1…FI-5 plus FIX-01 FI-6 (per-swarm scoped replay) / FI-7 (terminal-once) and FIX-02 FI-8 (skewed-backlog filtered replay); rate/quota caps, 429 storm, 402 freeze, 401 block, concurrency cap. FakeHarness + tmp-Git/tmp-SQLite only. |

## 3. Design notes carried from M2/M4 (unchanged, not re-proven here) [DESIGN]

- **Quota 402 no-retry (M2 carry):** the M2 `isQuotaStatus` → `quota_paused`, never-auto-retry-paid-path posture is unchanged by M5; M5 adds the limiter/ledger machinery around it, not a new paid path. Provider-side 402 shaping stays NOT VERIFIED — carried, not closed.
- **At-least-once (honest):** exactly-once logical intent (dedupe keys, `task_id PRIMARY KEY` run rows, fencing tokens, `session_executions` receipts) over at-least-once transport; ambiguous admitted-but-unacked admissions quarantine for operator review, never blind-replay.
- **No separate `task_attempts` table:** attempts are already the system of record in `tasks.attempt` (bumped verifying→ready) plus `verification_evidence` rows per attempt; a separate table would duplicate durable state and risk divergence, so ledger entries carry the store's attempt number for correlation only (`describeTaskAttemptAccounting`).
- **Outbox FIFO + bounded + ack-gated:** replay is `created_at`-ordered, capped per pass, and marks delivered only on consumer ack.

## 4. Per-acceptance mapping — spec §13 failure-injection matrix → committed tests [PROBE]

Counts below are **committed/supplied evidence** (implementation-handoff figures inspected in source, not re-executed in this DOC session): focused **19 recovery + 8 crash-replay + 35 rate-limit + 4 rate-quota = 66 M5 tests, all PASS (supplied)**; carried suites runtime 153+/177, git-workspaces 74, verification 23 (supplied, cited for regression context, not re-run); `tsc × 2` clean (supplied). This doc session executed **only the link check** (§8); every typecheck/test figure is cited, not claimed as a fresh run.

| # | §13 fault row → expected | Test evidence (file: test) | Gate |
|---|---|---|---|
| 1 | Kill daemon after message commit, before wake delivery → restart replays one undelivered wake | `crash-replay.test.ts`: `§13 FI-1 … exactly one redelivery after restart; second pass empty`; `recovery.test.ts`: `M5-01 restart replay: commit-then-kill replays pending outbox once; second pass is empty` + `a throwing consumer leaves the row pending (marked delivered only after ack)` | PASS (supplied) |
| 2 | Kill daemon after prompt admitted, before local acknowledgement → reconcile; do not blindly resubmit | `crash-replay.test.ts`: `§13 FI-2 … submitted-but-unacked admission quarantines; harness sees zero new turns`; `recovery.test.ts`: `M5-01 ambiguous admissions quarantine … zero resubmits` + `never-submitted crash releases the lease so the SAME intent retries (no duplicate)` + `session_executions: receipt → ack → outcome correlates; ambiguous listed until acked` | PASS (supplied) |
| 3 | Duplicate OpenCode event → one terminal task transition | `crash-replay.test.ts`: `§13 FI-3 … redelivered event dedupes; terminal edge fires exactly once`; `recovery.test.ts`: `M5-01 duplicate collapse: duplicate completion is a single transition` | PASS (supplied) |
| 4 | Agent crashes holding lease → lease fencing; recovery without double-writing | `crash-replay.test.ts`: `§13 FI-4 … successor fencing strictly exceeds crashed holder; merge lands exactly once`; `recovery.test.ts`: `M5-01 lease fencing recovery … completed work never merges twice` + `M5-01 fencing high-water: acquire → release → acquire strictly increases (never resets to 1)` + FIX-01 `F-01 CAS + fail-closed high-water` (concurrent handles, expiry race, failing-DDL fail-closed, CAS/high-water crash gap) + FIX-02 `F1 tokenless release is a fail-closed no-op` | PASS (supplied) / F-01 disposition ACCEPTED RISK + revisit (see §6) |
| 5 | Provider rate limit → queued admission; no model polling | `rate-quota.test.ts`: `fault injection: rate-limit storm stays bounded — 429 on every transport → bounded submits, queued spillover, dispatch terminates`; `rate-limit.test.ts`: `429 bounded retries then terminal` (growing spacing, budget, then terminal; 429-then-success recovers; backoff bounded by cap) + `concurrency cap under parallel dispatch` (12 workers never exceed cap 3) + `throttle queues spend zero inference` (queued waiters never invoke transport) + `rate limiter S2 remediation: bounded waiters + unified admission` (F-C01/F-C02/F-C04) + `M5-02-FIX-02 FINDING-01: re-admit queued id never ghosts` | PASS (supplied) |
| 6 | Model quota exhausted → member quota-paused; no periodic retry | `rate-quota.test.ts`: `fault injection: quota exhausted freezes with zero follow-ups — 402 → quota-paused; +60s virtual advance performs zero submits`; `rate-limit.test.ts`: `402 → quota-paused after exactly one submit; state preserved` + `classifier separates quota/auth/rate-limited/transient/permanent` + `block registry: blocked members stay blocked; only documented triggers resume` + `usage ledger` quota-paused outcome rollup | PASS (supplied) |
| 7 | Worker edits forbidden file → permission/ownership gate rejects and flags | M4 carry — `path-policy` + `worktree-manager.validateWrite` (see [m4-safe-coding](m4-safe-coding.md) §4 rows 2–3, 8). Unchanged by M5; not re-proven here. | PASS (supplied, M4) |
| 8 | Conflicting Git integration → queue serialized; fail safely on conflict | M4 carry — serialized CAS `IntegrationService` (see [m4-safe-coding](m4-safe-coding.md) §4 rows 3, 6); M5 hardens its fencing with the high-water + CAS acquire above (row 4). | PASS (supplied, M4 + M5 fencing) |
| 9 | Detached worktree contains unmerged changes → preserve and warn on remove | M4 carry — `remove()` refuses dirty/unintegrated unless `preserveFailed`, never touches unlisted paths (see [m4-safe-coding](m4-safe-coding.md) §2). Unchanged by M5; not re-proven here. | PASS (supplied, M4) |
| 10 | Network event stream overflow → reconnect + state snapshot; no assumed replay | `crash-replay.test.ts`: `§13 FI-5 … overflowed consumer resyncs to the durable journal exactly`; `recovery.test.ts`: `M5-01 overflow reconnect: reconnect replays exactly the missed range, deterministically` | PASS (supplied) |
| + | FIX-01 per-swarm scope (F-D3) → replay/executions never cross-deliver | `crash-replay.test.ts`: `M5-01-FIX-01 FI-6 … scoped replay, no cross-delivery`; `recovery.test.ts`: `F-D3 per-swarm replay + execution scope` (scoped replay + ambiguous executions scope by swarm) | PASS (supplied) |
| + | FIX-01 terminal-once (F-02) → second outcome never overwrites the first | `crash-replay.test.ts`: `M5-01-FIX-01 FI-7 … recorded succeeded survives restart + duplicate delivery`; `recovery.test.ts`: `F-02 terminal-once outcome` | PASS (supplied) / F-02 advisory (see §6) |
| + | FIX-02 skewed backlog (F2) → own-swarm rows reachable past other-swarm backlog | `crash-replay.test.ts`: `M5-01-FIX-02 FI-8 … buried past an other-swarm max*5 window; nothing lost`; `recovery.test.ts`: `F2 skewed-backlog filtered replay` | PASS (supplied) |
| + | Auth dedupe → 401/403 zero follow-up, status-less auth never transient | `rate-quota.test.ts`: `fault injection: auth failure blocks with zero retries — 401 → terminal after exactly one submit`; `rate-limit.test.ts`: `401/403 → auth-blocked after exactly one submit; never auto-approved` + `status-less auth is auth-blocked, never transient` (F-C03 code-only, message-only, classifier) + `M5-02-FIX-02 S2-01: extended auth vocab is zero-retry` + `S3 hardening: backoff sanitize, reasonCode allowlist, auth resume split` | PASS (supplied) |
| + | Caps / concurrency under parallel dispatch | `rate-quota.test.ts`: `concurrency cap under parallel dispatch — 10 workers through one gate: peak never exceeds cap 2` | PASS (supplied) |

Required-test tally: **66 M5 focused tests (19 recovery + 8 crash-replay + 35 rate-limit + 4 rate-quota), all PASS (supplied)**; carried regression context runtime 153+/177 + git-workspaces 74 + verification 23 (supplied, not re-run); `tsc × 2` clean (supplied). [PROBE — cited, not re-executed]

## 5. Out of scope for this slice (TODO, not claimed) [DESIGN]

Live OpenCode server behavior, TUI board (M6), scale/cost/Codex (M7), packaging/release/security audit (M8), deployment behavior, endpoints, CLI flags, screenshots, release numbers, spend figures, or support promises. No separate `task_attempts` table (deliberate, §3). Review follow-ups F-02 (advisory) and the S3 hardening lists are **filed follow-ups, not blockers for docs closeout**; F-01 stays **ACCEPTED RISK with its revisit condition** (§6), never upgraded to PASS here.

## 6. Live gate — separately labeled, NOT VERIFIED in this repo [PROBE]

- **Live turns / overlap / provider 402-shape / spend / 401-403 surface: NOT VERIFIED.** No live OpenCode server session, no real `submitTurn` admission, no model inference was executed for M5. All dispatch/replay/limit/ledger paths above are FakeHarness + tmp-Git/tmp-SQLite simulations (**IMPLEMENTED**, not live-VERIFIED).
- **F-01 (fencing high-water + CAS): ACCEPTED RISK with revisit condition** (supplied M5-01/02 review disposition). The simulations prove the mechanism against fakes (concurrent handles, expiry races, failing-DDL fail-closed, CAS/write crash gap); what remains unproven is the mechanism under live concurrent load and real crash timing. **Revisit condition:** re-examine F-01 against live-server contention evidence (or a dedicated concurrent-load probe) before any production or release claim; do not cite row 4 as proof of live crash safety. F-02 is advisory (terminal-once, covered by FI-7 tests); S3 items are deferred follow-ups.
- **F-04 (harness 402-shape): NOT VERIFIED (carried, not closed).** M5 adds no new paid path and no live provider call; the M2 quota posture is carried unchanged. The exact 402/quota error shape a live provider surfaces remains unproven.
- No screenshots, deployment behavior, endpoint, CLI-flag, release-number, or support-promise claims are made. [DESIGN]

## 7. Reproducible log (commands inspected at HEAD; NOT re-executed in this DOC session)

```powershell
git rev-parse HEAD
# 69f40a9726876411e77b8f81848e62b2681b6311 (inspected)

git show --stat HEAD
# 8 files changed, 3527 insertions(+), 21 deletions(-) (inspected — file list in §1)

git log --oneline -6
# 69f40a9 (HEAD) / c10e0be / b54c50c / 698171b / 7330e0e / 4b4b616 (inspected)

# Supplied (cited, NOT re-executed here — no build/test re-runs in DOC-M5-01):
# tsc clean x2 → exit 0
# focused: 19 (recovery) + 8 (crash-replay) + 35 (rate-limit) + 4 (rate-quota) = 66 PASS
# carried: runtime 153+/177 + git-workspaces 74 + verification 23 PASS
# live inference: NOT VERIFIED (no live server, no spend, no credentials)
```

Typecheck/test figures above are **committed/supplied evidence with honest scope**: inspected in source and handoff, not freshly executed in this documentation session. To advance the live gate, re-run the focused suites plus `bun test` in a disposable dir against a live server. [PROBE]

## 8. Link validation (the only check executed in this DOC session) [PROBE]

- Relative links in this file (`../plan/spec.md`, `m4-safe-coding.md`, `m2-wake-engine.md`, `m3-coordination.md`, `../compatibility-report.md`, `../milestone-matrix.md`) validated by read-only file-existence inspection (`ls`/`read` of `docs/` and `docs/evidence/`); all targets exist.
- No unexecuted command examples are presented as executed; §7 commands are labeled inspected/supplied.

## 9. Claim-status summary

| Claim | Status |
|---|---|
| Crash-replay + limiter + ledger + fencing design (§§2–3) | IMPLEMENTED (code-observed at `69f40a9`) |
| 66 M5 focused PASS (19 + 8 + 35 + 4, FakeHarness/tmp-Git/tmp-SQLite) | SUPPLIED PASS / NOT VERIFIED (fresh run) — cited, see §7 |
| Carried suites (runtime 153+/177, git-workspaces 74, verification 23) + `tsc × 2` | SUPPLIED PASS / NOT VERIFIED (fresh run) — cited |
| §13 rows 7–9 (forbidden-file / conflict / preserve-on-remove) | PASS (supplied, M4 carry — not re-proven here) |
| Commit `69f40a9` (8 files, 3527 insertions, 21 deletions) | COMMITTED (HEAD, §1) |
| F-01 | ACCEPTED RISK + revisit condition (live contention evidence before any production claim) |
| F-02 / S3 lists | Filed follow-ups (advisory / deferred, non-blocking for docs) |
| M4 S2-1…S2-3 / m105 | COMMITTED `c10e0be` / cleared `b54c50c` (prior chain, not re-verified here) |
| Live turns / provider 402/401-403 shapes / spend | NOT VERIFIED (no live log in repo) |
| M6+ work | TODO (see [milestone-matrix](../milestone-matrix.md)) |
| Release / shipped / production | NOT CLAIMED — commit is not a release |
