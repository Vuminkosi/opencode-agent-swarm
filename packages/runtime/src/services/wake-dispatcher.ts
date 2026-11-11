/**
 * M2 wake dispatcher — event-driven durable wake-ups (spec §§7, 8 M2).
 *
 * Owns the dispatch loop over durable wake intents:
 * - selects the oldest eligible queued wake per swarm (FIFO, ordering +
 *   identity + ownership preserved from the journal);
 * - fenced-claims it (one active turn per member, coalesced duplicates,
 *   never paused/killed/quota-blocked);
 * - resumes the EXISTING native session with ONE queue-only harness turn
 *   correlated by wake id (adapter-internal externalId — never an OpenCode
 *   API argument);
 * - acks observed_running on admission, schedules bounded exp-backoff
 *   retries for TRANSIENT transport failures, quota-pauses (no auto paid
 *   retry) on 402, and quarantines nothing here (ambiguity belongs to the
 *   reconciler).
 *
 * Exactly-once LOGICAL intent (delivery_key UNIQUE, one persisted action)
 * + at-least-once TRANSPORT (receipts may redeliver; ack is idempotent).
 * Never claims exactly-once physical delivery.
 *
 * Zero idle inference: with no eligible wake the dispatcher performs zero
 * harness submitTurn calls (proven by the idle test asserting the
 * FakeHarness counter stays 0). Status reads never dispatch.
 */

import { ProtocolError } from "@opencode-swarm/protocol";
import type { Member, WakeIntent, WakeReason } from "@opencode-swarm/protocol";
import {
  WAKE_BACKOFF_BASE_MS_DEFAULT,
  WAKE_BACKOFF_CAP_MS_DEFAULT,
  WAKE_LEASE_TTL_MS_DEFAULT,
  WAKE_MAX_ATTEMPTS_DEFAULT,
  type SwarmStore,
} from "../db/store.js";
import { formatWakeEvent, newCorrelationId, type WakeEventEmitter } from "./wake-events.js";

/** Minimal harness surface the dispatcher needs (satisfied structurally by
 *  the M1-03 OpenCodeHarness; tests inject a FakeHarness). Queue-only. */
export interface DispatchHarness {
  submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: WakeReason;
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }>;
  getSession(sessionId: string): Promise<{
    readonly hasLiveExecution: boolean;
    readonly knownTerminalExternalIds: readonly string[];
  }>;
}

export interface DispatchPolicy {
  readonly leaseTtlMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => string;
  readonly random?: () => number;
}

export type DispatchStatus =
  | "dispatched"
  | "deferred-live-turn"
  | "deferred-stale"
  | "deferred-ineligible"
  | "deferred-backoff"
  | "deferred-quarantined"
  | "skipped-not-queued"
  | "skipped-swarm-paused"
  | "quota-blocked"
  | "failed-transient-scheduled"
  | "failed-permanent";

export interface DispatchResult {
  readonly status: DispatchStatus;
  readonly swarmId: string;
  readonly wakeId: string;
  readonly memberId: string;
  readonly correlationId: string;
  readonly attempts: number;
  readonly fencingToken?: number;
  readonly notBefore?: string;
  readonly detail?: string;
}

function isQuotaError(err: unknown): boolean {
  if (err instanceof ProtocolError) return false;
  const withStatus = err as { status?: unknown; code?: unknown; message?: unknown };
  if (withStatus.status === 402) return true;
  const code = typeof withStatus.code === "string" ? withStatus.code : "";
  const message = typeof withStatus.message === "string" ? withStatus.message : "";
  return /quota/i.test(code) || /quota/i.test(message) || /402/.test(code);
}

function isTransientError(err: unknown): boolean {
  if (err instanceof ProtocolError) return false;
  const withStatus = err as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  if (typeof withStatus.status === "number") {
    const s = withStatus.status as number;
    if (s === 429 || s === 408 || s === 502 || s === 503 || s === 504) return true;
    if (s >= 400 && s < 500) return false;
    if (s >= 500) return true;
  }
  const code = typeof withStatus.code === "string" ? withStatus.code : "";
  const name = typeof withStatus.name === "string" ? withStatus.name : "";
  if (/ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|FETCH_TIMEOUT|TIMEOUT|ABORT/i.test(`${code} ${name}`)) return true;
  return true;
}

const TERMINAL_SWARM = new Set(["completing", "completed", "failed", "cancelled"]);

