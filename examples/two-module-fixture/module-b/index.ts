/**
 * M1-05 fixture module-b: deterministic pure logic owned by worker-b.
 *
 * Exclusive ownership area: workers/worker-b/. Stdlib only, no network,
 * no inference, no cross-module imports (see index.test.ts for AC1 proof).
 */

export const WORKER_B_PREFIX = "workers/worker-b/";

/** True only for paths inside the worker-b exclusive area. */
export function ownsPath(path: string): boolean {
  return path.startsWith(WORKER_B_PREFIX);
}

/** Brief mention line posted for a worker (pure string build). */
export function formatBriefLine(workerName: string, index: number, total: number): string {
  return "@" + workerName + " Brief " + index + "/" + total;
}

/** True when a candidate path belongs to a sibling area and is forbidden. */
export function isForbidden(candidate: string, siblingPrefixes: readonly string[]): boolean {
  return siblingPrefixes.some((prefix) => candidate.startsWith(prefix));
}
