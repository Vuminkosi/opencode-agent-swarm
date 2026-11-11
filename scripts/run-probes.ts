/**
 * Probe runner — executes scripts/probe-01.ts … probe-12.ts sequentially and
 * prints the 12-row verdict table. Usage: `bun scripts/run-probes.ts`.
 * Each probe appends to <probe-dir>/probe-NN.log; the table below mirrors it.
 */
import { join } from "node:path";
import { probeDir } from "./probe-lib.ts";

const rows: string[] = [];
let failed = false;
for (let i = 1; i <= 12; i++) {
  const n = String(i).padStart(2, "0");
  const proc = Bun.spawn(["bun", `scripts/probe-${n}.ts`], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const m = out.match(/VERDICT\s+(PASS|FAIL|NOT VERIFIED)\s+—\s*(.*)/);
  if (m?.[1] === "FAIL" || code !== 0) failed = true;
  rows.push(`| ${n} | ${m?.[1] ?? `exit=${code}`} | ${(m?.[2] ?? err.slice(0, 160)).slice(0, 160)} |`);
  console.log(out);
  if (err.trim()) console.error(err);
}
console.log(`\nprobe logs: ${join(probeDir())}\n`);
console.log("| Probe | Verdict | Detail |");
console.log("|---|---|---|");
for (const r of rows) console.log(r);
// S2-1: any FAIL verdict (or nonzero probe exit) fails the runner.
// NOT VERIFIED is intentionally non-failing (stays exit 0).
if (failed) process.exitCode = 1;
