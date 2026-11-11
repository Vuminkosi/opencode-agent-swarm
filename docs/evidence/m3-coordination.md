# M3 coordination evidence — autonomous team core (M3-01)

> **Document status: IMPLEMENTED (FakeHarness + tmp-SQLite simulations) / COMMITTED.**
> All behavior below is code-observed at the recorded HEAD and covered by
> committed **FakeHarness simulations** — deterministic fakes, never live
> inference. **Live-server turns remain NOT VERIFIED** (no live server, no
> inference spend, no credentials). Design intent is never described as
> shipped, released, or production-proven. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Baseline HEAD:** `e7a0b8f677045c67a34a9e09daf643333ac21a9e` —
  `feat(runtime): M3 coordination core + S1/S2 fixes (M3-01)` [PROBE — `git rev-parse HEAD`]
- **Commit scope:** 8 files, 1678 insertions, zero deletions
  (`git show --stat HEAD`). [PROBE]
- **Git status at inspection:** clean working tree (no staged, unstaged, or
  untracked changes observed before this doc was authored). [PROBE]
- **Prior chain (oldest → newest):** `c62c824` (M2-01) → `937af39` (DOC-M2-01)
  → `9f595ad` (target-capabilities checklist) → `e7a0b8f` (M3-01, HEAD). [PROBE — `git log --oneline`]
- **M3 constraints honored:** M0/M1/M2 behavior preserved (no M0/M1/M2 source
  file touched by the commit — 6 new services + 2 new test files only);
  **no schema change** (no new migration; services project over the M1-01
  journal + M2 wake rows); protocol DTOs untouched (no `packages/protocol`
  file in the commit). [DESIGN — `git show --stat HEAD` file list]

Related records: [spec](../plan/spec.md) §§7, 8, 13, 14 ([DESIGN] contract
source), [m2-wake-engine](m2-wake-engine.md) (M2 engine this slice builds on),
[compatibility-report](../compatibility-report.md) (M3 addendum),
[milestone-matrix](../milestone-matrix.md).

Evidence-label key: **[DESIGN]** approved contract / code-observed claim;
**[PROBE]** needs (or has, when noted) executable confirmation. S1/S2 finding
IDs below are the review findings remediated inside this same commit (no
separate fix-review commit exists in `git log` — recorded honestly here, not
invented). [DESIGN]

## 1. Reconciled M3 scope vs the 12 user verifications [DESIGN]

Spec §14 gates M3 as *"planner, groups, task DAG, verifier and dormant
monitor — three-worker task + verifier + monitor with remediation"*. The 12
numbered test slots in `coordination.test.ts` are the user-facing
verifications for this slice; each maps to exactly one named test:

| # | User verification (board / mentions / private / wake / lead / roster / recovery / quota) | Test (`describe` → `test`) | Status |
|---|---|---|---|
| 1 | Board: chronological durable sequence 1..N across authors | M3 board → `(1) chronological durable sequence 1..N across authors` | IMPLEMENTED, PASS [PROBE] |
| 2 | Mentions: `@member` wakes exactly that member | M3 board → `(2) @member mention wakes exactly that member` | IMPLEMENTED, PASS [PROBE] |
| 3 | Mentions: `@group` fans out to live group members, author excluded | M3 board → `(3) @group mention fans out to live group members, author excluded` | IMPLEMENTED, PASS [PROBE] |
| 4 | Mentions: `@all` wakes everyone except author; killed never woken | M3 board → `(4) @all wakes everyone except the author; killed never woken` | IMPLEMENTED, PASS [PROBE] |
| 5 | Wake: duplicate idempotencyKey replays post with zero new wakes | M3 board → `(5) duplicate idempotencyKey replays post with zero new wakes` | IMPLEMENTED, PASS [PROBE] |
| 6 | Private: user→worker steering writes no post row, dispatches `user_direct` | M3 private steering → `(6) private user->worker steering writes no post row, dispatches user_direct` | IMPLEMENTED, PASS [PROBE] |
| 7 | Wake: mention-free post wakes nobody | M3 board → `(7) mention-free post wakes nobody` | IMPLEMENTED, PASS [PROBE] |
| 8 | Wake: working member coalesces — second mention defers, zero extra submits | M3 private steering → `(8) working member coalesces: second mention defers, zero extra submits` | IMPLEMENTED, PASS [PROBE] |
| 9 | Lead: `markWaiting` sleeps with zero submits | M3 lead autonomy → `(9) markWaiting sleeps with zero submits` | IMPLEMENTED, PASS [PROBE] |
| 10 | Lead: `none` stays asleep; completion wakes exactly one coordinator wake | M3 lead autonomy → `(10) none stays asleep; completion wakes exactly one coordinator wake` | IMPLEMENTED, PASS [PROBE] |
| 11 | Recovery: journal replay — file DB reopen preserves posts, wakes, outbox | M3 restart + identity → `(11) journal replay: file DB reopen preserves posts, wakes, outbox` | IMPLEMENTED, PASS [PROBE] |
| 12 | Quota: 402 quota-pauses member, never auto-retries | M3 private steering → `(12) quota-blocked: 402 quota-pauses member, never auto-retries` | IMPLEMENTED, PASS [PROBE] |

