/**
 * Task-DAG validation — M1-01 (spec §7 guard: reject cycles at task
 * creation using DFS/topological validation; release only after accepted).
 *
 * Pure functions over plain edge lists so both the store and unit tests
 * share one implementation. Evidence: [DESIGN] (spec §7).
 */
import { ProtocolError } from "./errors.js";
import type { TaskState } from "./schemas.js";

export type TaskEdge = readonly [taskId: string, dependsOnId: string];

/** Depth-first cycle search. Returns the cycle path (closed loop) or null. */
export function findCycle(nodeIds: readonly string[], edges: readonly TaskEdge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const [from, to] of edges) {
    const list = adjacency.get(from);
    if (list !== undefined) list.push(to);
    else adjacency.set(from, [to]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const id of nodeIds) {
    const cycle = visit(id);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * Validate a new task's dependency list against the existing graph.
 * Throws SELF_DEP / UNKNOWN_DEP / DAG_CYCLE (all ProtocolError).
 */
export function assertDepsAcyclic(
  newTaskId: string,
  deps: readonly string[],
  existingNodeIds: readonly string[],
  existingEdges: readonly TaskEdge[],
): void {
  for (const dep of deps) {
    if (dep === newTaskId) {
      throw new ProtocolError("SELF_DEP", `Task ${newTaskId} cannot depend on itself`, { taskId: newTaskId });
    }
    if (!existingNodeIds.includes(dep)) {
      throw new ProtocolError("UNKNOWN_DEP", `Task ${newTaskId} depends on unknown task ${dep}`, {
        taskId: newTaskId,
        dep,
      });
    }
  }
  const nodeIds = [...existingNodeIds, newTaskId];
  const edges: TaskEdge[] = [...existingEdges, ...deps.map((d): TaskEdge => [newTaskId, d])];
  const cycle = findCycle(nodeIds, edges);
  if (cycle !== null) {
    throw new ProtocolError("DAG_CYCLE", `Dependency cycle rejected: ${cycle.join(" -> ")}`, {
      cycle: cycle.join(" -> "),
    });
  }
}

/** A task is unblocked only when every dependency is `accepted` (spec §7). */
export function depsSatisfied(depStates: Readonly<Record<string, TaskState>>): boolean {
  return Object.values(depStates).every((s) => s === "accepted");
}
