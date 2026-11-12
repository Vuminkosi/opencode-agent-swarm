# Troubleshooting — swarm commands + board

> **Document status: APPROVED CONTRACT + IMPLEMENTED (code-observed) /
> NOT VERIFIED (live repro).** Every entry below describes a **real,
> source-evidenced** failure mode — observed in the repo, its tests, its
> harness, or its git state. No entry invents an error, a flag, or a fix.
> Unexecuted commands are labeled as such. Source baseline: canonical repo
> at `HEAD 7d4d79b42b6a775a31fbe9bfca458045714a2ef4`. For install and
> daemon config, see [install.md](install.md) (not duplicated here). For
> board semantics, see the [user guide](user-guide-swarm.md) and
> [m6-parity-ux evidence](evidence/m6-parity-ux.md).

How to use this page: find your symptom, check the cause against the
evidence pointer, apply the fix. Fixes are the smallest safe correction;
escalation criteria are stated where the failure is fail-closed by
design.

## 1. Install fails on the lockfile

**Symptom:** `bun install --frozen-lockfile` exits nonzero and reports
that the lockfile is out of sync with a workspace manifest.

**Cause:** `--frozen-lockfile` installs exactly what is locked (root
`package.json`, `workspaces packages/*`) and refuses to resolve drift —
a manifest changed without its lockfile entry, per
[install.md](install.md) §2 and `.github/workflows/publish.yml`, which
uses the same flag in CI.

**Fix (unexecuted):** do not hand-edit the lockfile. Update the manifest
deliberately, regenerate the lockfile with a normal install, then re-run
the frozen command:

```powershell
bun install
bun install --frozen-lockfile
```

If CI passes the frozen install and your machine does not, your checkout
is behind or ahead of the locked tree — reconcile with the canonical
branch before retrying.

## 2. `npx tsc` resolves the wrong toolchain

**Symptom:** typechecking via `npx tsc` behaves unexpectedly (missing
binary shim, wrong TypeScript version, or resolution outside the repo
toolchain).

**Cause:** the repo toolchain is Bun-first with a pinned TypeScript
(`5.9.2` devDependency, per [install.md](install.md) §1). The supported
typecheck path is the workspace script, and CI invokes `bunx tsc`
per-package (`.github/workflows/publish.yml`). `npx` resolves outside
that pinned path.

**Fix (unexecuted):** use the documented commands only:

```powershell
bun run typecheck
bunx tsc --noEmit -p packages/runtime/tsconfig.json
```

Expected result: exit 0 with no output. Anything else is a real type
error to fix, not a toolchain quirk.

## 3. Provider returns 402 — member `quota_paused`, never retries

**Symptom:** a worker stops getting new turns; its state reads
`quota_paused`. Logs or harness output reference HTTP 402 / quota.

**Cause:** the dispatcher maps 402 to quota exhaustion and parks the
member after **exactly one transport attempt with zero retries** — by
design, so the swarm can never spend past the cap
(`tests/fault-injection/rate-quota.test.ts`,
`docs/evidence/m2-wake-engine.md`,
`scripts/live-cd-harness.README.md`). Resume happens only on documented
triggers (new post, model switch, user input) — never on elapsed time.

**Fix:** this is fail-closed, not a bug to retry around.

1. Top up or otherwise restore the provider balance out of band.
2. Drive one of the documented resume triggers (post an update, switch
   the model, or steer the worker).
3. Never force retries against a 402 — the one-attempt gate is the spend
   backstop. The exact provider-side 402 shape stays NOT VERIFIED (F-04,
   carried); see [m6-parity-ux](evidence/m6-parity-ux.md) §7.

## 4. Run aborts on a `permission.asked` event

**Symptom:** the live harness (or a guarded run) aborts after a
`permission.asked` payload, classifying the scope as unsafe.

**Cause:** the harness treats permission prompts with an unsafe scope as
fail-closed abort conditions (`scripts/live-cd-harness.ts` unsafe-scope
classifier; `scripts/live-cd-harness.README.md`). The run stops rather
than answering a prompt it cannot prove safe.

**Fix:** review the flagged scope in the run output. If the request is
genuinely safe, re-run with an explicitly narrowed, pre-approved scope;
if it is not, change the task so the prompt never arises. Do not
auto-approve permission prompts to get a run unstuck.

## 5. Daemon port conflict (default `127.0.0.1:4788`)

**Symptom:** the daemon fails to start or bind, or a second instance
reports the address in use.

**Cause:** `packages/runtime/src/config.ts` defaults to loopback-only
`127.0.0.1` port `4788`. Only one process can hold that socket; a stale
daemon from an earlier run is the usual holder.

**Fix (unexecuted):**

1. Check what is listening (PowerShell):
   `Get-NetTCPConnection -LocalPort 4788` and stop the stale process, or
2. point this instance at a free port in `swarm.config.json`
   (`runtime.port`), keeping `runtime.listen` on loopback.

Non-loopback `listen` values are **refused at startup** without an
explicitly configured file token (`auth.token`) — see
[install.md](install.md) §5. Do not bind a public interface to dodge a
local conflict.

## 6. Stray `NUL` file at the repo root

**Symptom:** `git status --short` shows an untracked entry `?? NUL` at
the repo root.

**Cause:** a Windows reserved-name artifact (`NUL`) created as junk. It
is in no commit, is cited as noise in
[m6-parity-ux](evidence/m6-parity-ux.md) (§1, §7) and the
[compatibility-report](compatibility-report.md#114-housekeeping-note), and
was deliberately left untouched by those lanes.

**Fix:** it is untracked noise — never `git add` or commit it. Leave it
in place or delete it locally through Explorer; either way it is not
evidence and not part of any deliverable.

## 7. `.env` and daemon token handling

**Symptom:** uncertainty about where the daemon bearer token lives, or a
secret appearing in status/diff output.

**Cause:** the daemon requires a bearer token of **minimum 16
characters**, supplied either as `auth.token` in `swarm.config.json` or
via the `SWARM_DAEMON_TOKEN` environment variable
(`packages/runtime/src/config.ts`, [install.md](install.md) §5). `.env`
files are git-ignored (`.gitignore`), so a missing-token startup error
almost always means neither source is set in the current shell.

**Fix (unexecuted):**

```powershell
$env:SWARM_DAEMON_TOKEN = "<at-least-16-chars-do-not-commit>"
```

Never commit a real token, a real connection string, or a filled-in
`.env`. Placeholders only in docs and examples. If a secret ever lands
in the working tree, rotate it at the provider before anything else.

## 8. `daemon_unwired` / `stale_schema` from board reads

**Symptom:** a versioned board read answers `daemon_unwired` (for
`boardSnapshot` / `boardPosts`) or `stale_schema`.

**Cause:** both are fail-closed by design in
`packages/plugin/src/rpc.ts` (`createSwarmRpcHandlers`): `daemon_unwired`
means no daemon reader is injected in this slice, and `stale_schema`
means the caller's `schemaVersion` differs from `0.0.1`.

**Fix:** for `daemon_unwired`, use the terminal-board fallback
(`bunx opencode-swarm board --swarm <id>`) — do not invent a fetch path
around it. For `stale_schema`, make sure plugin and daemon come from the
same checkout, then retry once. See the [user
guide](user-guide-swarm.md#4-native-board-page-not-verified--know-what-to-expect).

## Gaps

1. No entry above was live-reproduced in this task (link check only);
   each is grounded in the cited source file, test, or recorded git
   state.
2. No new error modes are claimed. If you hit a symptom not listed here,
   capture the exact message, the command, and the HEAD, and escalate to
   the orchestrator rather than guessing a fix.
