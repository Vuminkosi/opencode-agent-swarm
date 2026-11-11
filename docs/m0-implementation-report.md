# M0 implementation report — gate checklist and M1 readiness verdict

**Document:** `docs/m0-implementation-report.md` · **Task:** DOC-M0-01C
**Audience:** master orchestrator (M1 GO/NO-GO decision).
**Scope note:** this document is an **APPROVED CONTRACT** record for spec-derived gates, an **IMPLEMENTED (not yet independently verified)** record for code-observed items, and **NOT VERIFIED** for all live outcomes. Documentation completion is not software delivery or proof of release.
**Evidence labels:** every claim below carries one of **[G-DOC]** / **[OC2-DOC]** / **[DESIGN]** / **[PROBE]**, per spec §1. Live-server checks are **NOT VERIFIED** throughout; no executed test evidence is claimed here.

**Sources inspected (read-only, no execution):** spec §§14/15/19 + App. B **[G-DOC/OC2-DOC/DESIGN]**; `docs/api-compatibility.md` (M0-01 record) **[DESIGN/PROBE]**; `packages/adapter-opencode/src/port.ts` (frozen C-HARNESS-01) **[DESIGN]**; `packages/plugin/src/index.ts`, `tui.tsx`, `rpc.ts` (M0-02 bootstrap) **[DESIGN/PROBE]**; `scripts/probe-*.ts` + `run-probes.ts` (harness authored, outcomes pending) **[DESIGN]**. Baseline per assignment: canonical repo `C:\DevOps\opencode-agent-swarm`, `master` zero commits, all files untracked **[PROBE]** (unconfirmed by this task; committer records before/after HEAD).

**Related docs (not modified):** [api-compatibility.md](./api-compatibility.md) (authoritative M0-01 probe record), [plan/spec.md](./plan/spec.md) (normative design).

---

## 1. M0 gate checklist

Status key: **IMPLEMENTED** = code authored and observed by inspection (not independently verified); **NOT VERIFIED** = no executed compile/log/runtime proof reviewed by this task — pending test-engineer evidence. Nothing below is marked verified.

### M0-01 — Toolchain and public-API lock (spec §15) [DESIGN]

