# M6 parity UX evidence — `/swarm` family + native TUI/RPC + terminal board (M6-01/M6-02/M6-03)

> **Document status: APPROVED CONTRACT + IMPLEMENTED (FakeHarness + disposable-tmp simulations, supplied) / COMMITTED at `817835a` + `ccf0db6`.**
> Every behavior below is code-observed at the recorded HEADs and covered by
> committed **FakeHarness simulations with disposable in-memory/tmp doubles** —
> never live inference, never a live TUI mount, never the canonical checkout
> as a test subject. **Live TUI mounting, live-server turns, and live
> inference remain NOT VERIFIED** (no live server, no TUI host mount, no
> inference spend, no credentials). Design intent is never described as
> shipped, released, or production-proven. [DESIGN]

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Source baseline HEAD:** `ccf0db6729d7612e48e190b6339276524a096041` —
  `feat(board-terminal): terminal board fallback (M6-BOARD-COMMIT-01)` [PROBE — `git rev-parse HEAD`, inspected read-only in the DOC-M6-01 session]
- **Commit scope A (plugin lane):** `817835a15a4da910d84d4560493e471d0c6cc717` —
  `feat(m6): /swarm command family + native TUI/RPC wiring (M6-0103-FIX-REVIEW-01)`; **8 files, 1737 insertions, 76 deletions** (`git show --stat 817835a`). [PROBE — inspected]
- **Commit scope B (board lane):** `ccf0db6729d7612e48e190b6339276524a096041` —
  `feat(board-terminal): terminal board fallback (M6-BOARD-COMMIT-01)`; **4 files, 1592 insertions** (`git show --stat ccf0db6`). [PROBE — inspected]
- **Prior chain (oldest → newest):** `7330e0e` (M4) → `698171b` (DOC-M4-01) → `b54c50c` (m105 cleared) → `c10e0be` (M4-INT-FIX-01) → `69f40a9` (M5) → `55541b0` (DOC-M5-01) → `817835a` (M6 plugin lane) → `ccf0db6` (M6 board lane, HEAD). [PROBE — `git log --oneline`, inspected]
- **Git status at inspection:** clean apart from one untracked junk file `NUL` at the repo root, which is **not** part of either M6 commit, is never cited as evidence here, and is left untouched. [PROBE]
- **M6 constraints honored:** M0–M5 source behavior preserved — neither M6 commit touches runtime, protocol, store, git-workspaces, or verification sources; **no migration file, no protocol change**. The board lane is a new read-only package that imports no store, daemon, harness, or ledger writer. [DESIGN — `git show --stat` file lists]

Related records: [spec](../plan/spec.md) §§11 (terminal UX), 4.2/4.4 (server hooks / TUI+RPC), 14 (M6 gate), 2 (PAR-01…25) ([DESIGN] contract source), [m5-robustness](m5-robustness.md) (M5 baseline this slice builds on), [compatibility-report](../compatibility-report.md) (M6 addendum §11), [milestone-matrix](../milestone-matrix.md).

Evidence-label key: **[DESIGN]** approved contract / code-observed claim, **[PROBE]** needs (or has, when noted) executable confirmation.

Human-language note: this file describes what a person using the swarm sees and does — boards, rosters, commands, shortcuts — in everyday words. Internal field, type, and file names appear only as evidence pointers in backticks, never as user-facing terminology. [DESIGN]

## 1. Commit file lists (exact, from `git show --stat`) [PROBE]

### 1.1 `817835a` — plugin lane (8 files, 1737 insertions, 76 deletions)

