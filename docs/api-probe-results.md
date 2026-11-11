# API probe results — spec §4.6 probes 01–12 (M0-01)

Executable-probe record for the 12 required compatibility probes in
[spec §4.6](./plan/spec.md#46-required-executable-compatibility-probes-m0).
Companion verdict table: [docs/api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46).

> **Document status: IMPLEMENTED (probe harness code exists) / NOT VERIFIED
> (all live-server probe outcomes).** No probe in this file has been executed
> against a live OpenCode server in this task — no execution was performed.
> There are **zero FAIL rows**: no failure was observed, and none is invented.
> Toolchain/file-existence observations are **not** probe PASS verdicts.

## Claim status header

| Class | Meaning in this document | Applies to |
|---|---|---|
| APPROVED CONTRACT | Behavior the spec requires probes to confirm before production code may rely on it | All 12 probe subjects (spec §4.6) — [OC2-DOC] claims under test |
| IMPLEMENTED | Probe harness code that exists on disk and was inspected (not executed) | `scripts/probe-01.ts`…`scripts/probe-12.ts`, `scripts/probe-lib.ts`, `scripts/run-probes.ts` — [DESIGN] |
| NOT VERIFIED | No live-server evidence exists; log paths below are pending/missing | All 12 live-server probe outcomes — [PROBE] |

**Evidence-label key** (per spec §1): **[G-DOC]** = Antigravity documented
behavior · **[OC2-DOC]** = OpenCode 2 documented API/hook ·
**[DESIGN]** = our implementation decision · **[PROBE]** = requires executable
confirmation on the pinned build. Every factual claim below carries a label.

**Live-server checks: NOT VERIFIED.** No `probe-NN.log` exists in either the
disposable probe dir or `scripts/probe-logs/` (confirmed by inspection:
`scripts/probe-logs/*` matches no files) [PROBE]. No version captures exist
(`opencode --version`, `bun --version` not captured) [PROBE]. No server
behaviors are asserted [PROBE].

## 12-row verdict table

| # | Probe (spec §4.6) | Verdict | Command / env | Evidence / log | Fallback or blocking issue |
|---|---|---|---|---|---|
| 01 | Clean pinned install + no-op server plugin compile | NOT VERIFIED | `bun scripts/probe-01.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-01.log` — **missing**; `scripts/probe-logs/probe-01.log` — **missing** | FAIL → record exact tsc error, file blocking issue, M0-02 blocked |
| 02 | `/swarm` + `/swarm board` command semantics | NOT VERIFIED | `bun scripts/probe-02.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-02.log` — **missing**; `scripts/probe-logs/probe-02.log` — **missing** | Fallback: `bunx opencode-swarm board` CLI instead of TUI route (spec §4.4) |
| 03 | Native agent/model/permission enumeration | NOT VERIFIED | `bun scripts/probe-03.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-03.log` — **missing**; `scripts/probe-logs/probe-03.log` — **missing** | FAIL → M1-03 blocked; unknown IDs must fail visibly (spec §9) |
| 04 | Two sessions, concurrent prompts | NOT VERIFIED | `bun scripts/probe-04.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-04.log` — **missing**; `scripts/probe-logs/probe-04.log` — **missing** | FAIL → M1 milestone blocked; no multi-worker claims |
| 05 | Overlapping execution events (true concurrency) | NOT VERIFIED | `bun scripts/probe-05.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-05.log` — **missing**; `scripts/probe-logs/probe-05.log` — **missing** | FAIL → serialize turns; document throughput limit |
| 06 | One waiting-session prompt → exactly one turn | NOT VERIFIED | `bun scripts/probe-06.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-06.log` — **missing**; `scripts/probe-logs/probe-06.log` — **missing** | FAIL → wake dispatcher cannot claim exactly-once; quarantine path (spec §8) |
| 07 | Event shapes + admission↔completion correlation IDs | NOT VERIFIED | `bun scripts/probe-07.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-07.log` — **missing**; `scripts/probe-logs/probe-07.log` — **missing** | If no stable ID → adapter-local `externalId` + snapshot reconcile only (spec §8) |
| 08 | Mid-turn reconnect + snapshot reconcile, no duplicate completion | NOT VERIFIED | `bun scripts/probe-08.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-08.log` — **missing**; `scripts/probe-logs/probe-08.log` — **missing** | FAIL → single-flight subscription + manual review queue (M5) |
| 09 | Model switch preserves waiting-session history | NOT VERIFIED | `bun scripts/probe-09.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-09.log` — **missing**; `scripts/probe-logs/probe-09.log` — **missing** | FAIL → recreate session with transcript repost; M3 model-override descoped |
| 10 | Cancel tool-running worker → terminal signal | NOT VERIFIED | `bun scripts/probe-10.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-10.log` — **missing**; `scripts/probe-logs/probe-10.log` — **missing** | FAIL → no preemption claims; cooperative stop protocol only |
| 11 | Deny rules enforced, bypass rejected | NOT VERIFIED | `bun scripts/probe-11.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-11.log` — **missing**; `scripts/probe-logs/probe-11.log` — **missing** | FAIL → safe-coding profile blocked; parity-only with warnings |
| 12 | Plugin exit/reload, daemon survives | NOT VERIFIED | `bun scripts/probe-12.ts` · `SWARM_PROBE_DIR` | `%TEMP%/opencode/swarm-probes/probe-12.log` — **missing**; `scripts/probe-logs/probe-12.log` — **missing** | FAIL → daemon-owns-durability invariant unproven; M1-02 blocked |

**FAIL count: 0.** No probe has produced PASS or FAIL output; all 12 await
first live execution [PROBE].

## Environment and directory rule

Probes run **only** in the disposable directory — **never** in the canonical
tree [DESIGN]:

- Default dir: `%TEMP%/opencode/swarm-probes` (resolved by `probeDir()` in
  `scripts/probe-lib.ts` via `join(tmpdir(), "opencode", "swarm-probes")`)
  [DESIGN].
- Override: `SWARM_PROBE_DIR` environment variable [DESIGN].
- Each probe appends verdict-stamped lines to `<probe-dir>/probe-NN.log` via
  `log()` / `verdict()` [DESIGN].
- Verdict vocabulary is fixed: `PASS` | `FAIL` | `NOT VERIFIED`
  (`Verdict` type in `scripts/probe-lib.ts`) [DESIGN].

## Runner semantics

`bun scripts/run-probes.ts` executes `scripts/probe-01.ts`…`probe-12.ts`
**sequentially**, parses each probe's `VERDICT <v> — <reason>` line, and prints
the 12-row table [DESIGN]:

- A `FAIL` verdict **or any nonzero probe exit code** sets the runner's
  `process.exitCode = 1` — the runner fails [DESIGN].
- `NOT VERIFIED` is **intentionally non-failing**: the runner stays exit 0
  (see the `S2-1` comment in `scripts/run-probes.ts`) [DESIGN].

## Install / config snippet (UNEXECUTED example)

> The commands below were **not executed** in this task. They are the
> documented invocation shape for the test-engineer live run [DESIGN].

```powershell
# 1. Install dependencies (canonical tree)
bun install

# 2. Typecheck the adapter package
bun run typecheck
# or directly:
# tsc --noEmit -p packages/adapter-opencode/tsconfig.json

# 3. Run all 12 probes in the disposable dir (default %TEMP%/opencode/swarm-probes)
bun scripts/run-probes.ts

# 4. Same run with an explicit disposable dir
$env:SWARM_PROBE_DIR = "D:\tmp\swarm-probes"
bun scripts/run-probes.ts

# 5. Single probe (example: probe-01)
bun scripts/probe-01.ts
```

Expected artifacts after a live run: `<probe-dir>/probe-01.log` …
`<probe-dir>/probe-12.log`, each ending in a `VERDICT <v> — <reason>` line
[DESIGN]. Until those logs exist, every outcome in this file stays
NOT VERIFIED [PROBE].

## Per-probe sections

### Probe 01 — clean pinned install + no-op server plugin compile

- **Verdict: NOT VERIFIED** [PROBE]. No live log exists; no `bun` /
  `opencode` version capture exists.
- **Command (unexecuted):** `bun scripts/probe-01.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only (`probe-01/` subdir under the probe dir for
  the skeleton `package.json` + `index.ts`); registry access required for
  `bun pm view @opencode/plugin versions --json` [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-01.log`
  (**missing**); `scripts/probe-logs/probe-01.log` (**missing**, referenced by
  [docs/api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [PROBE].
- **Harness code (inspected, not executed):** `scripts/probe-01.ts` writes a
  `probe-01-noop-plugin` skeleton (`@opencode/plugin: TBD-BY-PROBE-01`,
  `typescript: 5.9.2` [DESIGN]), emits NOT VERIFIED when `bun` is absent or
  `node_modules/@opencode/plugin` is missing, PASS only on `tsc --noEmit`
  exit 0, FAIL otherwise. Representative of the probe pattern [DESIGN]. This
  file inspection is **not** a probe PASS.
- **Contract context:** `@opencode/plugin` **2.2.7** is pinned in
  `packages/plugin/package.json` (M0-02 stub context); probe-01 must resolve
  and confirm the compatible 2.x pin from the registry — never
  `@opencode-ai/*` (spec §1 version warning) [OC2-DOC] [DESIGN] [PROBE].
- **Fallback / blocking:** on FAIL, record the exact tsc error, file a
  blocking issue, M0-02 blocked
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 02 — `/swarm` + `/swarm board` command semantics

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-02.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-02.log`
  (**missing**); `scripts/probe-logs/probe-02.log`
  (**missing**) [PROBE].
- **Contract context:** verifies the `/swarm` command and `/swarm board`
  argument semantics in the TUI (spec §4.6(2), §4.4) — [OC2-DOC] surface
  (`ctx.command.transform` / `ctx.command.list`) subject to probe
  confirmation [PROBE].
- **Fallback / blocking:** `bunx opencode-swarm board` CLI instead of a TUI
  route (spec §4.4)
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 03 — native agent/model/permission enumeration

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-03.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-03.log`
  (**missing**); `scripts/probe-logs/probe-03.log`
  (**missing**) [PROBE].
- **Contract context:** enumerates available native agents and their
  effective models/permissions (spec §4.6(3), §9) [OC2-DOC] [PROBE].
- **Fallback / blocking:** on FAIL, M1-03 blocked; unknown IDs must fail
  visibly (spec §9)
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 04 — two sessions, concurrent prompts

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-04.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-04.log`
  (**missing**); `scripts/probe-logs/probe-04.log`
  (**missing**) [PROBE].
- **Contract context:** creates two independent sessions, selects two native
  agent IDs, prompts concurrently (spec §4.6(4)); gates the M1-03
  session-bridge work [OC2-DOC] [DESIGN] [PROBE].
- **Fallback / blocking:** on FAIL, M1 milestone blocked; no multi-worker
  claims
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 05 — overlapping execution events (true concurrency)

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-05.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-05.log`
  (**missing**); `scripts/probe-logs/probe-05.log`
  (**missing**) [PROBE].
- **Contract context:** confirms true concurrency by overlapping
  `session.execution.started` → terminal execution events (spec §4.6(5))
  [OC2-DOC] [PROBE].
- **Fallback / blocking:** on FAIL, serialize turns; document throughput
  limit
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 06 — one waiting-session prompt → exactly one turn

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-06.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-06.log`
  (**missing**); `scripts/probe-logs/probe-06.log`
  (**missing**) [PROBE].
- **Contract context:** sends a prompt to a waiting session and confirms
  **one** new model turn (spec §4.6(6)); informs the exactly-once question and
  the §8 crash-window analysis [OC2-DOC] [DESIGN] [PROBE].
- **Fallback / blocking:** on FAIL, the wake dispatcher cannot claim
  exactly-once; use the quarantine path (spec §8)
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 07 — event shapes + admission↔completion correlation IDs

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-07.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-07.log`
  (**missing**); `scripts/probe-logs/probe-07.log`
  (**missing**) [PROBE].
- **Contract context:** captures all event shapes and detects which IDs
  correlate prompt admission with execution completion (spec §4.6(7));
  decides spec open question Q-04 (correlation ID) [OC2-DOC] [PROBE].
- **Fallback / blocking:** if no stable ID exists → adapter-local
  `externalId` + snapshot reconcile only (spec §8)
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 08 — mid-turn reconnect + snapshot reconcile, no duplicate completion

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-08.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-08.log`
  (**missing**); `scripts/probe-logs/probe-08.log`
  (**missing**) [PROBE].
- **Contract context:** reconnects the event listener mid-turn, reconciles
  via session snapshot, and proves duplicate completion is prevented
  (spec §4.6(8)); informs Q-10 (double-admission) with probe 06
  [OC2-DOC] [DESIGN] [PROBE].
- **Fallback / blocking:** on FAIL → single-flight subscription + manual
  review queue (M5)
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 09 — model switch preserves waiting-session history

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-09.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-09.log`
  (**missing**); `scripts/probe-logs/probe-09.log`
  (**missing**) [PROBE].
- **Contract context:** changes the model for a waiting session and verifies
  history is retained (spec §4.6(9)) [OC2-DOC] [PROBE].
- **Fallback / blocking:** on FAIL → recreate session with transcript
  repost; M3 model-override descoped
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 10 — cancel tool-running worker → terminal signal

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-10.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-10.log`
  (**missing**); `scripts/probe-logs/probe-10.log`
  (**missing**) [PROBE].
- **Contract context:** cancels a tool-running worker and validates the
  final failure/interruption signal (spec §4.6(10)) [OC2-DOC] [PROBE].
- **Fallback / blocking:** on FAIL → no preemption claims; cooperative stop
  protocol only
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 11 — deny rules enforced, bypass rejected

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-11.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-11.log`
  (**missing**); `scripts/probe-logs/probe-11.log`
  (**missing**) [PROBE].
- **Contract context:** enforces deny rules for the canonical worktree and
  verifies denied edit/bypass behavior (spec §4.6(11)); decides Q-05
  (permission enforcement) [OC2-DOC] [PROBE].
- **Fallback / blocking:** on FAIL → safe-coding profile blocked;
  parity-only with warnings
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

### Probe 12 — plugin exit/reload, daemon survives

- **Verdict: NOT VERIFIED** [PROBE].
- **Command (unexecuted):** `bun scripts/probe-12.ts` with
  `SWARM_PROBE_DIR` optionally set [DESIGN].
- **Env:** disposable dir only [DESIGN].
- **Evidence / log:** `%TEMP%/opencode/swarm-probes/probe-12.log`
  (**missing**); `scripts/probe-logs/probe-12.log`
  (**missing**) [PROBE].
- **Contract context:** verifies the plugin process can exit/reload while
  the daemon continues running (spec §4.6(12)); proves the
  daemon-owns-durability invariant for M1-02 [DESIGN] [PROBE].
- **Fallback / blocking:** on FAIL → daemon-owns-durability invariant
  unproven; M1-02 blocked
  ([api-compatibility.md §2](api-compatibility.md#2-per-probe-verdicts-spec-46))
  [DESIGN].

## Factual gaps (missing evidence)

1. All 12 `probe-NN.log` files are missing — no live execution has occurred
   [PROBE].
2. No `opencode --version` / `bun --version` captures exist; pinned versions
   in [api-compatibility.md §1](api-compatibility.md#1-pinned-version-table)
   remain UNCONFIRMED candidates [PROBE].
3. `@opencode/plugin` registry resolution (probe-01's `bun pm view` step)
   has not run; the 2.2.7 pin lives in the M0-02 plugin stub, not in a probe
   log [PROBE].
4. No FAIL was observed — but absence of logs is **not** evidence of future
   success. The first live `bun scripts/run-probes.ts` run may surface FAILs
   that supersede this record [PROBE].

## References

- Spec: [./plan/spec.md](./plan/spec.md) (§4.6 probes; §1 evidence labels;
  §4.4 board fallback; §8 wake/dedupe semantics; §9 agent/permission rules)
- Verdict table: [api-compatibility.md](api-compatibility.md) §2
- Harness: `../scripts/probe-lib.ts`, `../scripts/run-probes.ts`,
  `../scripts/probe-01.ts`…`../scripts/probe-12.ts` (relative to repo root;
  `scripts/` was inspected, not modified)