| # | Gate item | Status | Evidence / note |
|---|---|---|---|
| M0-01a | Toolchain pinned (OpenCode 2.x build, `@opencode/plugin`, Bun, TS; `bun.lock`, `tsconfig.base.json`) | **IMPLEMENTED** (pin record) / **NOT VERIFIED** (live versions) | Pin table exists in `docs/api-compatibility.md` §1 **[DESIGN]**; OpenCode 2.2.7 + Bun 1.4.4 are **UNCONFIRMED candidates** pending `opencode --version` / `bun --version` capture **[PROBE]** |
| M0-01b | 12 probes (§4.6) authored | **IMPLEMENTED** | `scripts/probe-01.ts` … `probe-12.ts`, `probe-lib.ts`, `run-probes.ts` observed in repo **[DESIGN]**; all 12 verdicts recorded as NOT VERIFIED in `docs/api-compatibility.md` §2 **[PROBE]** |
| M0-01c | Zero undocumented API in production code | **IMPLEMENTED** (by construction) | `packages/adapter-opencode/src/port.ts` has zero runtime dependencies; §4.2 hook names appear only in comments as [OC2-DOC] citations **[DESIGN]**; verdict recorded in `docs/api-compatibility.md` §3 **[DESIGN]** |
| M0-01d | Freeze recorded (typed adapter port C-HARNESS-01) | **IMPLEMENTED** | `port.ts` header declares `@frozen M0-01`, architect-amendment-only rule; `externalId` documented as adapter-internal, never an OpenCode argument **[DESIGN]**; volatile-stream durability caveat recorded **[OC2-DOC]** |
| M0-01e | Probe outcomes / gaps recorded | **NOT VERIFIED** | All probe-01…probe-12 logs pending (`scripts/probe-logs/*.log` absent from this task's evidence) **[PROBE]**; Q-01…Q-10 carried forward per `api-compatibility.md` §4 **[PROBE]** |

### M0-02 — Plugin bootstrap (spec §15) [DESIGN]

| # | Gate item | Status | Evidence / note |
|---|---|---|---|
| M0-02a | No-op `/swarm` command registered | **IMPLEMENTED** / **NOT VERIFIED** (live launch) | `packages/plugin/src/index.ts` registers `swarm` via `ctx.command.transform(editor.add(...))`, `execute` is a no-op **[DESIGN]**; `Plugin.define({id, setup})` shape cites pinned `@opencode/plugin` 2.2.7 types **[OC2-DOC/PROBE]**; `opencode` clean-launch proof pending **[PROBE]** |
| M0-02b | `swarm_health` zero-inference stub | **IMPLEMENTED** / **NOT VERIFIED** (runtime) | `swarmHealth()` returns static `{status:"ok", schemaVersion, protocolVersion}`; header states no `session.prompt` / generate / network call **[DESIGN]**; zero-token behavior unconfirmed live **[PROBE]** |
| M0-02c | Separate `./tui` + `./rpc` entries typecheck against `@opencode/plugin` 2.2.7 | **IMPLEMENTED** (authored) / **NOT VERIFIED** (compile log) | `src/tui.tsx` (`@opencode/plugin/tui`, registers no slot/page/keybinding yet) and `src/rpc.ts` (`Rpc.define` health method, JSON-schema only) both cite 2.2.7 types in headers **[DESIGN/PROBE]**; no `tsc` log reviewed by this task **[PROBE]**; TUI standalone-import peer note (`solid-js`, `@opentui/*` provided by host) is code-comment-recorded only **[PROBE]** |
| M0-02d | Teardown unsubscribes all listeners (reverse order) | **IMPLEMENTED** / **NOT VERIFIED** (runtime) | `index.ts` setup returns teardown disposing registrations in reverse **[DESIGN]**; reload/exit behavior is probe-12, still NOT VERIFIED **[PROBE]** |

**Gate summary:** M0 code authoring is **IMPLEMENTED by inspection**; every live/compile/runtime proof (probe logs, `tsc` output, `opencode` launch, TUI/RPC load in host, teardown behavior) is **NOT VERIFIED** and awaits test-engineer evidence. M0 is therefore **not gated-passed** by this document — it is **report-complete**.

---

## 2. GO / NO-GO verdict for M1 parallel work

> **Verdict: CONDITIONAL NO-GO for parallel M1-01…M1-05 implementation; narrow GO only for contract-stable prep described below.** **[DESIGN]**

**Rule applied:** spec §14, "Do not parallelize until M0 determines the real SDK surface, or multiple teams will invent incompatible abstractions." **[DESIGN]**

- **NO-GO:** full parallel implementation of M1-01…M1-05 (protocol/DB, daemon transport, session bridge, coordinator activation, demonstrator) **must not** proceed in parallel, because probe-01/Q-01 (does the pinned OpenCode build support the 2.x `Plugin.define` API?) is still NOT VERIFIED **[PROBE]**, and probes 02–12 have no logs **[PROBE]**. Starting all five workstreams now risks incompatible SDK abstractions — exactly what §14 forbids.
- **Narrow GO (contract-stable prep only):** work that does **not** invent SDK abstractions may proceed serially or as design drafts: Zod protocol schema design (spec §5 shapes are **[DESIGN]**), SQLite migration drafts (spec §6, incl. normalized wake-dedupe key from §6 caveat) **[DESIGN]**, and fixture/acceptance-script drafts for M1-05 **[DESIGN]**. Any draft that assumes an unprobed SDK method name, event payload, TUI slot, or RPC transport detail must be labeled **[PROBE]**-gated and must not be presented as implementation.
- **Exact unblock condition:** test-engineer executes `scripts/run-probes.ts` against the pinned toolchain in the disposable dir and records, at minimum: probe-01 PASS log (pinned `opencode --version`, `bun --version`, `@opencode/plugin` version, no-op server-plugin compile) resolving **Q-01** **[PROBE]**, plus probe-02 (command semantics) and probe-04/07 (session surface + correlation ID) verdicts needed by M1-03/M1-04 **[PROBE]**. On probe-01 PASS, the orchestrator may authorize M1-01 → M1-02 → M1-03 sequencing per spec §19 order (pin/test SDK → protocol/DB → daemon API → native session adapter → slash command → demonstrator) **[DESIGN]**; remaining probes gate their dependent milestones per `api-compatibility.md` fallback column **[PROBE]**.

---

## 3. Residual risks

| # | Risk | Why it matters | Gating probe / milestone |
|---|---|---|---|
| R-01 | Volatile OpenCode event stream (overflow / drop on disconnect; no replay) | Daemon must treat its journal as durability layer and reconcile snapshots; board delivery cannot rely on stream offsets **[OC2-DOC]** | Probes 05/08; M2/M5 **[PROBE]** |
| R-02 | No exactly-once admission (`externalId` is adapter-local only) | Prompt admission ≠ execution proof; crash window between admission and journal ack can double-admit; ambiguous admissions must quarantine, not blindly replay (spec §8; App. B-2) **[DESIGN]** | Probes 06/08, Q-10; M2/M5 **[PROBE]** |
| R-03 | TUI/RPC surface unconfirmed | `/swarm board` route, roster panes, `Alt+S` interception, RPC method/transport names are not asserted until probed; fallback is standalone Bun board **[OC2-DOC/DESIGN]** | Probe-02; M6 **[PROBE]** |
| R-04 | Permission enforcement unconfirmed (probe-11) | Last-match-wins, child inheritance, and real shell/edit denial through created sessions are unknown; safe-coding profile blocked on FAIL **[OC2-DOC/PROBE]** | Probe-11, Q-05; M4 **[PROBE]** |
| R-05 | Generation-rule risk (`@opencode-ai/*` mixing) | Legacy v1 packages and singular-`plugin` JSON examples differ from v2 `@opencode/*` + plural `plugins`; mixing generations breaks compat (spec §1 warning) **[OC2-DOC]** | Probe-01; M0 gate **[PROBE]** |
| R-06 | Zero-commit baseline (no canonical HEAD yet) | `master` has zero commits per assignment baseline **[PROBE]**; no before/after HEAD, no integration history; committer must record first-commit evidence and no claim of prior release may be made **[DESIGN]** |
| R-07 | Waiting ≠ suspend API; wake is request, not guarantee | No fictional native `suspend()` exists; coordinator "sleep" is a no-prompt invariant, and lead anti-polling must hold (spec §§8–9; App. B-1) **[DESIGN]** | Probes 06/12; M2 **[PROBE]** |

Risk count: **7** (R-01…R-07).

---

## 4. M1 follow-up backlog (spec §15)

M1 explicitly excludes verifier, monitor, crash-exactly-once claims, complex workspace merge, full graph, and Codex backend **[DESIGN]** (spec §15 closing line).

| ID | Title | Files | Acceptance (per spec §15) |
|---|---|---|---|
| M1-01 | Protocol and journal | `packages/protocol/src/*.ts`, `packages/runtime/src/db/{migrations,store}.ts` | Zod schemas + SQLite migrations; 100-way concurrent appends yield unique contiguous board sequence; restart keeps all posts; migrations repeatable **[DESIGN]** |
| M1-02 | Daemon and transport | `packages/runtime/src/server.ts`, `packages/runtime/src/app.ts`, `packages/plugin/src/client.ts` | Loopback authenticated API (health, create swarm, add member, post, stream, snapshot); daemon survives plugin exit; unauthorized callers denied; board clients resume from last sequence **[DESIGN]** |
| M1-03 | Native agent/session bridge | `packages/adapter-opencode/src/{harness,sessions,events}.ts` | Two native agent sessions bound to project locations, distinct briefs, overlapping executions proven by timestamps; separate history; native permissions preserved **[DESIGN]** |
| M1-04 | `/swarm` coordinator activation | `packages/plugin/src/commands/swarm.ts`, `packages/runtime/src/services/swarm-service.ts` | `/swarm <requirement>` binds current session as coordinator, creates two named workers with native agent profile, posts two public briefs, records completion; status readable without LLM call **[G-DOC/DESIGN]** |
| M1-05 | First demonstrator + acceptance script | `examples/two-module-fixture/`, `tests/e2e/m1.spec.ts`, `scripts/m1-demo.ts` | Disposable Git fixture; session overlap measured; TUI kill/restart (daemon survives); board + outputs inspected; lead inference calls flat while workers run; deterministic pass in CI + Windows 11 with versions recorded **[DESIGN]** |

---

## 5. Canonical install / probe snippet (UNEXECUTED example) [DESIGN]

The following is the canonical command shape only — **not executed by this task; no output is claimed** **[PROBE]**:

```powershell
bun install
bun run typecheck
# = tsc --noEmit -p packages/adapter-opencode/tsconfig.json (root "typecheck" script)
$env:SWARM_PROBE_DIR = "<disposable-dir>"
bun scripts/run-probes.ts
```

Probe runner executes exclusively in the disposable dir (`%TEMP%/opencode/swarm-probes`, override `SWARM_PROBE_DIR`) **[DESIGN]**; logs land in `<probe-dir>/probe-NN.log` (default `%TEMP%/opencode/swarm-probes`, override `SWARM_PROBE_DIR`) **[DESIGN]** (pending **[PROBE]**).

---

## 6. Stop conditions restated (spec §19) [DESIGN]

Until M0 compatibility probes and M1 acceptance tests pass, do **not**:

1. Rewrite the user's existing `AGENTS.md`.
2. Replace Ensemble.
3. Modify production repositories.
4. Expand worker permissions.
5. Install unreviewed plugins.
6. Claim exact wake/execution guarantees.

Implementation order reminder (§19): (1) pin/test SDK → (2) protocol/DB → (3) daemon API → (4) native session adapter → (5) slash command → (6) demonstrator → (7) sleep/wake and verification in the next milestone **[DESIGN]**.

---

## 7. Factual gaps (for test-engineer / orchestrator)

1. All 12 probe logs (`probe-01.log` … `probe-12.log`) — pending execution **[PROBE]**.
2. Pinned-version captures (`opencode --version`, `bun --version`, `@opencode/plugin` resolved version, API schema checksum, first-commit HEAD) — pending **[PROBE]**.
3. `tsc` compile log for M0-02 entries — pending **[PROBE]**.
4. `opencode` clean-launch + `/swarm` no-op + `swarm_health` zero-inference observation — pending **[PROBE]**.
5. TUI host load and RPC wiring confirmation — pending (probe-02 scope) **[PROBE]**.
6. Teardown/dispose and daemon-survival behavior — pending (probe-12 scope) **[PROBE]**.
