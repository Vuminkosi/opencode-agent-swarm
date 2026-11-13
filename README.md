# OpenCode Swarm

OpenCode Swarm is an **OpenCode multi-agent swarm plugin and runtime** that implements
Antigravity `/swarm` behavioral parity: one `/swarm` invocation binds your current
conversation as coordinator and runs named workers, verifier(s), and a dormant monitor
against a shared board. Status: **release candidate, not production**
(see [Status + honesty](#5-status--honesty) below).

**Architecture (code-observed):** an OpenCode 2 plugin (`server` + `tui` + `rpc` parts in
`packages/plugin/`) backed by a long-lived local Bun swarm daemon (`packages/runtime/`)
whose durability layer is a SQLite journal in WAL mode (`packages/runtime/src/db/`,
migrations + atomic store). Sources: [spec](docs/plan/spec.md) §3,
`packages/plugin/src/index.ts`, `packages/runtime/src/db/store.ts`.

> Source baseline: canonical tree at `HEAD 8ccb19e` on `master`. Commit evidence is not
> release evidence — verification does not prove commit, commit does not prove release.

## 1. Quickstart

### Prerequisites

Recorded toolchain pins (confirm on your machine — no version-capture log ships in this repo):

| Tool | Pin | Where it is recorded |
|---|---|---|
| Bun | 1.4.4 | `.github/workflows/publish.yml` (CI setup), `bun-types` devDependencies |
| Node | 24 | `.github/workflows/publish.yml` (`actions/setup-node@v6`, npm compat) |
| TypeScript | 5.9.2 | Root `package.json` `devDependencies` |
| `@opencode/plugin` | 2.2.7 | `packages/plugin/package.json` `dependencies` |
| OpenCode CLI | 2.2.7 | Source-baseline contract per [install.md](docs/install.md) §1 — **UNCONFIRMED**, confirm with `opencode --version` |

Windows PowerShell is used for all commands below. No global installs beyond the pinned
toolchain are assumed. Full detail: [docs/install.md](docs/install.md).

### Install

```powershell
# From the repo root:
bun install --frozen-lockfile
```

This installs the `packages/*` workspaces exactly as locked. **Unexecuted here** — run it
yourself on a clean machine.

### Typecheck and probes (existence-verified scripts, unexecuted here)

```powershell
# Root script (verifies the frozen adapter port package):
bun run typecheck
# Expands to: tsc --noEmit -p packages/adapter-opencode/tsconfig.json

# Full 12-probe compatibility run (disposable dir only, never the canonical tree):
bun scripts/run-probes.ts
```

`bun run typecheck` and `bun scripts/run-probes.ts` are the only two scripts in the root
`package.json` — no root `test`, `build`, or `lint` script exists. Per-package
`bun run --cwd <pkg> typecheck` scripts exist for every workspace; only
`packages/board-terminal` additionally defines a `test` script
(`bun test src/__tests__/board.test.ts`). Everything else runs via `bun test <path>`
directly. See [For contributors](#2-for-contributors) below.

### The `/swarm` command family

Type `/swarm help` at any time for the full reference
(`SWARM_HELP` in `packages/plugin/src/commands/swarm.ts`). Every row below is
source-observed in `parseSwarmInput` + `SwarmCommand.execute` — nothing invented:

| Command | One-line example | What it does |
|---|---|---|
| `/swarm <requirement>` | `/swarm Add tests to two independent fixture modules` | Binds this session as coordinator, starts two workers (coordinator-only) |
| `/swarm status [id]` | `/swarm status swarm-9` | Zero-model-call snapshot from saved daemon state |
| `/swarm board [id]` | `/swarm board swarm-9` | Board posts via the versioned read, plus the terminal-board fallback hint |
| `/swarm agents [id]` | `/swarm agents swarm-9` | Roster with each worker's session and a navigation hint |
| `/swarm message @worker <text>` | `/swarm message @worker-a keep going` | Private note to one worker; never appears on the shared board |
| `/swarm pause <id>` | `/swarm pause swarm-9` | Halts new work from starting; running work finishes (coordinator-only) |
| `/swarm resume <id>` | `/swarm resume swarm-9` | Releases the gate; queued work resumes in order (coordinator-only) |
| `/swarm stop <id>` | `/swarm stop swarm-9` | Durable cancel; a stopped swarm never resumes, work is preserved (coordinator-only) |
| `/swarm help` | `/swarm help` | Prints the whole family |

Notes: matching is case-insensitive (`/swarm STATUS` works); bare `/swarm` with nothing
after it is a usage error; an omitted role defaults to least privilege (`researcher`).

### Reading the board

The **terminal board is the working surface today** (contract-approved fallback per
spec §4.4). Native TUI embedding (board page, panes, `Alt+S`) is wired but
**NOT VERIFIED live** — mounting it needs a plugin-config change outside any safe
default. The documented fallback command (the `TERMINAL_BOARD_FALLBACK` constant in
`packages/plugin/src/rpc.ts`) is:

```powershell
bunx opencode-swarm board --swarm <id>
```

Copy it from `/swarm board` output rather than retyping it. Board reads are
zero-inference and read-only by construction: posts in order with an unread divider,
roster, delivery/wake status, tasks and verification lines. Daemon config
(`swarm.config.json`: loopback `127.0.0.1:4788` default, bearer token minimum
16 characters) is covered in [docs/install.md](docs/install.md) §5.

> `bunx` board invocations above are **unexecuted examples**. No `bin` entry wiring an
> `opencode-swarm` binary was observed in the workspace manifests inspected for this
> document, so first-run behavior of that exact string on your machine is **NOT VERIFIED** —
> if it does not resolve, follow [docs/user-guide-swarm.md](docs/user-guide-swarm.md) §3
> and [docs/troubleshooting.md](docs/troubleshooting.md).

### Published packages

Versioned packages publish to the GitHub Packages npm registry
(`https://npm.pkg.github.com`) under the `@vuminkosi` scope via the `publish` workflow
(`.github/workflows/publish.yml`: GitHub Release `published` or manual dispatch → verify
job → publish job; `private: true` packages are skipped). Consumers point the scope at
the registry with an `.npmrc` line (from [docs/publishing.md](docs/publishing.md) §5 and
the workflow's registry step):

```ini
@vuminkosi:registry=https://npm.pkg.github.com
```

Publishable workspaces (all `public`, `provenance: true`, `files: ["src"]`):
`@vuminkosi/protocol`, `@vuminkosi/runtime`, `@vuminkosi/verification`,
`@vuminkosi/adapter-opencode`, `@vuminkosi/plugin`, `@vuminkosi/board-terminal`,
`@vuminkosi/git-workspaces`. `apps/swarmctl` (`@vuminkosi/swarmctl`) stays
`private: true` and is skipped by the publish loop. Full procedure:
[docs/publishing.md](docs/publishing.md).

## 2. For contributors

### Repo layout (one line each, from the actual tree)

```text
opencode-swarm/
  apps/swarmctl/          # Bun CLI: zero-token daemon status via /healthz + snapshot (private, unpublished)
  packages/plugin/        # OpenCode 2 server/TUI/RPC package: /swarm command, swarm_health, versioned SwarmRpc
  packages/protocol/      # Versioned wire protocol: Zod-single-source schemas (Swarm/Member/Task/BoardPost/...)
  packages/runtime/       # Bun daemon: SQLite journal, wake dispatcher, scheduler, coordinator service
  packages/adapter-opencode/ # Frozen harness adapter port: dependency-free TypeScript interfaces only
  packages/git-workspaces/# Task-scoped Git worktrees + path policy (safe-coding profile)
  packages/verification/  # Actual test runner: task acceptance command in tmp worktree cwd
  packages/board-terminal/# Standalone terminal board: chronological public stream, zero inference
  tests/e2e/              # End-to-end suites (disposable fixtures, fake harness)
  tests/fault-injection/  # Crash replay, rate-limit/quota, M8 release-hardening suites
  docs/                   # Install, user guide, troubleshooting, contracts, evidence, release records
  docs/plan/spec.md       # The approved technical design + phased plan (contract source)
  docs/evidence/          # Per-milestone evidence records (M2–M8 + live probes)
  scripts/                # 12 compatibility probes + runner, live-CD harness, M1 demo, M7 bench
  examples/two-module-fixture/ # Disposable two-module demonstrator fixture
```

### Build / test / verify commands (copied from manifests — only scripts that exist)

Root `package.json` defines exactly two scripts — there is no root `build`, `test`, or
`lint`:

```powershell
bun run typecheck   # tsc --noEmit -p packages/adapter-opencode/tsconfig.json
bun scripts/run-probes.ts  # via root "probes" script; disposable dir only (%TEMP%/opencode/swarm-probes, override SWARM_PROBE_DIR)
```

CI (`.github/workflows/publish.yml`, verify job) runs `bun install --frozen-lockfile`,
`tsc --noEmit` for the protocol/runtime/adapter-opencode/plugin tsconfigs, then a scoped
`bun test` list (plugin bootstrap, protocol + runtime DB tests, daemon, config, adapter
bridge Tier-A, swarm-service, `/swarm` command tests, the two-module fixture,
`tests/e2e/`). Per-package `typecheck` scripts exist in every workspace; reproduce any of
them with, e.g. `bunx tsc --noEmit -p packages/runtime/tsconfig.json`. Only
`packages/board-terminal` defines a `test` script; elsewhere invoke `bun test <path>`
directly (see [docs/install.md](docs/install.md) §7).

Reported suite state (supplied handoff evidence, **not** re-run for this document): full
suite **514 passed / 0 failed / 14054 assertions / 36 files**, `tsc` 9/9 clean —
see [docs/evidence/m8-release-qualification.md](docs/evidence/m8-release-qualification.md)
§10.4, honestly labeled supplied-not-fresh with unexecuted repro commands.

### Contributor essentials

- Colocated tests ship in the tarballs: test files live beside their sources under each
  package's `src/` (e.g. `src/__tests__/`, `src/*.test.ts`), and every publishable
  manifest sets `"files": ["src"]`.
- Migrations are up-only; on failure restore the SQLite file from backup — never
  hand-edit `schema_migrations` ([docs/recovery-runbook.md](docs/recovery-runbook.md)).
- Stuck? Start at [docs/troubleshooting.md](docs/troubleshooting.md), then the
  [user guide](docs/user-guide-swarm.md).

## 3. Docs index

All targets below were verified to exist on disk at this document's baseline:

- Start here: [install.md](docs/install.md) · [user-guide-swarm.md](docs/user-guide-swarm.md) · [troubleshooting.md](docs/troubleshooting.md) · [recovery-runbook.md](docs/recovery-runbook.md)
- Contracts: [spec](docs/plan/spec.md) (design baseline) · [api-compatibility.md](docs/api-compatibility.md) · [api-probe-results.md](docs/api-probe-results.md) (all 12 probes NOT VERIFIED) · [test-evidence.md](docs/test-evidence.md) · [m0-implementation-report.md](docs/m0-implementation-report.md) · [m1-followups.md](docs/m1-followups.md)
- Compatibility + milestones: [compatibility-report.md](docs/compatibility-report.md) · [milestone-matrix.md](docs/milestone-matrix.md)
- Publishing + releases: [publishing.md](docs/publishing.md) · [release-decision.md](docs/release/release-decision.md) · [release-blockers.md](docs/release/release-blockers.md) · [final-review-matrix.md](docs/release/final-review-matrix.md)
- Evidence: [m2-wake-engine](docs/evidence/m2-wake-engine.md) · [m3-coordination](docs/evidence/m3-coordination.md) · [m4-safe-coding](docs/evidence/m4-safe-coding.md) · [m5-robustness](docs/evidence/m5-robustness.md) · [m6-parity-ux](docs/evidence/m6-parity-ux.md) · [m7-scale-codex](docs/evidence/m7-scale-codex.md) · [m8-release-qualification](docs/evidence/m8-release-qualification.md) · [live-probe-02](docs/evidence/live-probe-02-muse-contributor.md)
- Demo: [two-module-fixture](examples/two-module-fixture/README.md) · pipeline: [.github/workflows/publish.yml](.github/workflows/publish.yml)

## 4. Compatibility and requirements

- OpenCode 2.x plugin surface only — never the legacy `@opencode-ai/*` generation
  (spec §1 version warning; no production code references it).
- The `Codex` adapter was **removed by architecture decision**: the fail-closed
  `packages/adapter-codex` stub (M7) was deleted at `3589e2b`; the OpenCode harness is
  the execution backend via the `CodingHarness` port. Historical rationale is retained in
  [m7-scale-codex](docs/evidence/m7-scale-codex.md) §4 — it is history, not current
  implementation. Do not document Codex support as available.
- Live TUI mount is a **documented fallback posture** (terminal board primary,
  §1 above); live turns, provider 402-shape, spend, and the 10-minute idle window are
  **NOT VERIFIED** (no live server, no inference spend authorized).

## 5. Status + honesty

- **Release state: RELEASE CANDIDATE, not production.** Recorded decision
  `RELEASE_CANDIDATE_BLOCKED (Option A — No release)` in
  [docs/release/release-decision.md](docs/release/release-decision.md):
  implementation-complete, release-unproven. Blocking gaps: fresh-install smoke/E2E
  (spec §14 M8 gate), live inference / provider 402-shape / spend, live TUI mount,
  live idle window. Do not describe this project as shipped, production-ready, or supported.
- **What is IMPLEMENTED (code-observed at `8ccb19e`):** plugin `/swarm` family + versioned
  RPC + native TUI wiring, Bun daemon + SQLite journal, wake/monitor/scheduler policies,
  worktree manager + verification runner, terminal board, probes harness code.
- **What is VERIFIED-supplied (not freshly executed here):** 514/0/14054/36 full suite,
  `tsc` 9/9, frozen-adapter zero-import — supplied M8-FIX handoff evidence per
  [m8-release-qualification §10.4](docs/evidence/m8-release-qualification.md);
  frozen-install determinism per the release decision record.
- **What is NOT VERIFIED:** every live-server probe outcome (probes 01–12, no
  `probe-NN.log` in repo), live TUI mount, live turns/overlap, provider 402 shaping,
  spend, fresh-install E2E, and every `bunx`/install/typecheck/test command quoted above
  (unexecuted in this document — run them yourself and keep the logs).
- **Colocated tests ship in tarballs** via `"files": ["src"]` (see §2) — stated as
  manifest fact, not as a pass claim.
- No license file ships in this tree (no `LICENSE*`/`LICENCE*` found), so none is
  claimed or linked here.

No screenshots, endpoints, deployment behavior, CLI flags beyond the sourced
`swarmctl status`/`run-probes` shapes, version promises beyond the recorded pins, or
support promises are claimed in this document.
