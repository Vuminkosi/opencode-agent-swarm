/**
 * M2 inbox reconciler — restart/reconnect/interrupted-dispatch recovery
 * (spec §§8, 12 M2).
 *
 * Runs after daemon restart, event-stream reconnect, or an interrupted
 * dispatch: for every unsettled wake (admitted/observed_running) it
 * compares the durable journal against a fresh harness session snapshot
 * and the adapter-internal submission record, then:
 * - session live -> keep (re-acquire the member lease when expired);
 * - terminally known with a reported outcome -> complete accordingly;
 * - terminally known WITHOUT a reported outcome -> QUARANTINE (never
 *   invent an outcome, never blind replay);
 * - idle + never submitted (crash between claim and admission) ->
 *   release the lease so the dispatcher can drive the SAME logical
 *   intent (same wake id, same externalId — no duplicate action);
 * - idle + submitted but no terminal record (crash between admission
 *   and ack) -> QUARANTINE (ambiguous: resubmitting could double the
 *   model turn; an operator clears it after review);
 * - member killed / generation drift -> cancel as stale.
 *
 * Queued wakes need no action (restart preserves them; the dispatcher
 * re-reads them). Only the reconciler completes or quarantines unsettled
 * wakes — the dispatcher never touches non-queued rows.
 */

import type { Member, WakeIntent } from "@vuminkosi/protocol";
import type { SwarmStore } from "../db/store.js";
import { formatWakeEvent, newCorrelationId, type WakeEventEmitter } from "./wake-events.js";

/** Fresh harness/session observation for one member session. */
export interface ReconcileSnapshot {
  /** True when a model turn is currently executing on the session. */
  readonly hasLiveExecution: boolean;
  /** Wake ids the backend reports as terminally executed. */
  readonly knownTerminalExternalIds: readonly string[];
  /** Reported outcome per terminal wake id (absent = unknown outcome). */
  readonly terminalOutcomes?: Readonly<Record<string, "succeeded" | "failed">>;
  /** True when the adapter registry holds a non-terminal admission. */
  readonly wasSubmitted?: boolean;
}

export type SnapshotProvider = (sessionId: string) => Promise<ReconcileSnapshot>;

export type ReconcileDecision =
  | "kept-running"
  | "completed"
  | "released-for-retry"
  | "quarantined"
  | "cancelled-stale"
  | "skipped-snapshot-unavailable";

export interface ReconciledWake {
  readonly wakeId: string;
  readonly memberId: string;
  readonly decision: ReconcileDecision;
  readonly detail?: string;
}

export interface ReconcileReport {
  readonly swarmId: string;
  readonly correlationId: string;
  readonly at: string;
  readonly checked: number;
  readonly keptRunning: number;
  readonly completed: number;
  readonly releasedForRetry: number;
  readonly quarantined: number;
  readonly cancelledStale: number;
  readonly wakes: readonly ReconciledWake[];
}

export class InboxReconciler {
  constructor(
    private readonly store: SwarmStore,
    private readonly snapshots: SnapshotProvider,
    private readonly events?: WakeEventEmitter,
    private readonly nowFn: () => string = () => new Date().toISOString(),
  ) {}

  private log(event: {
    readonly kind: "reconciled" | "quarantined" | "completed" | "cancelled_stale";
    readonly swarmId: string;
    readonly wakeId: string;
    readonly memberId: string;
    readonly correlationId: string;
    readonly detail?: Readonly<Record<string, string>>;
  }): void {
    if (this.events === undefined) return;
    const emitted = this.events.emit(event);
    console.info(formatWakeEvent(emitted));
  }

