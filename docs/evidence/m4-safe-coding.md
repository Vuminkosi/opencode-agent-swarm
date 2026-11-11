# M4 safe-coding evidence — worktrees, verification runner and integration gate (M4-01/M4-02/M4-03)

> **Document status: IMPLEMENTED (FakeHarness + tmp-Git simulations) / COMMITTED.**
> All behavior below is code-observed at the recorded HEAD and covered by
> committed **FakeHarness + disposable tmp-Git simulations** — deterministic
> fakes and `git init` tmp repos, never live inference, never the canonical
> checkout as a test subject. **Live-server turns and live inference remain
> NOT VERIFIED** (no live server, no inference spend, no credentials). Design
> intent is never described as shipped, released, or production-proven. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Baseline HEAD:** `7330e0e2516561b4fb974602a3e3665d2433a3c2` —
  `feat(m4): add git-workspaces, verification runner and integration gate (M4-01/M4-02/M4-03)` [PROBE — `git rev-parse HEAD`, inspected read-only in the DOC-M4-01 session]
- **Commit scope:** 12 files, 4911 insertions, zero deletions
  (`git show --stat HEAD`). [PROBE — inspected, not re-executed beyond the stat read]
- **Prior chain (oldest → newest):** `e7a0b8f` (M3-01) → `c77848b` (DOC-M3-01 matrix) → `aece2e0` (live-probe-02 doc) → `eb874e8` (target-capabilities checklist) → `4b4b616` (MODEL-INHERIT-01) → `7330e0e` (M4-01/02/03, HEAD). [PROBE — `git log --oneline`, inspected]
- **Git status at inspection:** one dirty tracked modification (`.gitignore`) preserved untouched; no other working-tree changes observed before this doc was authored. [PROBE]
- **M4 constraints honored:** M0/M1/M2/M3 source behavior preserved (no M0–M3 file touched by the commit — 6 new source files + 3 new test files + 3 new package/tsconfig scaffolds only); **no protocol change** (no `packages/protocol` file in the commit); **no 003 migration file** — `integration_runs` is service-owned and ensured idempotently by `ensureIntegrationSchema()` on the shared DB handle (same durability, `task_id PRIMARY KEY` dedupe). [DESIGN — `git show --stat HEAD` file list]

Related records: [spec](../plan/spec.md) §§5, 6, 8, 9, 10, 14 ([DESIGN] contract source), [m2-wake-engine](m2-wake-engine.md) (quota/idempotency this slice reuses), [m3-coordination](m3-coordination.md) (verifier/defect-loop convention), [compatibility-report](../compatibility-report.md) (M4 addendum), [milestone-matrix](../milestone-matrix.md).

Evidence-label key: **[G-DOC]** Antigravity docs, **[OC2-DOC]** OpenCode 2 docs, **[DESIGN]** approved contract / code-observed claim, **[PROBE]** needs (or has, when noted) executable confirmation.

## 1. Commit file list (exact, from `git show --stat HEAD`) [PROBE]

| File | Insertions (stat) | Role [DESIGN] |
|---|---|---|
| `packages/git-workspaces/package.json` | 23 | M4-01 package scaffold |
| `packages/git-workspaces/src/__tests__/path-policy.test.ts` | 351 | M4-01 path-policy tests (44 tests) |
| `packages/git-workspaces/src/__tests__/worktree-manager.test.ts` | 626 | M4-01 worktree-manager tests (30 tests) |
| `packages/git-workspaces/src/path-policy.ts` | 508 | M4-01 Windows-safe normalization + confinement + grants |
| `packages/git-workspaces/src/worktree-manager.ts` | 895 | M4-01 worktree lifecycle + `IntegrationLock` |
| `packages/git-workspaces/tsconfig.json` | 16 | M4-01 typecheck scaffold |
| `packages/runtime/src/services/__tests__/integration.test.ts` | 540 | M4-03 integration-gate tests (13 tests) |
| `packages/runtime/src/services/integration.ts` | 848 | M4-03 serialized CAS integration service |
| `packages/verification/package.json` | 24 | M4-02 package scaffold |
| `packages/verification/src/__tests__/test-runner.test.ts` | 508 | M4-02 runner tests (23 tests) |
| `packages/verification/src/test-runner.ts` | 563 | M4-02 `runVerification` + `isVerificationPassing` |
| `packages/verification/tsconfig.json` | 9 | M4-02 typecheck scaffold |

