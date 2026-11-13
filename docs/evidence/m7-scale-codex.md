# M7 scale + Codex evidence — validation suite, bench, and fail-closed probe (M7-CODE-COMMIT-01)

> **Document status: APPROVED CONTRACT + IMPLEMENTED (FakeHarness + tmp-Git/tmp-SQLite/disposable-tmp simulations, supplied) / COMMITTED at `9111c4a`.**
> Every behavior below is code-observed at the recorded HEAD and covered by
> committed **FakeHarness simulations with disposable in-memory/tmp doubles** —
> never live inference, never live server turns, never live spend, never the
> canonical checkout as a test subject. **Live inference, live server turns,
> live contention timing, and live provider spend remain NOT VERIFIED** (no
> live server, no inference spend, no credentials). Design intent is never
> described as shipped, released, or production-proven. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Source baseline HEAD:** `9111c4a465de9469f2f8011124eac1dc0c301c33` —
  `feat(m7): scale validation suite + bench and Codex fail-closed probe (M7-CODE-COMMIT-01)` [PROBE — `git rev-parse HEAD`, inspected]
- **Commit scope:** `9111c4a` (M7-CODE-COMMIT-01); **8 files, 1859 insertions, zero deletions** (`git show --stat HEAD`). [PROBE — inspected, file list in §1]
- **Prior chain (oldest → newest):** `69f40a9` (M5) → `55541b0` (DOC-M5-01) → `817835a` (M6 plugin lane) → `ccf0db6` (M6 board lane) → `f7237bf` (DOC-M6-01) → `9111c4a` (M7, HEAD). [PROBE — `git log --oneline`, inspected]
- **Git status at inspection:** clean apart from one untracked junk file `NUL` at the repo root, which is **not** part of the M7 commit, is never cited as evidence here, and is left untouched (same long-standing noise pattern recorded since DOC-M6-01). [PROBE]
- **M7 constraints honored:** M0–M6 source behavior preserved — the commit touches no runtime, protocol, store, plugin, board, worktree, or verification sources; **no migration file, no protocol change, no OpenCode default change**. The Codex lane is a new private fail-closed package; the scale lane is tests + a disposable bench script. [DESIGN — `git show --stat HEAD` file list]

Related records: [spec](../plan/spec.md) §14 (M7 gate), §§12/13 (observability/testing), §8 (crash window), §4.5 (Codex future) ([DESIGN] contract source), [m6-parity-ux](m6-parity-ux.md) (M6 baseline this slice builds on), [compatibility-report](../compatibility-report.md) (M7 addendum §12), [milestone-matrix](../milestone-matrix.md).

Evidence-label key: **[DESIGN]** approved contract / code-observed claim, **[PROBE]** needs (or has, when noted) executable confirmation.

Human-language note: this file describes what scale validation proves about running bigger teams, and what the Codex probe resolved, in everyday words. Internal field, type, and file names appear only as evidence pointers in backticks, never as user-facing terminology. [DESIGN]

## 1. Commit file list (exact, from `git show --stat HEAD`) [PROBE]

### 1.1 `9111c4a` — scale validation + bench + Codex probe (8 files, 1859 insertions, 0 deletions)

| File | Change (stat) | Role [DESIGN] |
|---|---|---|
| `packages/runtime/src/services/__tests__/scale.test.ts` | 575 lines (new) | M7-01 scale suite: 8/12-worker unique ownership, duplicate `@all` collapse, quota freeze + restart + read-only zero-inference, secrets scan, measured replay + contention (10 tests, supplied PASS) |
| `tests/fault-injection/m7-scale.test.ts` | 368 lines (new) | M7-01 fault-injection scale suite: conflicting-integration rejection, concurrent-integrate winner/dedupe, 4-way disjoint integrates, crash/restart dedupe + reconcile (5 tests, supplied PASS) |
| `scripts/m7-bench.ts` | 602 lines (new) | M7-01 bench runner: scheduler throughput, wake latency, 1000-post replay, SQLite contention, RSS delta, gate checks (dup/quota/restart/read-only/secrets), 4-way integration safety; report JSON to a disposable tmp dir only, never canonical |
| `packages/adapter-codex/src/codex-harness.ts` | 129 lines (new) | M7-02 fail-closed stub: satisfies the `CodingHarness` type against a `backend: "codex"` candidate while every method throws `CodexNotImplementedError`; zero fake turns, zero network, zero child processes |
| `packages/adapter-codex/src/__tests__/codex-harness.test.ts` | 104 lines (new) | M7-02 contract tests: 9 fail-closed rows, zero-fake-turn check, no-OpenCode-default-regression check (supplied PASS) |
| `packages/adapter-codex/README.md` | 57 lines (new) | M7-02 probe log: resolve-only CLI/SDK/version findings, missing-gate list, not-verified verdict |
| `packages/adapter-codex/package.json` | 16 lines (new) | Private package manifest (`@opencode-swarm/adapter-codex` 0.0.1, `private: true`, zero runtime dependencies, `typecheck` script) |
| `packages/adapter-codex/tsconfig.json` | 8 lines (new) | Package typecheck config |

