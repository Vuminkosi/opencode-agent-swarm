/**
 * Frozen harness adapter port — M0-01 (contract C-HARNESS-01).
 *
 * @frozen M0-01 — any change to the exported surface below requires an
 * architect-approved contract amendment. Do not widen this file to cover
 * Codex or other backends; those get their own adapter behind `CodingHarness`.
 *
 * Design notes (spec §§4.2, 8, App. B):
 * - `externalId` is OUR adapter-internal correlation key (wake-intent id).
 *   It is never passed through to a documented OpenCode API argument;
 *   the concrete harness implementation maps and reconciles it locally.
 * - "Waiting" means the daemon submitted no prompt for the member. There is
 *   no fictional native `suspend()` API; do not add one here.
 * - OpenCode event streams are volatile (may overflow / drop on disconnect).
 *   Durability lives in the daemon journal, not in `EventSubscription`.
 * - This file has zero runtime dependencies by design, so production code
 *   references no undocumented OpenCode API surface through this port.
 *
 * Evidence: [DESIGN] (ours to implement); OpenCode-side method names cited
 * in doc comments are [OC2-DOC] per spec §4.2 and are subject to §4.6 probe
 * confirmation before any concrete harness implementation relies on them.
 */

/** How a turn payload is admitted to a native session. [DESIGN] */
export type TurnDelivery = "queue" | "steer";

/** Terminal outcome observed for one admitted turn. [DESIGN] */
export type TurnOutcome = "succeeded" | "failed" | "interrupted";

/** Why a member is (re)admitted for a turn. Mirrors WakeIntent reasons. [DESIGN] */
export type WakeReason =
  | "mention"
  | "assigned_task"
  | "verifier_request"
  | "monitor_intervention"
  | "user_direct";

/** Model reference using native provider + model ids (not friendly labels). [OC2-DOC] */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
}

/** Request to submit exactly one turn to a native session. [DESIGN] */
export interface SubmitTurnRequest {
  /** Native session id owning the turn. */
  readonly sessionId: string;
  /** Full prompt text for this turn (unread mentions + task brief batch). */
  readonly text: string;
  /** Admission mode: `queue` (append to inbox) vs `steer` (direct steer). [OC2-DOC, probe 6] */
  readonly delivery: TurnDelivery;
  /**
   * Adapter-internal correlation key (wake-intent id). Used for local
   * admission/execution reconciliation only — never forwarded as an
   * OpenCode API argument.
   */
  readonly externalId: string;
  /** Wake reason, for observability and policy. */
  readonly reason: WakeReason;
}

/** Local acknowledgement that a turn was admitted (NOT proof of execution). [DESIGN] */
export interface AdmissionReceipt {
  readonly externalId: string;
  readonly admittedAt: string;
  /** Human-readable note on how admission was performed/reconciled. */
  readonly transportNote: string;
}

/** Observed terminal state of one execution, correlated to an admission. [DESIGN] */
export interface ExecutionRecord {
  readonly externalId: string;
  readonly sessionId: string;
  readonly outcome: TurnOutcome;
  readonly observedAt: string;
  /** Opaque native execution/correlation id, when the backend exposes one. */
  readonly nativeExecutionId: string | null;
}

/** Native agent descriptor discovered from OpenCode config/agent surface. [OC2-DOC, probe 3] */
export interface NativeAgentInfo {
  readonly id: string;
  readonly model: ModelRef;
}

/** Session snapshot used for post-disconnect reconciliation. [OC2-DOC, probe 8] */
export interface SessionSnapshot {
  readonly sessionId: string;
  /** True when a model turn is currently executing. */
  readonly hasLiveExecution: boolean;
  /** Ids of terminal executions known to the backend (for dedupe). */
  readonly knownTerminalExternalIds: readonly string[];
}

/** Permission rule applied to a session scope. [OC2-DOC, probe 11] */
export interface PermissionRule {
  readonly scope: string;
  readonly action: "allow" | "deny";
}

/**
 * Replaceable coding-harness backend. The daemon depends ONLY on this
 * interface; OpenCode (M1-03) and Codex (M7) provide implementations.
 * Contract C-HARNESS-01.
 */
export interface CodingHarness {
  readonly backend: "opencode" | "codex";
  /** Create an isolated native session bound to a working directory. */
  createSession(title: string, directory: string): Promise<{ sessionId: string }>;
  /** Read a reconciliation snapshot (lifecycle + execution state). */
  getSession(sessionId: string): Promise<SessionSnapshot>;
  /** Bind a session to a native agent id; preserves native permissions. */
  switchAgent(sessionId: string, agentId: string): Promise<void>;
  /** Switch model on a waiting session; history must be retained. */
  switchModel(sessionId: string, model: ModelRef): Promise<void>;
  /**
   * Admit exactly one turn. Returning a receipt means the prompt was handed
   * to the backend; it does NOT mean the model executed (see crash-window
   * note in spec §8 — reconcile via `getSession` / event observation).
   */
  submitTurn(request: SubmitTurnRequest): Promise<AdmissionReceipt>;
  /** Interrupt a running turn; resolves with the observed terminal outcome. */
  interrupt(sessionId: string): Promise<TurnOutcome>;
  /**
   * Optional completion signal. MUST NOT be treated as durable truth —
   * always reconcile against `getSession` before state transitions.
   */
  wait(sessionId: string, signal: AbortSignal): Promise<ExecutionRecord>;
  /** Apply sandbox permission rules to a session scope. */
  applyPermissionRules(sessionId: string, rules: readonly PermissionRule[]): Promise<void>;
  /** Discover available native agents with effective models/permissions. */
  listAgents(): Promise<readonly NativeAgentInfo[]>;
}

/**
 * Volatile backend event delivered to the daemon for forwarding.
 * No replay guarantee — the daemon journal is the durability layer. [OC2-DOC]
 */
export interface HarnessEvent {
  readonly type: string;
  readonly sessionId: string;
  readonly at: string;
  /** Backend correlation id when the backend exposes one (probe 7). */
  readonly nativeExecutionId: string | null;
  readonly payload: Readonly<Record<string, string>>;
}

/** Volatile subscription; caller must reconcile via `getSession` on resubscribe. [OC2-DOC, probe 8] */
export interface EventSubscription {
  readonly sessionId: string;
  subscribe(handler: (event: HarnessEvent) => void, signal: AbortSignal): Promise<void>;
}