Total: **12 files, 4911 insertions, zero deletions.** [PROBE]

## 2. Component map (all paths inspected at HEAD, read-only) [DESIGN]

| Component | File | Role |
|---|---|---|
| Path policy | `packages/git-workspaces/src/path-policy.ts` | Pure functions: Win32/UNC normalization, `resolveWithinRoot`, grant overlap (`grantsOverlap` + cross-namespace `SEC-F-01`), `validateWorktreeWrite` (canonical-deny → worktree-gate → forbidden-wins → default-deny owned). Best-effort realpath ancestor resolution; TOCTOU-after-validation is a documented known limit, re-checked at use time. |
| Worktree manager | `packages/git-workspaces/src/worktree-manager.ts` | Admission (`createWorktree`: allowlisted taskId/branch/commit, root-not-canonical, ancestor-aware physical confinement, ownedPaths exclusivity, branch freshness, post-add verification), `refresh` (existence + branch + clean/dirty baseline, canonical-record fail-closed), `remove` (refuses dirty/unintegrated unless `preserveFailed`, requires `baseCommit`, never touches unlisted paths), `recover` (never deletes; bumps fencing generation), `validateWrite` (manager surface over the pure policy). Git via `Bun.spawn` argv-only, never a shell. |
| Integration lock | `worktree-manager.ts` (`IntegrationLock` + `LEASES_DDL`) | Stale-lease lock on the shared `leases` contract (`canonical-lock`, monotonic `fencing_token++`, ISO `expires_at`, expiry-gated recovery). Mirrors runtime migration 001 DDL; point at the same SQLite file to share with the daemon. |
| Verification runner | `packages/verification/src/test-runner.ts` | `runVerification` spawns the task acceptance command with `cwd = worktreePath` (tmp worktree only), captures exit + redacted stdout/stderr artifacts + timing + commitSha + executor into a `RecordEvidenceInput` DTO; `isVerificationPassing` (clean exit, no timeout) is the caller gate. Tmp repos only, symlink/junction denied, canonical denied via realpath, evidence under `os.tmpdir()`, secret redaction, timeout + `taskkill /T` / detached-group `killTree`, byte-counted streaming caps. Caller persists via `store.recordVerificationEvidence` and drives the M3 verifier gate. |
| Integration gate | `packages/runtime/src/services/integration.ts` | Serialized policy-controlled canonical integration (spec §10 steps 7–10): bounded canonical-lock admission → worktree refresh → base-descendant check → pre-verification (fail ⇒ `blocked-verification`, preserved) → disposable `integrate/<taskId>` temp branch + tmp worktree `--no-ff` merge (conflict ⇒ `rejected-conflict`, abort, retained) → post-integration tests (fail ⇒ `blocked-post-integration`, canonical unchanged) → atomic `update-ref` compare-and-swap advance → durable `integration_runs` row. M4-01/M4-02 loaded at runtime via dynamic `import()` (import-only reuse; orchestrator-owned manifests/tsconfigs forbid static cross-package wiring). Never merges on failure; never deletes the task worktree. |

## 3. Design notes carried from M2/M3 (unchanged, not re-proven here) [DESIGN]

- **Quota 402 no-retry (M2 carry):** the M2 `isQuotaError` → `quota_paused`, never-auto-retry-paid-path posture is unchanged by M4; M4 adds no inference path and no paid-service call. Provider-side 402 shaping (F-04) stays NOT VERIFIED — carried, not closed.
- **At-least-once (honest):** exactly-once logical intent (delivery keys, `task_id PRIMARY KEY` run rows, fencing tokens) over at-least-once transport; ambiguous admitted-but-unacked states quarantine for operator review, never blind-replay. `reconcile` quarantines live-foreign-lease admissions (`lease-held-ambiguous`) and only re-arms stale leases with a fencing bump.
- **Q-03 decision (git CLI vs worktree SDK):** transport is git CLI via `Bun.spawn` argv-only because the OpenCode worktree SDK `projectID` is unresolved — the undocumented plugin worktree API is NOT used. See the compatibility-report M4 addendum.

