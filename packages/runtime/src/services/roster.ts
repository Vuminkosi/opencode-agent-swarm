/**
 * M3 roster / history / pending / delivery read models (spec §14 M3).
 *
 * Pure SQLite projections over the M1-01 journal + M2 wake rows — no new
 * tables, no migration, no inference, no harness calls. Identity and
 * ownership are preserved verbatim (`nativeAgentId`, `sessionId`,
 * `memberId`, `delivery_key`-backed wake ids); the public projection never
 * leaks internal-only wake payload hashes.
 */

import type { BoardPost, Member, Task, WakeIntent } from "@opencode-swarm/protocol";
import type { OutboxEntry, SwarmStore } from "../db/store.js";

export interface RosterEntry {
  readonly member: Member;
  /** True when an admitted/observed_running turn currently holds the member. */
  readonly hasLiveTurn: boolean;
  readonly liveWakeId: string | null;
}

export interface PendingView {
  readonly queuedWakes: readonly WakeIntent[];
  readonly unsettledWakes: readonly WakeIntent[];
  readonly readyTasks: readonly Task[];
  readonly blockedTasks: readonly Task[];
}

export function getRoster(store: SwarmStore, swarmId: string): RosterEntry[] {
  return store.listMembers(swarmId).map((member) => {
    const live = store.findLiveWakeForMember(member.id);
    return { member, hasLiveTurn: live !== null, liveWakeId: live?.id ?? null };
  });
}

export function getHistory(store: SwarmStore, swarmId: string, after = 0, limit = 100): BoardPost[] {
  return store.getPostsAfter(swarmId, after, limit);
}

export function getPending(store: SwarmStore, swarmId: string, limit = 100): PendingView {
  const tasks = store.listTasks(swarmId);
  return {
    queuedWakes: store.listWakes(swarmId, "queued", limit),
    unsettledWakes: store.listUnsettledWakes(swarmId, limit),
    readyTasks: tasks.filter((t) => t.state === "ready"),
    blockedTasks: tasks.filter((t) => t.state === "blocked"),
  };
}

/** Durable delivery trail for one swarm (at-least-once outbox; undelivered = pending). */
export function getDelivery(store: SwarmStore, swarmId: string, limit = 100): OutboxEntry[] {
  // S2-03: the outbox table is global, so the projection must scope by swarm —
  // otherwise swarm B's entries leak into swarm A's trail. Each kind resolves
  // its aggregate back to its owning swarm; entries whose aggregate vanished
  // or of an unknown kind are excluded rather than leaked cross-swarm.
  return store
    .listPendingOutbox(limit * 5)
    .filter((entry) => outboxEntrySwarm(store, entry) === swarmId)
    .slice(0, limit);
}

function outboxEntrySwarm(store: SwarmStore, entry: OutboxEntry): string | null {
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  switch (entry.kind) {
    case "post_committed": {
      // Payload carries { postId, swarmId, sequence }.
      return typeof payload["swarmId"] === "string" ? (payload["swarmId"] as string) : null;
    }
    case "wake_queued": {
      try {
        return store.getWake(entry.aggregateId).swarmId;
      } catch {
        return null;
      }
    }
    case "evidence_recorded": {
      // Payload carries { evidenceId, taskId }.
      if (typeof payload["taskId"] !== "string") return null;
      try {
        return store.getTask(payload["taskId"] as string).swarmId;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
