/**
 * M3 task DAG scheduler — ready -> leased assignment on the frozen M2 engine
 * (spec §14 M3; contracts C-PROTOCOL-01 / C-DB-01).
 *
 * - Creation goes through `SwarmStore.createTask`, which rejects cycles with
 *   the protocol DFS (`assertDepsAcyclic`) — this layer never invents its own
 *   graph check.
 * - `ready -> leased` is atomic INSIDE the store transaction (generation bump
 *   + deps-accepted re-check, spec §7: release only after accepted).
 * - A task is leasable only when every dependency is `accepted`
 *   (`depsSatisfied`), it has an owner (leased without an owner is rejected
 *   by the store), and no other worker holds it (leased state = held).
 * - Zero model inference; zero harness submits.
 */

import { depsSatisfied, type CreateTaskInput, type Task } from "@opencode-swarm/protocol";
import { ProtocolError } from "@opencode-swarm/protocol";
import type { SwarmStore } from "../db/store.js";

export interface LeaseResult {
  readonly task: Task;
  /** True when an already-leased/running row for this task was returned (no state edge taken). */
  readonly alreadyHeld: boolean;
}

function depStatesFor(store: SwarmStore, swarmId: string, deps: readonly string[]): Record<string, Task["state"]> {
  const states: Record<string, Task["state"]> = {};
  if (deps.length === 0) return states;
  for (const task of store.listTasks(swarmId)) {
    if (deps.includes(task.id)) states[task.id] = task.state;
  }
  return states;
}

/** Create a task; protocol DFS rejects self/unknown/cyclic deps (store-owned). */
export function createTask(store: SwarmStore, swarmId: string, input: CreateTaskInput): Task {
  return store.createTask(swarmId, input);
}

/** Publish a draft task as ready for lease. */
export function publishReady(store: SwarmStore, taskId: string): Task {
  return store.transitionTask(taskId, "ready");
}

/**
 * Lease the oldest ready, unblocked task owned by `memberId`.
 * Skips tasks whose deps are not all accepted. Each winning row is claimed
 * inside the store txn; if the row lost a concurrent race between the list
 * snapshot and the claim (it left `ready`, or its deps/owner ceased to
 * qualify), the claim throws INVALID_TRANSITION/VALIDATION_FAILED and the
 * scheduler falls through to the next candidate instead of failing the
 * whole lease. Returns null when no candidate can be claimed.
 */
export function leaseNext(store: SwarmStore, swarmId: string, memberId: string): Task | null {
  const candidates = store
    .listTasks(swarmId)
    .filter((t) => t.state === "ready" && t.ownerId === memberId)
    .filter((t) => depsSatisfied(depStatesFor(store, swarmId, t.deps)));
  for (const next of candidates) {
    try {
      return store.transitionTask(next.id, "leased");
    } catch (err) {
      // Lost race: the row left `ready` (leased/blocked/…) or stopped
      // qualifying between list and claim — try the next candidate.
      if (err instanceof ProtocolError && (err.code === "INVALID_TRANSITION" || err.code === "VALIDATION_FAILED")) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

/** Re-queue a blocked task once its blocker clears (blocked -> ready). */
export function requeueBlocked(store: SwarmStore, taskId: string): Task {
  return store.transitionTask(taskId, "ready");
}

/** Mark a leased task running (leased -> running). */
export function startRunning(store: SwarmStore, taskId: string): Task {
  return store.transitionTask(taskId, "running");
}

/** Submit a running task for verification (running -> verifying). */
export function submitForVerification(store: SwarmStore, taskId: string): Task {
  return store.transitionTask(taskId, "verifying");
}

/** Mark a running task blocked (running -> blocked). */
export function markBlocked(store: SwarmStore, taskId: string): Task {
  return store.transitionTask(taskId, "blocked");
}
