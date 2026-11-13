# M8 release qualification — residual hardening + release-readiness record (M8-CODE-COMMIT-01 + M8-FIX-COMMIT-01)

> **Document status: IMPLEMENTED (code-observed at `7d4d79b` + fix commit
> `895316a`) / COMMITTED
> (`7d4d79b42b6a775a31fbe9bfca458045714a2ef4` + fix `895316a16e1137dfbe40223bcc9c97807d968cc3`, HEAD) / NOT VERIFIED (live inference,
> live server, live TUI mount, fresh test/typecheck runs) / TODO (release
> decision — master-owned).**
> §§1–9 below are the DOC-M8-COMMIT-01 record at `7d4d79b`, preserved
> unchanged as the amend base (their internal HEAD/stat/chain lines still
> describe that commit — see §10 for the fix-commit delta). **§10 is the
> fix-commit amendment at `895316a`** (code-observed; full-suite totals and
> Phase-4 re-review verdicts are **supplied M8-FULL/M8-FIX handoff evidence,
> not fresh runs of this DOC session** — this session executed only the
> link check in §10.8).
> Every behavior below is code-observed at the recorded HEAD and covered by
> committed **FakeHarness simulations with disposable in-memory/tmp doubles** —
> never live inference, never live server turns, never live spend, never the
> canonical checkout as a test subject. **Live inference, live server turns,
> live contention timing, live provider 402 shaping, live TUI mount, and live
> spend remain NOT VERIFIED** (no live server, no inference spend, no
> credentials). Test/typecheck PASS figures are **supplied M8-CODE handoff
> evidence cited here, not fresh runs of this DOC session** — this session
> executed only the link check (§7). Design intent is never described as
> shipped, released, or production-proven. Verification does not prove commit;
> commit does not prove release. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Source baseline HEAD:** `7d4d79b42b6a775a31fbe9bfca458045714a2ef4` —
  `feat(m8): residual hardening (M8-CODE-COMMIT-01)` [PROBE — `git rev-parse HEAD`, inspected]
- **Commit stat:** `7 files, 1074 insertions(+), 28 deletions(-)` (`git show --stat HEAD`, inspected — file list in §1). Includes a 48-line `bun.lock` resync. [PROBE]
- **Prior chain (oldest → newest):** `69f40a9` (M5) → `55541b0` (DOC-M5-01) → `817835a` (M6 plugin lane) → `ccf0db6` (M6 board lane) → `f7237bf` (DOC-M6-01) → `9111c4a` (M7) → `8ea372f` (DOC-M7-01) → `7d4d79b` (M8, HEAD). [PROBE — `git log --oneline`, inspected]
- **Git status at inspection:** clean apart from one untracked junk file `NUL` at the repo root, which is **not** part of the M8 commit, is never cited as evidence here, is never presented as committed, and is left untouched (same long-standing noise pattern recorded since DOC-M6-01). [PROBE]
- **M8 constraints honored:** no protocol change (no `packages/protocol` file in the commit); **no migration file** — `session_executions` remains service-owned via idempotent `CREATE TABLE IF NOT EXISTS` ensure (same precedent as M4-03 `integration_runs` and M5 `usage_ledger`/`lease_fencing_high_water`); no OpenCode default change; the Codex lane stays an explicitly unsupported fail-closed stub (the M8 suite asserts this by absence — it never imports the stub). [DESIGN — `git show --stat HEAD` file list]

Related records (linked, not duplicated): [spec](../plan/spec.md) §14 (M8 gate) + milestone row 823 ([DESIGN] contract source), [milestone-matrix](../milestone-matrix.md) M8+ row, [compatibility-report](../compatibility-report.md) (M8 addendum style §§11–12 precedent), [install](../install.md) (install procedure — not repeated here), [api-compatibility](../api-compatibility.md) (port/probe record — not repeated here), [m7-scale-codex](m7-scale-codex.md) (M7 baseline this slice builds on), [m6-parity-ux](m6-parity-ux.md) + [m5-robustness](m5-robustness.md) (board/client and recovery semantics reused by reference, never re-derived). M6 board/client semantics are reused by reference; no M6 behavior is restated here. [DESIGN]

Evidence-label key: **[G-DOC]** Antigravity documented behavior, **[OC2-DOC]** documented OpenCode 2 API, **[DESIGN]** approved contract / code-observed claim, **[PROBE]** needs (or has, when noted) executable confirmation.

Human-language note: this file describes what M8 residual hardening proves about release readiness, and what it honestly leaves open for the release decision-maker, in everyday words. Internal field, type, and file names appear only as evidence pointers in backticks, never as user-facing terminology. [DESIGN]

## 1. Commit file list (exact, from `git show --stat HEAD`) [PROBE]

### 1.1 `7d4d79b` — residual hardening + fault-injection suite (7 files, 1074 insertions, 28 deletions)

| File | Change (stat) | Role [DESIGN] |
|---|---|---|
| `bun.lock` | 48-line resync | Lockfile resync only — never touched by hand; `bun.lock` stays committed and is NOT modified by this doc task |
| `packages/runtime/src/services/rate-limiter.ts` | hardening delta (digit-guard tokens, `timeoutMs` deadline, null-status auth routing) | M8-01 classifier hardening: anchored digit-guarded 401/402/429/408/502/503/504 tokens, status-less auth → `auth-blocked` before transient fallback, per-attempt `timeoutMs` deadline as bounded transient (reject-not-cancel) |
| `packages/runtime/src/services/recovery.ts` | `REPLAY_SCAN_CAP` (documented value 2000) + filtered-fairness + NULL-swarm quarantine rows | M8-01 scan bound: every replay pass reads at most 2000 rows; per-swarm filtered replay never widens one pass; unknown-kind rows quarantine on filtered passes, redeliver on unfiltered passes |
| `packages/runtime/src/services/wake-dispatcher.ts` | digit-guard parity tokens (`DISPATCH_*_TOKEN`) + numeric/string agreement twin | M8-01-FIX-01 parity: dispatcher agrees with the limiter on every core shape (`429`/`402`/`401`/`403`/`408`/`502`/`503`/`504`, digit-run lookalikes, status-less auth) |
| `packages/runtime/src/services/__tests__/rate-limit.test.ts` | +176 lines | M8-01 classifier/deadline/parity rows (37 `test(` blocks observed in source, §3) |
| `packages/runtime/src/services/__tests__/recovery.test.ts` | +86 lines | M8-01 scan-cap/filtered-fairness/NULL-swarm rows (21 `test(` blocks observed in source, §3) |
| `tests/fault-injection/m8-release.test.ts` | 560 lines (new) | M8-01 Phase-1 residual suite: 10k-row replay, two-handle contention, non-vacuous secrets canaries, classification hardening, live-host win32 junction/case/8.3 confinement, inheritance re-verify, SKIP-free junction proof (14 `test(` blocks in 7 `describe` groups observed in source, §3) |