Total M7: **8 files, 1859 insertions, 0 deletions**. [PROBE]

## 2. Scale validation behaviors (all PASS-supplied, FakeHarness/tmp) [PROBE]

| # | Behavior (plain words) | Where it is proven (code-observed, supplied PASS) |
|---|---|---|
| 1 | 8-worker and 12-worker runs: every worker gets its own task, its own conversation, its own file area, and its own brief | `scale.test.ts`: `M7 scale: N-worker runs with unique ownership` — parameterized `[8, 12]` loop asserting unique sessions, disjoint owned paths, one lease per worker, per-session payload round-trip |
| 2 | 12-worker memory cost is small and finite | `scale.test.ts`: `12-worker RSS delta is measured and finite` |
| 3 | A message to everyone (`@all`) wakes each person exactly once, even if the message is recorded twice | `scale.test.ts`: `M7 duplicate @all: one logical wake per recipient` — idempotency replay + mention-batch redrive collapse on the delivery key |
| 4 | A worker out of quota stays frozen: no follow-up turns after a simulated +60s wait | `scale.test.ts`: `M7 quota freeze + restart + read-only zero-inference` — quota member paused, zero follow-up submits after +60s virtual advance |
| 5 | A restart in the middle of a run loses nothing and duplicates no turns | Same describe: restart mid-run preserves pending wakes/tasks, sessions re-identified, no duplicate turns (file DB reopen) |
| 6 | Just looking at the board costs nothing: read-only sweeps send zero turns | Same describe: read-only board/roster/usage sweeps perform zero submits |
| 7 | No secrets leak into durable records, outbox payloads, or turn texts | `scale.test.ts`: `M7 secrets scan: zero pattern hits in durable rows/outbox/turns` |
| 8 | 1000-message history replays back in exact order with no gaps | `scale.test.ts`: `M7 measured: replay + contention` — 1000-post resync gapless, timed |
| 9 | Two writers hammering one database file serialize cleanly with zero lock errors | Same describe: dual-handle interleaved writers, zero `SQLITE_BUSY`, 200 posts + 100 wakes |
| 10 | Claiming the same file area twice is rejected; the shared history is untouched | `m7-scale.test.ts`: `M7 conflicting integrations cannot corrupt canonical` — same-owned-path second admission rejected (`OWNERSHIP_CONFLICT`), canonical ref unchanged |
| 11 | Two conflicting merges: the first wins, the second is rejected, the loser keeps its work | Same describe: merge conflict — second integrate rejected, canonical keeps the winner, loser worktree preserved |
| 12 | Two integrates racing on one task: at most one advances the shared history, then the retry dedupes | `m7-scale.test.ts`: `M7 integration safety: concurrent integrates, one winner per task` — duplicate concurrent integrates dedupe to a single merge |
| 13 | Four independent merges in parallel all land with no cross-contamination | Same describe: 4-way parallel disjoint integrates serialize, all land |
| 14 | After a crash and restart, re-merging dedupes and reconciliation confirms the stored outcome | `m7-scale.test.ts`: `M7 restart: integration outcomes preserved, no duplicate merges` — file-DB crash/restart, re-integrate dedupes, reconcile confirms, target stable |