/**
 * Deterministic wake payload: unread intent metadata + owned task brief.
 * Pure text assembly — no inference, no harness calls. Truncated defensively
 * so one giant brief cannot blow the session inbox budget.
 */
export function buildWakePayload(member: Member, intent: WakeIntent, taskBrief?: string): string {
  const lines = [
    `@${member.name} WAKE reason=${intent.reason} wake=${intent.id}`,
    `Member: ${member.id} (generation ${intent.memberGeneration})`,
    ...(intent.postSequence !== null ? [`Board sequence: ${intent.postSequence}`] : []),
    ...(intent.taskId !== null ? [`Task: ${intent.taskId}`] : []),
    ...(taskBrief !== undefined && taskBrief !== "" ? [`Brief: ${taskBrief.slice(0, 2000)}`] : []),
    `Reply on this board when done; do not start a second turn for the same wake.`,
  ];
  return lines.join("\n");
}

export class WakeDispatcher {
  private dispatchedTurns = 0;
  private readonly leaseTtlMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly maxAttempts: number;
  private readonly nowFn: () => string;
  private readonly randomFn: () => number;

  constructor(
    private readonly store: SwarmStore,
    private readonly harness: DispatchHarness,
    private readonly events?: WakeEventEmitter,
    policy?: DispatchPolicy,
  ) {
    this.leaseTtlMs = policy?.leaseTtlMs ?? WAKE_LEASE_TTL_MS_DEFAULT;
    this.backoffBaseMs = policy?.backoffBaseMs ?? WAKE_BACKOFF_BASE_MS_DEFAULT;
    this.backoffCapMs = policy?.backoffCapMs ?? WAKE_BACKOFF_CAP_MS_DEFAULT;
    this.maxAttempts = policy?.maxAttempts ?? WAKE_MAX_ATTEMPTS_DEFAULT;
    this.nowFn = policy?.now ?? (() => new Date().toISOString());
    this.randomFn = policy?.random ?? Math.random;
  }

  /** Queue-only dispatches performed (status/eligibility reads never move this). */
  getDispatchCount(): number {
    return this.dispatchedTurns;
  }

  private log(event: Parameters<NonNullable<WakeDispatcher["events"]>["emit"]>[0]): void {
    if (this.events === undefined) return;
    const emitted = this.events.emit(event);
    console.info(formatWakeEvent(emitted));
  }

  private swarmDispatchable(swarmId: string): boolean {
    const swarm = this.store.getSwarm(swarmId);
    return swarm.status !== "paused" && !TERMINAL_SWARM.has(swarm.status);
  }