Total M8: **7 files, 1074 insertions, 28 deletions**. [PROBE]

Dependencies (hard): M8-CODE-COMMIT-01 (`7d4d79b`) content above + M8 reviews with **S2s closed and residuals documented** (supplied review disposition — no finding IDs are invented here beyond the S2-generic class; see §6). [PROBE]

## 2. Release gates — verdicts + decision INPUTS (the release decision itself is master-owned) [PROBE]

Each gate carries an explicit verdict. **This table is an input to the release
decision, not the decision.** Commit `7d4d79b` is not a release; no
shipped/production claim is made anywhere in this file.

| # | Gate (spec §14 M8 + exit criteria) | Verdict | Evidence / input to the decision-maker |
|---|---|---|---|
| G1 | Residual hardening implemented: digit-guard classification, timeout deadline, dispatcher parity, scan cap | **PASS (IMPLEMENTED, code-observed; test PASS supplied-not-fresh)** | §3 rows R1–R7; source-inspected diffs; focused PASS cited from M8-CODE handoff, not re-executed here |
| G2 | 10k-row outbox replay drains across scan-bounded passes, zero loss, zero dupes | **PASS (supplied simulation) / live deep-backlog timing NOT VERIFIED** | `m8-release.test.ts` 10k-replay group: 10050 rows, every pass `scanned <= REPLAY_SCAN_CAP`, `delivered + failed == checked`, zero redelivery (supplied PASS; hardware timing NOT VERIFIED) |
| G3 | Two-handle contention serializes with zero `SQLITE_BUSY`, zero lost rows | **PASS (supplied simulation) / live concurrent-load timing NOT VERIFIED** | `m8-release.test.ts` contention group: 120 interleaved rounds, `busyErrors == 0`, full redelivery on restart-style drain (supplied PASS) |
| G4 | Non-vacuous secrets canaries: live flow, absent everywhere persisted/rendered | **PASS (supplied simulation)** | `m8-release.test.ts` canary group (3 rows): positive-control in-memory carry proven, rejection text clean, block/ledger/outbox/board/ingest surfaces clean (supplied PASS) |
| G5 | Classification hardening: anchored codes, status-less auth single-attempt, timeouts bounded-transient | **PASS (supplied simulation)** | `m8-release.test.ts` classification group (3 rows) + `rate-limit.test.ts` digit/parity/timeout rows (supplied PASS) |
| G6 | Windows junction/case/8.3 confinement proved LIVE on the host, zero skips | **PASS (supplied, host-live at M8-CODE time) / fleet generality NOT VERIFIED** | `m8-release.test.ts` win32 group + trailing SKIP-free proof test (`skippedLegs == []`, `provedLegs == [junction, symlink]`); proof is host-local, not a Windows-fleet guarantee |
| G7 | Model/permission inheritance unchanged (report-only, no new logic) | **PASS (supplied simulation)** | `m8-release.test.ts` inheritance group: quota/auth classifiers + `no-retry` policy + limiter agreement (supplied PASS) |
| G8 | Codex adapter stays explicitly unsupported (stub only, 4 gating items open) | **NOT-VERIFIED-stub (by design, unchanged)** | M8 suite never imports the stub (asserted by absence in source); the four M7 gating questions (stable verbs, session identity, model mapping, snapshot semantic) remain open — see [m7-scale-codex](m7-scale-codex.md) §4 |
| G9 | Fresh Windows install passes smoke and E2E (spec §14 M8 required gate) | **BLOCKED — NOT VERIFIED** | No fresh-install smoke/E2E log exists in the repo; no live server, no installer run, no screenshots. This is the release-blocking gap. |
| G10 | Live inference / live server turns / provider 402 shaping / spend | **BLOCKED — NOT VERIFIED** | No live log in repo; F-04 (harness 402-shape) carried since M2, not closed (see §6) |
| G11 | Live TUI mount (plugin-config change this slice must not perform) | **BLOCKED — NOT VERIFIED (→ fallback)** | Terminal board (`bunx opencode-swarm board`) remains the contract-approved fallback per spec §4.4; native mount unproven |
| G12 | No-token-waste 10-minute idle window; crash safety; no unsafe integration (exit criteria) | **PASS (supplied simulation) / live 10-minute window NOT VERIFIED** | Carried M2/M5/M7 idle/replay/integration evidence by reference; the live 10-minute idle measurement has no log |
| G13 | Upgrade/rollback path documented, no migration risk | **PASS (documentation, this file §5)** | No migration file in M8 (service-owned ensure precedent); rollback = `git revert` / checkout prior commit `8ea372f` |

**Gate roll-up for the decision-maker:** hardening + simulation gates (G1–G8, G12-sim, G13) are **satisfied as implementation inputs**; live/release gates (G9, G10, G11, G12-live) are **NOT VERIFIED and block any release claim**. A release decision additionally requires the master-owned live-install smoke/E2E run, which this file scopes but does not perform. [PROBE]

## 3. Behaviors (all IMPLEMENTED code-observed; PASS supplied-not-fresh, FakeHarness/tmp) [PROBE]

