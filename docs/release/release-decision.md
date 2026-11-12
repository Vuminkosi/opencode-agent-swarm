# Release decision — M8 (STUB, master-owned — DOC-M8-FINAL-01)

> **Document status: STUB — no decision is made in this file.**
> This stub scopes the decision for the master orchestrator, which owns
> release authority. Do not treat any PASS cited here as a release
> approval. Current value: **`decision: RELEASE_CANDIDATE_BLOCKED (Option A)`**. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Candidate commits:** `7d4d79b` (M8-CODE-COMMIT-01) → `2cae97b` (DOC-M8-COMMIT-01) → `895316a` (M8-FIX-COMMIT-01, HEAD). [PROBE]
- **Source baseline:** fix HEAD `895316a16e1137dfbe40223bcc9c97807d968cc3`. [PROBE]

## Options before the master

| Option | Meaning | Preconditions |
|---|---|---|
| A — No release | Hold; M8 stays implementation-complete, release-unproven | Default while any § Gates row is BLOCKED/NOT VERIFIED |
| B — Qualified internal release | Release to a disposable/internal surface only, with live gates waived in writing | Master records which live gates are waived, why, and the expiry/revisit |
| C — Full release | Declare M8 releasable | ALL gates in § Gates PASS with executed evidence; no BLOCKED rows remain |

## Gates (summary — full per-gate verdicts linked, not duplicated)

Full per-gate table: [m8 release qualification §10.5](../evidence/m8-release-qualification.md#105-amended-release-checklist-per-gate-verdicts--remaining-blockers).

- Implementation inputs satisfied (supplied): G1, G1-FIX (S2 closures, COMMIT-ready lanes), G2–G8-sim, G12-sim, G13, G14-supplied (514/0/14054/36, tsc 9/9, frozen-adapter 0 — VERIFIED-supplied, not fresh).
- Blocking (NOT VERIFIED): G9 fresh-install smoke/E2E, G10 live inference/402-shape/spend, G11 live TUI mount (fallback applies), G12-live idle window.

## Required evidence pointers (read before deciding)

1. [m8 release qualification](../evidence/m8-release-qualification.md) — §§1–9 (`7d4d79b` base) + §10 (`895316a` fix amendment: S2 closures, full totals, checklist, pinned matrix, upgrade/rollback).
2. [final-review-matrix](final-review-matrix.md) — 9-area verdicts after fixes (supplied Phase-4, not a fresh full re-review).
3. [release-blockers](release-blockers.md) — S2s closed, accepted residuals (F-01/F-02/F-04/S3s), live blockers, resumption conditions.
4. [compatibility-report §14](../compatibility-report.md#14-m8-fix-compatibility-addendum-doc-m8-final-01) — fix hunks, digit-guard parity, ledger wiring, migration 004 note.
5. [milestone-matrix](../milestone-matrix.md) — M8 + M8-FIX rows.
6. Spec §14 M8 gate + milestone row 823 ([spec](../plan/spec.md) §14) — contract source, linked not duplicated.

## Decision record (master only)

```text
decision: RELEASE_CANDIDATE_BLOCKED
decided-by: OpenCode Engineering Orchestrator (master)
decided-at: 2026-11-12
selected-option: A — No release (RELEASE_CANDIDATE_BLOCKED; M8 stays implementation-complete, release-unproven)
waived-gates (B only): N/A — no waiver granted under Option A
evidence-logs: deterministic gates PASS — frozen install exit 0 (274 installs, no changes); full suite 514 pass / 0 fail / 14054 expects / 36 files at 895316a; tsc 9/9 clean; targeted suites green (recovery 19+8 crash-replay, rate-limit 35+4, path-policy 55, worktree 30, plugin 51+22, adapter-codex 9 + bridge Tier-A 50, board 34, m1 e2e 6/6 SKIP-with-zero-inference); independent reviews complete (code/security/integration/integrity/compat/dependency/test), 0 S0/S1, S2s closed or accepted-residual with revisit conditions. Live gates BLOCKED — no authorized paid inference this program (SWARM_ALLOW_LIVE_INFERENCE gate closed at every live attempt; user explicitly forbade paid inference); LIVE-PROBE-02 reached 12/13 proofs then provider 402 Insufficient balance with $0.00 spend and zero retries, so successful wake-triggered model turns + 402-shape live proof + live TUI mount + live contention remain NOT VERIFIED. Resumption: set SWARM_ALLOW_LIVE_INFERENCE=1 with funded quota, rerun identical harness flags (--max-turns 6 --timeout-ms 300000 --max-cost-usd 0.50) + live TUI mount via supported APIs + full suite re-run at that HEAD.
```

Decision recorded as `RELEASE_CANDIDATE_BLOCKED` by the OpenCode Engineering Orchestrator (master) on 2026-11-12, superseding the `UNDECIDED-PENDING-MASTER` state. No agent below the master may edit this record — the documentation lane leaves it dirty in the working tree for master review, never staged, never committed by this lane. [DESIGN]