  /**
   * Dispatch exactly one wake by id. Never submits for non-queued,
   * ineligible, backoff-pending or quarantined wakes (returns a
   * deferred/skipped result with zero harness calls instead).
   */
  async dispatchWake(
    swarmId: string,
    wakeId: string,
    opts?: { readonly correlationId?: string; readonly payloadText?: string },
  ): Promise<DispatchResult> {
    const correlationId = opts?.correlationId ?? newCorrelationId();
    const base = { swarmId, wakeId, memberId: "", correlationId, attempts: 0 };
    if (!this.swarmDispatchable(swarmId)) {
      const intent = this.store.getWake(wakeId);
      return { ...base, memberId: intent.memberId, attempts: intent.attempts, status: "skipped-swarm-paused" };
    }
    const current = this.store.getWake(wakeId);
    if (current.state !== "queued") {
      return {
        ...base, memberId: current.memberId, attempts: current.attempts,
        status: "skipped-not-queued", detail: `state=${current.state}`,
      };
    }
    const claim = this.store.claimWakeForDispatch(wakeId, {
      leaseTtlMs: this.leaseTtlMs,
      correlationId,
      nowIso: this.nowFn(),
      baseMs: this.backoffBaseMs,
      capMs: this.backoffCapMs,
    });
    if (claim.status !== "admitted") {
      const mapped: DispatchStatus =
        claim.status === "deferred-live-turn" ? "deferred-live-turn"
        : claim.status === "deferred-stale" ? "deferred-stale"
        : claim.status === "deferred-ineligible" ? "deferred-ineligible"
        : claim.status === "deferred-quarantined" ? "deferred-quarantined"
        : "deferred-backoff";
      this.log({
        kind: "deferred", swarmId, wakeId, memberId: claim.intent.memberId, correlationId,
        detail: { status: mapped },
      });
      return {
        ...base, memberId: claim.intent.memberId, attempts: claim.intent.attempts,
        status: mapped, detail: claim.status,
      };
    }
    const member = this.store.getMember(claim.intent.memberId);
    // S2-1 TOCTOU guard: re-read the member AFTER the claim. Killed or
    // generation drift cancels the intent (never dispatch a dead turn);
    // quota/approval pause PRESERVES the admitted intent and releases the
    // lease (mirror markQuotaBlocked) so resume redrives with zero loss —
    // never cancelStaleWake a paused member (dedupe would suppress redrive).
    if (member.internalState === "killed" || claim.intent.memberGeneration !== member.generation) {
      const cancelled = this.store.cancelStaleWake(
        wakeId,
        member.internalState === "killed" ? "member-killed-at-dispatch" : "member-generation-drift-at-dispatch",
        correlationId,
      );
      void cancelled;
      const after = this.store.getWake(wakeId);
      return {
        ...base, memberId: member.id, attempts: after.attempts,
        status: "deferred-stale", detail: member.internalState,
      };
    }
    if (member.internalState === "quota_paused" || member.internalState === "approval_paused") {
      this.store.releaseWakeLease(member.id, wakeId);
      const preserved = this.store.getWake(wakeId);
      return {
        ...base, memberId: member.id, attempts: preserved.attempts,
        status: "deferred-ineligible", detail: member.internalState,
      };
    }
    // One live turn per session: verify the native session is idle before
    // admitting a transport turn (prevents overlapping turns on restart).
    try {
      const snapshot = await this.harness.getSession(member.sessionId);
      if (snapshot.hasLiveExecution) {
        // F-01: a live session is a deferral, not a failure — release the
        // lease with zero budget burn (attempts frozen) so busy defers can
        // never terminally close a never-attempted wake.
        const deferred = this.store.deferWakeWithoutBudget(wakeId, {
          correlationId, baseMs: this.backoffBaseMs, capMs: this.backoffCapMs,
          reason: "session-live-execution",
        });
        const after = this.store.getWake(wakeId);
        return {
          ...base, memberId: member.id, attempts: after.attempts,
          status: "deferred-live-turn", detail: "session-live-execution", notBefore: deferred.notBefore,
        };
      }
    } catch {
      // Snapshot failure must not dispatch blindly — and must not burn
      // retry budget either: release the lease, freeze attempts, defer.
      const deferred = this.store.deferWakeWithoutBudget(wakeId, {
        correlationId, baseMs: this.backoffBaseMs, capMs: this.backoffCapMs,
        reason: "session-snapshot-unavailable",
      });
      const after = this.store.getWake(wakeId);
      return {
        ...base, memberId: member.id, attempts: after.attempts,
        status: "deferred-backoff", detail: "session-snapshot-unavailable", notBefore: deferred.notBefore,
      };
    }
    let taskBrief: string | undefined;
    if (claim.intent.taskId !== null) {
      try {
        taskBrief = this.store.getTask(claim.intent.taskId).brief;
      } catch {
        taskBrief = undefined;
      }
    }
    const text = opts?.payloadText ?? buildWakePayload(member, claim.intent, taskBrief);
    try {
      await this.harness.submitTurn({
        sessionId: member.sessionId,
        text,
        delivery: "queue",
        externalId: wakeId,
        reason: claim.intent.reason,
      });
    } catch (err) {
      if (isQuotaError(err)) {
        // 402: quota-pause the member, NEVER auto-retry the paid path.
        const blocked = this.store.markQuotaBlocked(member.id, wakeId, correlationId);
        void blocked;
        this.log({
          kind: "quota_blocked", swarmId, wakeId, memberId: member.id, correlationId,
          detail: { memberTransition: blocked.memberTransition },
        });
        const after = this.store.getWake(wakeId);
        return { ...base, memberId: member.id, attempts: after.attempts, status: "quota-blocked" };
      }
      if (isTransientError(err)) {
        const retry = this.store.failWakeTransient(wakeId, {
          fencingToken: claim.fencingToken,
          correlationId,
          baseMs: this.backoffBaseMs,
          capMs: this.backoffCapMs,
          maxAttempts: this.maxAttempts,
          rand: this.randomFn,
          nowIso: this.nowFn(),
        });
        this.log({
          kind: "retry_scheduled", swarmId, wakeId, memberId: member.id, correlationId,
          detail: { attempts: String(retry.attempts), notBefore: retry.notBefore },
        });
        return {
          ...base, memberId: member.id, attempts: retry.attempts,
          status: retry.exhausted ? "failed-permanent" : "failed-transient-scheduled",
          notBefore: retry.notBefore, detail: retry.exhausted ? "retry-budget-exhausted" : "transient-transport",
        };
      }
      const failed = this.store.completeWake(wakeId, "failed", claim.fencingToken, correlationId);
      this.log({ kind: "completed", swarmId, wakeId, memberId: member.id, correlationId, detail: { outcome: "failed" } });
      return { ...base, memberId: member.id, attempts: failed.attempts, status: "failed-permanent", detail: "permanent-transport" };
    }
    // Admission receipt != execution proof (crash window): record the ack
    // so restart reconciles instead of blindly replaying.
    const acked = this.store.ackWakeObservedRunning(wakeId, claim.fencingToken);
    this.dispatchedTurns += 1;
    this.log({
      kind: "dispatched", swarmId, wakeId, memberId: member.id, correlationId,
      detail: { fencingToken: String(claim.fencingToken) },
    });
    return {
      ...base, memberId: member.id, attempts: acked.attempts,
      status: "dispatched", fencingToken: claim.fencingToken,
    };
  }

