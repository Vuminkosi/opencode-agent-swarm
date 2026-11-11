/**
 * M0-02 TUI entry (`@opencode-swarm/plugin/tui`).
 *
 * Typechecks against the installed `@opencode/plugin/tui` 2.2.7 types
 * (`Plugin.define({id, setup})`). Intentionally registers no slot, page, or
 * keybinding yet.
 *
 * [PROBE] NOT VERIFIED: exact TUI registration shape for a `/swarm` action,
 * `/swarm board` navigation/route, roster/detail panes, and `Alt+S` shortcut
 * interception are not asserted until probe-02 runs against the pinned
 * release. Avoid undocumented terminal input interception. Fallback per spec
 * §4.4: a standalone Bun terminal board (`bunx opencode-swarm board`) instead
 * of native board embedding.
 *
 * [PROBE] Load note (m0-02-probe, Bun 1.4.4): importing this entry standalone
 * fails at `@opencode/plugin/dist/tui/solid.js` without the optional peers
 * (`solid-js`, `@opentui/*`) — the TUI part is expected to load inside the
 * opencode TUI host, which provides those peers. Server (`./index.ts`) and
 * RPC (`./rpc.ts`) entries import cleanly standalone with zero inference.
 */
import { Plugin as TuiPlugin } from "@opencode/plugin/tui";

export const SWARM_TUI_ID = "swarm" as const;

export default TuiPlugin.define({
  id: SWARM_TUI_ID,
  setup(_ctx) {
    return () => {};
  },
});