Test-block counts below are **source-inspected structure** (`test(` occurrences
observed in the committed files); PASS verdicts are **supplied M8-CODE handoff
evidence, not fresh executions of this DOC session** (link check only, §7).
All rows run against FakeHarness transports and disposable tmp file DBs/Git
repos — zero inference, zero spend, zero canonical-checkout mutation.

| # | Behavior (plain words) | Where it is proven (code-observed, supplied PASS) |
|---|---|---|
| R1 | Lookalike numbers no longer fool the classifier: `14029` is not a rate-limit, `4021` is not quota exhaustion | `rate-limiter.ts`: `QUOTA/AUTH/RATE/TRANSIENT_STATUS_TOKEN` anchored on non-digit boundaries; `rate-limit.test.ts` digit-lookalike rows |
| R2 | Errors with no status but an auth smell (bad credentials, `401`/`403` wording) are blocked after exactly one try — never retried three times as a mystery failure | `rate-limiter.ts`: `classifyTransportError` routes real `.status` first; null/non-status falls to code+message auth checks before the transient fallback |
| R3 | A hung provider call gets a deadline instead of hanging forever; breaching it costs a bounded retry, never quota/auth confusion, never an uncancellable storm | `rate-limiter.ts`: `runAttempt` + `timeoutMs` policy (reject-not-cancel; slot held across backoff); timeout-shaped errors classify transient |
| R4 | The wake dispatcher agrees with the rate limiter on every core error shape | `wake-dispatcher.ts`: `DISPATCH_*_TOKEN` parity set + `isDispatchAuthError` export; parity rows assert limiter/dispatcher agreement |
| R5 | Restart replay reads a bounded window per pass no matter how deep the backlog is, and still eventually redelivers everything exactly once | `recovery.ts`: `REPLAY_SCAN_CAP = 2000`; `replayOutbox` reports `scanned <= cap`; `recovery.test.ts` scan-cap/filtered-fairness/NULL-swarm rows; `m8-release.test.ts` 10k group (10050 rows drain, zero redelivery) |
| R6 | Two processes sharing one database file never collide and lose nothing | `m8-release.test.ts` contention group: two `SwarmStore` + two ledger handles, WAL + busy-timeout, 120 interleaved rounds, zero `SQLITE_BUSY`, restart-style drain complete |
| R7 | Secret-shaped values can flow through error paths live yet never land in anything saved or shown | `m8-release.test.ts` canary group: `sk-canary-*`/`xoxb-canary-*` positive controls in-memory; throttle results, block records, rejection text, ledger telemetry, outbox rows, board output, ingest rows all clean |
| R8 | Windows folder tricks (junction escapes, lookalike letter-casing, short 8.3 spellings) stay locked inside their allowed area — proved on the real machine, with skipped checks treated as failures | `m8-release.test.ts` win32 group + SKIP-free proof: live `mklink /J` refusal, live symlink refusal, case/8.3 agreement; `skippedLegs` must be empty or the suite fails |

Rows R1–R5 touch `rate-limiter.ts` / `recovery.ts` / `wake-dispatcher.ts` deltas
plus `rate-limit.test.ts` (+176 lines) and `recovery.test.ts` (+86 lines);
rows R5–R8 are exercised end-to-end by `m8-release.test.ts` (560 lines, 7
`describe` groups, 14 `test(` blocks observed). [PROBE — source-inspected]

## 4. Version compatibility matrix (accurate vs `7d4d79b`; live items NOT VERIFIED) [PROBE]

| Component | Recorded version | Status |
|---|---|---|
| OpenCode CLI build | 2.2.7 UNCONFIRMED candidate | [PROBE] — NOT VERIFIED; no `opencode --version` log exists in this baseline (carried from [compatibility-report](../compatibility-report.md) §4) |
| Bun | 1.4.4 (UNCONFIRMED candidate) | [PROBE] — NOT VERIFIED; no `bun --version` log exists in this baseline |
| TypeScript | 5.9.2 | [DESIGN] selected (`package.json` devDependencies); confirm via install log — NOT VERIFIED here |
| `@opencode/plugin` | 2.2.7 (pinned in `packages/plugin/package.json`) | [DESIGN] pin recorded in plugin source comments from the M0-02 disposable-probe resolution; remains an UNCONFIRMED candidate — NOT VERIFIED by any live-server log in this baseline. [PROBE] Do not treat it as verified until probe-01 captures it. |
| `@opencode/sdk` | TBD (preferred: same minor as plugin) | [PROBE] — NOT VERIFIED; do not depend on it until probes confirm the session surface |
| Node | n/a (Bun runtime) | [DESIGN] |
| Git baseline | `7d4d79b` (M8 HEAD) ← `8ea372f` ← `9111c4a` ← … (chain in header) | [PROBE] — `git rev-parse HEAD` + `git log --oneline`, inspected |
| Generation rule | v2 `@opencode/*` only — never `@opencode-ai/*` (spec §1) | [OC2-DOC] No production code references the legacy generation. [DESIGN] |

M8 introduces no new toolchain assumption: the commit touches runtime services
+ tests + lockfile resync only. The `bun.lock` 48-line resync is a
dependency-manifest refresh, not a version migration — toolchain pins above
are unchanged from M7. [DESIGN]

## 5. Upgrade / rollback instructions (documentation; commands UNEXECUTED here) [DESIGN]

No migration file ships in M8: `session_executions` (and the M4/M5
service-owned tables) are ensured idempotently with `CREATE TABLE IF NOT
EXISTS` on the shared DB handle, safe on every open and safe on legacy DBs
that predate the tables (see `recovery.ts` `ensureSessionExecutionsSchema`).
There is therefore **no schema-upgrade step and no downgrade-migration step**
for M8. [DESIGN — code-observed]

- **Upgrade:** move the checkout to the M8 commit, reinstall dependencies per
  [install](../install.md), and re-run the typecheck/test commands named in §7
  (UNEXECUTED here — follow the install guide; do not invent flags or
  versions beyond it). No data migration is required: service-owned ensures
  run on open. [DESIGN]
