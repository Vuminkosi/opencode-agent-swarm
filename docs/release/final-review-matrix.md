# Final review matrix — M8 Phase-4 collection + fix disposition (DOC-M8-FINAL-01)

> **Document status: IMPLEMENTED (fix code-observed at `895316a`) / COMMITTED
> (`895316a`, HEAD) / verdicts SUPPLIED (Phase-4 collection, not a fresh
> full re-review here) / live items NOT VERIFIED / release decision
> UNDECIDED-PENDING-MASTER (master-owned).**
> This file records the current status of each of the 9 review areas after
> the M8-FIX-COMMIT-01 fixes, using the targeted re-verification already
> done (store / RPC / compat lanes COMMIT-ready). It is **not** a full
> re-review. Live inference, live server, live TUI mount, and live spend
> remain NOT VERIFIED. [DESIGN] [PROBE]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Fix HEAD:** `895316a16e1137dfbe40223bcc9c97807d968cc3` (M8-FIX-COMMIT-01). [PROBE]
- **Evidence pointers (linked, not duplicated):** [m8 release qualification](../evidence/m8-release-qualification.md) (§§1–9 = `7d4d79b` base, §10 = `895316a` fix amendment), [compatibility-report §14](../compatibility-report.md#14-m8-fix-compatibility-addendum-doc-m8-final-01), [milestone-matrix](../milestone-matrix.md) (M8 + M8-FIX rows), [release-blockers](release-blockers.md), [release-decision](release-decision.md) (stub).

## Area verdicts after fixes

| # | Review area | Phase-4 verdict (supplied) | Status after fix `895316a` | Evidence |
|---|---|---|---|---|
| 1 | Store / persistence (fencing, quarantine, dedupe, migration 004) | FAIL → **fixed** | **COMMIT-ready (targeted re-verification done, supplied)** — fencing monotonic, quarantine TTL + review queue, swarm-scoped dedupe + additive 004; live contention timing NOT VERIFIED | [m8 qual §10.2](../evidence/m8-release-qualification.md#102-s2-closures-supplied-phase-4-re-review-disposition-commit-ready-lanes), `m8-store.test.ts` (255 lines, supplied PASS) |
| 2 | Rate limiter / ingest / dispatcher (ledger, parity, contention) | FAIL → **fixed** | **COMMIT-ready (targeted re-verification done, supplied)** — ledger wiring, digit-guard parity incl. timeout-with-digits edge, ingest contention hardening; live timing/spend NOT VERIFIED | [m8 qual §10.2](../evidence/m8-release-qualification.md#102-s2-closures-supplied-phase-4-re-review-disposition-commit-ready-lanes), `rate-limit.test.ts` +201 lines (supplied PASS) |
| 3 | Plugin RPC / TUI contract (`invalid_caller`, edit/write, schema) | FAIL → **fixed** | **COMMIT-ready (targeted re-verification done, supplied)** — `invalid_caller` fail-closed, explicit edit/write separation; live TUI mount NOT VERIFIED (terminal board fallback per spec §4.4) | `tui-rpc.test.ts` +141 lines (supplied PASS) |
| 4 | Adapter bridge (`sessions.ts` surface) | PASS | **PASS (carried, fix hunk covered by supplied bridge rows)** — frozen port untouched, zero runtime deps; live transport NOT VERIFIED | `bridge.test.ts` +18 lines (supplied PASS) |
| 5 | Path policy (prefix / device / NUL guards) | FAIL → **fixed** | **COMMIT-ready (targeted re-verification done, supplied)** — prefix, device, NUL guards; live Windows-fleet behavior NOT VERIFIED | `path-policy.test.ts` +123 lines (supplied PASS) |
| 6 | Scan-cap / replay bounds (F-01) | Conditional → **fixed (mechanism)** | **ACCEPTED RISK with revisit (carried)** — bounded passes (`REPLAY_SCAN_CAP` 2000) code-observed; revisit against live-server contention evidence before any production claim | [m8 qual §10.3](../evidence/m8-release-qualification.md#103-accepted-residuals-probe) |
| 7 | Ledger / telemetry wiring | Conditional → **wired** | **COMMIT-ready (targeted re-verification done, supplied)** — limiter ledger wired through dispatch + ingest; live spend NOT VERIFIED | [compat §14.3](../compatibility-report.md#143-ledger-wiring-design) |
| 8 | Docs / compat record | Conditional | **Satisfied by this lane** — §10 amendment, §14 addendum, M8-FIX matrix row, and these release files; link check is the only check executed here (see Gaps) | This file + siblings; link check exit 0 |
| 9 | Live / release gates (smoke, E2E, inference, 402-shape, TUI mount) | NOT VERIFIED | **NOT VERIFIED (unchanged)** — no live log in repo; blocks any release claim | [release-blockers](release-blockers.md) |

## What "fixed" means here — and what it does not

- **Means:** the fix hunks are code-observed at the committed HEAD `895316a`; the targeted rows covering them report supplied PASS; the store / RPC / compat lanes report supplied COMMIT-ready with S2s closed. [PROBE]
- **Does not mean:** a fresh full re-review was executed in this DOC session (it was not — link check only); live behavior is proven (it is not — see area 9); the product is released, shipped, or production-proven (it is not — `decision: UNDECIDED-PENDING-MASTER`). [PROBE]

## Gaps

1. Area verdicts are supplied Phase-4 collection evidence cited here, not fresh executions of this doc session (link check only).
2. Full-suite totals (514/0/14054/36, tsc 9/9, frozen-adapter 0) are supplied M8-FULL/M8-FIX handoff evidence — VERIFIED-supplied, not fresh runs.
3. Live inference / server / spend / 402-shape / TUI mount / fresh-install E2E: NOT VERIFIED (no live log, no credentials).
4. No finding IDs are invented beyond the supplied S2-generic class; no new defect classes are claimed.
