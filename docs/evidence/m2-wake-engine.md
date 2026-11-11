# M2 wake-engine evidence — durable wake-up engine (M2-01)

> **Document status: IMPLEMENTED (FakeHarness simulations) / COMMITTED.**
> All behavior below is code-observed at the recorded HEAD and covered by
> committed **FakeHarness simulations** — deterministic fakes, not live
> inference. **Live-server turns remain NOT VERIFIED** (no live server, no
> inference spend, no credentials). Design intent is never described as
> shipped, released, or production-proven. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Baseline HEAD:** `c62c82418f93a923325968ea841b18f81d182c46` —
  `feat(runtime): durable wake-up engine (M2-01)` [PROBE — `git rev-parse HEAD`]
- **Commit scope:** 7 files, 2703 insertions, zero deletions
  (`git show --stat HEAD`). [PROBE]
- **Prior chain (oldest → newest):** `56d22a2` (M0) → `1c88f0f` (M1-01) →
  `4e61a58` (M1-02) → `5f2c9c3` (M1-03) → `2cfec1c` (M1-04) →
  `513862c` (M1-05) → `d22d8c1` (publish workflow, Node24) →
  `c62c824` (M2-01, HEAD). [PROBE — `git log --oneline`]
- **M2 constraints honored:** M0/M1 behavior preserved (no M0/M1 file
  touched by the commit); **no schema change** (no 003 migration —
  `delivery_key` UNIQUE index rides on migration 002 plus store-level
  backfill/cleanup); protocol DTOs untouched (no `packages/protocol`
  file in the commit). [DESIGN — `git show --stat HEAD` file list]

Related records: [spec](../plan/spec.md) §§7–8 ([DESIGN] contract source),
[api-compatibility](../api-compatibility.md),
[api-probe-results](../api-probe-results.md), [test-evidence](../test-evidence.md),
[compatibility-report](../compatibility-report.md) (M2 addendum),
[milestone-matrix](../milestone-matrix.md).

Evidence-label key (per `api-compatibility.md`): **[G-DOC]** Antigravity docs,
**[OC2-DOC]** OpenCode 2 docs, **[DESIGN]** our decision / code-observed claim,
**[PROBE]** needs executable confirmation.

## 1. Component map (all paths inspected at HEAD, read-only)

| Component | File | Role [DESIGN] |
|---|---|---|
| Durable queue + coalesce | `packages/runtime/src/services/wake-queue.ts` | Enqueue, mention fan-out, oldest-first eligible reads. No inference, no turn submission. |
| Dispatch loop | `packages/runtime/src/services/wake-dispatcher.ts` | FIFO select → fenced claim → one queue-only `submitTurn` → ack / backoff / quota-pause. Quarantines nothing (ambiguity belongs to the reconciler). |
| Reconciler | `packages/runtime/src/services/inbox-reconciler.ts` | Restart/reconnect recovery: keep-running, complete, release-for-retry, quarantine, cancel-stale. Only the reconciler completes or quarantines unsettled wakes. |
| Events | `packages/runtime/src/services/wake-events.ts` | Observable lifecycle events + correlation IDs; at-least-once transport, consumers dedupe by `(kind, wakeId, correlationId)`. |
| Durability + transitions | `packages/runtime/src/db/store.ts` | `delivery_key` idempotency, fencing leases, eligibility/backoff/quota/quarantine transitions, outbox rows in the same txn. |

## 2. Idempotency: `delivery_key` + UNIQUE + fencing [DESIGN]

- Normalized non-null delivery key
  (`sha256(memberId|generation|reason|postIdOr0|taskIdOr0)`-shaped, per spec
  §7 idempotency caveat) with `UNIQUE(swarm_id, delivery_key)` enforced via
  migration 002 (`ix_wake_delivery_key`) — `store.ts` (~lines 382–535:
  backfill, duplicate cleanup keeping earliest `(created_at, id)`, NULL
  safety-net). [DESIGN — code-observed, read-only]
