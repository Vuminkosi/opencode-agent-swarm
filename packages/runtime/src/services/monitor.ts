/**
 * M3 dormant monitor — quiescence watch with a single bounded intervention
 * (spec §14 M3; contracts C-DB-01 / C-HARNESS-01).
 *
 * - ACTIVE (a live admitted/observed_running turn exists, or a board post
 *   landed within `quietThresholdMs`): return `active`, zero harness submits,
 *   zero wake enqueues, zero posts.
 * - QUIET but within `cooldownMs` of the last monitor post: return `quiet`
 *   (quiescence observed, intervention suppressed — no spam).
 * - QUIET and cooldown elapsed: publish ONE `monitor` post and enqueue ONE
 *   `monitor_intervention` wake for the coordinator (lead). The intervention
 *   is idempotent: the durable `monitor`-kind post inside the cooldown window
 *   is the guard, so restarts and duplicate checks cannot double-intervene.
 * - Quota/killed coordinators are never admitted: if the intervention enqueue
 *   is rejected as KILLED_MEMBER the check reports `suppressed`; quota_paused
 *   coordinators surface as `suppressed` with detail (dispatch would defer
 *   anyway — never an auto-retry of a paid path).
 * - Zero model inference; dispatch of the intervention wake stays in the M2 lane.
 */

import { ProtocolError } from "@vuminkosi/protocol";
import type { BoardPost, WakeIntent } from "@vuminkosi/protocol";
import type { SwarmStore } from "../db/store.js";
import { WakeQueue } from "./wake-queue.js";

export type MonitorDecision = "active" | "quiet" | "intervened" | "suppressed";

export interface MonitorCheck {
  readonly decision: MonitorDecision;
  readonly detail: string;
  readonly monitorPost?: BoardPost;
  readonly interventionWake?: WakeIntent;
}

export interface MonitorPolicy {
  /** Silence window with no posts and no live turns before intervening. */
  readonly quietThresholdMs?: number;
  /** Minimum gap between two monitor interventions. */
  readonly cooldownMs?: number;
  /** Override for deterministic tests. */
  readonly nowMs?: number;
}

const DEFAULT_QUIET_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

function findMonitorWake(store: SwarmStore, swarmId: string, postId: string): WakeIntent | null {
  // S1-02: fate-share repair probe. The intervention wake carries
  // payloadHash `monitor:<postId>`; if a post exists without its wake (the
  // post txn committed but the enqueue txn crashed / was KILLED / faulted),
  // the retry must re-enqueue rather than report quiet with zero wakes.
  const marker = `monitor:${postId}`;
  for (const w of store.listWakes(swarmId, "queued", 1_000)) {
    if (w.payloadHash === marker) return w;
  }
  for (const w of store.listUnsettledWakes(swarmId, 1_000)) {
    if (w.payloadHash === marker) return w;
  }
  return null;
}

function enqueueIntervention(
  store: SwarmStore,
  queue: WakeQueue,
  swarmId: string,
  leadId: string,
  postId: string,
): WakeIntent {
  const enqueued = queue.enqueue(
    {
      swarmId,
      memberId: leadId,
      reason: "monitor_intervention",
      payloadHash: `monitor:${postId}`,
    },
    `m3-monitor-${postId}`,
  );
  return enqueued.intent;
}

function coordinatorOf(store: SwarmStore, swarmId: string): { id: string; sessionId: string } {
  const lead = store
    .listMembers(swarmId)
    .find((m) => m.role === "coordinator" && m.internalState !== "killed");
  if (lead === undefined) {
    throw new ProtocolError("NOT_FOUND", `Swarm ${swarmId} has no live coordinator`, { swarmId });
  }
  return { id: lead.id, sessionId: lead.sessionId };
}

