/**
 * M6-03 native TUI embedding probe (`@opencode-swarm/plugin/tui`).
 *
 * Registers ONLY verified 2.2.7 TUI slots (see
 * `packages/plugin/node_modules/@opencode/plugin/dist/tui/context.d.ts`):
 * - Board navigation: `UI.router.register({ name, render })` +
 *   `UI.router.navigate({ type: "plugin", name })` (`Page`, `Route`,
 *   `Destination`, context.d.ts:112-131/423-427).
 * - Roster/post/detail panes: `UI.slot({ append: "session.panel", render })`
 *   (`SlotMap`/`SlotPath`/`SlotClaim`/`PanelInput`, context.d.ts:138-231)
 *   shown via `UI.panel.open(name)` (context.d.ts:428-440).
 * - Worker-session navigation: `UI.tabs.focus(sessionID): boolean` first,
 *   else `UI.router.navigate({ type: "session", sessionID })`
 *   (context.d.ts:112-125/441-461). No invented session-links API.
 * - Shortcut: `Keymap.layer` with a named command
 *   `{ id: "swarm.board", bind: "alt+s", palette: true, slash }`
 *   (`KeymapCommand`/`KeymapLayer`, context.d.ts:340-416). The `bind` slot
 *   is documented; the exact `alt+s` parse is host OpenTUI behavior, so the
 *   palette + slash equivalents are the guaranteed path (see [PROBE]).
 * - Read markers / filters / follow: `Storage.memory("swarm-board", …)`
 *   live-synced ephemeral state (context.d.ts:6-22) + pure helpers below.
 * - Versioned server reads: `bindBoardRpc(client)` = `client.rpc(SwarmRpc)`
 *   (`RpcApi<D>(definition): RpcClient<D>`,
 *   `@opencode/client/dist/promise/rpc.d.ts:26-28`).
 *
 * [PROBE] No dedicated board slot exists in `SlotMap` (only `app`,
 * `home.footer*`, `prompt.footer*`, `session.composer.top`, `session.panel`,
 * `sidebar.*`), so the board is a router page, never a slot claim.
 *
 * [PROBE] Render deferred: `solid-js`/`@opentui/*` are optional peers and
 * are NOT installed in `packages/plugin` (manifests are out of scope), so no
 * JSX may be compiled here. Renders are stubs; the functional terminal board
 * (`bunx opencode-swarm board`, M6-02) remains the supported fallback and is
 * NOT duplicated here. Board body rendering lands with the peers.
 *
 * [PROBE] NOT VERIFIED live: mounting inside the TUI host needs a
 * plugin-config mutation, which this slice must not perform. Covered by
 * fakes in `__tests__/tui-rpc.test.ts`, never by a live mount.
 */
import { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { SwarmRpc, TERMINAL_BOARD_FALLBACK } from "./rpc.js";

export const SWARM_TUI_ID = "swarm" as const;

/** Router page name for the native board (`Page.name`). */
export const SWARM_BOARD_PAGE = "Swarm Board" as const;
/** Session-panel name claimed for roster/post/detail panes. */
export const SWARM_BOARD_PANEL = "swarm-board" as const;
/** Stable keymap command id (used by `layer` + `bindings` + `dispatch`). */
export const SWARM_BOARD_COMMAND_ID = "swarm.board" as const;
/** Slash-completion name for the board command (TUI keymap namespace). */
export const SWARM_BOARD_SLASH = "swarm-board" as const;
/**
 * [PROBE] Best-effort binding on the documented `KeymapCommand.bind` slot.
 * OpenTUI owns binding-parse; if the host rejects it, the command stays
 * reachable via palette + slash (tested fallback path in tui-rpc.test.ts).
 */
export const SWARM_BOARD_KEYBIND = "alt+s" as const;

export type TuiUi = TuiPlugin.Context["ui"];
export type TuiClient = TuiPlugin.Context["client"];

/** Bind the versioned board RPC client from the TUI host client. */
export function bindBoardRpc(client: TuiClient): ReturnType<TuiClient["rpc"]> {
  return client.rpc(SwarmRpc);
}

export type WorkerSessionTarget = "tab" | "route";

/**
 * Verified worker-session navigation: focus the session tab when tabs
 * support it (`UI.tabs.focus` returns false when disabled), otherwise route
 * to the session (`Route { type: "session", sessionID }`).
 */
export function openWorkerSession(ui: TuiUi, sessionID: string): WorkerSessionTarget {
  if (ui.tabs.focus(sessionID)) return "tab";
  ui.router.navigate({ type: "session", sessionID });
  return "route";
}

/** Ephemeral board view-state (read markers, kind filter, follow). */
export interface BoardViewState {
  /** Highest post sequence marked read. */
  readonly readAfter: number;
  /** Post-kind filter; undefined shows every kind. */
  readonly kindFilter: string | undefined;
  /** Follow live posts when true. */
  readonly follow: boolean;
}

export function createBoardViewState(): BoardViewState {
  return { readAfter: 0, kindFilter: undefined, follow: true };
}

/** Advance the read marker; never moves backwards. */
export function markPostsRead(state: BoardViewState, after: number): BoardViewState {
  return { ...state, readAfter: Math.max(state.readAfter, after) };
}

export interface BoardPostLike {
  readonly sequence: number;
  readonly kind: string;
}

/** Apply the kind filter; read state is tracked separately via `readAfter`. */
export function applyPostFilter(
  posts: readonly BoardPostLike[],
  state: BoardViewState,
): readonly BoardPostLike[] {
  if (state.kindFilter === undefined) return posts;
  return posts.filter((post) => post.kind === state.kindFilter);
}

export default TuiPlugin.define({
  id: SWARM_TUI_ID,
  setup(ctx) {
    // Verified board route (router page; see module doc — no board slot exists).
    const unregisterPage = ctx.ui.router.register({
      name: SWARM_BOARD_PAGE,
      // [PROBE] Render deferred until solid-js/@opentui peers are installed.
      render: () => null,
    });

    // Verified detail-pane slot; visible when opened via ui.panel.open.
    const unregisterPanel = ctx.ui.slot({
      append: "session.panel",
      // [PROBE] Render deferred (see above); claim proves the slot path only.
      render: () => null,
    });

    // Verified shortcut slot with guaranteed palette + slash equivalents.
    ctx.keymap.layer(() => ({
      commands: [
        {
          id: SWARM_BOARD_COMMAND_ID,
          title: "Swarm board",
          description: `Open the Swarm board (native page; fallback: ${TERMINAL_BOARD_FALLBACK})`,
          palette: true,
          slash: { name: SWARM_BOARD_SLASH },
          bind: SWARM_BOARD_KEYBIND,
          run: () => {
            ctx.ui.router.navigate({ type: "plugin", name: SWARM_BOARD_PAGE });
          },
        },
      ],
      bindings: [SWARM_BOARD_COMMAND_ID],
    }));

    // Verified ephemeral view-state for read markers / filters / follow.
    const [boardStore] = ctx.storage.memory("swarm-board", { initial: createBoardViewState() });
    void boardStore;

    return () => {
      unregisterPanel();
      unregisterPage();
    };
  },
});
