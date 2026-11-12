# Swarm user guide — `/swarm` commands + board

> **Document status: APPROVED CONTRACT + IMPLEMENTED (code-observed, not
> independently verified here).** Live TUI mounting, live turns, and live
> inference remain **NOT VERIFIED** — no live server was contacted and no
> inference was run for this document. Command examples below are
> **unexecuted** unless you run them yourself. Source baseline: canonical
> repo at `HEAD 7d4d79b42b6a775a31fbe9bfca458045714a2ef4`
> (M8-CODE-COMMIT-01). M6 semantics carry: plugin lane `817835a` (command
> family + native TUI/RPC wiring) + board lane `ccf0db6` (terminal board
> fallback). For install, daemon config, and first checks, see
> [install.md](install.md) (not duplicated here). For per-acceptance test
> evidence and the supported-API table, see
> [m6-parity-ux evidence](evidence/m6-parity-ux.md) (cited, not rewritten
> here).

Audience: anyone who drives a swarm from inside OpenCode — operators and
end users of the `/swarm` commands and the board. No daemon internals are
assumed; internal field and type names appear only as evidence pointers in
backticks.

## 1. What the swarm gives you

A swarm is a small team that works from your current conversation: you
stay the lead (coordinator), and named workers carry out the work. Three
things are always true:

- **Reads are free.** Status, board, and roster reads are served from
  saved daemon state and never spend model calls (`modelCalls: 0` by
  construction in `packages/plugin/src/commands/swarm.ts`).
- **Private stays private.** A message you send to one worker travels as
  a private wake and is never written to the shared board (PAR-23).
- **Paused work is kept.** Pausing or stopping a swarm never silently
  deletes unfinished, failed, or dirty work — it is preserved for
  diagnosis (PAR-18).

Native TUI embedding (a board page inside the OpenCode interface) is
wired but **NOT VERIFIED live**: mounting it needs a plugin-config change
this slice must not perform, and the display libraries it needs
(`solid-js` / `@opentui/*`) are optional peers that are not installed in
`packages/plugin`. The **working surface today is the terminal board**
(see §3). This is the contract-approved fallback per spec §4.4, not a
temporary hack.

## 2. The `/swarm` command family

Type `/swarm help` at any time for the full reference in your own words
(`SWARM_HELP` in `packages/plugin/src/commands/swarm.ts`). Every command
below is source-observed in `parseSwarmInput` + `SwarmCommand.execute`;
nothing here is invented.

| Command | What it does | Who may use it |
|---|---|---|
| `/swarm <requirement>` | Binds your current conversation as coordinator and starts two workers on the described work. A single plain word is treated as a work description, never an error. | Coordinator only (code-gated, not prompt-gated) |
| `/swarm status [id]` | Shows a snapshot of the swarm from saved state. Costs zero model calls. | Anyone with access |
| `/swarm board [id]` | Shows board posts via the versioned read, plus the terminal-board fallback hint. Costs zero model calls. | Anyone with access |
| `/swarm agents [id]` | Lists the roster with each worker's session, plus a hint to open a worker conversation through your session navigator. Costs zero model calls. | Anyone with access |
| `/swarm message @worker <text>` | Sends a private note to one worker. It never appears on the shared board. Unknown names fail with a validation error and nothing is sent. | Anyone permitted to post |
| `/swarm pause <id>` | Halts new work from starting; work already running finishes on its own. Every reply carries the work-preservation promise. | Coordinator only |
| `/swarm resume <id>` | Releases the gate; queued work resumes in order. | Coordinator only |
| `/swarm stop <id>` | Records a durable cancel. A stopped swarm never resumes. Work is preserved, never deleted. | Coordinator only |
| `/swarm help` | Prints the whole family in plain words. | Anyone |

Notes from the source you should know:

- **Matching ignores case** (`/swarm STATUS` works like `/swarm status`),
  but your work description keeps its original wording.
- **Bare `/swarm` with nothing after it** is a usage error, not an
  implicit start — describe the work you want done.
- **Omitted role defaults to least privilege.** If no role is resolved,
  you get `researcher` (post only), never coordinator.
