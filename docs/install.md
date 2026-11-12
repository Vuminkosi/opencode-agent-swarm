# Install and first checks

> **Document status: APPROVED CONTRACT + IMPLEMENTED (not independently verified here).**
> Live-server probe outcomes: **NOT VERIFIED** — no live server was contacted and no
> inference was run for this document. Command examples below are **unexecuted** unless
> you run them yourself. Source baseline: canonical repo at `HEAD 2cfec1c`
> (chain `56d22a2`→`1c88f0f`→`4e61a58`→`5f2c9c3`→`2cfec1c`); commit IDs are the
> source baseline only, not a release claim.

Audience: a new developer or operator who needs a clean install, daemon config,
and first health checks. For probe semantics and verdict history, see
[api-compatibility.md](api-compatibility.md) and
[api-probe-results.md](api-probe-results.md) (not duplicated here).

## 1. Prerequisites

| Tool | Pinned version | Evidence |
|---|---|---|
| OpenCode CLI | 2.2.7 | source-baseline contract; confirm with `opencode --version` on your machine |
| Bun | 1.4.4 | source-baseline contract; confirm with `bun --version` |
| TypeScript | 5.9.2 | `package.json` `devDependencies` |
| `@opencode/plugin` | 2.2.7 | `packages/plugin/package.json` `dependencies` |

Windows PowerShell is used for all commands below. No global installs beyond the
pinned toolchain are assumed.

## 2. Install

```powershell
# From the repo root:
bun install --frozen-lockfile
```

`bun install --frozen-lockfile` installs the `packages/*` workspaces exactly as
locked (root `package.json`: `name opencode-swarm`, `workspaces packages/*`).
**NOT VERIFIED here** — this document's author did not execute the install.

## 3. Typecheck

```powershell
# Root script (verifies the frozen adapter port package):
bun run typecheck
# Expands to: tsc --noEmit -p packages/adapter-opencode/tsconfig.json
```

Per-package equivalents (each package also defines its own `typecheck` script):

```powershell
bun run --cwd packages/adapter-opencode typecheck
bun run --cwd packages/protocol typecheck
bun run --cwd packages/runtime typecheck
bun run --cwd packages/plugin typecheck
```

Expected result: exit 0 with no output. **NOT VERIFIED here** — unexecuted in
this task.

## 4. Compatibility probes

Probes execute **only** in a disposable directory — never in the canonical
tree. The directory is resolved by `probeDir()` in `scripts/probe-lib.ts`:

- Default: `%TEMP%/opencode/swarm-probes` (`join(tmpdir(), "opencode", "swarm-probes")`).
- Override: `SWARM_PROBE_DIR` environment variable.

```powershell
# Full 12-probe run (sequential; prints a 12-row verdict table):
bun scripts/run-probes.ts

# Same run with an explicit disposable dir:
$env:SWARM_PROBE_DIR = "D:\tmp\swarm-probes"
bun scripts/run-probes.ts

# Single probe (example):
bun scripts/probe-01.ts
```

Runner semantics (`scripts/run-probes.ts`): a `FAIL` verdict or any nonzero
probe exit fails the runner (`process.exitCode = 1`); `NOT VERIFIED` is
intentionally non-failing. Each probe appends to
`<probe-dir>/probe-NN.log` via `log()` / `verdict()`; the verdict vocabulary
is fixed (`PASS` | `FAIL` | `NOT VERIFIED`).

**Live-server probe outcomes: NOT VERIFIED.** All 12 live outcomes are
unexecuted here — running them may contact a live OpenCode server and consume
inference. See [api-probe-results.md](api-probe-results.md) for the per-probe
record and fallbacks.

## 5. Daemon config (`swarm.config.json`)

The daemon reads its own validated file `swarm.config.json` — not an
OpenCode-provided config surface (`packages/runtime/src/config.ts`).

| Setting | Contract |
|---|---|
| `schemaVersion` | Must equal `1` (`SCHEMA_VERSION = 1` in `packages/protocol/src/version.ts`); receivers reject unknown versions |
| `runtime.listen` / `runtime.port` | Defaults `127.0.0.1` / `4788` (loopback-only) |
| `runtime.databasePath` | Required; path to the SQLite journal file |
| `auth.token` or `SWARM_DAEMON_TOKEN` | Bearer token, **minimum 16 characters**; required at startup |
| Non-loopback listen | **Refused at startup** without an explicitly configured file token (`auth.token`) |
| `mode` | `"parity"` (default) or `"safe-coding"` |

Minimal example (replace the placeholder with a real secret — never commit one):

```json
{
  "schemaVersion": 1,
  "runtime": {
    "listen": "127.0.0.1",
    "port": 4788,
    "databasePath": "./data/swarm.db"
  },
  "mode": "parity",
  "auth": { "token": "<at-least-16-chars-do-not-commit>" }
}
```

Environment alternative to `auth.token` (same 16-character floor):

```powershell
$env:SWARM_DAEMON_TOKEN = "<at-least-16-chars-do-not-commit>"
```

Auth behavior (`packages/runtime/src/app.ts`): `GET /healthz` is unauthenticated
and returns `{status, schemaVersion, protocolVersion}`; every `/v1/*` route
requires `Authorization: Bearer <token>` (401 otherwise) and rejects
non-loopback `Origin` values (403).

## 6. Plugin load (no inference claim)

The plugin (`packages/plugin/src/index.ts`, entry `@opencode-swarm/plugin`)
registers a no-op `/swarm` command and a `swarm_health` tool, then returns a
teardown that unsubscribes registrations in reverse order. The `swarm_health`
tool returns a static payload shaped like `GET /healthz`
(`{status, schemaVersion, protocolVersion}`) and performs **zero model
inference** — it never calls `session.prompt`, `experimental.generate`, or any
network endpoint. No LLM polling or event-forwarding loop is included.

No load or inference claim is made here: this document does not assert the
plugin was loaded against a live server in this task (**NOT VERIFIED**).

## 7. Tests

Tests use Bun's built-in runner. Exactly one package defines a `test` script
(`packages/board-terminal`: `bun test src/__tests__/board.test.ts`); the
other packages define none, so invoke `bun test` directly for those:

```powershell
# Whole repo (from the repo root):
bun test

# Single package without its own `test` script (example):
bun test packages/runtime

# The one package-scoped script:
bun run --cwd packages/board-terminal test
```

Test files live beside their sources (for example
`packages/runtime/src/config.test.ts`,
`packages/protocol/src/__tests__/schemas.test.ts`,
`packages/plugin/src/index.test.ts`). **NOT VERIFIED here** — no suite was
executed for this document; run the commands above to produce your own results.

## Claim-status summary

- **APPROVED CONTRACT + IMPLEMENTED:** prereq pins, install/typecheck/probe
  commands, daemon config shape (loopback default, token floor, non-loopback
  refusal), `healthz` shape, plugin no-inference design. Each was read from the
  listed source file, not executed.
- **NOT VERIFIED:** every live-server probe outcome (probes 01–12), install /
  typecheck / test pass results on your machine, and any live daemon or plugin
  load. No `probe-NN.log` evidence was produced in this task.

## Gaps

1. No command in this document was executed here — first `bun install
   --frozen-lockfile`, `bun run typecheck`, `bun scripts/run-probes.ts`, and
   `bun test` results on a clean machine are still pending (owner: reader /
   test-engineer live run).
2. No `opencode --version` / `bun --version` capture exists in this task.
3. The daemon start command is intentionally not documented — no start-script
   evidence was in scope; do not invent CLI flags.
