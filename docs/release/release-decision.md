# Release decision — M8 (STUB, master-owned — DOC-M8-FINAL-01)

> **Document status: STUB — no decision is made in this file.**
> This stub scopes the decision for the master orchestrator, which owns
> release authority. Do not treat any PASS cited here as a release
> approval. Current value: **`decision: UNDECIDED-PENDING-MASTER`**. [DESIGN]

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
decision: UNDECIDED-PENDING-MASTER
decided-by: <master orchestrator signature>
decided-at: <date>
selected-option: <A / B / C>
waived-gates (B only): <gate IDs + rationale + expiry>
evidence-logs: <fresh-install smoke/E2E log, live probe logs, suite re-run logs>
```

No agent below the master may edit this record. The documentation lane leaves it `UNDECIDED-PENDING-MASTER` and dirty in the working tree for master review — never staged, never committed by this lane. [DESIGN]
