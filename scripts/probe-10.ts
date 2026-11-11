/**
 * Probe 10 — cancel a tool-running worker; validate terminal failure /
 * interruption signal (session.execution.interrupted or equivalent).
 * Spec §4.6(10). Scratch workspace only.
 */
import { log, verdict } from "./probe-lib.ts";

const N = "10";
const session = process.env.PROBE_TOOL_SESSION;
log(N, `tool-running session: ${session ?? "unset"}`);
log(N, "steps: start shell-tool turn in scratch dir -> interrupt(session, continue:false) -> record terminal event + tool state");
if (session === undefined) {
  verdict(N, "NOT VERIFIED", "set PROBE_TOOL_SESSION, rerun against live server");
} else {
  verdict(N, "NOT VERIFIED", "cancel assertion not yet automated — record terminal event payload in log");
}
