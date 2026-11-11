# Probe logs (M0-01)

Execution probes run in the **disposable** dir (`%TEMP%/opencode/swarm-probes`,
override with `SWARM_PROBE_DIR`), never in the canonical tree. Each
`probe-NN.ts` run appends a timestamped `probe-NN.log` here plus a
`VERDICT <PASS|FAIL|NOT VERIFIED> — <reason>` line.

## Current status (authored, not yet executed)

| Probe | Verdict | Evidence |
|---|---|---|
| 01 | NOT VERIFIED | `bun install` + `tsc` in disposable dir pending (no shell in authoring worker) |
| 02–12 | NOT VERIFIED | require live pinned OpenCode server / provider credentials; scripts record resumption env vars |

See `docs/api-compatibility.md` for the per-probe verdict table and fallbacks.
