/**
 * Probe 11 — deny rules for the canonical worktree; verify denied edit and
 * bypass behavior (permission.asked flow, last-match-wins, child inheritance).
 * Spec §4.6(11). Scratch workspace only; NEVER point deny rules at real repos.
 */
import { log, verdict } from "./probe-lib.ts";

const N = "11";
const session = process.env.PROBE_SANDBOX_SESSION;
log(N, `sandbox session: ${session ?? "unset"}`);
log(N, "steps: apply deny rule on scratch path -> attempt edit -> expect permission.asked + denial -> attempt bypass variant -> record outcome");
if (session === undefined) {
  verdict(N, "NOT VERIFIED", "set PROBE_SANDBOX_SESSION, rerun against live server with scratch paths only");
} else {
  verdict(N, "NOT VERIFIED", "deny/bypass assertion not yet automated — record permission event payloads in log");
}