Roster/identity is covered additionally by `identity/permission passthrough:
nativeAgentId chain + role policy intact` and `roster preserves
nativeAgentId/sessionId per member after fanout + dispatch`
(concurrency suite). Scheduler + verifier + monitor gate behaviors
(deps gating, defect fanout + `attempt++`, quiet→one intervention +
cooldown) are covered by the `M3 scheduler + verifier + monitor gate`
describe block and the monitor concurrency tests. [DESIGN — code-observed,
read-only]

Out of scope for this slice (TODO, not claimed): Git worktrees, real test-runner
execution, integration mutex (M4); leases/crash-replay matrix beyond the M2
reconciler (M5); TUI board (M6); scale/cost/Codex (M7). [DESIGN]

## 2. Per-service design (all paths inspected at HEAD, read-only) [DESIGN]

| Service | File | Role |
|---|---|---|
| Board | `packages/runtime/src/services/board-service.ts` (57 lines) | Single public-post path: `publishPost` delegates to `store.appendPost`, the ONLY sequence allocator (one `BEGIN IMMEDIATE` bump of `swarms.revision` → `sequence`; never MAX+1). Mention resolution (`@member`/`@group`/`@all`, author excluded, killed excluded) plus `post_recipients` write plus one wake intent per live recipient all happen INSIDE the same store transaction; the service performs NO second enqueue (a second batch with a different `payloadHash` would mint a second `delivery_key` and break exactly-once-logical). Zero inference, zero harness submits — dispatch stays in the M2 lane. Header lines 1–18; `publishPost` 44–52; `readBoard` 54–57. |
| Planner / DAG scheduler | `packages/runtime/src/services/task-scheduler.ts` (92 lines) | Creation via `store.createTask` (protocol DFS `assertDepsAcyclic` rejects self/unknown/cyclic deps — no second graph check here). `ready → leased` is atomic inside the store txn (generation bump + deps-accepted re-check, spec §7). Leasable only when every dep is `accepted`, an owner exists, and nobody else holds the row. `leaseNext` (54–72) falls through to the next candidate on `INVALID_TRANSITION`/`VALIDATION_FAILED` (S2-01 race fix). Zero inference, zero submits. |
| Groups | membership via `SwarmStore` `member_groups` (M1-01 journal) + `roster.ts` read models | Groups are a journal projection, not a new table: snapshot-at-post-commit recipient resolution (author excluded, killed excluded) is store-owned; `getRoster`/`getPending`/`getHistory`/`getDelivery` (`roster.ts` 28–59) are pure SQLite projections. Identity (`nativeAgentId`, `sessionId`) preserved verbatim; the public projection never leaks internal wake payload hashes. Header lines 1–9. |
| Verifier | `packages/runtime/src/services/verifier.ts` (117 lines) | Acceptance gate: exit 0 → record evidence then `verifying → accepted`, gated by `assertVerifierAccept` (a worker can never accept its own task; verifier must differ from owner). Exit ≠ 0 → evidence row still recorded, a `verification` defect post mentioning the owner is published (store fanout mints the remediation wake), task returns `verifying → ready` with `attempt++`. Crash-safety rationale lines 62–69; idempotent replay guard lines 91–95; defect post 105–114 (S2-02 fix). Zero inference; dispatch stays in the M2 lane. |
| Dormant monitor | `packages/runtime/src/services/monitor.ts` (191 lines) | Quiescence watch, not a running session: live unsettled turns → `active`; recent post within `quietThresholdMs` → `active`; quiet but within `cooldownMs` of last monitor post → `quiet` (suppressed, no spam); quiet + cooldown elapsed → ONE `monitor`-kind post + ONE `monitor_intervention` wake for the coordinator. Quota/approval-paused or killed coordinators → `suppressed`, never an auto-retry of a paid path. The durable `monitor` post inside the cooldown window is the idempotency guard, plus the S1-02 orphan-repair path (lines 139–165). Zero inference. |
| Lead autonomy | `packages/runtime/src/services/lead-autonomy.ts` (153 lines) | `markWaiting` (68–72): store transition only, zero submits. `decideLeadWake` (81–110): pure signal classification — `none` → stay waiting, zero enqueues; `completion`/`blocker`/`decision` → exactly ONE coordinator wake (delivery_key idempotent). Blocker/decision signals REQUIRE `postSequence` (S1-01 fix, lines 41–65). `steerWorkerDirect` (124–153): private steering enqueues ONE durable `user_direct` intent + one queue-only dispatch, writes NO board post row. |