Rows 1–9 are in-memory/tmp-SQLite FakeHarness simulations; rows 10–14 run against disposable tmp Git repos (never the canonical checkout) with local `git rev-parse HEAD` / `exit 1` verify probes only. No live server, no inference, no spend. [PROBE]

## 3. Measurements (supplied bench figures, FakeHarness/tmp — NOT fresh runs here) [PROBE]

Figures below are **supplied M7-CODE handoff evidence** (bench run at the M7-CODE session against `9111c4a` content, disposable tmp outputs), cited here — not re-executed in this DOC session. The bench code paths that produce each figure were inspected read-only (§1 roles + `scripts/m7-bench.ts` result keys). Hardware dependence is NOT VERIFIED: absolute timings are machine-local, only the gate outcomes travel.

| Metric | Supplied figure | Gate | Meaning in plain words |
|---|---|---|---|
| Scheduler throughput (12 workers × 10 tasks, timed `leaseNext` drain) | ~3441–3684 tasks/s | `schedulerUniqueOwnership` (120/120 leased) | Handing out 120 jobs is sub-second; every worker owns exactly its own jobs |
| Wake latency (20× post → dispatch decision) | p50 ~0.045ms, p95 ~0.077ms | `wakeLatencyMeasured` | Waking one worker is far below a millisecond of daemon work (no inference included — FakeHarness admission only) |
| Event replay (1000 posts) | append ~21–23ms, resync ~1ms, gapless | `eventReplayGapless` | A thousand-message history replays in about a millisecond with no gaps |
| SQLite contention (dual handles, 200 interleaved writes) | 0 busy errors, gapless | `sqliteSerializedNoBusy` | Two writers sharing one file never collide |
| Memory (12-worker setup + dispatch RSS delta) | +0.1–0.2MB | `rssDispatchComplete` (12/12 dispatched) | A 12-person team costs a fraction of a megabyte of daemon memory |
| 4-way parallel integrate (disposable tmp repo) | ~5.2–5.7s, all integrated | `integrationSafe` (+ dup `deduped` on winner SHA) | Four real Git merges serialize safely in seconds; re-merging the winner is a pure dedupe |
| Gates: dup-collapse, quota-freeze (+60s), restart-preserved, read-only-zero-submits, secrets-scan | all true, 0 hits | `dupCollapse`, `quotaFreeze`, `restartPreserved`, `readOnlyZeroSubmits`, `secretsZeroHits` | The §2 behaviors hold under the bench harness too |

Bench report JSON is written to a fresh `mkdtemp` dir under the OS tmp dir (`<out>/m7-bench-report.json`, default path printed on stdout); intermediate repos/DBs are removed and the report dir is retained. The report path is **disposable, never canonical** — no bench JSON is committed. [DESIGN — code-observed in `scripts/m7-bench.ts`]

## 4. Codex probe (resolve-only, REMOVED at 3589e2b — historical record at 9111c4a) [PROBE]

The M7-02 probe resolved what Codex offers **without installing anything and without spending anything** (read-only local resolution + metadata lookup, no network transport, no turn ever submitted). The probe log was recorded in `packages/adapter-codex/README.md` at `9111c4a`; that package (5 files, 320 deletions per `git show --stat HEAD`) was **REMOVED at `3589e2b`** per the architecture decision (OpenCode harness is the execution backend via the `CodingHarness` port; no Codex backend required). The findings below are retained explicitly as **historical rationale recorded at `9111c4a`**, not current implementation. The verdict is: **REMOVED — Codex stub removed; transport NOT VERIFIED and honestly unbuilt (historical fail-closed-stub finding retained below)**.