  /** Reconcile one unsettled wake against a fresh snapshot. */
  async reconcileWake(swarmId: string, wake: WakeIntent, correlationId?: string): Promise<ReconciledWake> {
    const cid = correlationId ?? newCorrelationId();
    const base = { wakeId: wake.id, memberId: wake.memberId };
    let member: Member;
    try {
      member = this.store.getMember(wake.memberId);
    } catch {
      const cancelled = this.store.cancelStaleWake(wake.id, "member-missing", cid);
      void cancelled;
      this.log({ kind: "cancelled_stale", swarmId, wakeId: wake.id, memberId: wake.memberId, correlationId: cid, detail: { reason: "member-missing" } });
      return { ...base, decision: "cancelled-stale", detail: "member-missing" };
    }
    if (member.internalState === "killed" || member.generation !== wake.memberGeneration) {
      this.store.cancelStaleWake(wake.id, "stale-generation-or-killed", cid);
      this.log({ kind: "cancelled_stale", swarmId, wakeId: wake.id, memberId: wake.memberId, correlationId: cid, detail: { reason: "stale-generation-or-killed" } });
      return { ...base, decision: "cancelled-stale", detail: "stale-generation-or-killed" };
    }
    let snapshot: ReconcileSnapshot;
    try {
      snapshot = await this.snapshots(member.sessionId);
    } catch {
      return { ...base, decision: "skipped-snapshot-unavailable", detail: "snapshot-provider-threw" };
    }
    if (snapshot.hasLiveExecution) {
      // Still running: keep. No lease surgery needed — the dispatcher only
      // claims QUEUED wakes and this wake is admitted, so no duplicate can
      // be admitted while it is live regardless of lease TTL.
      this.log({ kind: "reconciled", swarmId, wakeId: wake.id, memberId: wake.memberId, correlationId: cid, detail: { decision: "kept-running" } });
      return { ...base, decision: "kept-running" };
    }
    if (snapshot.knownTerminalExternalIds.includes(wake.id)) {
      const outcome = snapshot.terminalOutcomes?.[wake.id];
      if (outcome === undefined) {
        this.store.quarantineWake(wake.id, "terminal-without-reported-outcome", cid);
        this.log({ kind: "quarantined", swarmId, wakeId: wake.id, memberId: wake.memberId, correlationId: cid, detail: { reason: "terminal-without-reported-outcome" } });
        return { ...base, decision: "quarantined", detail: "terminal-without-reported-outcome" };
      }
      this.store.completeWake(wake.id, outcome, undefined, cid);
      this.log({ kind: "completed", swarmId, wakeId: wake.id, memberId: wake.memberId, correlationId: cid, detail: { outcome } });
      return { ...base, decision: "completed", detail: outcome };
    }
    if (snapshot.wasSubmitted !== true) {
      // Crash between claim and submitTurn: nothing reached the backend.
      // Release the member lease so the dispatcher can drive the SAME
      // logical intent (same wake id) — no duplicate action, no replay.
      this.store.releaseWakeLease(member.id, wake.id);
      this.log({ kind: "reconciled", swarmId, wakeId: wake.id, memberId: wake.memberId, correlationId: cid, detail: { decision: "released-for-retry" } });
      return { ...base, decision: "released-for-retry", detail: "never-submitted" };
    }
    // Submitted but no terminal record and session idle: ambiguous
    // (crash between admission and ack). Quarantine — never blind replay.
    this.store.quarantineWake(wake.id, "submitted-without-terminal-record", cid);
    this.log({ kind: "quarantined", swarmId, wakeId: wake.id, memberId: wake.memberId, correlationId: cid, detail: { reason: "submitted-without-terminal-record" } });
    return { ...base, decision: "quarantined", detail: "submitted-without-terminal-record" };
  }

  /** Reconcile every unsettled wake in a swarm (restart/reconnect path). */
  async reconcileSwarm(swarmId: string, correlationId?: string): Promise<ReconcileReport> {
    const cid = correlationId ?? newCorrelationId();
    const unsettled = this.store.listUnsettledWakes(swarmId, 500);
    const wakes: ReconciledWake[] = [];
    for (const wake of unsettled) {
      wakes.push(await this.reconcileWake(swarmId, wake, cid));
    }
    const count = (d: ReconcileDecision): number => wakes.filter((w) => w.decision === d).length;
    return {
      swarmId,
      correlationId: cid,
      at: this.nowFn(),
      checked: wakes.length,
      keptRunning: count("kept-running"),
      completed: count("completed"),
      releasedForRetry: count("released-for-retry"),
      quarantined: count("quarantined"),
      cancelledStale: count("cancelled-stale"),
      wakes,
    };
  }
}
