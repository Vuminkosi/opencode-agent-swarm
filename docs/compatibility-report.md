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