| Probe | Result (supplied, code-recorded in the stub header + README) |
|---|---|
| CLI presence | `codex-cli 0.167.0` via `codex --version` (pre-existing install, nothing installed by the task) |
| SDK metadata (resolve-only, no install) | `@openai/codex-sdk` version `0.167.2`, "TypeScript SDK for Codex APIs"; exported surface and stability NOT downloaded, NOT VERIFIED |
| App-server protocol verbs (local JSON-schema generation, no network) | `thread/start` (+ `resume`/`fork`/`read`/`list`/`turns/list`), `turn/start`, `turn/steer`, `turn/interrupt`, `model/list`; `ThreadStartParams` carries `cwd`/`model`/`modelProvider` |
| Agent switching | **No `switchAgent` verb exists** — only `ExternalAgentConfig/*` (config import, not a session agent switch) |
| Snapshot / permission equivalents | No stable snapshot verb maps to `SessionSnapshot.hasLiveExecution`/`knownTerminalExternalIds`; no stable `applyPermissionRules` equivalent confirmed |
| Execution model | `codex exec` is one-shot non-interactive (no interrupt/switch verbs); `codex queue --thread` exists but its completion/interrupt/identity semantics are undocumented for harness use |
| Doc URLs referenced | `https://developers.openai.com/codex`, `https://developers.openai.com/codex/cli` (+ app-server/SDK refs) — content NOT fetched (network out of probe scope) |
| Stability | `codex app-server` is explicitly marked `[experimental]` in `0.167.0` help output — not a stable documented interface, so no production harness may be built on it |

Four gating questions must ALL hold before any transport is implemented (described generically — exact capability IDs were not assigned, and none are invented here): (1) a stable non-experimental verb set covering the full port surface; (2) documented session-identity mapping across restarts; (3) documented model-ref → Codex model-string mapping; (4) a stable completion/snapshot semantic backing crash-window reconciliation (spec §8). Until then the stub fails closed: every method throws `CodexNotImplementedError` with stable code `CODEX_NOT_IMPLEMENTED`, zero fake turns, zero network, zero child processes. [DESIGN — code-observed]

Contract-test rows (supplied PASS): **9 fail-closed rows + zero-fake-turn + default-regression** — every `CodingHarness` method rejects with the stable code and names the missing capability; a failed `submitTurn` yields no receipt and the stub holds no transport/process/fetch handle; the package discriminator is exactly `"codex"` and it exports no OpenCode/default-harness symbol. The OpenCode default path (`OpenCodeHarness`, `backend: "opencode"`) is untouched — this package registers nothing globally. [PROBE — code-observed test source]

Bridge Tier-A 50 (M1-03) still PASS (carried, supplied — no bridge source touched by this commit). [PROBE]

## 5. Per-acceptance mapping — spec §14 M7 gate + exit criteria → committed evidence [PROBE]

Counts below are **committed/supplied evidence** (implementation-handoff figures, source-inspected, not re-executed in this DOC session): **10 scale + 5 fault-injection + 9 Codex fail-closed rows** (plus zero-fake-turn + default-regression), carried **35 rate-limit + 4 rate-quota** (M5) and **207 + 74 + 23 + 51 + 34 + 12** prior suites (M0–M6, supplied); **`tsc` clean × 2 + adapter `typecheck` clean** (supplied). This doc session executed **only the link check** (§7); every typecheck/test/bench figure is cited, not claimed as a fresh run. Live inference/spend stays NOT VERIFIED throughout.

| # | Expected (spec §14 M7 gate / exit criterion) | Test evidence (file: test) | Gate |
|---|---|---|---|
| 1 | 8–12 workers run concurrently on distinct work with unique ownership | `scale.test.ts`: `M7 scale: N-worker runs with unique ownership` (8 + 12 parameterized) | PASS (supplied) |
| 2 | Duplicate wakes collapse; no double turns | `scale.test.ts`: `M7 duplicate @all` + bench `dupCollapse` gate | PASS (supplied) |
| 3 | Quota exhaustion pauses without retry (spec §13 row) | `scale.test.ts`: quota freeze + bench `quotaFreeze` gate (+60s virtual advance, zero follow-up submits) | PASS (supplied) |
| 4 | Restart preserves wakes/tasks/sessions with no duplicates (spec §13 rows) | `scale.test.ts`: restart mid-run + bench `restartPreserved`; `m7-scale.test.ts`: crash/restart dedupe + reconcile | PASS (supplied) |
| 5 | Read-only board/roster/usage costs zero turns | `scale.test.ts`: read-only sweeps + bench `readOnlyZeroSubmits` | PASS (supplied) |
| 6 | No secrets in durable artifacts | `scale.test.ts`: secrets scan + bench `secretsZeroHits` (0 hits) | PASS (supplied) |
| 7 | Measured replay + contention within sane bounds | `scale.test.ts`: 1000-post resync + dual-handle contention (0 busy) + bench figures §3 | PASS (supplied) / hardware dependence NOT VERIFIED |
| 8 | Conflicting integrations cannot corrupt the shared history | `m7-scale.test.ts`: ownership-conflict reject + merge-conflict winner-kept + concurrent winner/dedupe + 4-way disjoint + bench `integrationSafe` | PASS (supplied) |
| 9 | Codex adapter validated independently (spec §4.5) | `codex-harness.test.ts`: 9 fail-closed rows + zero-fake-turn + default-regression; README probe log | NOT-VERIFIED-stub (resolve-only probe; transport honestly unbuilt) |
| 10 | Comparable reproducible cost/quality benchmark (spec §14) | Bench gates + report JSON to disposable tmp (§3) | PASS (supplied-simulation) / live cost + spend NOT VERIFIED |
| 11 | Live 8–12 worker turns, live contention timing, provider 402 shaping, spend | No live server, no spend, no credentials | BLOCKED — NOT VERIFIED by design |

