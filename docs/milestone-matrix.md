# Milestone matrix — M0 through M2 closeout (DOC-M2-01)

> **Document status: IMPLEMENTED / COMMITTED summaries with honest gates.**
> `PASS (committed)` = reported PASS in the committed handoff and/or
> re-confirmed by inspection or re-execution noted in the row; this matrix
> does not invent fresh runs. `NOT VERIFIED` = no executed evidence exists.
> Live-server / inference-dependent checks are **NOT VERIFIED** throughout
> (no live server, no inference spend). Commit SHAs are from
> `git log --oneline`. Never cite this file as proof of a fresh test run —
> follow the per-row evidence links. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **HEAD at closeout:** `c62c82418f93a923325968ea841b18f81d182c46` —
  `feat(runtime): durable wake-up engine (M2-01)`. [PROBE]
- **Workflow pin:** `d22d8c1` — `chore(ci): warning-free workflow refs
  Node24` (PUBLISH-COMMIT-02). [PROBE]

## Gate summary

| Milestone | Scope | Commit | Gate | Evidence |
|---|---|---|---|---|
| M0 — API compatibility | Toolchain pins, frozen adapter port, 12 probes authored, plugin bootstrap | `56d22a2` (M0-COMMIT-01) | PASS (committed) / live probes NOT VERIFIED | [api-compatibility](api-compatibility.md), [compatibility-report](compatibility-report.md) §§1–6 |
| M1-01 — Protocol + journal | Schemas, SQLite migrations, atomic board sequence, idempotency | `1c88f0f` (M1-01-COMMIT-01) | PASS (committed, 70 tests per test-evidence) / live NOT VERIFIED | [test-evidence](test-evidence.md) row 3 |
| M1-02 — Daemon lifecycle | Ingest/broadcast, `swarmctl status`, config (13 + 22 tests) | `4e61a58` (M1-02-COMMIT-01) | PASS (committed) / live NOT VERIFIED | [test-evidence](test-evidence.md) rows 4–5 |
| M1-03 — Native session bridge | Sessions/events/harness Tier-A (50 tests) | `5f2c9c3` (M1-03-COMMIT-01) | PASS (committed) / live-server behavior NOT VERIFIED | [test-evidence](test-evidence.md) row 6 |
| M1-04 — Coordinator activation | `/swarm` command + SwarmService (19 tests) | `2cfec1c` (M1-04-COMMIT-01) | PASS (committed) / live NOT VERIFIED | [test-evidence](test-evidence.md) rows 7–8 |
| M1-05 — Demonstrator fixture | Disposable two-module fixture + e2e + demo | `513862c` (M1-05-COMMIT-01) | PASS (committed) / live NOT VERIFIED | commit subject; counts not re-stated here |
| Publish workflow | Warning-free workflow refs, Node24 | `d22d8c1` (PUBLISH-COMMIT-02) | PASS (committed) | commit subject |
| **M2 — Real sleep/wake** | Wake queue + dispatcher + reconciler + events; `delivery_key` UNIQUE + fencing; 402 quota-pause without retry; bounded transient backoff; quarantine-on-ambiguity; idle-zero | **`c62c824`** (M2-01-COMMIT-01) + M2-01-FIX-REVIEW-01 evidence (S2-1/S2-2/F-01) | **PASS: 20 wake + 98 runtime tests (FakeHarness), typecheck clean / live turns NOT VERIFIED / COMMITTED** | [m2-wake-engine](evidence/m2-wake-engine.md) |
| **M3 — Autonomous team** | Planner, groups, task DAG, verifier, dormant monitor; 26 coordination tests (21 base + S1-01/S1-02/S2-01/02/03 fixes) | **`e7a0b8f`** (M3-01-COMMIT-01; 8 files, 1678 insertions; fixes folded in, no separate fix commit in log) | **PASS: 26 coordination + 124 runtime + 188 repo tests (FakeHarness), typecheck clean / live turns NOT VERIFIED / COMMITTED** | [m3-coordination](evidence/m3-coordination.md) |
| **M4 — Safe coding** | Worktree manager + path policy + verification runner + serialized CAS integration gate; quota 402 no-retry carried, at-least-once honest | **`7330e0e`** (M4-01/M4-02/M4-03-COMMIT-01; 12 files, 4911 insertions) | **PASS (simulation): 74 + 23 + 13 focused, full 246 observed (FakeHarness/tmp-Git, supplied) / m105 env NOT VERIFIED external / COMMITTED** — S2 follow-ups S2-1…S2-3 + S3 lists filed, non-blocking | [m4-safe-coding](evidence/m4-safe-coding.md) |
| **M5 — Robustness** | Crash replay + rate limiting (M5-01/M5-02): durable leases (fencing high-water + CAS, fail-closed), outbox/session replay, 429 bounded+jitter+budget, 402/401/403 zero follow-up, usage ledger | **`69f40a9`** (M5-01/M5-02-COMMIT-01; 8 files, 3527 insertions) | **PASS (simulation): 19 recovery + 8 crash-replay + 35 rate-limit + 4 rate-quota (FakeHarness/tmp-Git, supplied) / live inference NOT VERIFIED / COMMITTED** — M4 S2-1…S2-3 committed c10e0be, m105 cleared b54c50c, F-01 accepted-risk + revisit | [m5-robustness](evidence/m5-robustness.md) |
| **M6 — Parity UX** | `/swarm` family + native TUI/RPC wiring + terminal board fallback | **`817835a`** (M6-0103-FIX-REVIEW-01; 8 files, 1737 insertions, 76 deletions) + **`ccf0db6`** (M6-BOARD-COMMIT-01; 4 files, 1592 insertions) | **PASS (simulation): 51 plugin + 34 board tests (FakeHarness/tmp, supplied), tsc × 2 clean (supplied) / live TUI mount + live inference NOT VERIFIED / COMMITTED** — S2 fixes + re-reviews folded into `817835a`; plugin/board reviews COMMIT-ready 0 findings (supplied); M7+ TODO | [m6-parity-ux](evidence/m6-parity-ux.md) |
| **M7 — Scale + Codex probe** | Scale validation suite + bench + fail-closed Codex probe | **`9111c4a`** (M7-CODE-COMMIT-01; 8 files, 1859 insertions) | **PASS (simulation): 10 scale + 5 fault-injection + 9 Codex fail-closed rows (FakeHarness/tmp, supplied), bench supplied, tsc × 2 + adapter typecheck supplied clean / live inference NOT VERIFIED / COMMITTED** — S2 accepted follow-ups + F-04 carried, non-blocking | [m7-scale-codex](evidence/m7-scale-codex.md) |
| **M8 — Residual hardening** | Scan-cap, digit-guard, per-attempt timeout, contention, lockfile resync | **`7d4d79b`** (M8-CODE-COMMIT-01; 7 files, 1074 insertions, 28 deletions) | **PASS (simulation, supplied — not freshly executed here) / live NOT VERIFIED / COMMITTED** — M8-01-FIX-01 findings folded in; S2 follow-ups as documented residuals, non-blocking [DESIGN] [PROBE] | commit file list (`git show --stat HEAD`); [spec](plan/spec.md) §14 |
| M8+ — Release readiness | M8 per spec §14 | — | TODO (release qualification pending; M8 hardening code COMMITTED — see M8 row) | [spec](plan/spec.md) §14 |