- **Rollback:** M8 is a pure source-and-test delta with no durable-schema
  change, so rollback is a source-only operation — `git revert` the M8 commit
  (or check out the prior committed state `8ea372f`, DOC-M7-01) and reinstall
  per [install](../install.md). No `DOWN` migration exists or is needed;
  outbox/journal rows written while on M8 remain readable on the prior commit
  (no column/table contract changed). [DESIGN]
- **Destructive operations:** none are authorized by this file. Never reset a
  dirty working tree, never force-push, never delete a database or worktree
  outside the disposable-tmp test convention. Reading this runbook never
  authorizes executing it against production. [DESIGN]

## 6. Findings + remaining blockers [PROBE]

- **M8-CODE/M8 reviews:** COMMIT-ready with **S2s closed and residuals
  documented** (supplied review disposition — no finding IDs are invented here
  beyond the S2-generic class). Residuals carried below are the documented
  remainder, non-blocking for implementation closeout but visible to the
  release decision. [PROBE]
- **m8 S2 follow-ups = documented residuals** (supplied, non-blocking):
  accepted hardening follow-ups filed against the M8 delta; none re-opens a
  gate in §2. [PROBE]
- **F-04 (harness 402-shape): NOT VERIFIED (carried since M2, not closed).**
  M8 adds no inference path and no paid-service call; the M2 quota posture
  (`quota_paused`, never auto-retry) is carried unchanged. The exact
  402/quota error shape a live provider surfaces remains unproven. Resumption:
  capture a live 402 in a disposable probe run and reconcile `isQuotaError`
  before any paid-path autonomy claim. [PROBE]
- **F-01 (fencing high-water + CAS): ACCEPTED RISK with revisit condition**
  (carried from M5): re-examine against live-server contention evidence before
  any production claim. [PROBE]
- **Codex transport: honest stub, 4 gating items open** — stable verb set,
  session-identity mapping, model-ref mapping, completion/snapshot semantic
  (see [m7-scale-codex](m7-scale-codex.md) §4). No Codex transport change in
  M8 (asserted by absence: the M8 suite never imports the stub). [DESIGN]
- **Live TUI mount = NOT VERIFIED → fallback.** Native board mount needs a
  plugin-config change this slice must not perform; the terminal board stays
  the contract-approved fallback per spec §4.4. [PROBE]
- **Live inference = NOT VERIFIED.** No live turns, no spend, no credentials
  in this baseline. [PROBE]
- **Untracked `NUL` junk file at repo root** is uncommitted noise, never
  evidence, left untouched. It is not linked as committed and not presented as
  committed anywhere in this file. [PROBE]

## 7. Reproducible log (commands inspected at HEAD; NOT re-executed in this DOC session)

```powershell
git rev-parse HEAD
# 7d4d79b42b6a775a31fbe9bfca458045714a2ef4 (inspected)

git show --stat HEAD
# 7 files changed, 1074 insertions(+), 28 deletions(-) (inspected — file list in §1)

git log --oneline -8
# 7d4d79b (HEAD) / 8ea372f / 9111c4a / f7237bf / ccf0db6 / 817835a / 55541b0 / 69f40a9 (inspected)

# Supplied (cited, NOT re-executed here — no build/test/bench re-runs in DOC-M8-01A):
# tsc clean (supplied) + focused M8 suites PASS (rate-limit +176 / recovery +86 /
#   m8-release 560-line fault-injection rows, FakeHarness + disposable tmp) = supplied PASS
# carried: M7 10 + 5 + 9 rows, M5 66 focused, priors per milestone-matrix (supplied, not re-run)
# live inference / live server / live TUI mount / live spend: NOT VERIFIED (no logs, no credentials)
```

Repro commands that WOULD reproduce (labeled supplied/inspected, UNEXECUTED
here): `bun run typecheck` (repo root), `bun test
packages/runtime/src/services/__tests__/rate-limit.test.ts`, `bun test
packages/runtime/src/services/__tests__/recovery.test.ts`, `bun test
tests/fault-injection/m8-release.test.ts`. Typecheck/test figures above are
**committed/supplied evidence with honest scope**: inspected in source and
handoff, not freshly executed in this documentation session. To advance the
live gates, run the suites on the pinned toolchain, capture the logs, mount a
disposable live probe for the Codex verbs, and run the fresh-install smoke/E2E
required by spec §14 M8. [PROBE]

### Link validation (the only check executed in this DOC session) [PROBE]

- Relative links in this file (`plan/spec.md`, `milestone-matrix.md`,
  `compatibility-report.md`, `m7-scale-codex.md`, `m6-parity-ux.md`,
  `m5-robustness.md`, `../install.md`, `../api-compatibility.md`) validated by
  read-only path-existence inspection (`Test-Path` over `docs/`); all targets
  exist — exit 0.
- No unexecuted command example is presented as executed; §5/§7 commands are
  labeled UNEXECUTED/supplied.
- This file creates no duplicate of the install procedure, API record,
  compatibility matrices, or prior evidence — it links to them (§header).

## 8. Gaps and NOT VERIFIED list [PROBE]

1. Fresh-install smoke/E2E on Windows (spec §14 M8 required gate) is NOT VERIFIED — the release-blocking gap.
2. Live inference/spend, live server turns, live contention timing, provider 402 shaping, and bench hardware dependence are NOT VERIFIED.
3. Focused/carried/typecheck figures (§§2–3, §7) are supplied evidence cited from the M8-CODE handoff and source inspection, not fresh executions of this doc session (link check only).
4. Live TUI mount is NOT VERIFIED (terminal board is the contract fallback); live 10-minute idle window is NOT VERIFIED.
5. Exactly-once physical delivery is not claimed; ambiguous admissions quarantine for operator review by design (M2 carry).
6. Codex transport is honestly unbuilt — four gating questions open (§6); no stable-verb, session-identity, model-mapping, or snapshot claim is made.
7. Untracked `NUL` junk file at repo root is uncommitted noise, never evidence, left untouched.
8. No live-server, screenshot, deployment, endpoint, CLI-flag, release-number, or support-promise claims are made in this evidence.
9. The release decision itself is TODO and master-owned — this file is an input, not an approval.

## 9. Claim-status summary