| File | Change (stat) | Role [DESIGN] |
|---|---|---|
| `packages/plugin/src/commands/swarm.ts` | 317 lines changed (M6-01 delta) | Full `/swarm` family: parse, coordinator binding (PAR-01), zero-token reads, private steer (PAR-23), scheduler gate + preservation policy (PAR-18), help, unsupported-API record; code-path role gate, fail-closed defaults |
| `packages/plugin/src/commands/__tests__/swarm-command.test.ts` | 379 lines changed | M6-01 family tests (parse, binding, role gate, reads, steer, lifecycle, help, versioned client reads) |
| `packages/plugin/src/rpc.ts` | 394 lines changed (M6-03 delta) | Versioned `SwarmRpc` portable definition (`swarm/0`, `0.0.1`); three methods (`health`, `boardSnapshot`, `boardPosts`); typed fail-closed errors; capability table with exact type refs |
| `packages/plugin/src/tui.tsx` | 162 lines changed (M6-03 delta) | Verified-slot native wiring only: board page, `session.panel` claim, tabs-first session navigation, best-effort `alt+s` with palette + slash equivalents, deferred render (no JSX compiled) |
| `packages/plugin/src/__tests__/tui-rpc.test.ts` | 461 lines (new) | M6-03 registration / slots / navigation / view-state / RPC validation / fallback / zero-inference source-guard tests |
| `packages/plugin/src/client.ts` | 47 lines changed | Versioned daemon-client reads; `UNSUPPORTED_DAEMON_READS` record (wakes/usage have no versioned route, never fetched via invented paths) |
| `packages/plugin/src/index.ts` | 34 lines changed | `/swarm` registration + `swarm_health` tool + `SwarmRpc` registration with reverse-order teardown; execute hook stays side-effect-free |
| `packages/plugin/src/index.test.ts` | 19 lines changed | Registration/teardown coverage delta |

### 1.2 `ccf0db6` — board lane (4 files, 1592 insertions)

| File | Change (stat) | Role [DESIGN] |
|---|---|---|
| `packages/board-terminal/src/board.ts` | 890 lines (new) | Read-only terminal board: ordering, filters, roster, delivery/wake status, tasks/verification, session-nav entries, usage actuals, reconnect cursors, zero-inference assertion; private steering has no render slot |
| `packages/board-terminal/src/__tests__/board.test.ts` | 673 lines (new) | 34 board tests incl. FIX-02/S3 follow-up coverage (code-observed describe blocks, supplied PASS) |
| `packages/board-terminal/package.json` | 19 lines (new) | Standalone package manifest (no store/daemon/harness dependencies by construction) |
| `packages/board-terminal/tsconfig.json` | 10 lines (new) | Package typecheck config |

Total M6: **12 files, 3329 insertions, 76 deletions** across the two commits. [PROBE]

## 2. Component map (all paths inspected at HEAD, read-only) [DESIGN]

| Component | File | Role |
|---|---|---|
| Command family | `packages/plugin/src/commands/swarm.ts` (`parseSwarmInput`, `SwarmCommand`) | Nine intents: activate (binds the current conversation as coordinator), status, board, agents, pause, resume, stop, message `@worker`, help. Single-token non-subcommand words are treated as work descriptions, never errors; matching is case-insensitive while the description keeps its original wording. Every privileged path checks the code role gate before acting; an omitted role defaults to the least-privileged researcher, never coordinator. |
| Coordinator binding | `swarm.ts` (`bindCoordinatorSession`) | Binds the current session as lead (PAR-01). Pure validation — the daemon persists the association. |
| Zero-token reads | `swarm.ts` (`status`/`board`/`agents` results carry `modelCalls: 0`) | Status, board posts, and roster are served from durable projections with no model call by construction. |
| Private steering | `swarm.ts` (`message` intent → `DirectSteerer`) | A person can address one worker privately; the message travels as a durable wake and is never written to the public board (PAR-23). Unknown names fail with a validation error and no wake is sent. |
| Scheduler gate + preservation | `swarm.ts` (`SCHEDULER_GATE_*`, `WORKTREE_PRESERVATION_POLICY`, `STOP_POLICY`) | Pause halts new wake-ups while in-flight work finishes; resume releases the gate; stop records a durable cancel (terminal states never resume). Every response carries the worktree preservation promise: unintegrated, failed, or dirty work is kept for diagnosis, never silently deleted (PAR-18). |
| Full reference | `swarm.ts` (`SWARM_HELP`) | `/swarm help` prints the whole family in plain words. |
| Daemon client | `packages/plugin/src/client.ts` (`SwarmDaemonClient`) | Versioned reads only (`/v1/` prefix, `/healthz` parity shape). Wake and usage-ledger reads have no versioned daemon route, so they are not fetched through invented paths (`UNSUPPORTED_DAEMON_READS`). |
| Versioned RPC | `packages/plugin/src/rpc.ts` (`SwarmRpc`, `createSwarmRpcHandlers`) | Wire versions `swarm/0` / `0.0.1` on every payload. Reads fail closed with named errors: wrong version → `stale_schema`; unwired daemon reader → `daemon_unwired` (terminal fallback named); bad swarm id → `invalid_swarm_id`; bad paging → `invalid_pagination` (huge pages clamp to 100). |
| Native board wiring | `packages/plugin/src/tui.tsx` | Board page registration, roster/post/detail pane claim, worker-conversation navigation (open the running tab when tabs are available, otherwise route to the session), best-effort `Alt+S` shortcut that is always also reachable from the command palette and `/swarm board`, read markers / filters / follow view-state, versioned board data calls. Rendering itself is deferred until the optional display libraries are present — the terminal board below is the working surface meanwhile. |
| Terminal board | `packages/board-terminal/src/board.ts` (`renderBoard`, `buildRoster`, `filterPosts`, `collapseWakes`, `buildTaskViews`, `sessionNav`, `renderUsage`, `assertZeroInference`) | Plain-text board that runs in any terminal today: chronological posts with an unread divider, roster with plain-word states, delivery/wake status, task and verification lines, worker-conversation entries, recorded cost/token totals (a zero means unobserved, never estimated), sequence-cursor reconnect that replays exactly the missed range, and a zero-inference assertion. Private steering has no parameter anywhere in the render path, so it can never leak onto the public board. |

