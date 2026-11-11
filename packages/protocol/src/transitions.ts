/**
 * State-machine transition guards — M1-01 (spec §7).
 *
 * Single source for member / task / wake-intent transitions. The store
 * (and later the scheduler) must call the `assert*` helpers — never
 * inline their own transition tables.
 *
 * Evidence: [DESIGN] (spec §7 state diagrams + guards).
 */
import { ProtocolError } from "./errors.js";
import type {
  InternalMemberState,
  PublicMemberState,
  TaskState,
  WakeState,
} from "./schemas.js";

export const MEMBER_TRANSITIONS: Record<InternalMemberState, readonly InternalMemberState[]> = {
  starting: ["working", "waiting", "killed"],
  working: ["waiting", "quota_paused", "approval_paused", "recovering", "killed"],
  waiting: ["working", "killed"],
  quota_paused: ["working", "killed"],
  approval_paused: ["working", "killed"],
  recovering: ["working", "waiting", "killed"],
  killed: [],
};

export function assertMemberTransition(from: InternalMemberState, to: InternalMemberState): void {
  if (from === to) return;
  const allowed = MEMBER_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ProtocolError("INVALID_TRANSITION", `Invalid member transition ${from} -> ${to}`, { from, to });
  }
}

/** Public-state projection (spec §7.1): exceptional internal states are
 * presented as supplementary labels, never as extra public states. */
export function projectPublicState(internal: InternalMemberState): PublicMemberState {
  switch (internal) {
    case "killed":
      return "killed";
    case "waiting":
      return "waiting";
    default:
      return "working";
  }
}

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  draft: ["ready", "cancelled"],
  ready: ["leased", "cancelled"],
  leased: ["running", "cancelled"],
  running: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["accepted", "ready", "cancelled"],
  blocked: ["ready", "cancelled"],
  accepted: [],
  failed: [],
  cancelled: [],
};

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (from === to) return;
  const allowed = TASK_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ProtocolError("INVALID_TRANSITION", `Invalid task transition ${from} -> ${to}`, { from, to });
  }
}

/** Guard: a worker cannot submit accepted status for its own verification gate (spec §7). */
export function assertVerifierAccept(taskOwnerId: string | null, verifierMemberId: string): void {
  if (taskOwnerId !== null && taskOwnerId === verifierMemberId) {
    throw new ProtocolError("SELF_ACCEPT", "Task owner cannot verify its own work", {
      ownerId: taskOwnerId,
      verifierId: verifierMemberId,
    });
  }
}

export const WAKE_TRANSITIONS: Record<WakeState, readonly WakeState[]> = {
  queued: ["admitted", "cancelled"],
  admitted: ["observed_running", "failed", "cancelled"],
  observed_running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function assertWakeTransition(from: WakeState, to: WakeState): void {
  if (from === to) return;
  const allowed = WAKE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ProtocolError("INVALID_TRANSITION", `Invalid wake-intent transition ${from} -> ${to}`, { from, to });
  }
}