Required-test tally: **10 (scale) + 5 (fault-injection) + 9 (Codex fail-closed rows) + zero-fake-turn + default-regression = M7 new, all PASS (supplied)**; carried **35 + 4** (M5 rate-limit/quota, supplied); prior suites **207 + 74 + 23 + 51 + 34 + 12** green (supplied, not re-executed); **`tsc` × 2 + adapter `typecheck`** clean (supplied). [PROBE — cited, not re-executed]

## 6. Review and fix record (supplied) [PROBE — cited, not re-executed]

- **M7-01/M7-02 reviews:** COMMIT-ready with **S2 dispositions: accepted hardening follow-ups, non-blocking** (supplied review disposition — no finding IDs are invented here beyond the S2-generic class). [PROBE]
- **F-04 (harness 402-shape): NOT VERIFIED (carried, not closed).** M7 adds no inference path and no paid-service call; the M2 quota posture is carried unchanged — the exact 402/quota error shape a live provider surfaces remains unproven, in the same language as M6 §5. [PROBE]

## 7. Reproducible log (commands inspected at HEAD; NOT re-executed in this DOC session)

```powershell
git rev-parse HEAD
# 9111c4a465de9469f2f8011124eac1dc0c301c33 (inspected)

git show --stat HEAD
# 8 files changed, 1859 insertions(+) (inspected — file list in §1)

git log --oneline -6
# 9111c4a (HEAD) / f7237bf / ccf0db6 / 817835a / 55541b0 / 69f40a9 (inspected)

# Supplied (cited, NOT re-executed here — no build/test/bench re-runs in DOC-M7-01):
# HISTORICAL-AT-9111c4a: tsc clean x2 + packages/adapter-codex typecheck clean → exit 0
# (package removed at 3589e2b; the adapter-codex typecheck command is no longer runnable)
# focused: 10 (scale.test.ts) + 5 (m7-scale.test.ts) + 9 fail-closed rows +
#   zero-fake-turn + default-regression (codex-harness.test.ts) = PASS
# carried: 35 + 4 (M5 rate-limit/quota) + 207 + 74 + 23 + 51 + 34 + 12 prior suites green
# bench: bun scripts/m7-bench.ts [--out <dir>] → m7-bench-report.json to disposable tmp only
# live inference / live server / live spend: NOT VERIFIED (no live server, no spend, no credentials)
```

Repro commands that WOULD reproduce at `9111c4a` (labeled supplied/inspected, not executed here; HISTORICAL-AT-9111c4a — the two `packages/adapter-codex/...` commands below are no longer runnable, package removed at `3589e2b`): `bun run typecheck` (repo root, × 2 configs per handoff), `bunx tsc --noEmit -p packages/adapter-codex/tsconfig.json` (from repo root — HISTORICAL, target deleted), `bun test packages/runtime/src/services/__tests__/scale.test.ts`, `bun test tests/fault-injection/m7-scale.test.ts`, `bun test packages/adapter-codex/src/__tests__/codex-harness.test.ts` (HISTORICAL, target deleted), `bun scripts/m7-bench.ts --dry-run` (plan only, zero work) then `bun scripts/m7-bench.ts [--out <dir>]` (full run, report JSON to disposable tmp). Typecheck/test/bench figures above are **committed/supplied evidence with honest scope**: inspected in source and handoff, not freshly executed in this documentation session. To advance the live gate, run the suites and bench on the pinned toolchain, capture the logs, and mount a disposable live probe for the Codex verbs. [PROBE]

