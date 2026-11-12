/**
 * M7-02 Codex adapter probe — FAIL-CLOSED STUB (verdict: NOT VERIFIED).
 *
 * Probe evidence (recorded 2026-11-12, codex resolution WITHOUT install):
 * (1) CLI presence VERIFIED: `codex --version` -> `codex-cli 0.167.0`
 *     (resolved at C:\Users\Vuminkosi\AppData\Roaming\npm\codex; pre-existing,
 *     nothing installed by this task).
 * (2) Registry metadata (resolve-only, `npm view`, no install):
 *     `@openai/codex-sdk` version `0.167.2`, description
 *     "TypeScript SDK for Codex APIs." Its exported surface (thread/turn
 *     verbs, stability) was NOT downloaded and is NOT VERIFIED here.
 * (3) App-server protocol verbs enumerated LOCALLY via
 *     `codex app-server generate-json-schema --out $env:TEMP\codex-schema-probe`
 *     (no network, no install), from the installed 0.167.0 CLI:
 *     thread/start (+resume/fork/read/list/turns/list), turn/start,
 *     turn/steer, turn/interrupt, model/list. ThreadStartParams carries
 *     cwd/model/modelProvider. NO switchAgent verb exists; the only
 *     agent-shaped methods are ExternalAgentConfig/* (config import, not a
 *     session agent switch). No stable snapshot verb maps to
 *     SessionSnapshot.hasLiveExecution/knownTerminalExternalIds; no stable
 *     applyPermissionRules equivalent was confirmed.
 *
 * Why NOT VERIFIED (do NOT implement transport until ALL hold):
 * - `codex app-server` is explicitly marked `[experimental]` in
 *   `codex --help` / `codex app-server --help` output (0.167.0). An
 *   experimental protocol is not a stable documented interface, so building
 *   a production CodingHarness on turn/start / turn/steer / turn/interrupt
 *   would violate the M7-02 "ONLY documented verbs" rule.
 * - `codex exec` is one-shot non-interactive; it documents no interrupt,
 *   switchAgent, switchModel-on-waiting-session, listAgents, or snapshot
 *   verbs usable by a long-lived harness.
 * - `codex queue --thread <THREAD> --message <TEXT>` exists (queue analogue)
 *   but its completion/interrupt/session-identity semantics are undocumented
 *   for harness use, and ModelRef {providerID,id} -> Codex model-string
 *   mapping (model-inheritance passthrough) is undocumented.
 * - Official doc URLs referenced but content NOT fetched/verified here
 *   (network out of scope for this probe): https://developers.openai.com/codex,
 *   https://developers.openai.com/codex/cli, app-server/SDK references.
 *
 * Contract: this stub implements the CodingHarness TYPE shape (proving the
 * M1-03 port.ts surface compiles against a `backend: "codex"` candidate)
 * while FAILING CLOSED at runtime: every method throws CodexNotImplementedError.
 * Zero fake turns, zero network, zero child processes. The OpenCode default
 * path (OpenCodeHarness, backend "opencode") is untouched — this package
 * exports no "opencode" backend and registers nothing globally.
 */

import type {
  AdmissionReceipt,
  CodingHarness,
  ExecutionRecord,
  ModelRef,
  NativeAgentInfo,
  PermissionRule,
  SessionSnapshot,
  SubmitTurnRequest,
  TurnOutcome,
} from "../../adapter-opencode/src/port.js";

/** Stable machine-readable marker: Codex transport has no verified backend. */
export const CODEX_NOT_IMPLEMENTED = "CODEX_NOT_IMPLEMENTED" as const;

/**
 * Thrown by every CodexHarness method. `code` is stable for programmatic
 * fail-closed detection; `missing` names the unverified capability.
 */
export class CodexNotImplementedError extends Error {
  readonly code = CODEX_NOT_IMPLEMENTED;
  readonly missing: string;

  constructor(missing: string) {
    super(
      `[${CODEX_NOT_IMPLEMENTED}] Codex adapter not implemented: ${missing}. ` +
        `See packages/adapter-codex/README.md (M7-02 probe: NOT VERIFIED). ` +
        `No turn was admitted, queued, or executed.`,
    );
    this.name = "CodexNotImplementedError";
    this.missing = missing;
  }
}

/**
 * Fail-closed Codex harness candidate. Satisfies the CodingHarness TYPE so
 * port-shape compatibility is compile-checked, but every call fails closed.
 * Constructing it performs no I/O and spawns nothing.
 */
export class CodexHarness implements CodingHarness {
  readonly backend = "codex" as const;

  async createSession(_title: string, _directory: string): Promise<{ sessionId: string }> {
    throw new CodexNotImplementedError("verified thread/start session-identity binding");
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    void sessionId;
    throw new CodexNotImplementedError("verified session-snapshot verb (hasLiveExecution/knownTerminalExternalIds)");
  }

  async switchAgent(_sessionId: string, _agentId: string): Promise<void> {
    throw new CodexNotImplementedError("verified switchAgent verb (no agent-switch in app-server schema 0.167.0)");
  }

  async switchModel(_sessionId: string, _model: ModelRef): Promise<void> {
    throw new CodexNotImplementedError("verified switchModel verb + ModelRef->Codex model mapping");
  }

  async submitTurn(request: SubmitTurnRequest): Promise<AdmissionReceipt> {
    void request;
    throw new CodexNotImplementedError("verified queue-only submitTurn verb (experimental turn/start is not stable)");
  }

  async interrupt(sessionId: string): Promise<TurnOutcome> {
    void sessionId;
    throw new CodexNotImplementedError("verified interrupt verb with observed terminal outcome");
  }

  async wait(sessionId: string, _signal: AbortSignal): Promise<ExecutionRecord> {
    void sessionId;
    throw new CodexNotImplementedError("verified completion-signal verb (reconciled via getSession)");
  }

  async applyPermissionRules(_sessionId: string, _rules: readonly PermissionRule[]): Promise<void> {
    throw new CodexNotImplementedError("verified permission-rules verb");
  }

  async listAgents(): Promise<readonly NativeAgentInfo[]> {
    throw new CodexNotImplementedError("verified listAgents verb with effective models/permissions");
  }
}