## 3. Per-acceptance mapping — spec §14 M6 gate + exit criteria → committed tests [PROBE]

Counts below are **committed/supplied evidence** (implementation-handoff figures, source-inspected, not re-executed in this DOC session): **51 plugin tests** across `tui-rpc.test.ts` + `swarm-command.test.ts` + `index.test.ts`, **34 board tests** in `board.test.ts`, all PASS (supplied); **`tsc` clean × 2** (supplied). This doc session executed **only the link check** (§6); every typecheck/test figure is cited, not claimed as a fresh run. Live TUI mount stays NOT VERIFIED throughout.

| # | Expected (spec gate / exit criterion) | Test evidence (file: test) | Gate |
|---|---|---|---|
| 1 | Full `/swarm` family parses: activate, status, board, agents, pause, resume, stop, message, help | `swarm-command.test.ts`: `M6-01 parseSwarmInput full family` + `parseSwarmInput validation` | PASS (supplied) |
| 2 | Current conversation becomes coordinator (PAR-01); unknown words are work, not errors | `swarm-command.test.ts`: `bindCoordinatorSession (PAR-01)` + family parsing | PASS (supplied) |
| 3 | Status / board / agents reads cost zero model calls | `swarm-command.test.ts`: `M6-01 zero-inference reads (status/board/agents)`; results carry `modelCalls: 0` | PASS (supplied) |
| 4 | Private message to one worker never appears on the public board (PAR-23) | `swarm-command.test.ts`: `M6-01 private steer (message never board-posted)` — board length proved unchanged; terminal `private isolation` describe | PASS (supplied) |
| 5 | Pause/resume/stop gate the scheduler and promise worktree preservation (PAR-18) | `swarm-command.test.ts`: `M6-01 coordinator-only lifecycle (scheduler gate + preservation policy)` | PASS (supplied) |
| 6 | Coordinator-only management; lead never edits code (PAR-15); default-deny roles | `swarm-command.test.ts`: `authorizeToolCall (tool auth, not prompt-only)` | PASS (supplied) |
| 7 | Board viewer: chronological posts, filters, unread divider, follow (PAR-21) | `board.test.ts`: `ordering`, `filters`, `D-07/D-08 board chrome and empty states` | PASS (supplied) |
| 8 | Roster: coordinator first; plain-word states; model, last post, latest task (PAR-21) | `board.test.ts`: `roster transitions`, `D-04 human roster lines` | PASS (supplied) |
| 9 | Delivery and wake status shown per post; duplicate wakes collapse (PAR-12 lineage) | `board.test.ts`: `delivery and wake status`, `D-01 collapse progression order`, `FIX-02 CODE F-01 taskWakes full-set` | PASS (supplied) |
| 10 | Tasks, attempts, and verification evidence visible; monitor rows shown (PAR-06/07/14 lineage) | `board.test.ts`: `task and verification visibility`, `D-06 human task lines`, `FIX-02 UX F-02 post line clean default` | PASS (supplied) |
| 11 | Worker-conversation navigation: open the matching session (PAR-24) | `tui-rpc.test.ts`: `M6-03 worker-session navigation` (tabs-first, route fallback); `board.test.ts`: `session-nav compat` | PASS (simulation) / live mount NOT VERIFIED |
| 12 | Board opening: shortcut plus guaranteed equivalents (spec §11 `Alt+S`) | `tui-rpc.test.ts`: keymap layer exposes the board command with palette + slash equivalents for the best-effort `Alt+S` bind | PASS (simulation) / live key capture NOT VERIFIED |
| 13 | Terminal board fallback works without native embedding (spec §4.4) | `tui-rpc.test.ts`: `M6-03 route/board fallback selection` + `selectBoardSurface` (native page only when fully wired, else terminal); terminal board fully rendered by `board.ts` | PASS (supplied) |
| 14 | Reconnect replays exactly the missed range; no assumed offsets (PAR-12/§12) | `board.test.ts`: `live-update and reconnect`, `D-02 reconnect advances cursor`, `D-03 generation-pinned live wakes` | PASS (supplied) |
| 15 | Usage/cost lines show recorded actuals only, never estimates (§12) | `board.test.ts`: `usage accuracy`, `renderUsage` (zero labelled unobserved) | PASS (supplied) |
| 16 | Zero inference while waiting (PAR-11; exit criterion: no model calls over a simulated idle window) | `tui-rpc.test.ts`: `M6-03 zero-inference source guard` (no inference call-sites in probe modules); `board.test.ts`: `zero-inference` (`assertZeroInference`) | PASS (simulation) / live 10-minute idle window NOT VERIFIED |
| 17 | Versioned RPC fails closed on stale/malformed input; teardown unsubscribes in reverse | `tui-rpc.test.ts`: `M6-03 RPC versioned-schema validation` + `M6-03 server registration` | PASS (supplied) |
| 18 | Mention-graph replay (PAR-22) as a drawn graph | Chronological replay is covered (rows 7/9); a drawn mention-graph surface is **not** claimed in this slice — TODO, not a silent pass | NOT VERIFIED (deferred, honestly unclaimed) |
| 19 | Live TUI mount, live server turns, live inference spend | No live mount (needs a plugin-config change this slice must not perform), no live server, no spend | BLOCKED — NOT VERIFIED by design |