| Claim | Status |
|---|---|
| Residual hardening: digit-guard, timeout deadline, dispatcher parity, scan cap (R1–R5) | IMPLEMENTED (code-observed at `7d4d79b`, supplied PASS) |
| 10k-row bounded replay, contention, canaries, classification, win32 confinement, inheritance (R5–R8) | IMPLEMENTED (code-observed at `7d4d79b`, supplied PASS-simulation) / live timing + fleet generality NOT VERIFIED |
| Focused suites (`rate-limit` +176 / `recovery` +86 / `m8-release` 560-line) + typecheck | SUPPLIED PASS / NOT VERIFIED (fresh run) — cited, see §7 |
| Commit `7d4d79b` (7 files, 1074+/28−, lockfile resync incl.) | COMMITTED (HEAD, §1) |
| Prior chain `… → 9111c4a → 8ea372f → 7d4d79b` | COMMITTED (inspected log) |
| M8 reviews COMMIT-ready; S2s closed, m8 S2 follow-ups = documented residuals | Cited supplied review disposition (see §6) |
| F-04 (harness 402-shape) | NOT VERIFIED (carried, not closed) |
| F-01 (fencing high-water + CAS) | ACCEPTED RISK with revisit condition (carried) |
| Codex transport | NOT-VERIFIED-stub, 4 gating items open (by design, unchanged) |
| Live turns / contention / provider shapes / spend / TUI mount / fresh-install E2E | NOT VERIFIED (no live log in repo) |
| Upgrade/rollback path (§5) | DOCUMENTED (no migration file; revert/checkout-prior-commit) |
| Release / shipped / production | NOT CLAIMED — commit is not a release; decision TODO (master-owned) |

## 10. Fix-commit evidence — M8-FIX-COMMIT-01 at `895316a` [PROBE]

> **Amendment status: IMPLEMENTED (code-observed at `895316a16e1137dfbe40223bcc9c97807d968cc3`, HEAD) / COMMITTED
> (`895316a`, verified `git rev-parse HEAD`) / full-suite totals VERIFIED-supplied (supplied M8-FULL/M8-FIX handoff evidence, not fresh runs
> of this DOC session) / live inference + provider 402-shape NOT VERIFIED / release decision UNDECIDED-PENDING-MASTER.**
> §§1–9 above are preserved unchanged as the `7d4d79b` amend base; nothing
> below rewrites them. Fix behavior is described as implemented and
> committed, never as released or shipped. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Fix HEAD:** `895316a16e1137dfbe40223bcc9c97807d968cc3` —
  `feat(m8): store dedupe swarm-scope, ingest contention, rate-limiter ledger with rpc/path-policy fixes (M8-FIX-COMMIT-01)` [PROBE — `git rev-parse HEAD`, inspected]
- **Commit stat:** `12 files, 1234 insertions(+), 65 deletions(-)` (`git show --stat HEAD`, inspected — file list in §10.1). [PROBE]
- **Prior chain (oldest → newest):** `… → 9111c4a` (M7) → `8ea372f` (DOC-M7-01) → `7d4d79b` (M8-CODE-COMMIT-01) → `2cae97b` (DOC-M8-COMMIT-01) → `895316a` (M8-FIX-COMMIT-01, HEAD). [PROBE — `git log --oneline`, inspected]
- **Git status at inspection:** clean apart from the same untracked junk file `NUL` at the repo root recorded in §6 — in no commit, never evidence, left untouched. [PROBE]

### 10.1 Fix file list (exact, from `git show --stat HEAD`) [PROBE]

