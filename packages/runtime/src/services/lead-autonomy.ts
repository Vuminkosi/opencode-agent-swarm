/**
 * M3 lead autonomy — sleep after delegation, wake on completion/blocker/
 * decision, private user->worker steering (spec §14 M3; contracts C-DB-01 /
 * C-HARNESS-01).
 *
 * - `markWaiting`: lead goes `working -> waiting` (or stays waiting, a store
 *   no-op) with ZERO harness submits and zero inference — the lead polls
 *   nothing; the M2 dispatcher wakes it.
 * - `decideLeadWake`: pure signal classification. `none` -> stay waiting,
 *   zero enqueues, zero inference. `completion | blocker | decision` ->
 *   exactly ONE coordinator wake (delivery_key idempotent: repeats of the
 *   same signal collapse to the same intent, `deduped: true`).
 * - `steerWorkerDirect`: private user->worker steering. It NEVER writes a
 *   board post row — it enqueues ONE durable `user_direct` intent and submits
 *   it queue-only through the M2 dispatcher (per-session serialization,
 *   quota/killed guards and delivery_key dedupe preserved). Reads stay
 *   board-free: the steering text travels only in the wake payload.
 */

import type { Member, WakeIntent } from "@opencode-swarm/protocol";
import { ProtocolError } from "@opencode-swarm/protocol";
import type { SwarmStore } from "../db/store.js";
import { WakeQueue } from "./wake-queue.js";
import { WakeDispatcher } from "./wake-dispatcher.js";

export type LeadSignal =
  | { readonly kind: "none" }
  | { readonly kind: "completion"; readonly taskId: string }
  | { readonly kind: "blocker"; readonly taskId: string; readonly postSequence?: number }
  | { readonly kind: "decision"; readonly postSequence?: number };

export interface LeadWakeDecision {
  /** False for `none` (lead stays waiting, zero enqueues). */
  readonly woke: boolean;
  readonly wake?: WakeIntent;
  readonly deduped?: boolean;
  /** Harness submits performed by the decision itself: always 0 (dispatch is the daemon lane). */
  readonly submits: 0;
}

function signalKey(signal: LeadSignal): string | null {
  switch (signal.kind) {
    case "none":
      return null;
    case "completion":
      return `lead-wake:completion:${signal.taskId}`;
    case "blocker": {
      // S1-01: distinct blocker/decision signals MUST carry their board
      // post sequence. Collapsing seq-less signals to `...:0` let UNIQUE
      // dedupe silently swallow every later distinct signal forever.
      if (signal.postSequence === undefined) {
        throw new ProtocolError("VALIDATION_FAILED", "Blocker lead signal requires postSequence", {
          taskId: signal.taskId,
        });
      }
      return `lead-wake:blocker:${signal.taskId}:${signal.postSequence}`;
    }
    case "decision": {
      if (signal.postSequence === undefined) {
        throw new ProtocolError("VALIDATION_FAILED", "Decision lead signal requires postSequence", {});
      }
      return `lead-wake:decision:${signal.postSequence}`;
    }
  }
}

/** Sleep the lead after delegation: store transition only, zero submits. */
export function markWaiting(store: SwarmStore, leadId: string): Member {
  const current = store.getMember(leadId);
  if (current.internalState === "waiting") return current;
  return store.transitionMember(leadId, "waiting");
}

/**
 * Classify a lead signal. Non-`none` signals enqueue exactly one coordinator
 * wake; repeats collapse via delivery_key. Never dispatches (zero submits).
 * Blocker/decision signals require `postSequence` (VALIDATION_FAILED when
 * absent): the delivery key embeds the sequence so two distinct posts yield
 * two wakes while a repeated sequence dedupes to the same intent.
 */
export function decideLeadWake(
  queue: WakeQueue,
  swarmId: string,
  leadId: string,
  signal: LeadSignal,
): LeadWakeDecision {
  const key = signalKey(signal);
  if (key === null) return { woke: false, submits: 0 };
  const reason =
    signal.kind === "completion"
      ? ("assigned_task" as const)
      : signal.kind === "blocker"
        ? ("monitor_intervention" as const)
        : ("user_direct" as const);
  const taskId =
    signal.kind === "completion" || signal.kind === "blocker" ? signal.taskId : undefined;
  const postSequence = signal.kind === "blocker" || signal.kind === "decision" ? signal.postSequence : undefined;
  const { intent, deduped } = queue.enqueue(
    {
      swarmId,
      memberId: leadId,
      reason,
      ...(taskId === undefined ? {} : { taskId }),
      ...(postSequence === undefined ? {} : { postSequence }),
      payloadHash: key,
    },
    key,
  );
  return { woke: true, wake: intent, deduped, submits: 0 };
}

export interface DirectSteerResult {
  readonly intent: WakeIntent;
  readonly deduped: boolean;
  readonly dispatched: boolean;
  readonly dispatchStatus?: string;
}

/**
 * Private user->worker steering: durable `user_direct` intent + one queue-only
 * dispatch. Writes NO board post row (verified by callers via `readBoard`
 * length before/after).
 */
export async function steerWorkerDirect(
  queue: WakeQueue,
  dispatcher: WakeDispatcher,
  input: {
    readonly swarmId: string;
    readonly workerId: string;
    readonly text: string;
    readonly idempotencySeed: string;
  },
): Promise<DirectSteerResult> {
  const { intent, deduped } = queue.enqueue(
    {
      swarmId: input.swarmId,
      memberId: input.workerId,
      reason: "user_direct",
      payloadHash: `user-direct:${input.idempotencySeed}`,
    },
    `user-direct-${input.idempotencySeed}`,
  );
  const result = await dispatcher.dispatchWake(input.swarmId, intent.id, {
    correlationId: `user-direct-${input.idempotencySeed}`,
    payloadText: input.text,
  });
  return {
    intent,
    deduped,
    dispatched: result.status === "dispatched",
    dispatchStatus: result.status,
  };
}