### Link validation (the only check executed in this DOC session) [PROBE]

- Relative links in this file (`../plan/spec.md`, `m6-parity-ux.md`, `../compatibility-report.md`, `../milestone-matrix.md`) validated by read-only path-existence inspection (`Test-Path` over `docs/`); all targets exist — exit 0. (HISTORICAL-AT-9111c4a: this list previously included `../../packages/adapter-codex/README.md`; that target was removed at `3589e2b` and the probe record now lives in §4 of this file — no link in this file points at a deleted path.)
- No unexecuted command examples are presented as executed; §7 commands are labeled inspected/supplied.

## 8. Gaps and NOT VERIFIED list [PROBE]

1. Live inference/spend, live server turns, live contention timing, provider 402 shaping, and bench hardware dependence are NOT VERIFIED.
2. Focused/carried/typecheck/bench counts (10 + 5 + 9 rows, 35 + 4, 207 + 74 + 23 + 51 + 34 + 12, `tsc × 2` + adapter typecheck, §3 figures) are supplied evidence cited in §§3/5, not fresh executions of this doc session (link check only).
3. Exactly-once physical delivery is not claimed; ambiguous admissions quarantine for operator review by design (M2 carry).
4. Codex transport is honestly unbuilt — four gating questions open (§4); no stable-verb, session-identity, model-mapping, or snapshot claim is made.
5. No live-server, screenshot, deployment, endpoint, CLI-flag, release-number, or support-promise claims are made in this evidence.
6. Untracked `NUL` junk file at repo root is uncommitted noise, never evidence, left untouched.
7. Bench report JSON path is disposable tmp, never canonical — no committed bench artifact is claimed.
8. Removal note: the 5 `packages/adapter-codex/*` files counted in §1 (320 deletions) were removed at `3589e2b` per the architecture decision (OpenCode harness is the execution backend via the `CodingHarness` port; no Codex backend required). §§1/5/9 counts stay as the historical record of `9111c4a` — history is not rewritten. [PROBE — `git show --stat HEAD`, inspected]

## 9. Claim-status summary

| Claim | Status |
|---|---|
| Scale behaviors: N-worker ownership, dup collapse, quota freeze, restart, read-only zero, secrets zero, replay, contention (§2 rows 1–9) | IMPLEMENTED (code-observed at `9111c4a`, supplied PASS) |
| Integration safety: conflict reject, winner/dedupe, 4-way disjoint, crash dedupe (§2 rows 10–14) | IMPLEMENTED (code-observed at `9111c4a`, supplied PASS) |
| Bench figures: scheduler/wake/replay/contention/RSS/integrate (§3) | SUPPLIED PASS (simulation) / hardware dependence + live timing NOT VERIFIED |
| Codex probe: resolve-only CLI/SDK/verb findings + fail-closed stub (§4) | REMOVED at `3589e2b` (historical IMPLEMENTED-stub, code-observed at `9111c4a`); transport NOT VERIFIED by design, findings retained as historical rationale |
| 10 + 5 + 9 rows + zero-fake-turn + default-regression; carried 35 + 4 + priors; `tsc × 2` + adapter typecheck | SUPPLIED PASS / NOT VERIFIED (fresh run) — cited, see §7 |
| Commit `9111c4a` (8 files, 1859+/0−) | COMMITTED (HEAD, §1) |
| M7-01/02 reviews COMMIT-ready; S2 accepted hardening follow-ups, non-blocking | Cited supplied review disposition (see §6) |
| F-04 (harness 402-shape) | NOT VERIFIED (carried, not closed) |
| Live turns / contention / provider shapes / spend | NOT VERIFIED (no live log in repo) |
| M8 work | TODO (see [milestone-matrix](../milestone-matrix.md)) |
| Release / shipped / production | NOT CLAIMED — commit is not a release |
