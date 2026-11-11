# API compatibility record — M0-01

Pinned toolchain and OpenCode §4.6 probe verdicts. All claims below carry
evidence labels: **[G-DOC]** (Antigravity docs), **[OC2-DOC]** (OpenCode 2
docs), **[DESIGN]** (our decision), **[PROBE]** (needs executable confirmation).

## 1. Pinned version table

> All `[PROBE]` versions below are **UNCONFIRMED candidates** until the
> probe-01 log captures them from the pinned toolchain. Do not treat any
> entry as verified.

| Component | Pinned version | Source |
|---|---|---|
| OpenCode CLI build | **2.2.7 (UNCONFIRMED candidate)** | [PROBE] discovery P1 (pending `opencode --version` capture by test-engineer) |
| Bun | **1.4.4 (UNCONFIRMED candidate)** | [PROBE] discovery (pending `bun --version` capture) |
| TypeScript | **5.9.2** | [DESIGN] selected for M0; confirm via `bun install` |
| `@opencode/plugin` | **TBD by probe-01** | [PROBE] zero installs found in discovery; resolve latest 2.x from registry in disposable dir, then pin here |
| `@opencode/sdk` | **TBD (preferred: same minor as plugin)** | [PROBE] do not depend on it until probe-04/07 confirm the session surface |
| Node (if used) | n/a (Bun runtime) | [DESIGN] |
| Git baseline | branch `master`, zero commits (unborn HEAD) | [PROBE] `git rev-parse HEAD` fails as expected; committer records before/after HEAD |

Generation rule: **v2 `@opencode/*` only — never `@opencode-ai/*`** (spec §1
version warning). The frozen adapter port (`packages/adapter-opencode/src/port.ts`)
has **zero runtime dependencies**, so no production code references any
OpenCode API surface yet — documented or otherwise.

## 2. Per-probe verdicts (spec §4.6)

| # | Probe | Verdict | Evidence / log | Fallback or blocking issue |
|---|---|---|---|---|
| 01 | Clean pinned install + no-op server plugin compile | NOT VERIFIED | `scripts/probe-logs/probe-01.log` (pending) | FAIL → record exact tsc error, file blocking issue, M0-02 blocked |
| 02 | `/swarm` + `/swarm board` command semantics | NOT VERIFIED | `probe-02.log` (pending) | Fallback: `bunx opencode-swarm board` CLI instead of TUI route (§4.4) |
| 03 | Native agent/model/permission enumeration | NOT VERIFIED | `probe-03.log` (pending) | FAIL → M1-03 blocked; unknown IDs must fail visibly (§9) |
| 04 | Two sessions, concurrent prompts | NOT VERIFIED | `probe-04.log` (pending) | FAIL → M1 milestone blocked; no multi-worker claims |
| 05 | Overlapping execution events (true concurrency) | NOT VERIFIED | `probe-05.log` (pending) | FAIL → serialize turns; document throughput limit |
| 06 | One waiting-session prompt → exactly one turn | NOT VERIFIED | `probe-06.log` (pending) | FAIL → wake dispatcher cannot claim exactly-once; quarantine path (§8) |
| 07 | Event shapes + admission↔completion correlation IDs | NOT VERIFIED | `probe-07.log` (pending) | If no stable ID → adapter-local `externalId` + snapshot reconcile only (§8) |
| 08 | Mid-turn reconnect + snapshot reconcile, no duplicate completion | NOT VERIFIED | `probe-08.log` (pending) | FAIL → single-flight subscription + manual review queue (M5) |
| 09 | Model switch preserves waiting-session history | NOT VERIFIED | `probe-09.log` (pending) | FAIL → recreate session with transcript repost; M3 model-override descoped |
| 10 | Cancel tool-running worker → terminal signal | NOT VERIFIED | `probe-10.log` (pending) | FAIL → no preemption claims; cooperative stop protocol only |
| 11 | Deny rules enforced, bypass rejected | NOT VERIFIED | `probe-11.log` (pending) | FAIL → safe-coding profile blocked; parity-only with warnings |
| 12 | Plugin exit/reload, daemon survives | NOT VERIFIED | `probe-12.log` (pending) | FAIL → daemon-owns-durability invariant unproven; M1-02 blocked |

All probes are authored as `scripts/probe-NN.ts` (runner: `bun scripts/run-probes.ts`)
and execute exclusively in the disposable dir
(`%TEMP%/opencode/swarm-probes`, override `SWARM_PROBE_DIR`).

## 3. Production-code API surface (M0-01)

- `packages/adapter-opencode/src/port.ts` — pure TypeScript interfaces
  (`CodingHarness`, `SubmitTurnRequest` with adapter-internal `externalId`,
  `EventSubscription`, etc.). **No imports, no OpenCode calls.** [DESIGN]
- §4.2 server-hook names (`ctx.command`, `ctx.session.*`, `ctx.event`,
  `ctx.permission`) appear only in comments as [OC2-DOC] citations subject to
  probe confirmation — they are not referenced by any executable code path.
- Verdict: **no undocumented API in production code** (there is no runtime
  production code yet by design; M0-02/M1-03 will add it behind this port).

## 4. Open questions carried forward

Q-01…Q-10 per spec §18 remain open; Q-01 (Plugin.define support) is decided by
probe-01, Q-04 (correlation ID) by probe-07, Q-05 (permission enforcement) by
probe-11, Q-10 (double-admission) by probes 06+08.
