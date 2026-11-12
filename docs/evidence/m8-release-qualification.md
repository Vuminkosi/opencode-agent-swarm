# M8 release qualification — residual hardening + release-readiness record (M8-CODE-COMMIT-01)

> **Document status: IMPLEMENTED (code-observed at `7d4d79b`) / COMMITTED
> (`7d4d79b42b6a775a31fbe9bfca458045714a2ef4`) / NOT VERIFIED (live inference,
> live server, live TUI mount, fresh test/typecheck runs) / TODO (release
> decision — master-owned).**
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
