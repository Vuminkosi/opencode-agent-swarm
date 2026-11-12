# Compatibility report — M0 gate (DOC-M0-01A)

## 0. Claim status header

- **APPROVED CONTRACT** — claims sourced from `docs/plan/spec.md` or `docs/api-compatibility.md`. These describe intended or documented behavior, not proof that the behavior runs. [DESIGN]
- **IMPLEMENTED (not yet independently verified)** — code-observed claims from files inspected in the canonical repo. The source exists in the working tree but no independent review, probe log, or typecheck output was executed for this report. [DESIGN]
- **NOT VERIFIED** — any claim that depends on a live OpenCode server, pinned CLI execution, TUI host embedding, RPC transport wiring, or probe log. No probe log exists in this baseline, so no probe is reported as PASSED. [PROBE]

Verification does not prove commit; commit does not prove release. Design intent below is never described as released capability. [DESIGN]

Baseline: `master` branch, zero commits (unborn HEAD, `git log` empty, all files untracked) per task source baseline. [PROBE] — NOT VERIFIED by this report (no shell execution performed here; recorded as supplied baseline, to be confirmed by the committer's before/after HEAD record).

Related records: [spec](../docs/plan/spec.md) ([DESIGN] contract source), [api-compatibility](../docs/api-compatibility.md) ([DESIGN] M0-01 record source).

## 1. Gate verdict summary

M0 compatibility gate verdict: **CONDITIONAL NO-GO for parallel M1 implementation; narrow GO for contract-stable prep only (frozen port and stub plugin surface). Full unblock requires probe-01 PASS (Q-01) plus probe-02 and probe-04/07 verdicts; all live-server behavior remains NOT VERIFIED.** [DESIGN]

| Category | Count | Meaning |
|---|---|---|
| Supported (contract-stable, code-present, no live behavior claimed) | 3 | Frozen adapter port; no-op `/swarm` server command; `swarm_health` tool with zero inference [DESIGN] |
| Fallback (documented alternative, native path unproven) | 2 | Standalone `bunx opencode-swarm board` terminal board instead of native TUI embedding; adapter-local `externalId` + snapshot reconcile instead of assumed server idempotency token [DESIGN] |
| Blocked (requires live probe before any implementation reliance) | 12 | Probes 01–12 per `docs/api-compatibility.md` §2, all NOT VERIFIED [PROBE] |

Count mapping: **3** = code-present, contract-stable items needing no live proof; **2** = contract-approved fallbacks used where the native path is unproven; **12** = probes 01–12, every one NOT VERIFIED with no probe log in this baseline. [DESIGN]

Every row in §2–§3 below carries its evidence label. No row claims a live behavior as delivered. [DESIGN]

## 2. Supported vs fallback vs blocked — spec §§4.2 and 4.4

Spec §§4.2/4.4 define the server-hook inventory and the TUI/RPC split; Appendix A/B supply the documentation trace. [OC2-DOC] for documented OpenCode 2 surface; [PROBE] for every executable confirmation. [OC2-DOC]

### 2.1 Server hooks and methods (spec §4.2)

Source of record for implementation shape: `packages/adapter-opencode/src/port.ts` — frozen, zero runtime dependencies, `externalId` is adapter-internal and never a documented OpenCode API argument. [DESIGN]

| Area (spec §4.2) | Documented method / event [OC2-DOC] | Our usage [DESIGN] | Status in this baseline | Evidence file |
|---|---|---|---|---|
| Command transform | `ctx.command.transform(editor => editor.add({name, description, execute}))` | `/swarm` command, input capture | IMPLEMENTED stub only (no-op command surface; argument semantics NOT VERIFIED, probe-02 pending) | `packages/plugin/src/index.ts` — no-op `/swarm` registration [DESIGN]; IMPLEMENTED (not yet independently verified) |
| Command listing | `ctx.command.list()` | Discover command conflicts | BLOCKED — NOT VERIFIED, requires probe-02 log | No production code references it; cited in `port.ts` comments as [OC2-DOC] subject to probe confirmation [DESIGN] |
| Session creation | `ctx.session.create({ title })` | New worker context | BLOCKED — NOT VERIFIED, requires probe-04 log (location/worktree binding unproven) | `port.ts` `createSession(title, directory)` is our port shape only, not a proven server call [DESIGN] |
| Session read | `ctx.session.get({ sessionID })` | Reconcile state | BLOCKED — NOT VERIFIED, requires probe-08 log | `port.ts` `getSession(sessionId)` port shape only [DESIGN] |
| Session transcript | `ctx.session.context({ sessionID })` | Recover recent context | BLOCKED — NOT VERIFIED, requires probe-08 log (size/pagination/cost unknown) | Port has no transcript method; no implementation claims transcript access [DESIGN] |
| Session native agent | `ctx.session.switchAgent({ sessionID, agent })` | Preserve native agent ID | BLOCKED — NOT VERIFIED, requires probe-03/04 logs | `port.ts` `switchAgent(sessionId, agentId)` port shape only [DESIGN] |
| Model change | `ctx.session.switchModel({ sessionID, model: {providerID, id} })` | Model overrides | BLOCKED — NOT VERIFIED, requires probe-09 log | `port.ts` `ModelRef {providerID, id}` + `switchModel` port shape only [DESIGN] |
| Prompt admission | `ctx.session.prompt({ sessionID, text, delivery? })` | Queue wake-ups / tasks | BLOCKED — NOT VERIFIED, requires probe-06 log (`queue` vs `steer` semantics unproven) | `port.ts` `submitTurn` with `TurnDelivery "queue" \| "steer"` port shape only; receipt is admission, not proof of execution [DESIGN] |
| Session cancel | `ctx.session.interrupt({ sessionID, continue:false })` | Cancellation | BLOCKED — NOT VERIFIED, requires probe-10 log | `port.ts` `interrupt(sessionId)` port shape only [DESIGN] |
| Session wait | `ctx.session.wait({ sessionID })` | Optional signal, not durable truth | BLOCKED — NOT VERIFIED, requires probe-05/08 logs | `port.ts` `wait(sessionId, signal)` explicitly documented as not durable truth [DESIGN] |
| Ordered event stream | `ctx.event.subscribe({signal})` | Session events to daemon | BLOCKED — NOT VERIFIED, requires probe-05/07/08 logs (payload/schema, reconnection, volatility handling unproven) | `port.ts` `HarnessEvent` + `EventSubscription` port shapes only; volatility noted in file header [DESIGN] |
| Permission rules | `ctx.permission.rules({sessionID, permissions})` | Sandbox canonical repo | BLOCKED — NOT VERIFIED, requires probe-11 log (last-match-wins and child inheritance unproven) | `port.ts` `PermissionRule` + `applyPermissionRules` port shape only [DESIGN] |
| Pending approvals | `ctx.permission.list({sessionID})` and `reply(...)` | Surface approvals, never auto-approve | BLOCKED — NOT VERIFIED, requires probe-11 log (request-ID lifecycle unproven) | No approval implementation in `index.ts`; policy stated in file comment only [DESIGN] |
| Prompt interception | `ctx.session.hook("prompt", handler)` | Enforce provenance/correlation metadata if needed | BLOCKED — NOT VERIFIED; guard against multiple invocations unproven | Not implemented; cited in `port.ts`/spec comments only [OC2-DOC] |
| Agent transform | `ctx.agent.transform(...)` | Optional agent metadata/capability decoration | FALLBACK — do not mutate native agent by default per spec §4.2 [DESIGN] | `index.ts` comment: nothing mutates agent permissions; IMPLEMENTED (not yet independently verified) [DESIGN] |

Volatile-stream rule: the public event stream is explicitly volatile (slow readers can overflow; missed events during disconnection cannot be replayed by the stream alone), so the daemon must durably record intents before acting and reconcile snapshots after reconnection. [OC2-DOC] per spec §4.2. The daemon journal is the durability layer, not the stream. [DESIGN]

Crash-window rule: prompt admission and SQLite acknowledgement cannot be made atomic, so exactly-once model execution is not guaranteed without a documented server-side idempotency token. [DESIGN] per spec §8. Fallback is adapter-local `externalId` mapping plus inbox/execution reconciliation, with ambiguous admissions quarantined rather than blindly replayed. [DESIGN] — IMPLEMENTED as port shape in `port.ts` (`externalId` adapter-internal), NOT VERIFIED against any live server. [PROBE]

Production-code surface verdict: `port.ts` has zero imports and zero OpenCode calls; §4.2 hook names appear only in comments as [OC2-DOC] citations subject to probe confirmation. [DESIGN] Verdict: **no undocumented API in production code** — there is no runtime production code beyond the frozen port and the M0-02 stub by design. [DESIGN] — IMPLEMENTED (not yet independently verified).

### 2.2 TUI and RPC (spec §4.4)

Source files: `packages/plugin/src/tui.tsx`, `packages/plugin/src/rpc.ts`, served by the M0-02 server stub in `packages/plugin/src/index.ts`. [DESIGN]

| Part | Spec §4.4 expectation [DESIGN] | Status in this baseline |
|---|---|---|
| TUI (`./tui`) | Discoverable `/swarm` action; `/swarm board` navigation; roster/post/detail panes, read markers, filters and follow; worker-session navigation | NOT VERIFIED native embedding. `tui.tsx` registers no slot, page, or keybinding yet by design; it typechecks against the installed `@opencode/plugin/tui` types per its file comment. [DESIGN] — IMPLEMENTED (not yet independently verified). Exact registration shape, route support, pane widgets, and `Alt+S` interception are not asserted until probe-02 runs. [PROBE] Fallback per spec §4.4: standalone Bun terminal board (`bunx opencode-swarm board`) instead of native board embedding. [DESIGN] `solid-js` peer note: importing the TUI entry standalone fails at `@opencode/plugin/dist/tui/solid.js` without optional peers (`solid-js`, `@opentui/*`); the TUI part is expected to load inside the OpenCode TUI host. [PROBE] — NOT VERIFIED beyond the file comment (no execution in this report). |
| RPC (`./rpc`) | Versioned client↔server message schema (`swarm/0`); method/transport wiring between server handlers and TUI client calls | NOT VERIFIED method/transport wiring. `rpc.ts` carries a versioned stub schema (`SWARM_RPC_SCHEMA_VERSION "0.0.1"`, `SWARM_RPC_PROTOCOL_VERSION "swarm/0"`, single `health` method, no events) built on `Rpc.define` JSON-schema values only. [DESIGN] — IMPLEMENTED (not yet independently verified). Method names, transport wiring (`ctx.rpc.register` handlers ↔ TUI client calls), and event payloads are not asserted until probed against the pinned release. [PROBE] Server path is independent of RPC: `swarm_health` is served locally by the tool in `index.ts` without any RPC hop. [DESIGN] |
| Server (`./index.ts`) | No-op `/swarm` command + `swarm_health` tool + teardown; zero inference | IMPLEMENTED (not yet independently verified). Registers `/swarm` no-op command and `swarm_health` tool returning static `{status, schemaVersion, protocolVersion}` shaped like daemon `GET /healthz`; teardown unsubscribes registrations in reverse order. [DESIGN] Zero-inference invariant (no `session.prompt`, no generation, no network call) is a code-observed claim from the file comment and body, not a live execution proof. [DESIGN] Plugin never stores authoritative swarm state; daemon owns it. [DESIGN] |

TUI verdict line: **TUI native embedding NOT VERIFIED; fallback is `bunx opencode-swarm board` per spec §4.4.** [PROBE]

RPC verdict line: **RPC method/transport wiring NOT VERIFIED; the M0-02 server path (`swarm_health`) does not depend on RPC.** [PROBE]

## 3. Open questions Q-01–Q-10 (spec §18)

All dispositions below are APPROVED CONTRACT for the question/milestone/blocker columns (spec-sourced) and NOT VERIFIED for the resolution itself (no probe log exists). [DESIGN]

| ID | Question (spec §18) [DESIGN] | Resolution milestone [DESIGN] | Blocker? [DESIGN] | Probe mapping [DESIGN] | Disposition in this baseline |
|---|---|---|---|---|---|
| Q-01 | Does current installed OpenCode support 2.x plugin `Plugin.define` API? | M0 | Yes | probe-01 | OPEN, M0 blocker — NOT VERIFIED. Decided by probe-01 compile + launch log, which does not exist yet. [PROBE] |
| Q-02 | Can `/swarm board` be intercepted as a real TUI route/command rather than model prompt? | M0/M6 | No; fallback exists | probe-02 | OPEN, non-blocking — NOT VERIFIED. Fallback is `bunx opencode-swarm board` CLI per spec §4.4. [PROBE] |
| Q-03 | Can plugin create sessions in distinct worktree locations without opening embedded host? | M0/M4 | M4 blocker | probe-04 (sessions) + §4.3 worktree/SDK question | OPEN, M4 blocker — NOT VERIFIED. Plugin/server-session APIs remain the preferred initial integration; embedded-host-per-worker is not the default. [PROBE] |
| Q-04 | Is there a stable session execution correlation ID across prompt admission and terminal event? | M0/M2 | M2 blocker | probe-07 | OPEN, M2 blocker — NOT VERIFIED. If no stable ID exists, fallback is adapter-local `externalId` + snapshot reconcile only per spec §8. [PROBE] |
| Q-05 | Are agent permissions enforced unchanged in independently created native sessions? | M0 | Yes | probe-11 | OPEN, M0 blocker — NOT VERIFIED. Unknown IDs must fail visibly per spec §9; silent fallback is rejected. [PROBE] |
| Q-06 | Does switching model preserve context on waiting session? | M0/M3 | M3 blocker | probe-09 | OPEN, M3 blocker — NOT VERIFIED. Fallback on failure is session recreation with transcript repost and model-override descoping. [PROBE] |
| Q-07 | How are quotas and rate-limit errors surfaced by each provider? | M2/M5 | M5 blocker | No single probe; integration/fault-matrix behavior (§13) | OPEN, M5 blocker — NOT VERIFIED. No quota behavior is claimed. [PROBE] |
| Q-08 | Can native TUI shortcut `Alt+S` be bound without unsupported internals? | M6 | No; equivalent command | probe-02 (TUI shape) | OPEN, non-blocking — NOT VERIFIED. Document an equivalent supported binding instead of undocumented interception. [PROBE] |
| Q-09 | Can Windows worktree junction/case-insensitivity rules be safely enforced? | M4 | Yes for safe-coding | probe-11 (permissions) + M4 worktree acceptance | OPEN, safe-coding blocker — NOT VERIFIED. [PROBE] |
| Q-10 | How to avoid ambiguous double-admission when API has no idempotency token? | M2/M5 | Yes for autonomous retries | probes 06+08 | OPEN, autonomous-retry blocker — NOT VERIFIED. Exactly-once execution is not claimed; quarantine-on-ambiguity applies per spec §8. [PROBE] |

Open/blocked list: **all ten questions Q-01–Q-10 are OPEN and NOT VERIFIED; blockers are Q-01, Q-05 (M0), Q-03/Q-09 (M4), Q-04/Q-10 (M2/M5), Q-06 (M3), Q-07 (M5). Q-02 and Q-08 are non-blocking with documented fallbacks.** [DESIGN]

## 4. Toolchain freeze statement

| Component | Recorded version | Status |
|---|---|---|
| OpenCode CLI build | 2.2.7 UNCONFIRMED candidate | [PROBE] — NOT VERIFIED; no `opencode --version` log exists in this baseline |
| Bun | 1.4.4 (UNCONFIRMED candidate) | [PROBE] — NOT VERIFIED; no `bun --version` log exists in this baseline |
| TypeScript | 5.9.2 | [DESIGN] selected for M0 (`package.json` devDependencies); confirm via install log — NOT VERIFIED here |
| `@opencode/plugin` | 2.2.7 (pinned in `packages/plugin/package.json`; `index.ts`/`tui.tsx`/`rpc.ts` comments record 2.2.7 from `m0-02-probe` disposable resolution where `latest` dist-tag matched CLI 2.2.7) | Reconciled honestly: `docs/api-compatibility.md` §1 still lists plugin as TBD/probe-01 pending with zero installs found during M0-01 discovery. [DESIGN] The 2.2.7 pin comes from the later M0-02 disposable-probe resolution noted in the plugin source comments, not from a committed probe-01 log. [DESIGN] It therefore remains an UNCONFIRMED candidate — NOT VERIFIED by any live-server log in this baseline. [PROBE] Do not treat it as verified until probe-01 captures it. |
| `@opencode/sdk` | TBD (preferred: same minor as plugin) | [PROBE] — NOT VERIFIED; do not depend on it until probe-04/07 confirm the session surface |
| Node | n/a (Bun runtime) | [DESIGN] |
| Git baseline | `master`, zero commits (unborn HEAD) | [PROBE] — recorded as supplied baseline; committer records before/after HEAD |

Generation rule: **v2 `@opencode/*` only — never `@opencode-ai/*`** per spec §1 version warning. [OC2-DOC] The legacy `@opencode-ai/plugin`, `@opencode-ai/sdk`, and singular-`plugin` JSON examples differ from OpenCode 2 `@opencode/plugin`, `@opencode/sdk`, and plural-`plugins`; the generations must not be mixed. [OC2-DOC] No production code in this baseline references the legacy generation. [DESIGN]

## 5. Gaps and NOT VERIFIED list

1. All probes 01–12 are NOT VERIFIED — no `scripts/probe-logs/*.log` exists in this baseline. No probe is reported as PASSED. [PROBE]
2. TUI native embedding (slots, routes, panes, `Alt+S`) is NOT VERIFIED; only the `bunx opencode-swarm board` fallback is contract-approved. [PROBE]
3. RPC method/transport wiring and event payloads are NOT VERIFIED; only the local `swarm_health` server path is code-present. [PROBE]
4. Session lifecycle, concurrency, correlation IDs, reconnect reconciliation, model-switch retention, cancel semantics, permission enforcement, and daemon-survives-plugin-exit are all NOT VERIFIED. [PROBE]
5. Toolchain versions (CLI 2.2.7, Bun 1.4.4, plugin 2.2.7) are UNCONFIRMED candidates without version-capture logs. [PROBE]
6. Typecheck status (`tsc --noEmit`, plugin `tsconfig`) was not executed for this report — NOT VERIFIED by design (reconcile file evidence only). [PROBE]
7. No live-server, screenshot, deployment, endpoint, CLI-flag, or support-promise claims are made in this report. [DESIGN]

## 6. Sources inspected (file evidence only, no execution)

- `docs/plan/spec.md` §§4.1/4.2/4.4/14/15/18 and Appendices A/B — APPROVED CONTRACT source. [DESIGN]
- `docs/api-compatibility.md` §§1–4 — M0-01 record source (UNCONFIRMED-candidate table, per-probe NOT VERIFIED verdicts, port-surface verdict, Q-01–Q-10 carry-forward). [DESIGN]
- `packages/adapter-opencode/src/port.ts` — frozen port, zero runtime deps, adapter-internal `externalId`. [DESIGN]
- `packages/plugin/src/index.ts` — no-op `/swarm` + `swarm_health` with zero inference per file comment. [DESIGN]
- `packages/plugin/src/tui.tsx` — no slot/page/keybinding yet; `solid-js` peer note. [DESIGN]
- `packages/plugin/src/rpc.ts` — versioned stub schema `swarm/0`. [DESIGN]
- `packages/plugin/package.json` — `@opencode/plugin` 2.2.7 pin, `./tui` + `./rpc` exports. [DESIGN]
- Root `package.json` — `typecheck` / `probes` scripts, TypeScript 5.9.2 devDependency. [DESIGN]

Relative links in this report were validated by inspection of the paths above (no execution). No unexecuted command example is included; where commands are named (`bunx opencode-swarm board`, probe scripts), they are cited as contract fallback/scope references, not as executed procedures. [DESIGN]

## 7. M2 wake-engine compatibility addendum (DOC-M2-01)

> **Document status for this section only: APPROVED CONTRACT + IMPLEMENTED
> (FakeHarness simulations) / COMMITTED at `c62c824`.** Live-server and
> live-inference behavior remain **NOT VERIFIED**. §§1–6 above are unchanged
> M0 baseline; nothing below rewrites them. [DESIGN]

- **Baseline:** HEAD `c62c82418f93a923325968ea841b18f81d182c46` —
  `feat(runtime): durable wake-up engine (M2-01)`; 7 files, 2703 insertions.
  Prior: `56d22a2` (M0) → … → `d22d8c1` (workflow, Node24). [PROBE]
- **Constraint compliance:** M0/M1 files untouched; no 003 migration
  (`delivery_key` UNIQUE rides on migration 002 + store backfill); protocol
  DTOs untouched. [DESIGN]
- **Evidence:** 20 wake tests + 98-test runtime suite PASS (FakeHarness),
  typecheck clean — see [m2-wake-engine evidence](evidence/m2-wake-engine.md)
  §§7/9 for the full test map and reproducible commands. [PROBE]

### 7.1 Adapter / dispatcher / harness compatibility

| Surface | Status in M2 |
|---|---|
| Frozen adapter port (`packages/adapter-opencode/src/port.ts`) | Unchanged by M2-01; dispatcher depends only on the narrow `DispatchHarness` surface (`submitTurn` queue-only + `getSession`), satisfied structurally by the M1-03 `OpenCodeHarness`. Contract-stable. [DESIGN] — IMPLEMENTED |
| Dispatcher transport posture | Queue-only turns, adapter-internal `externalId` (never an OpenCode API argument), at-least-once transport with idempotent acks. No new native API surface assumed. [DESIGN] — IMPLEMENTED |
| Harness error-shape handling | `isQuotaError` (402 / quota / 402-code) vs `isTransientError` (429/408/502/503/504/5xx/timeout) vs permanent-4xx classification is code-present and FakeHarness-tested. Whether the live provider/harness surfaces quota **exactly** in this shape is F-04 below. [DESIGN] — IMPLEMENTED, live shape NOT VERIFIED |
| Member-state / generation guards | `killed`, `quota_paused`, `approval_paused`, paused-swarm, terminal-swarm, generation-drift guards enforced store-side + dispatcher-side; S2-1/S2-2/F-01 fix-review hardening committed. [DESIGN] — IMPLEMENTED |
| Live probes 01–12 | Still NOT VERIFIED — no `probe-NN.log` exists in the repo. M2 simulations do not close any live probe. [PROBE] |

### 7.2 F-04: harness 402-shape — NOT VERIFIED

**F-04 (harness 402-shape): NOT VERIFIED.** [PROBE] The dispatcher's quota
branch triggers on `status === 402` (or quota/402-coded errors), and the
FakeHarness 402 simulations pass — but the exact error object the M1-03
`OpenCodeHarness` produces against a **live provider on quota exhaustion**
(status field? code string? message wording? paid-path side effects before
the error surfaces?) has no live log in this repo. Until a live 402 is
captured in a disposable probe run, the 402-detection regex is a
**contract assumption tested against fakes**, and provider-side 402 shaping
plus zero-spend-on-402 remain assignment-supplied claims (LIVE-PROBE-01),
not repo evidence. Resumption: run a quota-path probe against the pinned
toolchain, capture the raw error shape, and reconcile `isQuotaError` with
the observation before any paid-path autonomy claim. [PROBE]

### 7.3 M2 gaps and NOT VERIFIED list (additive to §5)

1. Live turns, overlapping-execution overlap figures, and provider 402
   shaping are NOT VERIFIED (no live server, no inference spend). [PROBE]
2. Exactly-once physical delivery is not claimed; ambiguous
   admitted-but-unacked wakes quarantine for operator review by design. [DESIGN]
3. No live-server, screenshot, deployment, endpoint, CLI-flag, release, or
   support-promise claims are made in this addendum. [DESIGN]

## 8. M3 coordination compatibility addendum (DOC-M3-01)

> **Document status for this section only: APPROVED CONTRACT + IMPLEMENTED
> (FakeHarness simulations) / COMMITTED at `e7a0b8f`.** Live-server and
> live-inference behavior remain **NOT VERIFIED**. §§1–7 above are unchanged
> M0/M2 baseline; nothing below rewrites them. [DESIGN]

- **Baseline:** HEAD `e7a0b8f677045c67a34a9e09daf643333ac21a9e` —
  `feat(runtime): M3 coordination core + S1/S2 fixes (M3-01)`; 8 files, 1678
  insertions. Prior: `c62c824` (M2) → `937af39` (DOC-M2-01) →
  `9f595ad` (checklist) → `e7a0b8f` (M3-01, HEAD). [PROBE]
- **Constraint compliance:** M0/M1/M2 files untouched; no new migration
  (services project over the M1-01 journal + M2 wake rows); protocol DTOs
  untouched. [DESIGN]
- **Evidence:** 26 coordination + 124-test runtime + 188-test repo suites PASS
  (FakeHarness + tmp-SQLite), typecheck clean — see [m3-coordination
  evidence](evidence/m3-coordination.md) §§4/9 for the full test map and
  reproducible commands. [PROBE]

### 8.1 Mention / board / lead / verifier / monitor vs OpenCode 2.2.7

| Surface | Status in M3 |
|---|---|
| Mention resolution (`@member`/`@group`/`@all`) | Store-owned snapshot resolution at post commit (author/killed excluded); lexer + fanout covered by committed simulation tests. No new native API assumed. [DESIGN] — IMPLEMENTED, live mention-turn behavior NOT VERIFIED |
| Board read models (roster/history/pending/delivery) | Pure SQLite projections over the frozen journal; zero inference, zero harness calls. No native TUI surface assumed. [DESIGN] — IMPLEMENTED |
| Lead sleep/wake + private steering | Store transitions + `user_direct` intents through the M2 queue-only dispatch lane; private text travels only in the wake payload, never a post row. No `queue` vs `steer` semantic change. [DESIGN] — IMPLEMENTED, live turn behavior NOT VERIFIED |
| Verifier gate (`assertVerifierAccept`, defect fanout, `attempt++`) | Daemon-side policy only; evidence rows are local artifacts. No native session/model surface assumed. [DESIGN] — IMPLEMENTED |
| Dormant monitor (quiescence + cooldown + one intervention) | Scheduler policy with zero inference; intervention dispatches through the M2 lane. Default quiet 5 min / cooldown 15 min are proposed values, not claimed Antigravity defaults. [DESIGN] — IMPLEMENTED, live quiescence timing NOT VERIFIED |
| Live probes 01–12 | Still NOT VERIFIED — no `probe-NN.log` exists in the repo. M3 simulations close no live probe. [PROBE] |

### 8.2 F-04: harness 402-shape — NOT VERIFIED (carried, not closed)

**F-04 (harness 402-shape): NOT VERIFIED.** [PROBE] The M3 quota path
(`quota_paused`, never auto-retry, monitor `suppressed`) is IMPLEMENTED and
FakeHarness-tested, but the exact 402/quota error shape the M1-03
`OpenCodeHarness` surfaces against a live provider on quota exhaustion
remains unproven — see §7.2. Assignment-supplied LIVE-PROBE-01 402 zero-spend
is recorded as a supplied claim, not repo evidence. Resumption: capture a
live 402 in a disposable probe run and reconcile `isQuotaError` before any
paid-path autonomy claim. [PROBE]

### 8.3 M3 gaps and NOT VERIFIED list (additive to §§5/7.3)

1. Live three-worker turns, overlap figures, and provider 402 shaping are NOT
   VERIFIED (no live server, no inference spend). [PROBE]
2. The `119` count figure from the task baseline matches no observed suite
   (actuals: 26 coordination / 124 runtime / 35 protocol / 188 repo-wide) and
   is NOT VERIFIED. [PROBE]
3. Exactly-once physical delivery is not claimed; ambiguous
   admitted-but-unacked wakes quarantine for operator review by design. [DESIGN]
4. No live-server, screenshot, deployment, endpoint, CLI-flag, release, or
   support-promise claims are made in this addendum. [DESIGN]

## 9. M4 safe-coding compatibility addendum (DOC-M4-01)

> **Document status for this section only: APPROVED CONTRACT + IMPLEMENTED
> (FakeHarness + tmp-Git simulations) / COMMITTED at `7330e0e`.**
> Live-server and live-inference behavior remain **NOT VERIFIED**. §§1–8
> above are unchanged M0/M2/M3 baseline; nothing below rewrites them. [DESIGN]

- **Baseline:** HEAD `7330e0e2516561b4fb974602a3e3665d2433a3c2` —
  `feat(m4): add git-workspaces, verification runner and integration gate (M4-01/M4-02/M4-03)`; 12 files, 4911 insertions, zero deletions.
  Prior: `e7a0b8f` (M3) → … → `4b4b616` → `7330e0e` (M4, HEAD). [PROBE]
- **Constraint compliance:** M0–M3 files untouched; **no store migration file** (no `003` file — `integration_runs` is service-owned via `ensureIntegrationSchema()` idempotent DDL on the shared DB handle); **no protocol change** (no `packages/protocol` file in the commit). [DESIGN]
- **Evidence:** 74 + 23 + 13 focused PASS (FakeHarness/tmp-Git, supplied), full 246 observed (supplied), tsc × 3 clean (supplied), m105 4 environment FAILs external — see [m4-safe-coding evidence](evidence/m4-safe-coding.md) §§4/7 for the per-acceptance map and honest repro scope. Live inference NOT VERIFIED. [PROBE]

### 9.1 Q-03 decision: git CLI vs OpenCode worktree SDK

| Surface | Status in M4 |
|---|---|
| Worktree transport | **Git CLI via `Bun.spawn` argv-only (never a shell).** The OpenCode worktree SDK `projectID` is unresolved, so the undocumented plugin worktree API is NOT used. Allowlists on every agent-supplied string (taskId/branch/commit); `..`/separator/UNC handling lexical + ancestor-aware physical. [DESIGN] — IMPLEMENTED, live worktree-API behavior NOT VERIFIED |
| Q-03 (spec §18) | Still OPEN as a live-SDK question, but **decided for implementation**: git CLI is the M4 transport. The SDK path stays a non-default future, not a blocker for safe-coding closeout. [DESIGN] |
| Live probes 01–12 | Still NOT VERIFIED — no `probe-NN.log` exists in the repo. M4 simulations close no live probe. [PROBE] |

### 9.2 Windows / UNC / junction limits (known, reported verbatim) [DESIGN]

- Comparison is lowercased NTFS-semantic (`\`-unified, drive/UNC-server casefolded); **comparison forms never drive FS operations** — records carry the case-preserving physical spelling (S2 F-03). [DESIGN] — IMPLEMENTED
- Symlink/junction resolution is ancestor-aware but **best-effort**: only existing ancestors resolve via realpath (8.3 short-name expansion included); a hostile link swapped in after validation (TOCTOU) is NOT detected by the policy module — creation and validation are re-checked at use time (refresh before destructive ops, `resolveWorktreeDir` + `finalComponentIsLink` in the runner, physical-form gates in the manager). [DESIGN]
- Remote UNC targets compare lexically; the local host cannot canonicalize a remote server's reparse points. Space-bearing paths integrate cleanly (argv-only, no shell — covered by the `windows paths` test). [DESIGN] — IMPLEMENTED, live Windows-fleet behavior NOT VERIFIED

### 9.3 Runner hardening notes (canonical protection, redaction, KillTree, evidence root) [DESIGN]

- **Canonical protection:** tmp worktree only; symlink/junction worktree denied; worktree inside the canonical root denied (explicit + discovered `git rev-parse --show-toplevel` root); evidence root constrained to `os.tmpdir()` (SEC F4, physical-form gate for not-yet-created leaves). [DESIGN] — IMPLEMENTED
- **Redaction:** secret patterns redacted from artifacts, persisted DTO command, and never logged; the disposable run script (`run.cmd`/`run.sh`) is unlinked after spawn. Non-capturing-pattern `[REDACTED]` shape pinned (F-01); key=value keeps `name=[REDACTED]`. [DESIGN] — IMPLEMENTED
- **KillTree:** `taskkill /T` on win32 (exit-code-checked, fallback to `proc.kill`); POSIX detached group `kill(-pid)` targeting exactly the spawned tree (R01-01); bounded 5 s drain guard after kill so a killed tree holding pipes cannot hang the runner. [DESIGN] — IMPLEMENTED, live kill-tree behavior NOT VERIFIED beyond simulations
- **Evidence root:** disposable `verification-<uuid>/` dir with best-effort `0700`; `stdout.log`/`stderr.log` sha256-pinned into the DTO; §5 wire lengths pre-validated before spawn (F-04); Zod `RecordEvidenceInputSchema` enforced before handoff. [DESIGN] — IMPLEMENTED

### 9.4 F-04: harness 402-shape — NOT VERIFIED (carried, not closed)

**F-04 (harness 402-shape): NOT VERIFIED.** [PROBE] M4 adds no inference path and no paid-service call; the M2 quota posture (`quota_paused`, never auto-retry) is carried unchanged. The exact 402/quota error shape a live provider surfaces remains unproven — see §7.2. Assignment-supplied m105 environment FAILs (4, external) are recorded as environment-external, not product evidence. Resumption: capture a live 402 in a disposable probe run and reconcile `isQuotaError` before any paid-path autonomy claim. [PROBE]

### 9.5 M4 gaps and NOT VERIFIED list (additive to §§5/7.3/8.3)

1. Live turns, overlap figures, provider 402 shaping, and live kill-tree / live Windows-fleet behavior are NOT VERIFIED (no live server, no inference spend). [PROBE]
2. Focused/full/typecheck counts (74 + 23 + 13, 246, tsc × 3) and the 136–149 evolution span are supplied evidence cited in [m4-safe-coding](evidence/m4-safe-coding.md), not fresh executions of this doc session (link check only). [PROBE]
3. Exactly-once physical delivery is not claimed; ambiguous admissions quarantine for operator review by design. [DESIGN]
4. No live-server, screenshot, deployment, endpoint, CLI-flag, release, or support-promise claims are made in this addendum. [DESIGN]

## 10. M5 robustness compatibility addendum (DOC-M5-01)

> **Document status for this section only: APPROVED CONTRACT + IMPLEMENTED
> (FakeHarness + tmp-Git/tmp-SQLite simulations) / COMMITTED at `69f40a9`.**
> Live-server and live-inference behavior remain **NOT VERIFIED**. §§1–9
> above are unchanged M0/M2/M3/M4 baseline; nothing below rewrites them. [DESIGN]

- **Baseline:** HEAD `69f40a9726876411e77b8f81848e62b2681b6311` —
  `feat(m5): crash replay + rate limiting (M5-01/M5-02)`; 8 files, 3527
  insertions, 21 deletions.
  Prior: `7330e0e` (M4) → `698171b` (DOC-M4-01) → `b54c50c` (m105 cleared) → `c10e0be` (M4-INT-FIX-01, M4 S2-1…S2-3) → `69f40a9` (M5-01/M5-02, HEAD). [PROBE]
- **Constraint compliance:** only existing-source file touched is
  `packages/git-workspaces/src/worktree-manager.ts` (M5 fencing delta,
  `leases`-row contract untouched); **no protocol change** (no
  `packages/protocol` file in the commit); **no migration file** —
  `session_executions`, `usage_ledger`, and `lease_fencing_high_water` are
  service-owned via idempotent `CREATE TABLE IF NOT EXISTS` ensures on the
  shared DB handle (same precedent as M4-03 `integration_runs`), because
  `store.ts` and its migration registry are owned by another lane. [DESIGN]
- **Evidence:** 66 M5 focused tests PASS (19 recovery + 8 crash-replay + 35
  rate-limit + 4 rate-quota, FakeHarness/tmp-Git/tmp-SQLite, supplied);
  carried runtime 153+/177 + git-workspaces 74 + verification 23 (supplied);
  `tsc × 2` clean (supplied); live inference NOT VERIFIED — see
  [m5-robustness evidence](evidence/m5-robustness.md) §§4/7 for the
  per-acceptance map and honest repro scope. [PROBE]

### 10.1 No new OpenCode APIs assumed [DESIGN]

| Surface | Status in M5 |
|---|---|
| Harness / session / model surface | Unchanged by M5-01/M5-02. The limiter wraps the existing M2 `submitTurn` transport shape (outcome classes over `.status`/`.code`/message) and the recovery service owns no paid path (no harness calls, no inference). No new native method, event, permission, or model ref assumed. [DESIGN] — IMPLEMENTED, live transport behavior NOT VERIFIED |
| Q-07 (spec §18, quota/rate-limit surfacing) | Still OPEN as a live-provider question, but **decided for implementation**: 402 → quota-paused, 429 → bounded retries then terminal, 401/403 → auth-blocked, all zero-speculative-spend by FakeHarness submit counters. The live provider error shape stays the unproven assumption, not the mechanism. [DESIGN] |
| Live probes 01–12 | Still NOT VERIFIED — no `probe-NN.log` exists in the repo. M5 simulations close no live probe. [PROBE] |

### 10.2 Service-owned ensures vs migrations (compatibility note) [DESIGN]

- `session_executions` (`recovery.ts`), `usage_ledger` (`usage-ledger.ts`),
  and `lease_fencing_high_water` (`worktree-manager.ts`) are ensured
  idempotently on the shared DB handle (`CREATE TABLE IF NOT EXISTS`, safe on
  every open, safe on legacy DBs that predate the tables). No `.sql`
  migration file is added because an unwired file would be dead schema —
  `store.ts` migrations are owned by another lane. DDL/read/write failure in
  the fencing path is fail-closed (throws), never a silent fallback. [DESIGN] — IMPLEMENTED

### 10.3 Bound notes (no unbounded behavior introduced) [DESIGN]

- Outbox replay: at most `maxPerRun` rows per pass (default 100, hard cap
  1000), `created_at` order; delivered marked only after consumer ack.
- Lease CAS: bounded `MAX_CAS_ATTEMPTS = 10` retries; contention loses and
  retries higher, never spins.
- 429/transient: bounded exp-backoff (`base * 2^attempts` + full jitter) with
  retry budget, then terminal exhaustion; throttle queues admit without
  calling the transport (zero speculative spend).
- 402 quota: exactly one transport attempt, zero retries, no elapsed-time
  resume (BlockRegistry; documented triggers only). 401/403 auth: exactly one
  attempt, zero retries, never auto-approved; traffic triggers cannot clear
  auth blocks. [DESIGN] — IMPLEMENTED, live timing behavior NOT VERIFIED

### 10.4 Residual list + expiry [DESIGN/PROBE]

- **F-01 (fencing high-water + CAS): ACCEPTED RISK with revisit condition**
  (supplied M5-01/02 review disposition — not upgraded to PASS here).
  Simulations prove the mechanism against fakes; live concurrent load and real
  crash timing are unproven. **Revisit condition:** re-examine F-01 against
  live-server contention evidence (or a dedicated concurrent-load probe)
  before any production or release claim. [PROBE]
- **F-02 (terminal-once outcome): advisory** — covered by FI-7 tests
  (recorded terminal survives restart + duplicate delivery); filed follow-up,
  non-blocking. [DESIGN]
- **S3 lists: deferred** follow-ups, non-blocking for M5 closeout. [DESIGN]
- **F-04 (harness 402-shape): NOT VERIFIED (carried, not closed).** M5 adds no
  live provider call; the M2 quota posture is carried unchanged. [PROBE]

### 10.5 M5 gaps and NOT VERIFIED list (additive to §§5/7.3/8.3/9.5)

1. Live turns, overlap figures, provider 402/401-403 shaping, spend, and live
   crash-timing / concurrent-load behavior are NOT VERIFIED (no live server,
   no inference spend). [PROBE]
2. Focused/carried/typecheck counts (66 M5 focused; runtime 153+/177,
   git-workspaces 74, verification 23; `tsc × 2`) are supplied evidence cited
   in [m5-robustness](evidence/m5-robustness.md), not fresh executions of this
   doc session (link check only). [PROBE]
3. Exactly-once physical delivery is not claimed; ambiguous admissions
   quarantine for operator review by design. [DESIGN]
4. No live-server, screenshot, deployment, endpoint, CLI-flag, release, or
   support-promise claims are made in this addendum. [DESIGN]

## 11. M6 parity-UX compatibility addendum (DOC-M6-01)

> **Document status for this section only: APPROVED CONTRACT + IMPLEMENTED
> (FakeHarness + disposable-tmp simulations, supplied) / COMMITTED at
> `817835a` + `ccf0db6`.** Live TUI mounting and live-inference behavior
> remain **NOT VERIFIED**. §§1–10 above are unchanged M0/M2/M3/M4/M5
> baseline; nothing below rewrites them. [DESIGN]

- **Baseline:** HEAD `ccf0db6729d7612e48e190b6339276524a096041` —
  `feat(board-terminal): terminal board fallback (M6-BOARD-COMMIT-01)`; 4 files, 1592 insertions.
  Prior: `55541b0` (DOC-M5-01) → `817835a` (M6-0103-FIX-REVIEW-01 plugin lane; 8 files, 1737 insertions, 76 deletions) → `ccf0db6` (M6 board lane, HEAD). [PROBE]
- **Constraint compliance:** M0–M5 files untouched; **no migration file, no protocol change** (no `packages/protocol` file in either commit). The board lane is a new read-only package importing no store, daemon, harness, or ledger writer. [DESIGN]
- **Evidence:** 51 plugin + 34 board tests PASS (FakeHarness/tmp, supplied), `tsc × 2` clean (supplied); live TUI mount NOT VERIFIED — see [m6-parity-ux evidence](evidence/m6-parity-ux.md) §§3/6 for the per-acceptance map and honest repro scope. [PROBE]

### 11.1 Native slots verified vs fallback [DESIGN]

| Surface | Status in M6 |
|---|---|
| Board page | **Native (verified slot):** `UI.router.register({ name: "Swarm Board" })` + `UI.router.navigate({ type: "plugin", name })` (`dist/tui/context.d.ts` router/Page/Route/Destination) — IMPLEMENTED, live mount NOT VERIFIED |
| Roster/post/detail panes | **Native (verified slot):** `UI.slot({ append: "session.panel" })` + `UI.panel.open(name)` (`SlotMap "session.panel": PanelInput`, `SlotClaim`, context.d.ts) — there is no dedicated board slot, so the board is a router page, never a slot claim |
| Worker-session navigation | **Native, conditional:** `UI.tabs.focus(sessionID)` first (returns false when tabs disabled), else `UI.router.navigate({ type: "session", sessionID })` — IMPLEMENTED, live navigation NOT VERIFIED |
| `Alt+S` board shortcut | **Best-effort:** documented `KeymapCommand.bind` slot (`KeymapCommand { id: "swarm.board", bind: "alt+s", palette, slash }`, context.d.ts); OpenTUI owns binding-parse and the host may reject it — palette command + `/swarm board` are the guaranteed equivalents |
| Read markers / filters / follow | **Native (verified slot):** `Storage.memory("swarm-board", …)` live-synced ephemeral view-state (context.d.ts) + pure helpers |
| Board reads | **Native transport, fallback data:** `client.rpc(SwarmRpc)` (`RpcApi<D>(definition): RpcClient<D>`); daemon-backed methods return typed `daemon_unwired` until the transport lane injects a reader |
| Board render | **Fallback:** `solid-js`/`@opentui/*` optional peers NOT installed in `packages/plugin`, so no JSX is compiled in `tui.tsx` — the terminal board (`bunx opencode-swarm board --swarm <id>`, M6-02) is the working surface |
| Live probes 01–12 | Still NOT VERIFIED — no `probe-NN.log` exists in the repo. M6 simulations close no live probe. [PROBE] |

### 11.2 Versioned RPC schema [DESIGN]

`SwarmRpc` (id `swarm`, wire `swarm/0` / `0.0.1`) exposes exactly three methods (`health`, `boardSnapshot`, `boardPosts`) plus one `board.updated` event, built on `Rpc.define` JSON-schema values only. Every method validates `schemaVersion` fail-closed (`stale_schema`); daemon reads fail closed (`daemon_unwired`); malformed ids and paging fail closed (`invalid_swarm_id`, `invalid_pagination`, limit clamps to 100). No new OpenCode API is assumed: the commit uses only `Plugin.define`, `ctx.command.transform/list/reload`, `ctx.tool.transform`, `ctx.rpc.register`, and the verified TUI slots in §11.1 — see the 14-row supported-API table in [m6-parity-ux](evidence/m6-parity-ux.md) §4. IMPLEMENTED, live transport behavior NOT VERIFIED.

### 11.3 No new OpenCode APIs assumed [DESIGN]

M6 invents no hook: the five unsupported command paths (native board route via command API, `Alt+S` interception, inline `@worker` routing, session deep-link RPC, wake/usage daemon reads) are recorded in `UNSUPPORTED_COMMAND_APIS` / `UNSUPPORTED_DAEMON_READS` with their supported fallbacks and never called. Q-02/Q-08 (spec §18) stay OPEN as live-TUI questions with documented fallbacks; the terminal board is the contract-approved fallback per spec §4.4. Live mount, live key capture, and live navigation remain NOT VERIFIED. [PROBE]

### 11.4 Housekeeping note [PROBE]

One untracked junk file `NUL` sits at the repo root; it is in neither M6 commit, is never cited as evidence, and was left untouched. Untracked `NUL` is uncommitted noise, not a committed artifact.

### 11.5 M6 gaps and NOT VERIFIED list (additive to §§5/7.3/8.3/9.5/10.5)

1. Live TUI mount (needs a plugin-config change this slice must not perform), live turns, provider 402 shaping, spend, and the live 10-minute idle window are NOT VERIFIED (no live server, no TUI host mount, no inference spend). [PROBE]
2. Focused/typecheck counts (51 + 34, `tsc × 2`) are supplied evidence cited in [m6-parity-ux](evidence/m6-parity-ux.md), not fresh executions of this doc session (link check only). [PROBE]
3. Exactly-once physical delivery is not claimed; ambiguous admissions quarantine for operator review by design. [DESIGN]
4. No live-server, screenshot, deployment, endpoint, CLI-flag, release, or support-promise claims are made in this addendum. [DESIGN]

## 12. M7 scale/codex compatibility addendum (DOC-M7-01)

> **Document status for this section only: APPROVED CONTRACT + IMPLEMENTED
> (FakeHarness + tmp-Git/tmp-SQLite/disposable-tmp simulations, supplied) /
> COMMITTED at `9111c4a`.** Live-server and live-inference behavior remain
> **NOT VERIFIED**. §§1–11 above are unchanged M0/M2/M3/M4/M5/M6 baseline;
> nothing below rewrites them. [DESIGN]

- **Baseline:** HEAD `9111c4a465de9469f2f8011124eac1dc0c301c33` —
  `feat(m7): scale validation suite + bench and Codex fail-closed probe (M7-CODE-COMMIT-01)`; 8 files, 1859 insertions, zero deletions.
  Prior: `ccf0db6` (M6 board lane) → `f7237bf` (DOC-M6-01) → `9111c4a` (M7, HEAD). [PROBE]
- **Constraint compliance:** M0–M6 files untouched; **no migration file** (no `.sql` file in the commit — service-owned ensures precedent carried); **no protocol change** (no `packages/protocol` file in the commit); **no OpenCode default change** (bridge Tier-A surface untouched, `OpenCodeHarness`/`backend: "opencode"` unshadowed). [DESIGN]
- **Evidence:** 10 scale + 5 fault-injection + 9 Codex fail-closed rows PASS (FakeHarness/tmp-Git/tmp-SQLite, supplied), bench gates supplied, `tsc × 2` + adapter `typecheck` clean (supplied); live inference NOT VERIFIED — see [m7-scale-codex evidence](evidence/m7-scale-codex.md) §§2–5/7 for the per-acceptance map and honest repro scope. [PROBE]

### 12.1 No new OpenCode APIs assumed [DESIGN]

| Surface | Status in M7 |
|---|---|
| OpenCode harness / session / model surface | Unchanged by M7. The scale lane reuses the frozen M1-03 engine import-only; the Codex lane type-checks against the M1-03 `CodingHarness` port shape but performs zero native calls — every method throws `CodexNotImplementedError`. No new native method, event, permission, or model ref assumed. [DESIGN] — IMPLEMENTED-stub, live transport behavior NOT VERIFIED |
| Codex CLI / SDK surface | Resolve-only: CLI `0.167.0` present, SDK `0.167.2` metadata resolved without install. Verbs enumerated locally (`thread/*`, `turn/start`/`steer`/`interrupt`, `model/list`); no `switchAgent`, snapshot, or permission-rules equivalent confirmed; `app-server` explicitly `[experimental]`. Fail-closed stub per §4 of the evidence file — no turn submitted without resolved stable verbs. [DESIGN] |
| OpenCode default path | Untouched: `adapter-codex` exports no `OpenCodeHarness`/default-harness symbol and registers nothing globally; discriminator is exactly `"codex"`. Bridge Tier-A 50 still PASS (carried, supplied). [DESIGN] — IMPLEMENTED, live default behavior NOT VERIFIED |
| Live probes 01–12 | Still NOT VERIFIED — no `probe-NN.log` exists in the repo. M7 simulations close no live probe. [PROBE] |

### 12.2 Service-owned ensures vs migrations (compatibility note) [DESIGN]

- The scale suites and bench reuse the M4/M5 service-owned ensure precedent (idempotent `CREATE TABLE IF EXISTS` ensures on shared/file DB handles, `integration_runs`/`leases` rows) — no new `.sql` migration file is added, because an unwired file would be dead schema while `store.ts` migrations are owned by another lane. [DESIGN] — IMPLEMENTED
- Bench report JSON goes to a disposable `mkdtemp` dir under the OS tmp dir only; no canonical or user-project writes by construction. [DESIGN] — IMPLEMENTED

### 12.3 Bound notes (no unbounded behavior introduced) [DESIGN]

- Scheduler drain, wake dispatch, post append/resync, contention interleavings, and 4-way integrates are all bounded loops over fixed N with deterministic FakeHarness admission (no retries against live transports, no inference spend). Quota path stays one-attempt/never-retry (M2 carry). [DESIGN] — IMPLEMENTED, live timing behavior NOT VERIFIED
- Bench RSS delta (+0.1–0.2MB supplied) and hardware-dependent timings are machine-local observations, not compatibility guarantees. [PROBE]

### 12.4 Residual list + carry [DESIGN/PROBE]

- **S2 dispositions: accepted hardening follow-ups, non-blocking** (supplied M7-01/02 review disposition — no finding IDs invented here). [PROBE]
- **F-04 (harness 402-shape): NOT VERIFIED (carried, not closed).** M7 adds no inference path and no paid-service call; the M2 quota posture is carried unchanged. [PROBE]

### 12.5 M7 gaps and NOT VERIFIED list (additive to §§5/7.3/8.3/9.5/10.5/11.5)

1. Live inference/spend, live server turns, live contention timing, provider 402 shaping, and bench hardware dependence are NOT VERIFIED (no live server, no inference spend). [PROBE]
2. Focused/carried/typecheck/bench counts (10 + 5 + 9 rows, carried 35 + 4 + priors, `tsc × 2` + adapter typecheck, bench §3 figures) are supplied evidence cited in [m7-scale-codex](evidence/m7-scale-codex.md), not fresh executions of this doc session (link check only). [PROBE]
3. Codex transport is honestly unbuilt — four gating questions open; no stable-verb, session-identity, model-mapping, or snapshot claim is made. [DESIGN]
4. Exactly-once physical delivery is not claimed; ambiguous admissions quarantine for operator review by design. [DESIGN]
5. No live-server, screenshot, deployment, endpoint, CLI-flag, release, or support-promise claims are made in this addendum. [DESIGN]