- Duplicate intents with the same key collapse to **one persisted logical
  action** (`deduped: true`, winner's id) — `wake-queue.ts` header + `enqueue`.
- Fenced claims: one active turn per member via the M1 `leases` table
  (monotonic `fencing_token` + TTL, `claimWakeForDispatch`,
  `assertWakeFencing` on ack/complete/quarantine paths — `store.ts`
  ~lines 1242–1630). Stale tokens cannot complete another holder's work. [DESIGN]
- **Exactly-once LOGICAL intent + at-least-once TRANSPORT.** Receipts may
  redeliver; ack is idempotent. Exactly-once *physical* delivery is never
  claimed (`wake-dispatcher.ts` header, `wake-events.ts` header). [DESIGN]

## 3. Quota: 402 → `quota-blocked`, no retry vs transient bounded backoff [DESIGN]

- `isQuotaError`: `status === 402`, or `/quota/i` on code/message, or `/402/`
  on code (`wake-dispatcher.ts` ~lines 87–94). `ProtocolError` (local
  validation) is never treated as quota. [DESIGN]
- On 402: the member transitions to `quota_paused` (`markQuotaBlocked`,
  `store.ts` ~lines 1706–1724), the admitted intent is **preserved**, the
  member lease is released, a `quota_blocked` event is emitted — and the paid
  path is **never auto-retried** (`wake-dispatcher.ts` ~lines 292–300).
  Resume redrives after the operator clears the pause. [DESIGN]
- Transient transport failures (429/408/502/503/504/5xx, ECONNRESET,
  timeouts) get **bounded exponential backoff** (`WAKE_BACKOFF_*`,
  `WAKE_MAX_ATTEMPTS_DEFAULT`) with `failed-transient-scheduled`, then
  redispatch; 4xx (non-quota) fails permanently without retry
  (`isTransientError`, `wake-dispatcher.ts` ~lines 96–109). [DESIGN]
- Fix-review hardening (M2-01-FIX-01, committed in `c62c824`):
  **S2-1** TOCTOU quota-pause preserves the admitted intent and releases the
  lease (resume redrives); **S2-2** store-level paused-swarm guard
  (`pause→claim` stays queued, `pause→reacquire` stays admitted);
  **F-01** pre-transport defers burn zero retry budget (attempts frozen,
  wake stays admitted). [DESIGN — `describe` blocks in the test files below]

## 4. Dispatch semantics: one turn, coalescing, guards, ordering [DESIGN]

- **One logical action → one queue-only turn**: the dispatcher resumes the
  EXISTING native session with a single `submitTurn({ delivery: "queue",
  externalId: <wake id>, reason })`. `externalId` is adapter-internal and
  never an OpenCode API argument. [DESIGN]
- **Per-session serialization / coalescing**: a live turn defers the second
  wake (`deferred-live-turn`, zero retry-budget burn); after completion the
  dispatcher resubmits the SAME `externalId` (admitted-retry, no duplicate
  action). One active turn per member, duplicates coalesced. [DESIGN]
- **Member-state guards**: killed members reject (`KILLED_MEMBER`);
  `quota_paused` / `approval_paused` members defer with zero submits;
  paused swarms dispatch nothing; terminal swarms (completing/completed/
  failed/cancelled) are ineligible; generation drift cancels as stale.
  (`wake-dispatcher.ts` ~lines 218–240, `store.ts` ~lines 1449–1450,
  1811, 1968.) [DESIGN]
- **Ordering / identity / ownership**: oldest-first eligible reads preserve
  FIFO across members; wake id + member generation bind identity; only the
  owning member's session receives the turn. [DESIGN]
- **Idle-zero (no polling inference)**: with no eligible wake the dispatcher
  performs **zero** harness `submitTurn` calls — proven by idle tests
  asserting the FakeHarness counter stays `0`; status reads never dispatch.
  (`wake-dispatcher.ts` header lines 21–23.) [DESIGN — FakeHarness simulation]

## 5. Restart / reconnect: reconciler decisions, quarantine policy [DESIGN]

Per `inbox-reconciler.ts` header + `reconcileWake` (~lines 94–148):

| Observation | Decision | Rationale |
|---|---|---|
| Session live | `kept-running` | No lease surgery; dispatcher only claims QUEUED wakes so no duplicate is possible. |
| Terminally known **with** reported outcome | `completed` | Outcome recorded, never invented. |
| Terminally known **without** reported outcome | `quarantined` | Never invent an outcome, never blind replay. |
| Idle + **never submitted** (crash between claim and `submitTurn`) | `released-for-retry` | Nothing reached the backend; SAME wake id redrives — no duplicate action, no replay. |
| Idle + **submitted**, no terminal record (crash between admission and ack) | `quarantined` | Ambiguous: resubmitting could double the model turn; an operator clears it after review. |
| Member killed / generation drift / member missing | `cancelled-stale` | Stale work never resumes. |
| Snapshot provider unavailable | `skipped-snapshot-unavailable` | No decision without fresh evidence. |

Queued wakes need no action (restart preserves them; the dispatcher
re-reads them). Only the reconciler touches non-queued rows. [DESIGN]

## 6. At-least-once statement (honest)

The engine guarantees **exactly-once logical intent** (one persisted action
per `delivery_key`) over an **at-least-once transport** (event receipts and
harness admissions may redeliver; all acks are idempotent). It does **not**
guarantee exactly-once physical model execution: a crash between backend
admission and local acknowledgement is unobservable by the daemon, so the
affected wake is **quarantined for operator review, never blind-replayed**.
No silent double-turn is possible by design; a quarantined wake waits for an
explicit human decision. [DESIGN]

## 7. Required-test map — all 10, with suite names and counts [PROBE]

Execution evidence: `bun test
packages/runtime/src/services/__tests__/wake-engine.test.ts
packages/runtime/src/services/__tests__/wake-concurrency.test.ts` →
**20 pass, 0 fail, 356 expect() calls**; full
`bun test packages/runtime/` → **98 pass, 0 fail, 618 expect() calls,
9 files**. Typecheck `bun run typecheck`
(`tsc --noEmit -p packages/adapter-opencode/tsconfig.json`) → exit 0.
All runs use **FakeHarness only** (deterministic fakes injected by the
tests; the `DispatchHarness` interface is satisfied structurally by the
M1-03 `OpenCodeHarness` in production, which is live-NOT VERIFIED).
[PROBE — executed in the DOC-M2-01 session against HEAD `c62c824`;
re-runnable per §9.]

### Suite A — `wake-engine.test.ts` (13 tests)

| # | Required behavior | Test (describe → test) |
|---|---|---|
| 1 | Mention → one persisted logical wake → exactly one queue-only turn | one logical action, one turn, FIFO → `mention → one persisted logical wake → exactly one queue-only turn` |
| 2 | Duplicate intents → one persisted action, no duplicate turn (coalescing) | same → `duplicate intents → one persisted logical action, no duplicate turn` |
| 3 | Per-session serialization: live turn defers, coalesces after completion | same → `per-session serialization: live turn defers the second wake, coalesces after completion` |
| 4 | FIFO ordering across members | same → `FIFO ordering across members is preserved` |
| 5 | Killed/quota/approval-paused members never invoked (zero submits) | eligibility guards → `killed member rejects the wake; quota/approval-paused members defer with zero submits` |
| 6 | Paused swarm dispatches nothing (zero submits) | same → `paused swarm dispatches nothing (zero submits)` |
| 7 | Restart preserves actionable events (queued + unsettled survive reopen) | restart, backoff, quota, lost-ack, idle-zero → `restart preserves actionable events (queued + unsettled survive reopen)` |
| 8 | Transient 503 → bounded backoff, redispatch, no retry storm | same → `transient 503 → bounded backoff, then redispatch; no retry storm` |
| 9 | Quota 402 → `quota-blocked` member, never auto-retries paid path | same → `quota 402 → quota-blocked member, never auto-retries the paid path` |
| 10a | Lost-ack: never-submitted releases for retry; submitted-ambiguous quarantines | same → `lost-ack reconciles: never-submitted releases for retry, submitted-ambiguous quarantines` |
| 10b | Idle swarm performs zero harness calls (zero inference) | same → `idle swarm performs zero harness calls (zero inference)` |
| 11 | S2-1 TOCTOU quota-pause preserves admitted intent; resume redrives | M2-01-FIX-01 S2-1 → `claim→quota→dispatch stays admitted + lease released; resume redrives` |
| 12 | S2-2 store-level paused-swarm guard | M2-01-FIX-01 S2-2 → `pause→claim stays queued; pause→reacquire stays admitted` |

### Suite B — `wake-concurrency.test.ts` (7 tests)

| # | Required behavior | Test (describe → test) |
|---|---|---|
| 13 | Bulk idempotency: 100 rapid intents → 100 unique `delivery_key`s; 100 posts → contiguous sequences | bulk idempotency + ordering → `100 rapid intents → 100 unique delivery_keys; 100 posts → contiguous sequences` |
| 14 | Dual claimants on one file: exactly one admitted, other deferred-live-turn | dual claimants, one winner → `two stores on one file: exactly one admitted, the other deferred-live-turn` |
| 15 | Restart preserves 20 queued wakes; reopened dispatcher drains with zero dupes | restart, lost-ack, quota isolation, idle-zero → `restart preserves 20 queued wakes; reopened dispatcher drains them with zero dupes` |
| 16 | Lost-ack across restart: never-submitted retries same id; ambiguous quarantines | same → `lost-ack across restart: never-submitted retries the same id; ambiguous quarantines` |
| 17 | Quota isolation: 402 blocks one member without retry while the other dispatches | same → `quota isolation: 402 blocks one member without retry while the other dispatches` |
| 18 | Idle-zero under load: settled swarm performs zero harness calls | same → `idle-zero under load: settled swarm performs zero harness calls` |
| 19 | F-01: pre-transport defers burn zero retry budget (attempts frozen, wake admitted) | M2-01-FIX-01 F-01 → `9 live-session defers leave attempts frozen and the wake admitted` |

Required-test tally: **10 required behaviors → 20 mapped test slots**
(behavior 10 split across restart/lost-ack/idle variants in both suites;
Suite A 13 + Suite B 7 = **20 wake tests, all PASS**). The 20 wake tests are
a subset of the **98-test `packages/runtime/` total (9 files)**. [PROBE]

## 8. Live gate — separately labeled, NOT VERIFIED in this repo [PROBE]

- **Overlap / concurrency:** assignment-supplied LIVE-PROBE-01 evidence
  reports overlapping execution proven (1557 ms overlap window). **No probe
  log exists in this repo** (`scripts/probe-logs/*.log` and
  `%TEMP%/opencode/swarm-probes/*.log` are both missing per
  [api-probe-results](../api-probe-results.md)) — so the overlap figure is
  recorded here as a **supplied claim, NOT VERIFIED by repo evidence**.
- **Live turns: NOT VERIFIED.** No live OpenCode server session, no real
  `submitTurn` admission, no model inference was executed for M2. All
  dispatch/ack/quota paths above are FakeHarness simulations
  (**IMPLEMENTED**, not live-VERIFIED).
- **402 zero-spend:** assignment-supplied LIVE-PROBE-01 evidence reports a
  402 response with zero inference spend. No credentials were used, no spend
  incurred, and no secret-bearing log is stored in this repo. The in-repo
  quota path (detection regex, `quota_paused`, no-retry) is IMPLEMENTED and
  FakeHarness-tested; provider-side 402 shaping is NOT VERIFIED.
- **Harness 402-shape (F-04): NOT VERIFIED.** The exact 402/quota error shape
  the M1-03 `OpenCodeHarness` surfaces against a live provider is unproven;
  see the [compatibility-report M2 addendum](../compatibility-report.md).
- No screenshots, deployment behavior, endpoint, CLI-flag, release-number, or
  support-promise claims are made. [DESIGN]

## 9. Reproducible log (commands inspected / executed at HEAD)

```powershell
git rev-parse HEAD
# c62c82418f93a923325968ea841b18f81d182c46

git show --stat HEAD
# 7 files changed, 2703 insertions(+)

bun run typecheck   # tsc --noEmit -p packages/adapter-opencode/tsconfig.json
# exit 0

bun test packages/runtime/src/services/__tests__/wake-engine.test.ts `
         packages/runtime/src/services/__tests__/wake-concurrency.test.ts
# 20 pass, 0 fail, 356 expect() calls

bun test packages/runtime/
# 98 pass, 0 fail, 618 expect() calls, 9 files
```

Typecheck, the 20 wake tests, and the 98-test runtime suite were executed
in the DOC-M2-01 session against HEAD `c62c824` (FakeHarness only) and all
passed. Live-server probes 01–12 remain NOT VERIFIED (no logs); re-run the
table above plus `bun scripts/run-probes.ts` in a disposable dir against a
live server to advance the live gate. [PROBE]

## 10. Claim-status summary

| Claim | Status |
|---|---|
| Queue / dispatcher / reconciler / events design (§§1–6) | IMPLEMENTED (code-observed at `c62c824`) |
| 20 wake + 98 runtime tests PASS (FakeHarness) | VERIFIED (executed, §9) |
| Typecheck clean | VERIFIED (executed, §9) |
| Commit `c62c824` (7 files, 2703 insertions) | COMMITTED (HEAD, §9) |
| Live turns / overlap / provider 402-shape / spend | NOT VERIFIED (no live log in repo) |
| M3+ autonomy work | TODO (see [milestone-matrix](../milestone-matrix.md)) |
| Release / shipped / production | NOT CLAIMED — commit is not a release |