- **Swarm ids** accept 1–128 characters of letters, digits, `_`, `-`
  (`SWARM_ID_PATTERN`, mirrored in `rpc.ts`). Anything else fails with a
  validation error. When you omit the id, the last swarm you used is
  assumed; if there is none, you are asked to pass one explicitly.

## 3. The board (working surface: terminal fallback)

The terminal board (`packages/board-terminal/src/board.ts`) runs in any
terminal today and is read-only by construction: it cannot submit work,
spend model calls, or leak a private message (private steering has no
render slot anywhere in its path). Unexecuted example:

```powershell
bunx opencode-swarm board --swarm <id>
```

This exact string is the `TERMINAL_BOARD_FALLBACK` constant in
`packages/plugin/src/rpc.ts` — copy it from `/swarm board` output rather
than retyping it.

What the board shows you, in plain words:

- **Posts in order**, oldest first, with an unread divider so you can see
  what is new since you last looked. Filters narrow by kind; follow mode
  tracks live posts.
- **Roster**, coordinator first, with plain-word states (working,
  waiting, killed) plus each worker's model, latest post, and latest task.
- **Delivery and wake status** per post; duplicate wakes collapse so one
  event reads as one line.
- **Tasks and verification lines**, including monitor rows.
- **Worker-conversation entries**: open the matching session through your
  session navigator to talk to a worker directly.
- **Recorded cost/token totals only.** A zero means unobserved — the
  board never estimates.
- **Reconnect replays exactly the missed range** from sequence cursors;
  it never assumes offsets.

## 4. Native board page (NOT VERIFIED — know what to expect)

The native wiring in `packages/plugin/src/tui.tsx` is implemented
against the installed `@opencode/plugin` 2.2.7 types and covered by
simulations (see [m6-parity-ux](evidence/m6-parity-ux.md) §§3–4), but it
has never been mounted in a live TUI host. Expect this behavior:

| Surface | Status | What you do |
|---|---|---|
| Board page ("Swarm Board") | Native slot verified, live mount NOT VERIFIED | Open it from the router when available; otherwise use the terminal board (§3) |
| Roster / post / detail panes | Native slot verified, live mount NOT VERIFIED | Open via the panel when available |
| Worker-session navigation | Tabs first, session route fallback | Opens the running tab when tabs exist, otherwise routes to the session |
| `Alt+S` shortcut | **Best-effort.** The binding slot is documented but the host owns key parsing and may reject it | Guaranteed equivalents: the command palette entry ("Swarm board") or `/swarm board` |
| Read markers / filters / follow | Native ephemeral view-state | Terminal board flags/paging when native is unavailable |
| Board data reads | Native transport; daemon reads return typed `daemon_unwired` until the transport lane wires a reader | Terminal board fallback applies — this is fail-closed by design, not an error to work around |

If a daemon-backed read answers `daemon_unwired`, or a version mismatch
answers `stale_schema`, the call failed closed safely: re-run the
terminal board command and, for `stale_schema`, check that your plugin
and daemon come from the same checkout. Never retry a `daemon_unwired`
read through an invented path.

For the exact type references behind each row, see
[compatibility-report §11](compatibility-report.md#111-native-slots-verified-vs-fallback)
— they are not repeated here.

## 5. Gaps and NOT VERIFIED list

1. Live TUI mount, live turns, overlap figures, provider 402 shaping,
   spend, and the live 10-minute idle window are NOT VERIFIED.
2. Board/test/typecheck counts cited via
   [m6-parity-ux](evidence/m6-parity-ux.md) are supplied evidence, not
   fresh executions of this document (link check only).
3. A drawn mention-graph surface is deferred and unclaimed — chronological
   replay is covered, a graph drawing is not.
4. No screenshot, deployment, endpoint, CLI-flag, release-number, or
   support-promise claims are made here.

## 6. Where to go next

- Install, daemon config, health checks, tests:
  [install.md](install.md).
- Per-acceptance evidence, supported-API table, repro log:
  [m6-parity-ux evidence](evidence/m6-parity-ux.md).
- Native-vs-fallback table:
  [compatibility-report §11](compatibility-report.md#111-native-slots-verified-vs-fallback).
- Something broke: [troubleshooting](troubleshooting.md).
