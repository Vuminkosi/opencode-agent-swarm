# adapter-codex — M7-02 probe (NOT VERIFIED, fail-closed)

## Verdict

**NOT VERIFIED — no Codex transport implemented.** This package is a
fail-closed stub: `src/codex-harness.ts` satisfies the `CodingHarness` *type*
from `packages/adapter-opencode/src/port.ts` (M1-03, C-HARNESS-01) so
port-shape compatibility is compile-checked, but **every method throws
`CodexNotImplementedError`**. Zero fake turns, zero network, zero child
processes. The OpenCode default (`OpenCodeHarness`, `backend: "opencode"`)
is untouched — nothing in this package registers, shadows, or replaces it.

## Probe log (2026-11-12, baseline `f7237bf`)

All probes were read-only. Nothing was installed
(no `bun add` / `npm install` / Codex install).

| # | Command (local, no mutate) | Result |
|---|----------------------------|--------|
| 1 | `codex --version` | `codex-cli 0.167.0` — CLI **present** (pre-existing at `C:\Users\Vuminkosi\AppData\Roaming\npm\codex`) |
| 1b | `where.exe codex` | Confirms the npm-shimmed install above |
| 2 | `codex --help` | Documents `exec`, `queue`, `resume`, `mcp`, and `app-server [experimental]` — app-server explicitly experimental |
| 3 | `codex exec --help` | One-shot non-interactive run; **no** interrupt / switchAgent / switchModel / listAgents / snapshot verbs |
| 4 | `codex queue --thread <THREAD> --message <TEXT>` | Queue analogue exists, but completion/interrupt/session-identity semantics are **undocumented for harness use** |
| 5 | `codex app-server generate-json-schema --out $env:TEMP\codex-schema-probe` | Local generation OK. Request verbs include `thread/start|resume|fork|read|list|turns/list`, `turn/start|steer|interrupt`, `model/list`. `ThreadStartParams` carries `cwd`/`model`/`modelProvider`. **No `switchAgent` verb** (only `ExternalAgentConfig/*` = config import). No stable snapshot verb for `hasLiveExecution`/`knownTerminalExternalIds`. No stable `applyPermissionRules` equivalent |
| 6 | `npm view @openai/codex-sdk version` (resolve-only metadata, no install) | `0.167.2` — "TypeScript SDK for Codex APIs." Exported surface/stability **NOT downloaded, NOT VERIFIED** |
| 7 | Doc URLs referenced (content NOT fetched — network out of probe scope) | `https://developers.openai.com/codex`, `https://developers.openai.com/codex/cli` (+ app-server/SDK refs) |

## What is missing (all must hold before implementing transport)

1. A **stable (non-`[experimental]`)** documented verb set covering the full
   port: create/switchAgent/switchModel/submitTurn-queue-only/interrupt/
   snapshot/listAgents/permission-rules.
2. Documented session-identity mapping (Codex thread UUID ↔ harness
   `sessionId`, incl. resume/fork semantics across restarts).
3. Documented `ModelRef {providerID, id}` → Codex model-string mapping
   (model-inheritance passthrough).
4. A stable completion/snapshot semantic backing `getSession` +
   `knownTerminalExternalIds` dedupe (crash-window reconciliation, spec §8).

## Layout

- `src/codex-harness.ts` — fail-closed `CodexHarness` (`backend: "codex"`).
- `src/__tests__/codex-harness.test.ts` — contract tests: 9 fail-closed
  rows, zero-fake-turn check, no-OpenCode-default-regression check.
  Run from `packages/adapter-codex`:
  `bun src/__tests__/codex-harness.test.ts` (or `bun test …`).
- `package.json` / `tsconfig.json` — private package, zero runtime deps,
  `typecheck` script. Type-only relative import of `port.ts` (erased at
  compile; no cross-package runtime dependency, no manifest touched).

## Resuming later

Re-run probes 2–7 against the then-current CLI/SDK. If every missing item
above becomes a **stable documented** verb, replace the stub methods with a
minimal `CodexHarness` (FakeCodex transport in tests, zero network) and flip
this README verdict to IMPLEMENTED with fresh evidence.
