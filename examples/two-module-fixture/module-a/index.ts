/**
 * M1-05 fixture module-a: deterministic pure logic owned by worker-a.
 *
 * Exclusive ownership area: workers/worker-a/. Stdlib only, no network,
 * no inference, no cross-module imports (see index.test.ts for AC1 proof).
 */

export interface WorkerATask {
  readonly id: string;
  readonly title: string;
  readonly ownedPath: string;
}

export const WORKER_A_PREFIX = "workers/worker-a/";

/** True only for paths inside the worker-a exclusive area. */
export function ownsPath(path: string): boolean {
  return path.startsWith(WORKER_A_PREFIX);
}

/** Deterministic summary line for a worker-a task (pure, no I-O). */
export function buildTaskSummary(task: WorkerATask): string {
  return "[worker-a] " + task.id + ": " + task.title + " @ " + task.ownedPath;
}

/** Additive checksum over UTF-16 code units (deterministic). */
export function checksum(text: string): number {
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc = (acc + text.charCodeAt(i)) >>> 0;
  }
  return acc;
}
