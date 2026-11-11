/**
 * Shared probe helper — M0-01. Every probe-NN.ts script uses this to resolve
 * the disposable probe dir and append a verdict-stamped log.
 *
 * Execution probes MUST run in the disposable dir, never the canonical tree.
 * Default: %TEMP%/opencode/swarm-probes (override with SWARM_PROBE_DIR).
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type Verdict = "PASS" | "FAIL" | "NOT VERIFIED";

export function probeDir(): string {
  const dir =
    process.env.SWARM_PROBE_DIR ?? join(tmpdir(), "opencode", "swarm-probes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logPath(n: string): string {
  return join(probeDir(), `probe-${n}.log`);
}

export function log(n: string, line: string): void {
  const stamp = new Date().toISOString();
  appendFileSync(logPath(n), `[${stamp}] ${line}\n`, "utf8");
  console.log(`[probe-${n}] ${line}`);
}

export function verdict(n: string, v: Verdict, reason: string): Verdict {
  log(n, `VERDICT ${v} — ${reason}`);
  process.exitCode = v === "FAIL" ? 1 : 0;
  return v;
}

/** Best-effort command runner; returns null when the command is unavailable. */
export async function tryRun(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; out: string } | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: `${stdout}\n${stderr}`.slice(0, 4000) };
  } catch {
    return null;
  }
}
