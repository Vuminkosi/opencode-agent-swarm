/**
 * Probe 06 — prompt a waiting session; confirm EXACTLY ONE new model turn.
 * Spec §4.6(6). Validates queue-vs-steer admission semantics for the harness.
 */
import { log, verdict } from "./probe-lib.ts";

const N = "06";
const session = process.env.PROBE_WAITING_SESSION;
log(N, `waiting session: ${session ?? "unset"}`);
log(N, "rule: count model turns before/after one admission; exactly +1 required; provider request counter must move by one");
if (session === undefined) {
  verdict(N, "NOT VERIFIED", "set PROBE_WAITING_SESSION to an idle session id, rerun, attach turn counters");
} else {
  verdict(N, "NOT VERIFIED", "turn-count assertion not yet automated — record pre/post counters in log");
}
