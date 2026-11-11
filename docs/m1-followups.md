# M1 follow-up tasks

> **Document status: PROPOSED / UNVERIFIED.** Every item below is a
> planned follow-up, not verified, committed, or released behavior.
> Baseline: M1-01 (protocol/journal), M1-02 (daemon/config), M1-03
> (bridge), M1-04 (coordinator) are done per committed evidence;
> live probes remain NOT VERIFIED. No item here asserts a new API
> contract, endpoint, flag, release, or severity verdict.

Authoritative sources: [spec](plan/spec.md), [probe results](api-probe-results.md),
[compatibility record](api-compatibility.md), [recovery runbook](recovery-runbook.md).

## F-01 — M1-05 live verification task

- **Status:** PROPOSED / UNVERIFIED.
- **Scope:** Execute the M1-05 first demonstrator and acceptance script
  exactly as defined in
  [spec §15 M1-05](plan/spec.md#m1-05-first-demonstrator-and-acceptance-script):
  disposable Git fixture, `/swarm` run with two workers, session-overlap
  measurement, TUI kill/restart (daemon survives), board/worker-output
  inspection, and lead idle-token check. Record actual OpenCode, Bun, Git,
  and provider versions.
- **Dependency:** M1-01…M1-04 committed evidence; live probes
  [01–12](api-probe-results.md#12-row-verdict-table) (currently all
  NOT VERIFIED); test-engineer live run owns execution.
- **Acceptance sketch:** `tests/e2e/m1.spec.ts` / `scripts/m1-demo.ts`
  pass deterministically in CI and on Windows 11; evidence log cites
  versions and board snapshots. Until then, no multi-worker or
  durability claim beyond committed code.
- **Next action:** Orchestrator schedules the M1-05 live run; this
  document is updated only from its evidence.

## F-02 — Verifier and monitor follow-ups (M3 scope, not M1)

- **Status:** PROPOSED / UNVERIFIED.
- **Scope:** Planner-suggested verifiers (`ceil(coders/3)` per
  [spec §2 PAR-06](plan/spec.md#2-antigravity-behavioral-parity-matrix)),
  verifier review/test-evidence loop (PAR-07), and the dormant monitor
  quiet-detection policy (`quietThreshold` 120 s proposed,
  `cooldown` 300 s proposed, per [spec §8](plan/spec.md#8-scheduling-concurrency-and-wake-ups)).
  M1 explicitly excludes verifier, monitor, and complex merge
  ([spec §15](plan/spec.md#m1-05-first-demonstrator-and-acceptance-script)).
- **Dependency:** M1-05 pass; probes 05 (concurrency), 07 (correlation
  IDs), 08 (reconnect) — see [fallbacks](api-probe-results.md#12-row-verdict-table).
- **Acceptance sketch:** Three-worker task with one verifier performing a
  real failing-test → defect post → coder fix → retest cycle, plus a
  monitor that stays silent during progress and intervenes once per
  quiet epoch (M3 gate in [spec §14](plan/spec.md#14-phased-development-plan-and-gates)).
- **Next action:** File M3 tickets referencing this note; do not start
  verifier/monitor implementation inside M1.

## F-03 — Crash-exactly-once semantics (probe-06 question)

- **Status:** PROPOSED / UNVERIFIED.
- **Scope:** Resolve the [spec §8 crash window](plan/spec.md#8-scheduling-concurrency-and-wake-ups):
  prompt admission and SQLite acknowledgement cannot be made atomic, so
  exactly-once model execution is **not guaranteed** without a
  documented server-side idempotency token. Confirm via probe-06 (one
  waiting-session prompt → exactly one turn) and probe-08 (mid-turn
  reconnect, no duplicate completion).
- **Dependency:** Probes
  [06](api-probe-results.md#probe-06--one-waiting-session-prompt--exactly-one-turn)
  and
  [08](api-probe-results.md#probe-08--mid-turn-reconnect--snapshot-reconcile-no-duplicate-completion)
  live outcomes; fallback on FAIL is the quarantine path
  ([compatibility §2](api-compatibility.md#2-per-probe-verdicts-spec-46)).
- **Acceptance sketch:** Live logs prove one admitted intent yields one
  observed turn, reconnect reconciles via snapshot without duplicate
  terminal transitions, and ambiguous admissions are quarantined for
  review rather than blindly replayed.
- **Next action:** Await probe-06/08 evidence; until then the wake
  dispatcher must not claim exactly-once.

## F-04 — Worktree merge procedure note

- **Status:** PROPOSED / UNVERIFIED.
- **Scope:** Document (do not yet implement) the controlled-integration
  sequence in [spec §10](plan/spec.md#10-git-verification-and-controlled-integration)
  and the safe-coding profile in [spec §9](plan/spec.md#9-agent-identity-capabilities-security-and-workspace):
  baseline capture, task-owned paths + base SHA, isolated worktree/branch,
  verifier read access, remediation loop, single-lock integration to a
  temp branch, post-integration tests, then merge with reported SHA.
  M1 explicitly excludes complex workspace merge.
- **Dependency:** M1-05 pass; probe-11 (deny rules) and probe-03/Q-03
  (worktree locations) outcomes — see [probe results](api-probe-results.md#12-row-verdict-table)
  and [Q-03/Q-09](plan/spec.md#18-open-questions-and-validation-blockers).
- **Acceptance sketch:** A dry-run note walks the §10 steps against a
  disposable fixture and records where the current worktree support
  stops; no canonical-branch mutation is claimed.
- **Next action:** Owners of the M4 workstream expand this note into a
  procedure once probe-11/Q-03 evidence exists.

## F-05 — Scale and Codex considerations (M7 scope, not M1)

- **Status:** PROPOSED / UNVERIFIED.
- **Scope:** Defer 8–12-worker scale, budget/cost routing, comparable
  cost/quality benchmarking, and the optional Codex harness adapter to M7
  per [spec §14](plan/spec.md#14-phased-development-plan-and-gates) and
  [spec §4.5](plan/spec.md#45-codex-adapter-future). No scale numbers,
  cost claims, or superiority statements are made here; the E2E baseline
  requires same-repo, same-requirement, compatible-tier measurement
  ([spec §13](plan/spec.md#end-to-end-baseline)).
- **Dependency:** M1–M6 gates, admission semaphore / quota behavior
  (probes 05, 10; Q-07), and independent Codex SDK validation.
  The daemon must stay replaceable behind `CodingHarness`; no shell-out
  to undocumented Codex commands.
- **Acceptance sketch:** Reproducible benchmark protocol run with time,
  tokens, spend, and verified success rate reported — comparison only
  with measurements, never by assertion.
- **Next action:** Keep Codex/scale work parked; revisit after M5/M6
  evidence.

## F-06 — S2/S3 follow-ups: traversal guard, contention test, grammar ruling, retry semantics

- **Status:** PROPOSED / UNVERIFIED (framed as S2/S3 only; no new
  severity verdicts are issued here).
- **Scope (four sub-items, each S2/S3 candidate):**
  1. **Traversal guard** — path-ownership validation including
     Windows drive-letter/UNC normalization, NTFS case-insensitive
     aliases, and symlink/junction handling per
     [spec §9](plan/spec.md#9-agent-identity-capabilities-security-and-workspace)
     and the unit-test list in
     [spec §13](plan/spec.md#unit-tests). No verdict on current
     implementation is made here.
  2. **Contention test** — board sequence uniqueness under concurrent
     appends (100-way per [spec §13](plan/spec.md#unit-tests)) and the
     `BEGIN IMMEDIATE` allocation rule ([spec §6](plan/spec.md#6-durable-sqlite-schema));
     confirm no `MAX(sequence)+1` race outside a transaction.
  3. **Grammar ruling** — mention-lexer determinism (exact names, groups,
     `@all`, escapes, code fences, unknown/killed members, ambiguous
     names) per [spec §5](plan/spec.md#5-public-protocol-and-typescript-contracts)
     and [spec §13](plan/spec.md#unit-tests); ambiguous mentions must
     reject deterministically.
  4. **Retry semantics** — quota-pause with no elapsed-time auto-retry
     (resume only on documented triggers) and bounded retry/backpressure
     behavior per [spec §8](plan/spec.md#8-scheduling-concurrency-and-wake-ups),
     [spec §7 guards](plan/spec.md#7-state-machines-and-transition-guards),
     and the failure-injection matrix in
     [spec §13](plan/spec.md#failure-injection-matrix).
- **Dependency:** M1-01 journal/store code (inspection only, no
  execution in this task); probes 08/10/11 fallbacks in the
  [compatibility record](api-compatibility.md#2-per-probe-verdicts-spec-46)
  where applicable.
- **Acceptance sketch:** One focused ticket per sub-item, each with a
  triggering input, expected rejection/serialization outcome, and the
  spec section it traces to; live evidence comes from later unit/fault
  runs, not from this note.
- **Next action:** Orchestrator converts each sub-item into a tracked
  S2/S3 ticket; this file stays a pointer until evidence lands.

## Gaps and non-claims

- No live probe log exists for any of probes 01–12
  ([probe results](api-probe-results.md#factual-gaps-missing-evidence));
  all follow-ups therefore stay PROPOSED / UNVERIFIED.
- No endpoint, flag, release version, scale figure, traversal-guard
  verdict, or severity ruling is introduced by this file.
- Test scopes above are cited by inspection of [spec §13](plan/spec.md#13-testing-plan)
  only; no test was executed in this task.