  /**
   * Retry an ADMITTED wake whose lease was lost (reconciler released it
   * after verifying never-submitted + session idle). Re-acquires the
   * fencing lease, re-verifies idleness, then submits the SAME externalId
   * — one persisted logical action, never blind replay. Quarantined or
   * backoff-pending wakes are never submitted here.
   */
  async retryAdmittedWake(
    swarmId: string,
    wakeId: string,
    opts?: { readonly correlationId?: string; readonly payloadText?: string },
  ): Promise<DispatchResult> {
    const correlationId = opts?.correlationId ?? newCorrelationId();
    const base = { swarmId, wakeId, memberId: "", correlationId, attempts: 0 };
    if (!this.swarmDispatchable(swarmId)) {
      const intent = this.store.getWake(wakeId);
      return { ...base, memberId: intent.memberId, attempts: intent.attempts, status: "skipped-swarm-paused" };
    }
    const current = this.store.getWake(wakeId);
    if (current.state !== "admitted") {
      return {
        ...base, memberId: current.memberId, attempts: current.attempts,
        status: "skipped-not-queued", detail: `state=${current.state}`,
      };
    }
    const claim = this.store.reacquireWakeLease(wakeId, {
      leaseTtlMs: this.leaseTtlMs,
      correlationId,
      nowIso: this.nowFn(),
      baseMs: this.backoffBaseMs,
      capMs: this.backoffCapMs,
    });
    if (claim.status !== "admitted") {
      const mapped: DispatchStatus =
        claim.status === "deferred-live-turn" ? "deferred-live-turn"
        : claim.status === "deferred-stale" ? "deferred-stale"
        : claim.status === "deferred-ineligible" ? "deferred-ineligible"
        : claim.status === "deferred-quarantined" ? "deferred-quarantined"
        : "deferred-backoff";
      return {
        ...base, memberId: claim.intent.memberId, attempts: claim.intent.attempts,
        status: mapped, detail: claim.status,
      };
    }
    const member = this.store.getMember(claim.intent.memberId);
    // S2-1 TOCTOU split (mirror dispatchWake): killed/drift cancels, quota/
    // approval preserves the admitted intent + releases the lease for resume.
    if (member.internalState === "killed" || claim.intent.memberGeneration !== member.generation) {
      const cancelled = this.store.cancelStaleWake(
        wakeId,
        member.internalState === "killed" ? "member-killed-at-retry" : "member-generation-drift-at-retry",
        correlationId,
      );
      void cancelled;
      const after = this.store.getWake(wakeId);
      return {
        ...base, memberId: member.id, attempts: after.attempts,
        status: "deferred-stale", detail: member.internalState,
      };
    }
    if (member.internalState === "quota_paused" || member.internalState === "approval_paused") {
      this.store.releaseWakeLease(member.id, wakeId);
      const preserved = this.store.getWake(wakeId);
      return {
        ...base, memberId: member.id, attempts: preserved.attempts,
        status: "deferred-ineligible", detail: member.internalState,
      };
    }
    try {
      const snapshot = await this.harness.getSession(member.sessionId);
      if (snapshot.hasLiveExecution || snapshot.knownTerminalExternalIds.includes(wakeId)) {
        // F-01: not-idle at retry is a deferral, not a transport failure.
        const deferred = this.store.deferWakeWithoutBudget(wakeId, {
          correlationId, baseMs: this.backoffBaseMs, capMs: this.backoffCapMs,
          reason: "session-not-idle-at-retry",
        });
        const after = this.store.getWake(wakeId);
        return {
          ...base, memberId: after.memberId, attempts: after.attempts,
          status: "deferred-live-turn", detail: "session-not-idle-at-retry", notBefore: deferred.notBefore,
        };
      }
    } catch {
      const deferred = this.store.deferWakeWithoutBudget(wakeId, {
        correlationId, baseMs: this.backoffBaseMs, capMs: this.backoffCapMs,
        reason: "session-snapshot-unavailable",
      });
      const after = this.store.getWake(wakeId);
      return {
        ...base, memberId: after.memberId, attempts: after.attempts,
        status: "deferred-backoff", detail: "session-snapshot-unavailable", notBefore: deferred.notBefore,
      };
    }
    let taskBrief: string | undefined;
    if (claim.intent.taskId !== null) {
      try {
        taskBrief = this.store.getTask(claim.intent.taskId).brief;
      } catch {
        taskBrief = undefined;
      }
    }
    const text = opts?.payloadText ?? buildWakePayload(member, claim.intent, taskBrief);
    try {
      await this.harness.submitTurn({
        sessionId: member.sessionId,
        text,
        delivery: "queue",
        externalId: wakeId,
        reason: claim.intent.reason,
      });
    } catch (err) {
      if (isQuotaError(err)) {
        const blocked = this.store.markQuotaBlocked(member.id, wakeId, correlationId);
        void blocked;
        const after = this.store.getWake(wakeId);
        return { ...base, memberId: member.id, attempts: after.attempts, status: "quota-blocked" };
      }
      if (isTransientError(err)) {
        const retry = this.store.failWakeTransient(wakeId, {
          fencingToken: claim.fencingToken,
          correlationId,
          baseMs: this.backoffBaseMs,
          capMs: this.backoffCapMs,
          maxAttempts: this.maxAttempts,
          rand: this.randomFn,
          nowIso: this.nowFn(),
        });
        return {
          ...base, memberId: member.id, attempts: retry.attempts,
          status: retry.exhausted ? "failed-permanent" : "failed-transient-scheduled",
          notBefore: retry.notBefore, detail: retry.exhausted ? "retry-budget-exhausted" : "transient-transport",
        };
      }
      const failed = this.store.completeWake(wakeId, "failed", claim.fencingToken, correlationId);
      return { ...base, memberId: member.id, attempts: failed.attempts, status: "failed-permanent", detail: "permanent-transport" };
    }
    const acked = this.store.ackWakeObservedRunning(wakeId, claim.fencingToken);
    this.dispatchedTurns += 1;
    this.log({
      kind: "dispatched", swarmId, wakeId, memberId: member.id, correlationId,
      detail: { fencingToken: String(claim.fencingToken), retry: "admitted-retry" },
    });
    return {
      ...base, memberId: member.id, attempts: acked.attempts,
      status: "dispatched", fencingToken: claim.fencingToken,
    };
  }

