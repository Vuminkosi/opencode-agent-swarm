/**
 * Probe 07 — capture all event shapes; identify which IDs correlate prompt
 * admission with execution completion (feeds harness externalId mapping).
 * Spec §4.6(7). Persist raw payloads under the disposable probe dir only.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { probeDir, log, verdict } from "./probe-lib.ts";

const N = "07";
const dir = join(probeDir(), "probe-07-events");
mkdirSync(dir, { recursive: true });
log(N, `raw event capture dir: ${dir}`);
log(N, "watch for: session.execution.started/succeeded/failed/interrupted, session.inbox.*, session.tool.*, permission.asked/replied, session.usage.updated");
verdict(N, "NOT VERIFIED", "needs live turn with event subscription; dump payloads to dir above and record correlation-ID finding");