## 4. Per-acceptance mapping (committed FakeHarness/tmp-Git simulations) [PROBE]

Counts below are **committed/supplied evidence** (implementation-handoff figures inspected in source, not re-executed in this DOC session): focused `74 + 23 + 13`, full-suite `246` observed, `tsc × 3` clean, `m105` 4 environment FAILs external. This doc session executed **only the link check** (§8); every test/typecheck figure is cited, not claimed as a fresh run.

| # | Acceptance | Test evidence (file: test) | Gate |
|---|---|---|---|
| 1 | 8 worktrees | `worktree-manager.test.ts`: `8 independently assigned worktrees on one repo`; `integration.test.ts`: `all integrate without contamination` (8 parallel integrates, 8 distinct SHAs, init + 8 commits + 8 merges = 17, 8 merge commits) | PASS (supplied) |
| 2 | No contamination | `worktree-manager.test.ts`: `8 simultaneous writes do not contaminate each other or canonical`; `integration.test.ts`: `disjoint files land exactly (no cross-task contamination)` | PASS (supplied) |
| 3 | Conflicting ownership rejected | `worktree-manager.test.ts`: `ownedPaths overlap rejected at admission`; `path-policy.test.ts`: overlap/conflict + cross-namespace `SEC-F-01` blocks; `integration.test.ts`: `merge conflict rejected; canonical unchanged; worktree preserved` + bounded `LEASE_HELD` with no run row | PASS (supplied) |
| 4 | Crash/restart safe | `worktree-manager.test.ts`: `daemon-restart equivalent: fresh manager instance reconciles`; `integration.test.ts`: `crash/restart on a file DB: new instance dedupes, no duplicate merge` + `reconcile recovers a stale lease … and takes no action` | PASS (supplied) |
| 5 | Stale lease recovered | `worktree-manager.test.ts`: `expiry allows recovery with a bumped fencing token (never reused)`; `integration.test.ts`: `stale lease recovers with fencing increment` (`recoveredFrom: crashed-worker`, token > 5) | PASS (supplied) |
| 6 | Duplicate deduped | `integration.test.ts`: `duplicate completion deduped; no duplicate merge` (`deduped`, same SHA, count unchanged) | PASS (supplied) |
| 7 | Failed build/review blocks + canonical unchanged | `test-runner.test.ts`: `failing command records non-zero exit and blocks the caller gate`; `integration.test.ts`: `failed verification blocks … retry allowed`, `failed post-integration tests abort the temp merge`, `dirty worktree blocked` — all assert target HEAD unchanged + worktree preserved | PASS (supplied) |
| 8 | Windows paths | `path-policy.test.ts`: drive casefold, separators, UNC, prefix-trap, 8.3/short-name awareness; `worktree-manager.test.ts`: S2 F-03 case-preserving FS ops; `integration.test.ts` `windows paths`: `worktree root containing spaces integrates cleanly (argv-only, no shell)` | PASS (supplied) |
| 9 | 136–149 no regression (count evolution note) | Supplied figures span 136–149 across M4 implementation runs as suites landed (runtime growth from the M3-era 124 baseline as the 13 integration tests plus worktree/runner suites came online); **full 246 observed at closeout**. NOT re-executed here — recorded as supplied, with the evolution noted honestly rather than flattened to a single number. | PASS (supplied) / NOT VERIFIED (fresh run) |
| 10 | m105 env FAIL external | `m105`: 4 environment FAILs, external to the product (no live server/inference in this repo). Recorded as **environment-external, not a product FAIL**; live inference stays NOT VERIFIED. | NOT VERIFIED (live/env) — not a product FAIL |

