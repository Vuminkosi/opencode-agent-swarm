/**
 * Probe 09 — model switch on a waiting session; verify history retained.
 * Spec §4.6(9). Uses native providerID + model id refs (not friendly labels).
 */
import { log, verdict } from "./probe-lib.ts";

const N = "09";
const session = process.env.PROBE_WAITING_SESSION;
const model = process.env.PROBE_TARGET_MODEL;
log(N, `session=${session ?? "unset"} targetModel=${model ?? "unset"} (format providerID/id)`);
if (session === undefined || model === undefined) {
  verdict(N, "NOT VERIFIED", "set PROBE_WAITING_SESSION + PROBE_TARGET_MODEL, compare transcript before/after switch");
} else {
  verdict(N, "NOT VERIFIED", "history-retention assertion not yet automated — attach pre/post transcript hashes");
}
