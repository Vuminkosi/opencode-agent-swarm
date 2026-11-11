/**
 * Probe 08 — reconnect the event listener mid-turn; reconcile via session
 * snapshot; prove duplicate completion is prevented (idempotent terminal).
 * Spec §4.6(8).
 */
import { log, verdict } from "./probe-lib.ts";

const N = "08";
const session = process.env.PROBE_RUNNING_SESSION;
log(N, `running session: ${session ?? "unset"}`);
log(N, "steps: subscribe -> start turn -> drop subscription mid-turn -> resubscribe -> snapshot via getSession -> assert single terminal transition");
if (session === undefined) {
  verdict(N, "NOT VERIFIED", "set PROBE_RUNNING_SESSION, rerun against live server");
} else {
  verdict(N, "NOT VERIFIED", "reconnect/reconcile assertion not yet automated — record snapshot + terminal count in log");
}