Required-test tally: **74 git-workspaces** (30 worktree-manager + 44 path-policy) **+ 23 verification runner + 13 integration gate = 110 focused tests, all PASS (supplied)**; full-repo **246 PASS observed (supplied)**; `tsc` clean on all three package configs (supplied). [PROBE — cited, not re-executed]

## 5. Out of scope for this slice (TODO, not claimed) [DESIGN]

Git worktree deletion of unknown paths (never done — fail-closed), live OpenCode session binding (Q-03 SDK path still unresolved), TUI board (M6), scale/cost/Codex (M7), production deployment hardening, accessibility/security attestations. S2 follow-ups S2-1…S2-3 (integration) plus the S3 lists are **filed follow-ups, not blockers for docs closeout**.

## 6. Live gate — separately labeled, NOT VERIFIED in this repo [PROBE]

- **Live turns / overlap / provider 402-shape / spend: NOT VERIFIED.** No live OpenCode server session, no real `submitTurn` admission, no model inference was executed for M4. All dispatch/verify/integrate paths above are FakeHarness + tmp-Git simulations (**IMPLEMENTED**, not live-VERIFIED).
- **m105:** 4 environment FAILs are external (no credentials, no spend, no secret-bearing log stored here). The in-repo quota path stays IMPLEMENTED + FakeHarness-tested; provider-side shaping remains NOT VERIFIED.
- No screenshots, deployment behavior, endpoint, CLI-flag, release-number, or support-promise claims are made. [DESIGN]

## 7. Reproducible log (commands inspected at HEAD; NOT re-executed in this DOC session)

```powershell
git rev-parse HEAD
# 7330e0e2516561b4fb974602a3e3665d2433a3c2 (inspected)

git show --stat HEAD
# 12 files changed, 4911 insertions(+) (inspected — file list in §1)

git log --oneline -8
# 7330e0e (HEAD) / 4b4b616 / eb874e8 / aece2e0 / c77848b / e7a0b8f / … (inspected)

# Supplied (cited, NOT re-executed here — no build/test re-runs in DOC-M4-01):
# tsc clean x3 (git-workspaces, verification, runtime-adjacent configs) → exit 0
# focused: 74 (git-workspaces) + 23 (verification) + 13 (integration) PASS
# full: 246 PASS observed
# m105: 4 FAIL — environment-external, not a product FAIL
```

Typecheck/test figures above are **committed/supplied evidence with honest scope**: inspected in source and handoff, not freshly executed in this documentation session. To advance the live gate, re-run the focused suites plus `bun test` in a disposable dir against a live server. [PROBE]

## 8. Link validation (the only check executed in this DOC session) [PROBE]

- Relative links in this file (`../plan/spec.md`, `m2-wake-engine.md`, `m3-coordination.md`, `../compatibility-report.md`, `../milestone-matrix.md`) validated by read-only inspection (`ls`/`read` of `docs/` and `docs/evidence/`); all targets exist.
- No unexecuted command examples are presented as executed; §7 commands are labeled inspected/supplied.

## 9. Claim-status summary

| Claim | Status |
|---|---|
| Worktree manager + path policy + runner + integration-gate design (§§2–3) | IMPLEMENTED (code-observed at `7330e0e`) |
| 74 + 23 + 13 focused + 246 full PASS, tsc × 3 clean (FakeHarness/tmp-Git) | SUPPLIED PASS / NOT VERIFIED (fresh run) — cited, see §7 |
| m105 4 FAIL | NOT VERIFIED (environment-external, not a product FAIL) |
| Commit `7330e0e` (12 files, 4911 insertions) | COMMITTED (HEAD, §1) |
| S2-1…S2-3 / S3 follow-ups | TODO (filed, non-blocking for docs) |
| Live turns / provider 402-shape / spend | NOT VERIFIED (no live log in repo) |
| M5+ work | TODO (see [milestone-matrix](../milestone-matrix.md)) |
| Release / shipped / production | NOT CLAIMED — commit is not a release |
