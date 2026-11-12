# Release blockers — M8 fix closeout (DOC-M8-FINAL-01)

> **Document status: IMPLEMENTED (fix code-observed at `895316a`) / COMMITTED
> (`895316a`, HEAD) / live gates NOT VERIFIED / release decision
> UNDECIDED-PENDING-MASTER (master-owned).**
> This file lists what is closed, what is accepted or deferred, and what
> still blocks any release claim. Commit `895316a` is not a release; no
> shipped/production claim is made here. [DESIGN] [PROBE]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm` — fix HEAD `895316a16e1137dfbe40223bcc9c97807d968cc3`. [PROBE]
- **Evidence pointers (linked, not duplicated):** [m8 release qualification](../evidence/m8-release-qualification.md) (§10 fix amendment), [final-review-matrix](final-review-matrix.md) (9-area verdicts), [release-decision](release-decision.md) (stub), [compatibility-report §14](../compatibility-report.md#14-m8-fix-compatibility-addendum-doc-m8-final-01).

## 1. S2s closed by M8-FIX-COMMIT-01 (supplied Phase-4 disposition)

No finding IDs are invented beyond the supplied S2-generic class:

- Fencing high-water monotonic guard (`store.ts`) — F-01 mechanism condition satisfied; revisit carries for production claims.
- Quarantine TTL + operator review queue (`store.ts`).
- Swarm-scoped dedupe + additive migration 004 (forward-safe; legacy rows frozen for audit, honored conservatively).
- RPC `invalid_caller` fail-closed + explicit edit/write separation (`rpc.ts`).
- Path prefix / device / NUL guards (`path-policy.ts`).
- Rate-limiter ledger wiring through dispatch + ingest (`wake-dispatcher.ts`, `ingest.ts`).
- Digit-guard parity limiter ↔ dispatcher, including the documented timeout-with-digits edge.

Supplied re-review verdicts: **store / RPC / compat lanes COMMIT-ready, S2s closed**. Targeted re-verification already done at fix time — not a full re-review. [PROBE]

## 2. Accepted residuals (non-blocking for fix closeout, visible to the decision-maker)

- **F-01 (fencing high-water + scan cap): ACCEPTED RISK with revisit condition** (carried since M5). Re-examine against live-server contention evidence before any production claim. [PROBE]
- **F-02 (terminal-once outcome): advisory** — covered by recorded-terminal-survives-restart rows; filed follow-up, non-blocking. [DESIGN]
- **F-04 (harness 402-shape): NOT VERIFIED (carried since M2, not closed).** The fix adds no inference path and no paid-service call; the exact live-provider 402/quota error shape stays unproven. Resumption: capture a live 402 in a disposable probe run and reconcile `isQuotaError` before any paid-path autonomy claim. [PROBE]
- **Harness S3s: deferred** (supplied disposition) — filed follow-ups, non-blocking for fix closeout. [PROBE]
- **Codex transport: honest stub, 4 gating items open** (stable verbs, session identity, model mapping, snapshot semantic) — by design, unchanged. [DESIGN]

## 3. Live gates — BLOCKING (no live log in repo)

| Gate | Verdict | Blocker |
|---|---|---|
| Fresh Windows install smoke + E2E (spec §14 M8 required gate) | **BLOCKED — NOT VERIFIED** | No fresh-install smoke/E2E log; no live server, no installer run, no screenshots |
| Live inference / live server turns / spend | **BLOCKED — NOT VERIFIED** | No live log; no credentials; no spend authorized — **live inference unauthorized = BLOCKED** |
| Provider 402-shape (F-04) | **NOT VERIFIED** | Carried; needs a disposable live-402 probe run |
| Live TUI mount | **BLOCKED — NOT VERIFIED (→ fallback)** | Needs a plugin-config change this slice must not perform; terminal board (`bunx opencode-swarm board`) is the contract-approved fallback per spec §4.4 |
| Live 10-minute idle window | **NOT VERIFIED** | No live measurement log |

## 4. Resumption conditions (minimum for the master to revisit)

1. Run the fresh-install smoke/E2E required by spec §14 M8 on the pinned toolchain (opencode 2.2.7, bun 1.4.4, TS 5.9.2, `@opencode/plugin` 2.2.7) and capture the logs.
2. Capture a live 402 in a disposable probe run; reconcile `isQuotaError` (closes F-04).
3. Capture live-server contention evidence; re-examine F-01 (closes the ACCEPTED RISK revisit).
4. Mount the native board in a disposable TUI host (or re-confirm the terminal-board fallback as the release surface).

**The release decision is master-owned.** This file is an input, never an approval — see [release-decision](release-decision.md) (`decision: UNDECIDED-PENDING-MASTER`). [DESIGN]
