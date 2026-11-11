/**
 * Probe 05 — true concurrency: overlapping session.execution.started →
 * terminal execution events for the two probe-04 sessions.
 * Spec §4.6(5). Requires probe-04 session IDs (env PROBE04_A/B).
 */
import { log, verdict } from "./probe-lib.ts";

const N = "05";
const a = process.env.PROBE04_A;
const b = process.env.PROBE04_B;
log(N, `sessions under test: A=${a ?? "unset"} B=${b ?? "unset"}`);
if (a === undefined || b === undefined) {
  verdict(N, "NOT VERIFIED", "set PROBE04_A/PROBE04_B from probe-04 run, then compare execution-started/finished timestamps for overlap");
} else {
  verdict(N, "NOT VERIFIED", "timestamp-overlap analysis not yet automated — record started/finished per session in log");
}