export function checkDormant(
  store: SwarmStore,
  queue: WakeQueue,
  swarmId: string,
  policy?: MonitorPolicy,
): MonitorCheck {
  const nowMs = policy?.nowMs ?? Date.now();
  const quietThresholdMs = policy?.quietThresholdMs ?? DEFAULT_QUIET_MS;
  const cooldownMs = policy?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  const live = store.listUnsettledWakes(swarmId, 100);
  if (live.length > 0) {
    return { decision: "active", detail: `live-turns:${live.length}` };
  }
  const recent = store.getPostsAfter(swarmId, 0, 1_000_000);
  const latest = recent.length === 0 ? null : recent[recent.length - 1];
  if (latest !== undefined && latest !== null) {
    const ageMs = nowMs - Date.parse(latest.createdAt);
    if (Number.isFinite(ageMs) && ageMs < quietThresholdMs) {
      return { decision: "active", detail: `recent-post:seq=${latest.sequence}` };
    }
  }
  const monitors = recent.filter((p) => p.kind === "monitor");
  const lastMonitor = monitors.length === 0 ? null : monitors[monitors.length - 1];
  if (lastMonitor !== undefined && lastMonitor !== null) {
    const ageMs = nowMs - Date.parse(lastMonitor.createdAt);
    if (Number.isFinite(ageMs) && ageMs < cooldownMs) {
      return { decision: "quiet", detail: `cooldown:seq=${lastMonitor.sequence}` };
    }
  }
  let lead: { id: string; sessionId: string };
  try {
    lead = coordinatorOf(store, swarmId);
  } catch {
    return { decision: "suppressed", detail: "no-live-coordinator" };
  }
  const leadMember = store.getMember(lead.id);
  if (leadMember.internalState === "quota_paused" || leadMember.internalState === "approval_paused") {
    return { decision: "suppressed", detail: `coordinator-${leadMember.internalState}` };
  }
  const posted = store.appendPost(swarmId, {
    authorMemberId: null,
    kind: "monitor",
    body:
      `MONITOR quiescence: no live turns and no board activity for ${quietThresholdMs}ms. ` +
      `Lead review requested.`,
    idempotencyKey: `m3-monitor-${swarmId}-${Math.floor(nowMs / cooldownMs)}`,
  });
  if (posted.deduped) {
    // S1-02 fate-share repair: the post txn committed on an earlier attempt
    // but its wake may never have been enqueued (crash/KILLED/fault between
    // the two txns). A missing wake must be re-enqueued here — returning
    // `quiet` with zero wakes would silently lose the intervention.
    const existing = findMonitorWake(store, swarmId, posted.post.id);
    if (existing !== null) {
      return { decision: "quiet", detail: `duplicate-window:seq=${posted.post.sequence}` };
    }
    try {
      const repaired = enqueueIntervention(store, queue, swarmId, lead.id, posted.post.id);
      return {
        decision: "intervened",
        detail: `repaired-orphan-post:seq=${posted.post.sequence}`,
        monitorPost: posted.post,
        interventionWake: repaired,
      };
    } catch (err) {
      if (err instanceof ProtocolError && err.code === "KILLED_MEMBER") {
        return {
          decision: "suppressed",
          detail: `coordinator-killed:post-orphan:seq=${posted.post.sequence}`,
        };
      }
      throw err;
    }
  }
  let intervention: WakeIntent;
  try {
    intervention = enqueueIntervention(store, queue, swarmId, lead.id, posted.post.id);
  } catch (err) {
    if (err instanceof ProtocolError && err.code === "KILLED_MEMBER") {
      // S1-02: the monitor post above already committed while the wake was
      // refused — surface the orphan explicitly so the post is never mistaken
      // for a delivered intervention. The next check lands in the deduped
      // repair path above once a live coordinator exists.
      return {
        decision: "suppressed",
        detail: `coordinator-killed:post-orphan:seq=${posted.post.sequence}`,
      };
    }
    // Any other enqueue failure also leaves a committed post without a wake;
    // propagate so the caller retries, and the deduped repair path above
    // converges to exactly one wake.
    throw err;
  }
  return {
    decision: "intervened",
    detail: `post:seq=${posted.post.sequence}`,
    monitorPost: posted.post,
    interventionWake: intervention,
  };
}