Required-test tally: **51 plugin + 34 board = 85 M6 tests, all PASS (supplied)**; `tsc × 2` clean (supplied). [PROBE — cited, not re-executed]

## 4. Supported vs fallback API map (installed `@opencode/plugin` 2.2.7 types, inspected read-only) [DESIGN]

Fourteen supported APIs below are the exact hooks the M6 commits use, each with its published type reference. Unsupported paths are never called — each names its supported fallback with an exact type ref. Live behavior of every row remains NOT VERIFIED (FakeHarness/tmp only).

| # | Supported API (used by M6) | Exact published type ref [PROBE — installed 2.2.7 types] | M6 use |
|---|---|---|---|
| 1 | `Plugin.define({id, setup})` (server) | `dist/promise/plugin.d.ts: `define(plugin: Plugin): Plugin`; `Context`, `Cleanup` | `index.ts` server entry |
| 2 | `ctx.command.transform(editor => …)` | `dist/promise/command.d.ts: CommandDomain.transform: Transform<CommandEditor>` | `/swarm` registration |
| 3 | `CommandEditor.add(definition)` | `dist/promise/command.d.ts: add(definition: CommandDefinition): void`; `execute: (input) => Promise<void>` | `/swarm` no-op hook |
| 4 | `ctx.command.list()` | `dist/promise/command.d.ts: CommandDomain extends Pick<CommandApi, "list">` | Conflict discovery (fallback path) |
| 5 | `ctx.tool.transform(editor => …)` + `ToolEditor.add` | `dist/promise/tool.d.ts: ToolDomain.transform`; `add<Input, Output>(tool: Info…): void` | `swarm_health` tool |
| 6 | `ctx.rpc.register(definition, handlers)` | `dist/promise/rpc.d.ts: register: <const D extends Rpc.PortableDefinition>(definition: D, handlers: RpcHandlers<NoInfer<D>>) => Promise<RpcRegistration<D>>` | `SwarmRpc` registration |
| 7 | `Rpc.define({id, methods, events})` | `@opencode/schema/rpc: PortableDefinition { id, methods, events }` (JSON-schema values only) | Portable contract |
| 8 | Handler context `{ signal, error }` | `dist/promise/rpc.d.ts: RpcCallContext<M> { signal: AbortSignal; error: Rpc.ErrorFactory<M> }` | Fail-closed errors, never throws |
| 9 | `RpcRegistration.dispose` + teardown chain | `dist/promise/rpc.d.ts: RpcRegistration<D> extends Registration { events: { emit } }` | Reverse-order teardown in `index.ts` |
| 10 | TUI `Plugin.define({id, setup})` | `dist/tui/plugin.d.ts` (TUI entry; host import stubbed by fakes) | `tui.tsx` entry |
| 11 | `UI.router.register(page)` + `UI.router.navigate(dest)` | `dist/tui/context.d.ts: router { register; navigate(destination: Destination) }`; `Page`, `Route`, `Destination` | Board page + session route |
| 12 | `UI.slot({ append: "session.panel" })` + `UI.panel.open(name)` | `dist/tui/context.d.ts: SlotMap "session.panel": PanelInput`; `slot: (claim: SlotClaim) => () => void`; `panel.open` | Roster/post/detail panes |
| 13 | `UI.tabs.focus/open(sessionID)` | `dist/tui/context.d.ts: tabs { focus(sessionID): boolean; open(…): boolean … }`; `Route { type: "session", sessionID }` | Worker-session navigation (tabs-first, route fallback) |
| 14 | `Keymap.layer` + `Storage.memory` + `client.rpc(definition)` | `dist/tui/context.d.ts: KeymapCommand { id, bind, palette, slash }`; `Storage.memory(key, { initial })`; `@opencode/client/dist/promise/rpc.d.ts: RpcApi<D>(definition): RpcClient<D>` | `alt+s` best-effort + palette/slash; ephemeral read markers/filters/follow; versioned board reads |

Unsupported-API fallbacks (exact type refs for why the native path is not taken) [DESIGN]:

- **Board route via command API:** `CommandDomain` (`command.d.ts`) exposes `transform`/`list`/`reload` only — no board-route hook exists there, so every board read carries the terminal fallback hint (`bunx opencode-swarm board --swarm <id>`). Native page registration itself uses row 11, not the command API. (M6-03)
- **`Alt+S` interception:** no verified command-API shortcut hook exists in 2.2.7 — the shortcut is a best-effort `KeymapCommand.bind` (row 14); OpenTUI owns binding-parse and the host may reject it, so the palette command and `/swarm board` are the guaranteed equivalents. (M6-03)
- **Inline `@worker` routing:** no verified TUI routing hook exists — `/swarm message @worker` is the supported path. (M6-03)
- **Session deep-link RPC:** no verified command-API navigation hook — native session ids are listed with the navigator hint; TUI deep-link deferred to M6-03 follow-up. (M6-03)
- **Wake/usage daemon reads:** no versioned daemon route exposes them (`UNSUPPORTED_DAEMON_READS` in `client.ts`); handlers return typed `daemon_unwired` until the transport lane injects a reader — never fetched via invented paths (contract amendment required).
- **Board render:** `solid-js`/`@opentui/*` are optional peers and are NOT installed in `packages/plugin`, so no JSX may be compiled in `tui.tsx`; renders are deferred stubs and the terminal board is the working surface (`SWARM_BOARD_CAPABILITIES` rows `board-render`, `daemon-snapshot-rpc`: `fallback`). [PROBE]

## 5. Review and fix record (supplied) [PROBE — cited, not re-executed]

- **Plugin lane review:** COMMIT-ready, **0 findings**. [PROBE — supplied review disposition]
- **Board lane review:** COMMIT-ready, **0 findings**. [PROBE — supplied review disposition]
- **S2 fixes + re-reviews:** folded into `817835a` before commit (no separate fix commit in log). [PROBE — supplied; `git log --oneline` shows no M6 fix commit between `55541b0` and `ccf0db6` besides the two lane commits]
- **Board FIX-02 / S3 one-liners:** committed inside `ccf0db6` — code-observed as `FIX-02 …` / `S3 …` describe blocks in `board.test.ts` (`FIX-02 CODE F-01 taskWakes full-set`, `FIX-02 UX F-01/F-02`, `FIX-02 S3 one-liners`). [DESIGN — code-observed]
- **F-04 (harness 402-shape): NOT VERIFIED (carried, not closed).** M6 adds no inference path and no paid-service call; the M2 quota posture is carried unchanged. [PROBE]

## 6. Reproducible log (commands inspected at HEAD; NOT re-executed in this DOC session)

```powershell
git rev-parse HEAD
# ccf0db6729d7612e48e190b6339276524a096041 (inspected)

git show --stat 817835a15a4da910d84d4560493e471d0c6cc717
# 8 files changed, 1737 insertions(+), 76 deletions(-) (inspected — file list in §1.1)

git show --stat ccf0db6729d7612e48e190b6339276524a096041
# 4 files changed, 1592 insertions(+) (inspected — file list in §1.2)

git log --oneline -8
# ccf0db6 (HEAD) / 817835a / 55541b0 / 69f40a9 / c10e0be / b54c50c / 698171b / 7330e0e (inspected)

# Supplied (cited, NOT re-executed here — no build/test re-runs in DOC-M6-01):
# tsc clean x2 → exit 0
# focused: 51 (plugin: tui-rpc + swarm-command + index) + 34 (board) = 85 PASS
# live TUI mount / live inference: NOT VERIFIED (no live server, no TUI host mount, no spend, no credentials)
```

Typecheck/test figures above are **committed/supplied evidence with honest scope**: inspected in source and handoff, not freshly executed in this documentation session. To advance the live gate, mount the plugin in a disposable TUI host, run the focused suites, and capture the mount log. [PROBE]

### Link validation (the only check executed in this DOC session) [PROBE]

- Relative links in this file (`../plan/spec.md`, `m5-robustness.md`, `../compatibility-report.md`, `../milestone-matrix.md`) validated by read-only path-existence inspection (`Test-Path` over `docs/` and `docs/evidence/`); all targets exist — exit 0.
- No unexecuted command examples are presented as executed; §6 commands are labeled inspected/supplied.

## 7. Gaps and NOT VERIFIED list [PROBE]

1. Live TUI mount (needs a plugin-config change this slice must not perform), live turns, overlap figures, provider 402 shaping, spend, and the live 10-minute idle window are NOT VERIFIED.
2. Focused/typecheck counts (51 + 34, `tsc × 2`) are supplied evidence cited in §3, not fresh executions of this doc session (link check only).
3. Exactly-once physical delivery is not claimed; ambiguous admissions quarantine for operator review by design (M2 carry).
4. Drawn mention-graph surface (PAR-22) is deferred and unclaimed — chronological replay is covered, a graph drawing is not.
5. No live-server, screenshot, deployment, endpoint, CLI-flag, release-number, or support-promise claims are made in this evidence.
6. Untracked `NUL` junk file at repo root is uncommitted noise, never evidence, left untouched.

## 8. Claim-status summary

| Claim | Status |
|---|---|
| `/swarm` family + role gate + zero-token reads + private steer + scheduler gate (§2) | IMPLEMENTED (code-observed at `817835a`) |
| Versioned RPC + native-slot wiring + best-effort shortcut (§§2/4) | IMPLEMENTED (code-observed at `817835a`); live mount NOT VERIFIED |
| Terminal board: viewer, roster, delivery, tasks, session-nav, usage, reconnect, zero-inference (§2) | IMPLEMENTED (code-observed at `ccf0db6`) |
| 85 focused PASS (51 plugin + 34 board, FakeHarness/tmp) + `tsc × 2` | SUPPLIED PASS / NOT VERIFIED (fresh run) — cited, see §6 |
| Commits `817835a` (8 files, 1737+/76−) + `ccf0db6` (4 files, 1592+) | COMMITTED (HEAD chain, §1) |
| Plugin / board reviews COMMIT-ready 0 findings; S2 + re-reviews folded into `817835a` | Cited supplied review disposition (see §5) |
| F-04 (harness 402-shape) | NOT VERIFIED (carried, not closed) |
| Mention-graph drawing (PAR-22) | TODO (deferred, unclaimed) |
| Live TUI mount / live turns / provider shapes / spend | NOT VERIFIED (no live log in repo) |
| M7+ work | TODO (see [milestone-matrix](../milestone-matrix.md)) |
| Release / shipped / production | NOT CLAIMED — commits are not a release |