## 3. S1/S2 remediation — file:line refs discovered in the `e7a0b8f` diff [DESIGN]

No separate `M3-01-FIX-REVIEW-01` commit exists in `git log --oneline`
(all 8 M3 files arrive in the single commit `e7a0b8f`); the five remediation
findings below are the S1/S2 describe blocks inside that commit's two test
files plus the guard code they pin. Line numbers are working-tree
observations at HEAD.

| ID | Finding → fix | Guard code | Pinning test |
|---|---|---|---|
| S1-01 | Distinct blocker/decision lead signals collapsed to one delivery key (`...:0`), silently swallowing later signals | `lead-autonomy.ts` 41–65 (`signalKey`: seq-less blocker/decision throws `VALIDATION_FAILED`; key embeds `postSequence`) | `coordination.test.ts` 464–506: `S1-01: distinct decision seqs wake twice; same seq dedupes; seq-less throws VALIDATION_FAILED` |
| S1-02 | Monitor post txn could commit while its intervention wake never enqueued (crash/KILLED/fault between txns) → silent orphan | `monitor.ts` 47–60 (`findMonitorWake` fate-share probe) + 139–165 (deduped-post repair re-enqueues) + 166–184 (killed-coordinator orphan surfaced, never mistaken for delivery) | `coordination.test.ts` 507–548: `S1-02: fault-injected enqueue failure leaves a repairable orphan; retry converges to exactly one wake` |
| S2-01 | Lease race between list snapshot and claim leaked `INVALID_TRANSITION` and failed the whole lease | `task-scheduler.ts` 59–72 (`leaseNext` catches `INVALID_TRANSITION`/`VALIDATION_FAILED`, falls through; all-lost returns `null`) | `coordination-concurrency.test.ts` 207–247: `S2-01: lease race falls through to the next candidate; all-lost returns null (no INVALID_TRANSITION leak)` |
| S2-02 | Kill between evidence commit and state/post edge commit left recorded evidence without its edge; naive retry double-edged | `verifier.ts` 62–69 (append-only audit rationale) + 91–95 (accepted-state replay returns without duplicate evidence) + 105–114 (`defectIdempotencyKey` collapses the defect post) | `coordination.test.ts` 549–591: `S2-02: kill between evidence and edge retries append-only with a single accepted edge; replay is a no-op` |
| S2-03 | Global outbox projection leaked swarm B entries into swarm A's delivery trail | `roster.ts` 49–87 (`getDelivery` scopes by swarm: `post_committed` via payload `swarmId`, `wake_queued` via wake row, `evidence_recorded` via task row; unknown/vanished aggregates excluded) | `coordination.test.ts` 592–647: `S2-03: delivery trail is swarm-scoped; swarm B entries never leak into A` |

