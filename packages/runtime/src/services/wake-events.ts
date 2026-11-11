/**
 * M2 wake lifecycle events — observable + correlatable (spec §§8, 12 M2).
 *
 * Pure (no DB, no harness, no inference): the emitter fans out to
 * subscribers and keeps a bounded ring for tests/diagnostics. Persistence
 * is the store's job — every lifecycle transition in `SwarmStore` appends
 * an `outbox` row in the SAME txn (`wake_admitted`, `wake_deferred`,
 * `wake_observed_running`, `wake_retry_scheduled`, `wake_quota_blocked`,
 * `wake_quarantined`, `wake_quarantine_cleared`, `wake_completed`,
 * `wake_cancelled_stale`), so the durable trail and these observable
 * events carry the same correlation IDs.
 *
 * Transport is at-least-once: events may redeliver; consumers dedupe by
 * (kind, wakeId, correlationId). Logical intent is exactly-once via the
 * store `delivery_key` UNIQUE (migration 002) — never claim exactly-once
 * physical delivery.
 */

export type WakeEventKind =
  | "enqueued"
  | "deduped"
  | "admitted"
  | "deferred"
  | "observed_running"
  | "dispatched"
  | "retry_scheduled"
  | "quota_blocked"
  | "completed"
  | "cancelled_stale"
  | "quarantined"
  | "quarantine_cleared"
  | "reconciled";

export interface WakeEvent {
  readonly kind: WakeEventKind;
  readonly swarmId: string;
  readonly wakeId: string;
  readonly memberId: string;
  readonly correlationId: string;
  readonly at: string;
  readonly detail?: Readonly<Record<string, string>>;
}

export type WakeEventSink = (event: WakeEvent) => void;

/** Adapter-internal correlation key (never forwarded to OpenCode APIs). */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

const RING_CAP = 1000;

/**
 * Synchronous in-process fan-out hub with a bounded history ring.
 * A throwing/slow listener never breaks the emit path (mirrors the
 * M1-02 BroadcastHub posture).
 */
export class WakeEventEmitter {
  private readonly listeners = new Set<WakeEventSink>();
  private readonly ring: WakeEvent[] = [];

  subscribe(sink: WakeEventSink): () => void {
    this.listeners.add(sink);
    return () => {
      this.listeners.delete(sink);
    };
  }

  emit(input: {
    readonly kind: WakeEventKind;
    readonly swarmId: string;
    readonly wakeId: string;
    readonly memberId: string;
    readonly correlationId?: string;
    readonly at?: string;
    readonly detail?: Readonly<Record<string, string>>;
  }): WakeEvent {
    const event: WakeEvent = {
      kind: input.kind,
      swarmId: input.swarmId,
      wakeId: input.wakeId,
      memberId: input.memberId,
      correlationId: input.correlationId ?? newCorrelationId(),
      at: input.at ?? nowIso(),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
    this.ring.push(event);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not break dispatch */
      }
    }
    return event;
  }

  /** Bounded recent history (oldest-first), for tests and diagnostics. */
  history(): readonly WakeEvent[] {
    return [...this.ring];
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * Safe structured log line for the daemon log (spec §12: ids + correlation,
 * never full prompts, never secrets).
 */
export function formatWakeEvent(event: WakeEvent): string {
  return JSON.stringify({
    op: `wake.${event.kind}`,
    swarmId: event.swarmId,
    wakeId: event.wakeId,
    memberId: event.memberId,
    correlationId: event.correlationId,
    at: event.at,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  });
}