  /** Dispatch the oldest eligible queued wake (FIFO), or null when idle. */
  async dispatchNext(
    swarmId: string,
    opts?: { readonly correlationId?: string },
  ): Promise<DispatchResult | null> {
    if (!this.swarmDispatchable(swarmId)) return null;
    const [next] = this.store.listEligibleQueuedWakes(swarmId, 1, { nowMs: Date.parse(this.nowFn()) });
    if (next === undefined) return null;
    return this.dispatchWake(
      swarmId,
      next.id,
      opts?.correlationId === undefined ? undefined : { correlationId: opts.correlationId },
    );
  }

  /** Drain up to `limit` eligible wakes in FIFO order; stops when idle. */
  async dispatchAll(swarmId: string, limit = 100): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    const cid = newCorrelationId();
    for (let i = 0; i < limit; i += 1) {
      if (!this.swarmDispatchable(swarmId)) break;
      const [next] = this.store.listEligibleQueuedWakes(swarmId, 1, { nowMs: Date.parse(this.nowFn()) });
      if (next === undefined) break;
      results.push(await this.dispatchWake(swarmId, next.id, { correlationId: cid }));
      const last = results[results.length - 1];
      if (last === undefined || (last.status !== "dispatched" && last.status !== "failed-transient-scheduled" && last.status !== "failed-permanent" && last.status !== "quota-blocked")) break;
    }
    return results;
  }
}