## 4. Required-test map — 21 base + 5 remediation = 26 [PROBE]

Execution evidence (DOC-M3-01 session, FakeHarness + tmp-file SQLite only):

```powershell
bun test packages/runtime/src/services/__tests__/coordination.test.ts `
         packages/runtime/src/services/__tests__/coordination-concurrency.test.ts
# 26 pass, 0 fail, 130 expect() calls, 2 files

bun test packages/runtime/
# 124 pass, 0 fail, 748 expect() calls, 11 files  (= 98 M2-era + 26 M3)

bun run typecheck   # tsc --noEmit -p packages/adapter-opencode/tsconfig.json
# exit 0

bun test
# 188 pass, 0 fail, 954 expect() calls, 20 files (repo-wide: runtime 124 + protocol 35 + adapter/plugin remainder)
```

Count reconciliation: `coordination.test.ts` holds 20 tests (16 base slots
§1 items 1–12 + deps-gate + verifier + monitor + restart-11 + identity, plus 4
remediation: S1-01, S1-02, S2-02, S2-03); `coordination-concurrency.test.ts`
holds 6 tests (5 base: back-to-back mentions, same-member serialization,
duplicate private steering, restart-during-admitted, roster identity; plus 1
remediation: S2-01). 16 + 5 = 21 base, + 5 remediation = **26, all PASS**.
[Inner PowerShell `NativeCommandError` text on these runs is a shell-reporting
artifact of piped stderr, not a test failure: counts read `0 fail` with exit
0 for typecheck.] [PROBE — executed in the DOC-M3-01 session against HEAD
`e7a0b8f`; re-runnable per §8.]

Note on the assignment-supplied `119` figure: no observed suite reports 119
(actuals are 26 coordination / 124 runtime / 35 protocol / 188 repo-wide), so
`119` is recorded here as **NOT VERIFIED — no matching suite observed**, not
as evidence. [PROBE]

### Concurrency suite slots (all PASS, FakeHarness)

- `back-to-back mentions to two members: gapless sequences, one wake each,
  parallel sessions both dispatch` (lines 82–109)
- `same member mentioned twice: sequences stay gapless, turns serialize (one
  live, one deferred)` (110–136)
- `duplicate private steering collapses to one logical intent, one submit`
  (137–161)
- `restart during admitted turn: reconciler keeps running, no duplicate
  submit` (162–206)
- `S2-01` lease-race fall-through (207–247, see §3)
- `roster preserves nativeAgentId/sessionId per member after fanout +
  dispatch` (248–270)

## 5. Idle-zero + no-retry proofs [DESIGN — FakeHarness simulation]

- **Idle-zero (no polling inference):** with no eligible wake the dispatcher
  performs zero harness `submitTurn` calls (M2 engine, unchanged); M3 adds
  `markWaiting` (zero submits by construction, test 9), `none`-signal
  zero-enqueue (test 10), mention-free posts waking nobody (test 7), and
  monitor `active`/`quiet` paths performing zero enqueues and zero posts.
  Status/roster/history reads are SQLite-only projections (`roster.ts`,
  `board-service.ts readBoard`) — no harness calls, no model requests.
- **No-retry (quota):** 402/quota errors transition the member to
  `quota_paused`, preserve the admitted intent, release the lease, and NEVER
  auto-retry the paid path (test 12; monitor `suppressed` on quota-paused
  coordinators). Transient failures use bounded backoff (M2 engine,
  unchanged); permanent 4xx fail without retry.

## 6. Restart / duplicate handling [DESIGN]

- Queued wakes survive reopen; the dispatcher re-reads them (test 11: file-DB
  reopen preserves posts, wakes, outbox).
- Restart during an admitted turn: the M2 reconciler keeps a live session
  running with no duplicate submit (concurrency test 162–206); never-submitted
  releases for retry under the SAME wake id; submitted-but-ambiguous
  quarantines for operator review (M2 engine, unchanged by M3).
- Duplicate posts (`idempotencyKey` replay) create no new row and no new
  wakes (test 5); duplicate private steering collapses to one intent, one
  submit; S2-02 retries converge to a single edge; S1-02 orphan repair
  converges to exactly one wake.

## 7. At-least-once statement (honest) [DESIGN]

M3 inherits the M2 guarantee unchanged: **exactly-once logical intent** (one
persisted action per `delivery_key`) over an **at-least-once transport**
(event receipts and harness admissions may redeliver; all acks idempotent).
New M3 surfaces preserve it by construction — the board service performs no
second enqueue, monitor intervention is guarded by its durable post, the
verifier gate is append-only with single-edge convergence, and the scheduler
falls through instead of double-claiming. Exactly-once *physical* model
execution is NOT claimed: ambiguous admitted-but-unacked wakes quarantine for
operator review, never blind-replay. No silent double-turn is possible by
design.

## 8. Live gate — separately labeled, NOT VERIFIED in this repo [PROBE]

- **Live turns / overlap / three-worker gate: NOT VERIFIED.** The spec §14
  gate (three-worker task + verifier + monitor with remediation) is proven
  here only as FakeHarness + tmp-SQLite simulation. No live OpenCode server
  session, no real `submitTurn` admission, no model inference was executed
  for M3. No probe log exists in this repo.
- **402 zero-spend:** assignment-supplied LIVE-PROBE-01 evidence reports a 402
  with zero inference spend. No credentials were used, no spend incurred, no
  secret-bearing log stored here. The in-repo quota path (detection regex,
  `quota_paused`, no-retry) is IMPLEMENTED and FakeHarness-tested;
  provider-side 402 shaping (F-04) stays NOT VERIFIED — carried, not closed.
- No screenshots, deployment behavior, endpoint, CLI-flag, release-number, or
  support-promise claims are made. [DESIGN]

## 9. Reproducible log (commands inspected / executed at HEAD)

```powershell
git rev-parse HEAD
# e7a0b8f677045c67a34a9e09daf643333ac21a9e

