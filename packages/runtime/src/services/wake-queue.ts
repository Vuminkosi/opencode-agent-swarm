/**
 * M2 wake queue — durable enqueue + coalesce + eligibility reads
 * (spec §§7, 8 M2).
 *
 * Thin service over `SwarmStore`: the store owns durability, delivery_key
 * idempotency and transitions; this layer resolves member generation,
 * batches mention fan-out, and emits observable lifecycle events. It
 * performs NO model inference and submits NO turns (that is the
 * dispatcher). Duplicate intents with the same delivery_key collapse to
 * ONE persisted logical action (`deduped: true`, same intent id).
 */

import type { SwarmStore } from "../db/store.js";
import type { WakeIntent, WakeReason } from "@vuminkosi/protocol";
import { newCorrelationId, type WakeEventEmitter } from "./wake-events.js";

export interface EnqueueWakeInput {
  readonly swarmId: string;
  readonly memberId: string;
  readonly reason: WakeReason;
  readonly postSequence?: number;
  readonly taskId?: string;
  readonly payloadHash: string;
  /** Omit to resolve the member's current generation (normal path). */
  readonly memberGeneration?: number;
}

export interface EnqueuedWake {
  readonly intent: WakeIntent;
  readonly deduped: boolean;
  readonly correlationId: string;
}

export class WakeQueue {
  constructor(
    private readonly store: SwarmStore,
    private readonly events?: WakeEventEmitter,
  ) {}

  /**
   * Enqueue one durable wake intent. Resolves generation from the member
   * row unless explicitly pinned (pinning enables stale-generation tests).
   * Killed members are rejected by the store (KILLED_MEMBER).
   */
  enqueue(input: EnqueueWakeInput, correlationId?: string): EnqueuedWake {
    const cid = correlationId ?? newCorrelationId();
    const generation =
      input.memberGeneration ?? this.store.getMember(input.memberId).generation;
    const { intent, deduped } = this.store.createWakeIntent(input.swarmId, {
      memberId: input.memberId,
      memberGeneration: generation,
      reason: input.reason,
      ...(input.postSequence === undefined ? {} : { postSequence: input.postSequence }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      payloadHash: input.payloadHash,
    });
    this.events?.emit({
      kind: deduped ? "deduped" : "enqueued",
      swarmId: intent.swarmId,
      wakeId: intent.id,
      memberId: intent.memberId,
      correlationId: cid,
      detail: { reason: intent.reason },
    });
    return { intent, deduped, correlationId: cid };
  }

  /**
   * Fan out one intent per live member for a board mention batch. Every
   * member gets at most one persisted logical action per delivery_key;
   * already-queued duplicates report deduped:true with the winner's id.
   */
  enqueueMentionBatch(
    swarmId: string,
    members: readonly { readonly memberId: string; readonly reason: WakeReason; readonly postSequence?: number; readonly payloadHash: string }[],
    correlationId?: string,
  ): readonly EnqueuedWake[] {
    const cid = correlationId ?? newCorrelationId();
    return members.map((m) =>
      this.enqueue(
        {
          swarmId,
          memberId: m.memberId,
          reason: m.reason,
          ...(m.postSequence === undefined ? {} : { postSequence: m.postSequence }),
          payloadHash: m.payloadHash,
        },
        cid,
      ),
    );
  }

  /** Oldest-first eligible queued wakes (dispatcher input; zero inference). */
  listEligible(swarmId: string, limit = 100, nowMs?: number): WakeIntent[] {
    return this.store.listEligibleQueuedWakes(swarmId, limit, nowMs === undefined ? undefined : { nowMs });
  }

  /** Wakes needing post-restart reconciliation (admitted/observed_running). */
  listUnsettled(swarmId: string, limit = 100): WakeIntent[] {
    return this.store.listUnsettledWakes(swarmId, limit);
  }
}
