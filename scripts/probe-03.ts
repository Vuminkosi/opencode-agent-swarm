/**
 * Probe 03 — enumerate native agents + effective models/permissions.
 * Spec §4.6(3). Read-only; preserves native agent IDs verbatim.
 */
import { log, verdict } from "./probe-lib.ts";

const N = "03";
const server = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
log(N, `target server: ${server}`);

try {
  // PROVISIONAL (S2-3): `/agents` is an unconfirmed endpoint guess pending
  // probe against the pinned API schema — an unexpected status proves only
  // that the shape may differ, not that enumeration is unavailable.
  const res = await fetch(`${server}/agents`, { signal: AbortSignal.timeout(5000) });
  const body = (await res.text()).slice(0, 4000);
  log(N, `GET /agents -> ${res.status} body=${body}`);
  if (res.ok) verdict(N, "PASS", "agent inventory captured — record ids/models/permissions in api-compatibility.md");
  else verdict(N, "NOT VERIFIED", `unexpected status ${res.status}; endpoint shape may differ — confirm against pinned API schema`);
} catch (e) {
  verdict(N, "NOT VERIFIED", `no live server: ${String(e).slice(0, 200)}`);
}