| File | Change (stat) | Role [DESIGN] |
|---|---|---|
| `packages/runtime/src/db/store.ts` | fencing/quarantine/dedupe delta | S2 closures: fencing high-water monotonic guard, quarantine TTL + review queue, swarm-scoped dedupe + migration 004 wiring |
| `packages/runtime/src/db/migrations/004_inbox_dedupe_swarm_scope.sql` | 26 lines (new) | Additive-only migration: new `inbox_dedupe_scoped` table (`PRIMARY KEY (swarm_id, source, external_event_id)`); legacy `inbox_dedupe` frozen in place for audit, still honored conservatively as global duplicates; all objects `IF NOT EXISTS`, applied once via `schema_migrations` (version 4) |
| `packages/plugin/src/rpc.ts` | RPC hardening | S2 closures: `invalid_caller` rejection, explicit edit vs write separation |
| `packages/plugin/src/__tests__/tui-rpc.test.ts` | +141 lines | RPC re-verification rows (supplied PASS) |
| `packages/git-workspaces/src/path-policy.ts` | path guards | S2 closures: prefix, device, and NUL guards |
| `packages/git-workspaces/src/__tests__/path-policy.test.ts` | +123 lines | Path-policy rows (supplied PASS) |
| `packages/adapter-opencode/src/sessions.ts` | adapter delta | Session-surface fix hunk (see [compat §14](compatibility-report.md#14-m8-fix-compatibility-addendum-doc-m8-final-01)) |
| `packages/adapter-opencode/src/__tests__/bridge.test.ts` | +18 lines | Bridge rows (supplied PASS) |
| `packages/runtime/src/services/ingest.ts` | ingest delta | Ingest contention hardening |
| `packages/runtime/src/services/wake-dispatcher.ts` | dispatcher delta | Rate-limiter ledger wiring |
| `packages/runtime/src/services/__tests__/rate-limit.test.ts` | +201 lines | Ledger + parity rows (supplied PASS) |
| `tests/fault-injection/m8-store.test.ts` | 255 lines (new) | Store fault-injection rows: fencing, quarantine, scoped dedupe (supplied PASS) |

Total fix: **12 files, 1234 insertions, 65 deletions**. [PROBE]

### 10.2 S2 closures (supplied Phase-4 re-review disposition; COMMIT-ready lanes) [PROBE]

Supplied Phase-4 collection verdicts used here — **no finding IDs are
invented beyond the supplied S2-generic class**:

- **Fencing monotonic** (`store.ts`): high-water advance is monotonic; concurrent losers retry higher, never spin, never regress — F-01 ACCEPTED RISK condition from §6 is satisfied by mechanism (live-server contention timing still NOT VERIFIED; revisit condition carries for any production claim).
- **Quarantine TTL + review queue** (`store.ts`): ambiguous admissions quarantine with a bounded TTL and an operator review queue — exactly-once physical delivery still not claimed (M2 carry).
- **Scoped dedupe + migration 004** (`store.ts` + `004_inbox_dedupe_swarm_scope.sql`): cross-swarm `(source, id)` collisions no longer dedupe each other; legacy rows kept for audit and honored conservatively. Migration is additive and forward-safe (see §10.6).
- **RPC `invalid_caller` + explicit edit/write** (`rpc.ts`): unknown callers fail closed; edit and write paths are explicit and separated.
- **Path prefix / device / NUL guards** (`path-policy.ts`): lexical + ancestor-aware prefix checks, device-path refusal, NUL-byte refusal.
- **Ledger wiring** (`wake-dispatcher.ts` + `ingest.ts`): rate-limiter ledger is wired through dispatch and ingest contention paths.
- **Digit-guard parity incl. timeout-with-digits edge**: dispatcher and limiter classifiers agree on every core shape (`429`/`402`/`401`/`403`/`408`/`502`/`503`/`504`, digit-run lookalikes, status-less auth); the documented edge is a timeout whose message embeds digits — classified bounded-transient, never quota/auth confusion.
- **Re-review verdicts (supplied, not fresh):** store / RPC / compat lanes **COMMIT-ready**, S2s closed. This section records targeted re-verification already done at fix time — it is **not** a full re-review. [PROBE]

### 10.3 Accepted residuals [PROBE]

- **F-01 (scan cap): ACCEPTED RISK + revisit** (carried from §6): every replay pass reads at most 2000 rows; revisit against live-server contention evidence before any production claim.
- **F-04 (harness 402-shape): NOT VERIFIED (carried, not closed).** The fix adds no inference path and no paid-service call; the exact 402/quota error shape a live provider surfaces remains unproven. Resumption: capture a live 402 in a disposable probe run and reconcile `isQuotaError` before any paid-path autonomy claim.
- **Harness S3s: deferred** (supplied disposition) — filed follow-ups, non-blocking for fix closeout.
- **Codex transport: honest stub, 4 gating items open** (carried from §6; the fix suite never imports the stub).

### 10.4 Full-suite totals at `895316a` (supplied, not fresh) [PROBE]

Supplied M8-FULL/M8-FIX handoff evidence, cited here — **no build, test,
or typecheck was re-executed in this DOC session**:

| Check | Supplied result |
|---|---|
| Full suite | **514 passed / 0 failed / 14054 assertions / 36 files** |
| Typecheck | **tsc 9/9 clean** (supplied) |
| Frozen adapter | **0 imports** (supplied — frozen port has zero runtime deps) |
| Toolchain / env | Per handoff env table (supplied): OpenCode CLI build 2.2.7, Bun 1.4.4, TypeScript 5.9.2, `@opencode/plugin` 2.2.7, `protocolVersion`/`schemaVersion` 1 — recorded as the pinned matrix in §10.5; live `opencode --version` / `bun --version` capture logs remain NOT VERIFIED |
| Zero-inference proof wording | FakeHarness transports with disposable in-memory/tmp doubles only — no live inference, no live server turns, no live spend, no credentials; the canonical checkout was never a test subject |
| Live inference + 402-shape | **NOT VERIFIED** (no live log) |

### 10.5 Amended release checklist (per-gate verdicts + remaining blockers) [PROBE]

Each gate carries an explicit verdict. **This table is an input to the
release decision, not the decision.** Commit `895316a` is not a release;
no shipped/production claim is made anywhere in this file.

| # | Gate (spec §14 M8 + exit criteria) | Verdict after fix |
|---|---|---|
| G1 | Residual hardening implemented (M8 deltas, §2) | **PASS (IMPLEMENTED, code-observed; supplied PASS)** |
| G1-FIX | S2 closures: fencing monotonic, quarantine TTL+review queue, scoped dedupe + 004, RPC `invalid_caller` + explicit edit/write, path prefix/device/NUL guards, ledger wiring, digit-guard parity | **PASS (IMPLEMENTED at `895316a`, code-observed; supplied targeted re-verification PASS — store/rpc/compat lanes COMMIT-ready)** |
| G2 | 10k-row outbox replay drains across scan-bounded passes | **PASS (supplied simulation) / live deep-backlog timing NOT VERIFIED** |
| G3 | Two-handle contention serializes, zero `SQLITE_BUSY` | **PASS (supplied simulation) / live concurrent-load timing NOT VERIFIED** |
| G4 | Non-vacuous secrets canaries | **PASS (supplied simulation)** |
| G5 | Classification hardening incl. timeout-with-digits edge | **PASS (supplied simulation)** |
| G6 | Windows junction/case/8.3 confinement proved live at M8-CODE time | **PASS (supplied, host-live at M8-CODE time) / fleet generality NOT VERIFIED** |
| G7 | Model/permission inheritance unchanged | **PASS (supplied simulation)** |
| G8 | Codex adapter explicitly unsupported stub | **NOT-VERIFIED-stub (by design, unchanged)** |
| G9 | Fresh Windows install smoke + E2E (spec §14 M8 required gate) | **BLOCKED — NOT VERIFIED** (no fresh-install smoke/E2E log; no live server, no installer run, no screenshots) |
| G10 | Live inference / live server turns / provider 402 shaping / spend | **BLOCKED — NOT VERIFIED** (no live log; F-04 carried §10.3) |
| G11 | Live TUI mount | **BLOCKED — NOT VERIFIED (→ fallback)** — terminal board (`bunx opencode-swarm board`) stays the contract-approved fallback per spec §4.4 |
| G12 | No-token-waste idle window; crash safety; no unsafe integration | **PASS (supplied simulation) / live 10-minute window NOT VERIFIED** |
| G13 | Upgrade/rollback path documented, migration risk bounded | **PASS (documentation, §10.6)** — additive 004 is forward-safe; rollback = `git revert` / reset to `7d4d79b` + rerun targeted suites; no migrations to roll back beyond additive 004 |
| G14 | Full suite at fix HEAD (514/0/14054/36, tsc 9/9, frozen 0) | **PASS-supplied (not fresh) / live items NOT VERIFIED** |

**Gate roll-up for the decision-maker:** hardening + fix + simulation gates (G1, G1-FIX, G2–G8-sim, G12-sim, G13, G14-supplied) are **satisfied as implementation inputs**; live/release gates (G9, G10, G11, G12-live) are **NOT VERIFIED and block any release claim**. Remaining blockers: **live inference unauthorized = BLOCKED** (no live log, no credentials, no spend authorized); **F-04 402-shape NOT VERIFIED**; **harness S3s deferred**. A release decision additionally requires the master-owned live-install smoke/E2E run, which this file scopes but does not perform. [PROBE]

### 10.6 Version compatibility matrix — pinned at `895316a` [PROBE]

| Component | Pinned version | Status |
|---|---|---|
| OpenCode CLI build | 2.2.7 | [PROBE] — pinned candidate; no live `opencode --version` log in this baseline — NOT VERIFIED live |
| Bun | 1.4.4 | [PROBE] — pinned candidate; no live `bun --version` log in this baseline — NOT VERIFIED live |
| TypeScript | 5.9.2 | [DESIGN] selected (`package.json` devDependencies); confirm via install log — NOT VERIFIED here |
| `@opencode/plugin` | 2.2.7 | [DESIGN] pinned in `packages/plugin/package.json`; UNCONFIRMED candidate — NOT VERIFIED by any live-server log |
| `@opencode/sdk` | TBD (preferred: same minor as plugin) | [PROBE] — NOT VERIFIED; do not depend on it until probes confirm the session surface |
| Protocol / schema version | 1 | [DESIGN] (`protocolVersion`/`schemaVersion` 1 per handoff env table) |
| Node | n/a (Bun runtime) | [DESIGN] |
| Git baseline | `895316a` ← `2cae97b` ← `7d4d79b` ← `8ea372f` ← `9111c4a` ← … (chain in §10 header) | [PROBE] — `git rev-parse HEAD` + `git log --oneline`, inspected |
| Generation rule | v2 `@opencode/*` only — never `@opencode-ai/*` (spec §1) | [OC2-DOC] No production code references the legacy generation. [DESIGN] |

The fix introduces no new toolchain assumption: deltas are confined to runtime store/services, plugin RPC, git-workspace path policy, adapter sessions, their focused tests, the new `m8-store.test.ts` fault-injection suite, and the additive 004 migration. [DESIGN]

### 10.7 Upgrade / rollback instructions (documentation; commands UNEXECUTED here) [DESIGN]

No downgrade-migration step exists: migration 004 is **additive only** —
it creates the new `inbox_dedupe_scoped` table with `IF NOT EXISTS`,
freezes the legacy `inbox_dedupe` table in place (pre-004 rows carry no
swarm attribution and are kept for audit; ingest still honors them
conservatively), and applies once via `schema_migrations` (version 4).
There is therefore **no schema-downgrade step**. [DESIGN — code-observed
in `packages/runtime/src/db/migrations/004_inbox_dedupe_swarm_scope.sql`]

- **Upgrade:** move the checkout across the documented range `7d4d79b →
  895316a` (code range; DOC commits `2cae97b` carry the amend-base
  documentation), reinstall per [install](../install.md), and re-run the
  typecheck/test commands named in §7 (UNEXECUTED here — follow the
  install guide; do not invent flags or versions). No data migration is
  required beyond the additive 004 ensure, which runs on open. [DESIGN]
- **Rollback:** the fix is a source-and-additive-schema delta, so rollback
  is `git revert` the fix commit (or reset the checkout to `7d4d79b`) +
  rerun the targeted suites (`rate-limit`, `path-policy`, `tui-rpc`,
  `bridge`, `m8-store` fault-injection). No migrations roll back: 004
  creates only the new scoped table and never alters or drops legacy
  rows, so a pre-004 checkout keeps reading legacy `inbox_dedupe` rows
  unchanged (forward-safe). [DESIGN]
- **Destructive operations:** none are authorized by this file. Never
  reset a dirty working tree, never force-push, never delete a database
  or worktree outside the disposable-tmp test convention. Reading this
  runbook never authorizes executing it against production. [DESIGN]

**The release decision is master-owned.** This file — §§1–9 as the
`7d4d79b` record plus this §10 fix amendment — is an input to that
decision, never the decision itself. Do not treat any PASS above as a
release approval; see [release-decision](../release/release-decision.md)
(stub, `decision: UNDECIDED-PENDING-MASTER`). [DESIGN]

### 10.8 Reproducible log (commands inspected at HEAD; NOT re-executed in this DOC session)

```powershell
git rev-parse HEAD
# 895316a16e1137dfbe40223bcc9c97807d968cc3 (inspected)

git show --stat HEAD
# 12 files changed, 1234 insertions(+), 65 deletions(-) (inspected — file list in §10.1)

git log --oneline -5
# 895316a (HEAD) / 2cae97b / 7d4d79b / 8ea372f / 9111c4a (inspected)

# Supplied (cited, NOT re-executed here — no build/test/bench re-runs in DOC-M8-FINAL-01):
# full suite 514 passed / 0 failed / 14054 assertions / 36 files (supplied) +
#   tsc 9/9 clean (supplied) + frozen-adapter 0 imports (supplied) +
#   FakeHarness + disposable tmp, zero inference/spend/credentials
# live inference / live server / live spend / provider 402-shape: NOT VERIFIED (no live log, no credentials)
```

Repro commands that WOULD reproduce (labeled supplied/inspected,
UNEXECUTED here): `bun run typecheck` (repo root), `bun test
packages/runtime/src/services/__tests__/rate-limit.test.ts`, `bun test
packages/git-workspaces/src/__tests__/path-policy.test.ts`, `bun test
packages/plugin/src/__tests__/tui-rpc.test.ts`, `bun test
tests/fault-injection/m8-store.test.ts`, `bun test` (full suite). Counts
above are **supplied handoff evidence with honest scope**: cited from
the M8-FULL/M8-FIX handoffs, not freshly executed in this documentation
session. To advance the live gates, run the suites on the pinned
toolchain, capture the logs, mount a disposable live probe, and run the
fresh-install smoke/E2E required by spec §14 M8. [PROBE]

#### Link validation (the only check executed in this DOC session) [PROBE]

- Relative links new or touched by this amendment (`../install.md`,
  `../release/release-decision.md`, `compatibility-report.md#14-…`,
  existing `plan/spec.md`, `milestone-matrix.md`,
  `compatibility-report.md`, `m7-scale-codex.md`, `m6-parity-ux.md`,
  `m5-robustness.md`, `../install.md`, `../api-compatibility.md`)
  validated by read-only path-existence inspection (`Test-Path` over
  `docs/` + the new `docs/release/` files); all targets exist — exit 0.
- No unexecuted command example is presented as executed; §10.7/§10.8
  commands are labeled UNEXECUTED/supplied.
- This amendment creates no duplicate of the install procedure, API
  record, compatibility matrices, or prior evidence — it links to them
  (§10 header, §10.7).

### 10.9 Gaps and NOT VERIFIED list (additive to §8) [PROBE]

1. Full-suite/typecheck/link figures in §10.4 (§10.8) are supplied handoff evidence cited from M8-FULL/M8-FIX, not fresh executions of this doc session (link check only, §10.8).
2. Live inference/spend, live server turns, live contention timing, provider 402 shaping (F-04), bench hardware dependence, and the live 10-minute idle window are NOT VERIFIED (no live log, no credentials).
3. Fresh-install smoke/E2E on Windows (spec §14 M8 required gate) is NOT VERIFIED — the release-blocking gap.
4. Live TUI mount is NOT VERIFIED (terminal board is the contract fallback); live 10-minute idle window is NOT VERIFIED.
5. Exactly-once physical delivery is not claimed; ambiguous admissions quarantine for operator review by design (M2 carry, TTL-bounded per §10.2).
6. Codex transport is honestly unbuilt — four gating questions open (§10.3); no stable-verb, session-identity, model-mapping, or snapshot claim is made.
7. Untracked `NUL` junk file at repo root is uncommitted noise, never evidence, left untouched.
8. No live-server, screenshot, deployment, endpoint, CLI-flag, release-number, or support-promise claims are made in this amendment.
9. The release decision itself is TODO and master-owned — this file is an input, not an approval (`decision: UNDECIDED-PENDING-MASTER`).

### 10.10 Claim-status summary (fix amendment)

| Claim | Status |
|---|---|
| S2 closures: fencing monotonic, quarantine TTL+review queue, scoped dedupe + 004, RPC `invalid_caller` + explicit edit/write, path prefix/device/NUL guards, ledger wiring, digit-guard parity incl. timeout-with-digits edge | IMPLEMENTED (code-observed at `895316a`, supplied targeted re-verification PASS — store/rpc/compat lanes COMMIT-ready) |
| Full suite 514/0/14054/36, tsc 9/9, frozen-adapter 0 imports | VERIFIED-supplied (supplied handoff evidence, not a fresh run — labeled honestly, §10.4) |
| Commit `895316a` (12 files, 1234+/65−) | COMMITTED (HEAD, §10.1) |
| Prior chain `… → 7d4d79b → 2cae97b → 895316a` | COMMITTED (inspected log) |
| F-01 (scan cap) | ACCEPTED RISK with revisit condition (carried) |
| F-04 (harness 402-shape) | NOT VERIFIED (carried, not closed) |
| Harness S3s | Deferred filed follow-ups, non-blocking |
| Codex transport | NOT-VERIFIED-stub, 4 gating items open (by design, unchanged) |
| Live turns / contention / provider shapes / spend / TUI mount / fresh-install E2E | NOT VERIFIED (no live log in repo) |
| Upgrade/rollback path (§10.7) | DOCUMENTED (additive 004, forward-safe; revert/reset to `7d4d79b` + rerun targeted suites) |
| Toolchain pins (opencode 2.2.7, bun 1.4.4, TS 5.9.2, `@opencode/plugin` 2.2.7, protocolVersion/schemaVersion 1) | PINNED-candidate matrix (§10.6); live version captures NOT VERIFIED |
| Release / shipped / production | NOT CLAIMED — fix commit is not a release; decision UNDECIDED-PENDING-MASTER (master-owned) |

## 11. M8-S3 follow-up closure at 49035b3 [PROBE]
> **Document status for this section only: IMPLEMENTED (code-observed at 49035b3) / COMMITTED (49035b3, verified git rev-parse HEAD).**
> POST-01 PASS-supplied (not a fresh run of this DOC session) / live inference NOT VERIFIED / release UNDECIDED-PENDING-MASTER.**
> Sections 1-10 above are unchanged; nothing below rewrites them. [DESIGN]
- **Scope (M8-S3-01):** gh_sk deny in SECRET_PREFIX_PATTERN plus UNC/device-namespace limits doc block (behavior unchanged, fail-closed) plus 5 S3 negative rows (2 fixed by this commit, 3 already-closed rows re-verified). [PROBE]
- **Review (REVIEW-01):** COMMIT_READY, 0 S0/S1 (supplied review disposition, cited, not a fresh review here). [PROBE]
- **Commit (COMMIT-01):** 49035b3, 4 files, 86 insertions, 3 deletions (git show --stat 49035b3, inspected). [PROBE]
- **Post-commit (POST-01):** PASS-supplied: tsc both exit 0; 50 plus 60 plus 13 equals 123 pass, 0 fail (supplied handoff evidence, not re-executed here). [PROBE]
- **Carry (unchanged):** F-04 402-shape NOT VERIFIED; live inference and live server NOT VERIFIED; release decision master-owned UNDECIDED-PENDING-MASTER. Commit is not a release. [PROBE]
