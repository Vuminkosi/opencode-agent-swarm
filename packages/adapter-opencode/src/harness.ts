/**
 * M1-03 native agent/session bridge — `CodingHarness` implementation.
 *
 * Wires `SessionManager` (sessions.ts) + the volatile event bridge
 * (events.ts) behind the frozen C-HARNESS-01 port. Uses ONLY verified
 * OpenCode 2.2.7 APIs (see sessions.ts header for the evidence inventory).
 *
 * Semantics enforced here (spec §§4.2, 8; M1-03 accept):
 * - submitTurn is QUEUE-ONLY. `steer` is rejected with an explicit code
 *   (probe-06 admission semantics are not yet live-confirmed).
 * - A receipt means ADMISSION, never execution proof (crash-window note).
 * - `wait()` is an optional completion signal; the record it returns is
 *   reconciled against `getSession` before the caller may transition state.
 * - `interrupt()` resolves with the observed terminal outcome.
 * - `switchAgent` never touches permissions; preservation is verified by
 *   comparing `getSession` permission snapshots before/after (bridge test).
 * - The daemon (M1-01 store + M1-02 journal) owns durability; this adapter
 *   owns only backend mapping + local admission reconciliation. It does NOT
 *   modify the store or daemon.
 */

import type {
  AdmissionReceipt,
  CodingHarness,
  ExecutionRecord,
  HarnessEvent,
  ModelRef,
  NativeAgentInfo,
  PermissionRule,
  SessionSnapshot,
  SubmitTurnRequest,
  TurnOutcome,
} from "./port.js";
import { OpenCodeApiError } from "./sessions.js";
import {
  AdmissionRegistry,
  SessionManager,
  toExecutionRecord,
  type OpenCodeTransport,
} from "./sessions.js";
import { subscribeHarnessEvents, executionOutcomeFor } from "./events.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface OpenCodeHarnessOptions {
  readonly transport: OpenCodeTransport;
  readonly registry?: AdmissionRegistry;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

/**
 * Queue-only OpenCode harness. Construct with `FetchTransport` for live use
 * or a fake `OpenCodeTransport` in tests. [DESIGN]
 */
export class OpenCodeHarness implements CodingHarness {
  readonly backend = "opencode" as const;
  private readonly sessions: SessionManager;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly lastNativeExecutionId = new Map<string, string | null>();

  constructor(opts: OpenCodeHarnessOptions) {
    this.sessions = new SessionManager(opts.transport, opts.registry);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? nowIso;
  }

  /** Exposed for daemon reconciliation + tests (no store/daemon coupling). */
  get manager(): SessionManager {
    return this.sessions;
  }

  async createSession(title: string, directory: string): Promise<{ sessionId: string }> {
    const created = await this.sessions.createSession({ title, directory });
    return { sessionId: created.sessionId };
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    const info = await this.sessions.getSession(sessionId);
    return this.sessions.toSnapshot(info, sessionId);
  }

  async switchAgent(sessionId: string, agentId: string): Promise<void> {
    await this.sessions.switchAgent(sessionId, agentId);
  }

  async switchModel(sessionId: string, model: ModelRef): Promise<void> {
    await this.sessions.switchModel(sessionId, model);
  }

  async submitTurn(request: SubmitTurnRequest): Promise<AdmissionReceipt> {
    return this.sessions.submitTurnRecorded(request, this.now);
  }

  async interrupt(sessionId: string): Promise<TurnOutcome> {
    const info = await this.sessions.interruptSession(sessionId);
    const outcome: TurnOutcome = info.outcome ?? "interrupted";
    const latest = this.sessions.registry.latestForSession(sessionId);
    if (latest !== null && !latest.terminal) {
      this.sessions.registry.markTerminal(latest.externalId);
    }
    return outcome;
  }

  /**
   * Optional completion signal via the verified experimental wait endpoint,
   * then MANDATORY reconciliation against getSession. Correlates to the
   * latest non-terminal admission for the session; throws a safe error when
   * no turn was admitted (the daemon must submitTurn before wait).
   * [OC2-REST: experimental.session.wait]
   */
  async wait(sessionId: string, signal: AbortSignal): Promise<ExecutionRecord> {
    const latest = this.sessions.registry.latestForSession(sessionId);
    if (latest === null || latest.terminal) {
      throw new OpenCodeApiError(400, "WAIT_WITHOUT_ADMITTED_TURN");
    }
    try {
      await this.sessions.waitForIdle(sessionId, signal);
    } catch (err) {
      if (signal.aborted) {
        throw new OpenCodeApiError(499, "WAIT_ABORTED");
      }
      throw err;
    }
    if (signal.aborted) {
      throw new OpenCodeApiError(499, "WAIT_ABORTED");
    }
    const info = await this.sessions.getSession(sessionId);
    const outcome: TurnOutcome = info.outcome ?? "succeeded";
    return toExecutionRecord(
      this.sessions.registry,
      latest,
      outcome,
      this.now(),
      this.lastNativeExecutionId.get(sessionId) ?? null,
    );
  }

  async applyPermissionRules(sessionId: string, rules: readonly PermissionRule[]): Promise<void> {
    await this.sessions.applyPermissionRules(sessionId, rules);
  }

  async listAgents(): Promise<readonly NativeAgentInfo[]> {
    return this.sessions.listAgents();
  }

  /**
   * Volatile subscription filtered to one session. The handler feeds the
   * daemon; terminal execution events also seed the nativeExecutionId cache
   * used by `wait()` correlation. Reconnect callers MUST reconcile via
   * getSession first (probe 08). [OC2-REST: event.subscribe]
   */
  subscribeSessionEvents(sessionId: string, handler: (event: HarnessEvent) => void, signal: AbortSignal): Promise<void> {
    return subscribeHarnessEvents(this.sessions.transport, {
      sessionIds: [sessionId],
      handler: (event) => {
        if (executionOutcomeFor(event.type) !== null && event.nativeExecutionId !== null) {
          this.lastNativeExecutionId.set(event.sessionId, event.nativeExecutionId);
        }
        handler(event);
      },
      signal,
      fetchImpl: this.fetchImpl,
    });
  }
}

/** Re-exported for daemon/tests that need raw mapping without the facade. */
export { toHarnessEvent } from "./events.js";
