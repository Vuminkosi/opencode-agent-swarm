# Test evidence summary — committed results (not fresh execution)

> **Document status: IMPLEMENTED (test code exists on disk) / committed-PASS summary.**
> This file summarizes **already-committed** test outcomes from worker handoffs at the
> baseline below. It was assembled by **inspection only (glob + document reads)** —
> no test, typecheck, probe, or server command was executed to produce this file.
> `PASS` below means **"reported PASS in the committed handoff, not re-verified in
> this documentation task."** Live-server and inference-dependent checks are
> **NOT VERIFIED** (no live server, no inference spend). Never cite this file as
> proof of a fresh test run.

## Baseline and toolchain

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Baseline HEAD:** `2cfec1c` — `feat(m1-04): coordinator activation - /swarm command + SwarmService (M1-04-COMMIT-01)`
- **Commit chain (oldest → newest):**
  1. `56d22a2` — `feat(m0): foundation toolchain, adapter port, probes, plugin bootstrap + docs (M0-COMMIT-01)`
  2. `1c88f0f` — `feat(protocol,journal): M1-01 protocol core and journal store with recovery runbook (M1-01-COMMIT-01)`
  3. `4e61a58` — `feat(runtime,swarmctl): M1-02 daemon lifecycle ingest broadcast plus swarmctl status (M1-02-COMMIT-01)`
  4. `5f2c9c3` — `feat(adapter-opencode): M1-03 native session bridge sessions/events/harness (M1-03-COMMIT-01)`
  5. `2cfec1c` — `feat(m1-04): coordinator activation - /swarm command + SwarmService (M1-04-COMMIT-01)` (HEAD)
- **Toolchain (as assigned from committed evidence):** opencode `2.2.7`, bun `1.4.4`,
  TypeScript `5.9.2`, `@opencode/plugin` `2.2.7`.
- **Status key:** `PASS (committed)` = handoff reported pass at the baseline above;
  this doc task did **not** re-execute it. `NOT VERIFIED` = no executed evidence
  exists in this task.

## Per-suite results

| # | Suite / scope | Test file scope (on disk) | Count (committed) | Command (documented shape, not executed here) | Env | Status | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Typecheck | `packages/adapter-opencode/tsconfig.json` | n/a | `bun run typecheck` (i.e. `tsc --noEmit -p packages/adapter-opencode/tsconfig.json`) | Repo root | PASS (committed) | Reported PASS in handoffs; not re-run for this file. No log, timing, or coverage reproduced here. |
| 2 | M0 plugin bootstrap | `packages/plugin/src/index.test.ts` | 2 | `bun test packages/plugin/src/index.test.ts` | Bun 1.4.4 | PASS (committed) | Count as committed; not re-verified here. |
| 3 | M1-01 protocol + journal | `packages/protocol/src/__tests__/schemas.test.ts`, `packages/protocol/src/__tests__/mentions.test.ts`, `packages/protocol/src/__tests__/transitions-dag.test.ts`, `packages/runtime/src/db/__tests__/store.test.ts`, `packages/runtime/src/db/__tests__/remediation-guards.test.ts`, `packages/runtime/src/db/__tests__/migration-v1-to-v2.test.ts`, `packages/runtime/src/db/__tests__/concurrency-restart-dedupe.test.ts` | 70 | `bun test packages/protocol/src/__tests__/ packages/runtime/src/db/__tests__/` | Bun 1.4.4 | PASS (committed) | 70 is the committed M1-01 total; per-file split not re-verified here. File list confirmed by glob. |
| 4 | M1-02 daemon lifecycle | `packages/runtime/src/services/__tests__/daemon.test.ts` | 13 | `bun test packages/runtime/src/services/__tests__/daemon.test.ts` | Bun 1.4.4 | PASS (committed) | Count as committed; not re-verified here. |
| 5 | M1-02 config | `packages/runtime/src/config.test.ts` | 22 | `bun test packages/runtime/src/config.test.ts` | Bun 1.4.4 | PASS (committed) | Count as committed; not re-verified here. |
| 6 | M1-03 session bridge (Tier-A) | `packages/adapter-opencode/src/__tests__/bridge.test.ts` | 50 | `bun test packages/adapter-opencode/src/__tests__/bridge.test.ts` | Bun 1.4.4 | PASS (committed) | Tier-A scope as committed; live-server behavior still NOT VERIFIED (see row 9). |
| 7 | M1-04 coordinator | `packages/runtime/src/services/__tests__/swarm-service.test.ts` | 19 | `bun test packages/runtime/src/services/__tests__/swarm-service.test.ts` | Bun 1.4.4 | PASS (committed) | Count as committed; not re-verified here. |
| 8 | M1-04 `/swarm` command tests | `packages/plugin/src/commands/__tests__/swarm-command.test.ts` | Not stated in assigned handoff | `bun test packages/plugin/src/commands/__tests__/swarm-command.test.ts` | Bun 1.4.4 | NOT VERIFIED | File exists on disk (glob-confirmed). No committed count was supplied for it, so no count or PASS is claimed. |
| 9 | Live executable probes 01–12 + live server / inference | `scripts/probe-01.ts`…`scripts/probe-12.ts`, runner `bun scripts/run-probes.ts` (i.e. root `probes` script) | 0 executed | `bun scripts/run-probes.ts` (disposable dir `%TEMP%/opencode/swarm-probes`, override `SWARM_PROBE_DIR`) | Disposable probe dir only; live OpenCode server required | NOT VERIFIED | No `probe-NN.log` exists; no live-server run, no inference spend. Context: [api-probe-results.md](api-probe-results.md) (all 12 NOT VERIFIED) and [api-compatibility.md](api-compatibility.md) (pins UNCONFIRMED until probe-01). Zero FAIL rows — nothing ran, nothing failed. |

Bun unit total for rows 2–7 as committed: **176** (2 + 70 + 13 + 22 + 50 + 19).
Arithmetic only — not a fresh execution claim. Row 8 is excluded because its
committed count was not stated.

## What was checked to write this file (and what was not)

- **Checked:** glob `packages/**/__tests__/*.test.ts` and `packages/**/*.test.ts`
  (13 hits, all listed above); root `package.json` scripts (`typecheck`, `probes`);
  [api-probe-results.md](api-probe-results.md) and
  [api-compatibility.md](api-compatibility.md) probe NOT VERIFIED context;
  `git log --oneline -15` confirming HEAD `2cfec1c` and the five-commit chain.
- **Not executed:** `tsc`, `bun test`, `bun scripts/run-probes.ts`, live server
  startup, or any inference call. No pass logs, timings, coverage figures,
  screenshots, or release numbers are reproduced here — none were supplied, and
  none are invented.

## Gaps and resumption conditions

1. **No fresh execution evidence in this task.** Every PASS above must be
   re-confirmed by an authorized verification run before release claims.
   Suggested re-verification (unexecuted): `bun run typecheck`, then the
   per-file `bun test <path>` commands from the table.
2. **`swarm-command.test.ts` count unknown.** Report its committed count or mark
   it explicitly before including it in any release total.
3. **Live probes fully pending.** First live `bun scripts/run-probes.ts` run in
   a disposable dir against the pinned toolchain may surface FAILs that supersede
   this record. That run requires a live OpenCode server and inference spend,
   neither of which was available or authorized here.
4. **No coverage data.** No coverage percentage is claimed; do not infer one
   from file counts.
