/**
 * Probe 04 — two independent sessions, two native agent IDs, concurrent prompts.
 * Spec §4.6(4). Executes ONLY in the disposable probe dir (two scratch
 * subdirs); never in the canonical tree. Requires provider credentials.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { probeDir, log, verdict } from "./probe-lib.ts";

const N = "04";
const dir = join(probeDir(), "probe-04");
mkdirSync(join(dir, "ws-a"), { recursive: true });
mkdirSync(join(dir, "ws-b"), { recursive: true });
log(N, `scratch workspaces: ${dir}/ws-a, ${dir}/ws-b`);

const server = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
let reachable = false;
try {
  reachable = (await fetch(`${server}/health`, { signal: AbortSignal.timeout(5000) })).ok;
} catch {
  reachable = false;
}
log(N, `server reachable: ${reachable}`);
if (!reachable) {
  verdict(N, "NOT VERIFIED", "needs live server + 2 native agent IDs + provider credentials; see api-compatibility.md resumption notes");
} else {
  verdict(N, "NOT VERIFIED", "live run not automated in M0-01 — manual: create 2 sessions via harness, prompt concurrently, record session IDs");
}