## M2 gate detail (why M2 is PASS-with-qualification, not fully VERIFIED)

- **PASS (simulation):** all 10 required behaviors mapped to named tests —
  13 in `wake-engine.test.ts` + 7 in `wake-concurrency.test.ts` = 20 wake
  PASS, inside a 98-test `packages/runtime/` PASS; `bun run typecheck`
  exit 0. FakeHarness only. Reproducible commands in
  [m2-wake-engine §9](evidence/m2-wake-engine.md#9-reproducible-log-commands-inspected--executed-at-head).
- **NOT VERIFIED (live):** probes 01–12 logless; live turns, overlap figures,
  provider 402-shape (F-04), and spend behavior unproven; no credentials or
  spend authorized. Recorded as [PROBE] gaps, not silent passes.
- **COMMITTED:** `c62c824` is HEAD (7 files, 2703 insertions); M0/M1 files
  untouched, no 003 migration, protocol DTOs untouched. Commit is not a
  release — no shipped/production claim.
- **Dependencies reused, not re-verified by new execution here:**
  M2-01-COMMIT-01 (`c62c824`) and M2-01-FIX-REVIEW-01 evidence are linked,
  not re-derived; the test/typecheck runs above are confirmatory
  re-executions against the same HEAD.

## Claim statuses used in this matrix

IMPLEMENTED (code-observed) / VERIFIED (executed evidence reviewed) /
COMMITTED (`9111c4a`/`7d4d79b` cited; not a release) / NOT VERIFIED (no live log) /
TODO (M8+). Live inference stays NOT VERIFIED across all rows.