git show --stat HEAD
# 8 files changed, 1678 insertions(+)

git status --short
# (clean before this doc was authored)

bun run typecheck
# exit 0

bun test packages/runtime/src/services/__tests__/coordination.test.ts `
         packages/runtime/src/services/__tests__/coordination-concurrency.test.ts
# 26 pass, 0 fail, 130 expect() calls

bun test packages/runtime/
# 124 pass, 0 fail, 748 expect() calls, 11 files

bun test
# 188 pass, 0 fail, 954 expect() calls, 20 files
```

Typecheck, the 26 coordination tests, the 124-test runtime suite, and the
188-test repo suite were executed in the DOC-M3-01 session against HEAD
`e7a0b8f` (FakeHarness + tmp-SQLite only) and all passed. Live-server probes
remain NOT VERIFIED; re-run the table above plus `bun scripts/run-probes.ts`
in a disposable dir against a live server to advance the live gate. [PROBE]

## 10. Claim-status summary

| Claim | Status |
|---|---|
| Board / scheduler / verifier / monitor / lead / roster design (§2) | IMPLEMENTED (code-observed at `e7a0b8f`) |
| S1-01 / S1-02 / S2-01 / S2-02 / S2-03 fixes (§3) | IMPLEMENTED (guard code + pinning tests committed in `e7a0b8f`; no separate fix commit in log) |
| 26 coordination + 124 runtime + 188 repo tests PASS (FakeHarness) | VERIFIED (executed, §9) |
| Typecheck clean | VERIFIED (executed, §9) |
| Commit `e7a0b8f` (8 files, 1678 insertions) | COMMITTED (HEAD, §9) |
| `119` count figure | NOT VERIFIED (no observed suite reports it; actuals are 26/124/35/188) |
| Live three-worker turns / overlap / provider 402-shape / spend | NOT VERIFIED (no live log in repo) |
| M4+ work (worktrees, real runner, integration, TUI, scale) | TODO (see [milestone-matrix](../milestone-matrix.md)) |
| Release / shipped / production | NOT CLAIMED — commit is not a release |
