/**
 * Probe 02 — command registration: `/swarm` + `/swarm board` argument semantics.
 * Spec §4.6(2). Requires a running OpenCode 2.x TUI/server with the probe
 * plugin loaded. Read-only inspection; no canonical-tree writes.
 */
import { log, verdict, tryRun } from "./probe-lib.ts";

const N = "02";
const server = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
log(N, `target server: ${server} (set OPENCODE_URL to override)`);
log(N, "expectation: ctx.command.transform registers /swarm; `/swarm board` parses subcommand, not model prompt");

let reachable = false;
try {
  // PROVISIONAL (S2-3): `/health` is an unconfirmed endpoint guess pending
  // probe against the pinned API schema — a non-200/unreachable result here
  // proves nothing about the server; see api-compatibility.md probe-02 row.
  const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(5000) });
  reachable = res.ok;
  log(N, `GET /health -> ${res.status}`);
} catch (e) {
  log(N, `server unreachable: ${String(e).slice(0, 300)}`);
}
const tui = await tryRun("opencode", ["--version"]);
log(N, `opencode cli: ${tui?.out.trim() ?? "UNAVAILABLE"}`);

if (!reachable) {
  verdict(N, "NOT VERIFIED", "no live OpenCode server; start pinned build with probe plugin, rerun with OPENCODE_URL");
} else {
  verdict(N, "NOT VERIFIED", "server reachable but command-listing assertion not yet automated — manual: confirm /swarm + /swarm board in TUI");
}
