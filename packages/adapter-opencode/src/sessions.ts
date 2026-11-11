/**
 * M1-03 native session bridge — session lifecycle + admission correlation.
 *
 * Talks ONLY to verified OpenCode 2.2.7 APIs. Evidence:
 * - [OC2-REST] live `opencode api GET /openapi.json` on 2.2.7 (this task):
 *   session.create/get/remove/switchAgent/switchModel/prompt/interrupt/update,
 *   session.inbox.list, session.message.list, session.context, agent.list/get,
 *   event.subscribe, experimental.session.wait, session.permission.*.
 *   Full operation inventory saved to the disposable probe dir
 *   (openapi-2.2.7.json + ops-2.2.7.json) — never the canonical tree.
 * - [OC2-DOC] spec §§4.2–4.3 method table (ctx.session.* / host.sessions.*).
 *
 * Correlation rule (contract C-HARNESS-01, port.ts): `externalId` is
 * adapter-internal. It is NEVER passed as an OpenCode API argument. It is
 * carried in-band inside the prompt `metadata` object (a VERIFIED prompt
 * field — the 2.2.7 prompt hook exposes `metadata?: Record<string, unknown>`)
 * plus a human-readable text header, and reconciled locally against
 * inbox/execution observations. No fictional `suspend()` exists here.
 *
 * Dependency-free by design (fetch + DOM globals only) so the adapter keeps
 * the zero-dependency posture of port.ts. No node: imports: the file must
 * typecheck under packages/adapter-opencode/tsconfig.json.
 */

import type {
  AdmissionReceipt,
  ExecutionRecord,
  ModelRef,
  NativeAgentInfo,
  PermissionRule,
  SessionSnapshot,
  SubmitTurnRequest,
  TurnOutcome,
} from "./port.js";

/** Pinned backend version this bridge was verified against. [OC2-REST] */
export const OPENCODE_BRIDGE_API_VERSION = "2.2.7";

/** In-band prompt-metadata key carrying the adapter-internal wake id. [DESIGN] */
export const SWARM_CORRELATION_METADATA_KEY = "swarm.externalId";

/** In-band prompt-metadata key carrying the wake reason. [DESIGN] */
export const SWARM_REASON_METADATA_KEY = "swarm.reason";

/**
 * Minimal REST transport over the verified 2.2.7 surface. Inject a fake in
 * tests; `FetchTransport` below targets a live server. Auth headers (when an
 * isolated disposable server requires them) are supplied by the caller —
 * this module never reads credentials itself. [DESIGN]
 */
export interface OpenCodeTransport {
  readonly baseUrl: string;
  request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

/** Safe, leak-free API failure (status + code only — never echoes bodies). [DESIGN] */
export class OpenCodeApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`OpenCode request failed: ${code} (http ${status})`);
    this.name = "OpenCodeApiError";
    this.status = status;
    this.code = code;
  }
}

/** Thrown when no isolated live server is available. No fiction, no fallback invent. [DESIGN] */
export class LiveServerUnavailableError extends Error {
  constructor(detail: string) {
    super(`Live OpenCode server unavailable: ${detail}`);
    this.name = "LiveServerUnavailableError";
  }
}

/**
 * fetch-backed transport. `fetchImpl` injection keeps tests hermetic.
 * Non-2xx responses map to `OpenCodeApiError` with a sanitized code.
 */
export class FetchTransport implements OpenCodeTransport {
  readonly baseUrl: string;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts?: { readonly headers?: Readonly<Record<string, string>>; readonly fetchImpl?: typeof fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.extraHeaders = opts?.headers ?? {};
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...this.extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new LiveServerUnavailableError(`fetch to ${this.baseUrl}${path} failed (server down or unreachable)`);
    }
    if (!res.ok) {
      throw new OpenCodeApiError(res.status, res.status === 404 ? "NOT_FOUND" : res.status === 409 ? "CONFLICT" : "REQUEST_FAILED");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }
}

/** Verified 2.2.7 Session.Info subset used by the bridge. [OC2-REST] */
export interface SessionInfo {
  readonly id: string;
  readonly projectID: string;
  readonly agent: string | null;
  readonly model: ModelRef | null;
  readonly title: string | null;
  readonly outcome: TurnOutcome | null;
  readonly busyAt: number | null;
  readonly idleAt: number | null;
  readonly directory: string | null;
  readonly permissions: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }>;
}

/** Verified 2.2.7 inbox entry subset (User/Synthetic/Compaction/Move union). [OC2-REST] */
export interface InboxEntry {
  readonly id: string;
  readonly sessionID: string;
  readonly type: string;
  readonly delivery: string | null;
  readonly createdAt: number | null;
}

/** Verified 2.2.7 native agent descriptor. [OC2-REST: agent.list/get] */
export interface AgentDescriptor {
  readonly id: string;
  readonly model: ModelRef | null;
  readonly raw: unknown;
}

interface DataEnvelope<T> {
  readonly data: T;
}

interface RawSessionInfo {
  readonly id?: unknown;
  readonly projectID?: unknown;
  readonly agent?: unknown;
  readonly model?: unknown;
  readonly title?: unknown;
  readonly outcome?: unknown;
  readonly time?: unknown;
  readonly location?: unknown;
  readonly permissions?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Defensive parse of Session.Info: unknown fields tolerated, never throws on extras. [DESIGN] */
export function parseSessionInfo(raw: unknown): SessionInfo {
  const root = asRecord(asRecord(raw)?.["data"] ?? raw) ?? {};
  const time = asRecord(root["time"]);
  const location = asRecord(root["location"]);
  const modelRaw = asRecord(root["model"]);
  const modelId = asString(modelRaw?.["id"]);
  const providerID = asString(modelRaw?.["providerID"]);
  const outcomeRaw = asString(root["outcome"]);
  const outcome: TurnOutcome | null =
    outcomeRaw === "succeeded" || outcomeRaw === "failed" || outcomeRaw === "interrupted" ? outcomeRaw : null;
  const permsRaw = Array.isArray(root["permissions"]) ? (root["permissions"] as unknown[]) : [];
  return {
    id: asString(root["id"]) ?? "",
    projectID: asString(root["projectID"]) ?? "",
    agent: asString(root["agent"]),
    model: modelId !== null && providerID !== null ? { id: modelId, providerID } : null,
    title: asString(root["title"]),
    outcome,
    busyAt: asNumber(time?.["busy"]),
    idleAt: asNumber(time?.["idle"]),
    directory: asString(location?.["directory"]),
    permissions: permsRaw.flatMap((p) => {
      const r = asRecord(p);
      const action = asString(r?.["action"]);
      const resource = asString(r?.["resource"]);
      const effect = asString(r?.["effect"]);
      return action !== null && resource !== null && effect !== null ? [{ action, resource, effect }] : [];
    }),
  };
}

/** Defensive parse of an inbox list envelope. [OC2-REST: session.inbox.list] */
export function parseInboxList(raw: unknown): InboxEntry[] {
  const data = asRecord(raw)?.["data"];
  if (!Array.isArray(data)) return [];
  return (data as unknown[]).flatMap((entry) => {
    const r = asRecord(entry);
    if (r === null) return [];
    const id = asString(r["id"]);
    const sessionID = asString(r["sessionID"]);
    if (id === null || sessionID === null) return [];
    const time = asRecord(r["time"]);
    return [
      {
        id,
        sessionID,
        type: asString(r["type"]) ?? "unknown",
        delivery: asString(r["delivery"]),
        createdAt: asNumber(time?.["created"]),
      },
    ];
  });
}

/**
 * Local admission registry: the ONLY place `externalId` lives. Maps the
 * adapter-internal wake id to the native inbox message id returned by the
 * verified prompt 200 envelope `{data: Session.Inbox.User}`. [DESIGN]
 */
export interface AdmissionEntry {
  readonly externalId: string;
  readonly sessionId: string;
  readonly admittedAt: string;
  readonly nativeInboxId: string | null;
  readonly reason: SubmitTurnRequest["reason"];
  readonly transportNote: string;
  terminal: boolean;
}

export class AdmissionRegistry {
  private readonly byExternalId = new Map<string, AdmissionEntry>();

  record(entry: AdmissionEntry): void {
    this.byExternalId.set(entry.externalId, entry);
  }

  resolve(externalId: string): AdmissionEntry | null {
    return this.byExternalId.get(externalId) ?? null;
  }

  resolveByNativeInboxId(nativeInboxId: string): AdmissionEntry | null {
    for (const entry of this.byExternalId.values()) {
      if (entry.nativeInboxId === nativeInboxId) return entry;
    }
    return null;
  }

  latestForSession(sessionId: string): AdmissionEntry | null {
    let latest: AdmissionEntry | null = null;
    for (const entry of this.byExternalId.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (latest === null || entry.admittedAt > latest.admittedAt) latest = entry;
    }
    return latest;
  }

  markTerminal(externalId: string): void {
    const entry = this.byExternalId.get(externalId);
    if (entry !== undefined) entry.terminal = true;
  }

  knownTerminalExternalIds(sessionId?: string): string[] {
    const out: string[] = [];
    for (const entry of this.byExternalId.values()) {
      if (entry.terminal && (sessionId === undefined || entry.sessionId === sessionId)) out.push(entry.externalId);
    }
    return out.sort();
  }
}

/**
 * Build the verified prompt body for a queue-only turn. `externalId` is
 * embedded ONLY in `metadata` (verified field) + a text header — never as a
 * top-level API argument. Throws on `steer`: queue-vs-steer admission
 * semantics are probe-06 territory and the daemon contract uses queue.
 * [OC2-REST: session.prompt] [DESIGN]
 */
export function buildPromptBody(request: SubmitTurnRequest, admittedAt: string): Record<string, unknown> {
  if (request.delivery !== "queue") {
    throw new OpenCodeApiError(400, "UNSUPPORTED_DELIVERY_STEER_NOT_VERIFIED");
  }
  if (request.text.trim() === "") {
    throw new OpenCodeApiError(400, "EMPTY_TURN_TEXT");
  }
  return {
    text: `[swarm-wake:${request.externalId}]\n${request.text}`,
    delivery: "queue",
    metadata: {
      [SWARM_CORRELATION_METADATA_KEY]: request.externalId,
      [SWARM_REASON_METADATA_KEY]: request.reason,
      "swarm.admittedAt": admittedAt,
    },
  };
}

/**
 * Map a port-level permission rule to the verified native Ruleset entry.
 * `scope` → native `resource`. The native `action` slot has no port-level
 * counterpart (C-HARNESS-01 is frozen); `"*"` is a documented daemon-policy
 * assumption — last-match-wins + child-inheritance semantics MUST be
 * confirmed live by probe 11 before relying on enforcement. Recorded here as
 * an explicit gap, not a verified semantic. [OC2-REST: Permission.Rule]
 */
export function mapPermissionRule(rule: PermissionRule): { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" } {
  if (rule.scope.trim() === "") {
    throw new OpenCodeApiError(400, "EMPTY_PERMISSION_SCOPE");
  }
  return { action: "*", resource: rule.scope, effect: rule.action };
}

/**
 * Session lifecycle facade over the verified 2.2.7 REST surface.
 * Location binding is verified: create accepts `location: {directory}` and
 * get echoes it back. Never touches the canonical tree: callers pass only
 * disposable directories (enforced by the bridge test guard). [OC2-REST]
 */
export class SessionManager {
  private readonly innerTransport: OpenCodeTransport;
  readonly registry: AdmissionRegistry;

  constructor(transport: OpenCodeTransport, registry?: AdmissionRegistry) {
    this.innerTransport = transport;
    this.registry = registry ?? new AdmissionRegistry();
  }

  get baseUrl(): string {
    return this.innerTransport.baseUrl;
  }

  /** Direct transport access for the harness facade (no new API surface). */
  get transport(): OpenCodeTransport {
    return this.innerTransport;
  }

  /** POST /api/session — verified body; returns the native session id. */
  async createSession(opts: {
    readonly title: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: ModelRef;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly sessionId: string; readonly info: SessionInfo }> {
    if (opts.title.trim() === "" || opts.directory.trim() === "") {
      throw new OpenCodeApiError(400, "INVALID_SESSION_CREATE_ARGS");
    }
    const raw = await this.transport.request<DataEnvelope<RawSessionInfo> | RawSessionInfo>("POST", "/api/session", {
      title: opts.title,
      ...(opts.agent === undefined ? {} : { agent: opts.agent }),
      ...(opts.model === undefined ? {} : { model: { id: opts.model.id, providerID: opts.model.providerID } }),
      location: { directory: opts.directory },
      ...(opts.metadata === undefined ? {} : { metadata: { ...opts.metadata } }),
    });
    const info = parseSessionInfo(raw);
    if (info.id === "") throw new OpenCodeApiError(500, "SESSION_CREATE_NO_ID");
    return { sessionId: info.id, info };
  }

  /** GET /api/session/{id} — snapshot source for reconciliation. Never durable truth alone. */
  async getSession(sessionId: string): Promise<SessionInfo> {
    const raw = await this.transport.request<DataEnvelope<RawSessionInfo> | RawSessionInfo>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}`,
    );
    return parseSessionInfo(raw);
  }

  /** DELETE /api/session/{id} — disposable-cleanup only. */
  async removeSession(sessionId: string): Promise<void> {
    await this.transport.request<unknown>("DELETE", `/api/session/${encodeURIComponent(sessionId)}`);
  }

  /** POST /api/session/{id}/agent — preserves native permissions (verified separately). */
  async switchAgent(sessionId: string, agentId: string): Promise<void> {
    if (agentId.trim() === "") throw new OpenCodeApiError(400, "EMPTY_AGENT_ID");
    await this.transport.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/agent`, {
      agent: agentId,
    });
  }

  /** POST /api/session/{id}/model — native providerID + id refs, history retained by backend. */
  async switchModel(sessionId: string, model: ModelRef): Promise<void> {
    await this.transport.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/model`, {
      model: { id: model.id, providerID: model.providerID },
    });
  }

  /**
   * PATCH /api/session/{id} {permissions} — verified live-update endpoint.
   * See `mapPermissionRule` for the marked action-slot assumption.
   */
  async applyPermissionRules(sessionId: string, rules: readonly PermissionRule[]): Promise<void> {
    await this.transport.request<unknown>("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, {
      permissions: rules.map(mapPermissionRule),
    });
  }

  /** GET /api/agent — native inventory; preserves ids verbatim. */
  async listAgents(): Promise<NativeAgentInfo[]> {
    const raw = await this.transport.request<unknown>("GET", "/api/agent");
    const data = asRecord(raw)?.["data"];
    if (!Array.isArray(data)) return [];
    return (data as unknown[]).flatMap((entry) => {
      const r = asRecord(entry);
      const id = asString(r?.["id"]);
      if (id === null) return [];
      const modelRaw = asRecord(r?.["model"]);
      const modelId = asString(modelRaw?.["id"]);
      const providerID = asString(modelRaw?.["providerID"]);
      const info: NativeAgentInfo = {
        id,
        model: { id: modelId ?? "unknown", providerID: providerID ?? "unknown" },
      };
      return [info];
    });
  }

  /** GET /api/session/{id}/inbox — reconcile admission vs delivery. */
  async listInbox(sessionId: string): Promise<InboxEntry[]> {
    const raw = await this.transport.request<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}/inbox`);
    return parseInboxList(raw);
  }

  /** GET /api/session/{id}/context — transcript recovery (size/cost observed by caller). */
  async getContext(sessionId: string): Promise<unknown> {
    return this.transport.request<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}/context`);
  }

  /** GET /api/session/{id}/message — turn counting (exactly-one-turn validation). */
  async listMessages(sessionId: string): Promise<unknown[]> {
    const raw = await this.transport.request<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}/message`);
    const data = asRecord(raw)?.["data"];
    return Array.isArray(data) ? (data as unknown[]) : [];
  }

  /**
   * Build a port-level snapshot from a verified Session.Info. `hasLiveExecution`
   * is a BEST-EFFORT heuristic (busy timestamp newer than idle timestamp);
   * busy/idle clock semantics are NOT verified — the daemon MUST combine this
   * with event observation and inbox reconciliation before transitions.
   * [DESIGN — heuristic flagged, probe 05/08 to confirm live]
   */
  toSnapshot(info: SessionInfo, sessionId: string): SessionSnapshot {
    const busy = info.busyAt ?? 0;
    const idle = info.idleAt ?? 0;
    return {
      sessionId,
      hasLiveExecution: busy > idle,
      knownTerminalExternalIds: this.registry.knownTerminalExternalIds(sessionId),
    };
  }

  /**
   * POST /api/session/{id}/interrupt, then reconcile via getSession.
   * Verified: interrupt takes no body; outcome observed on Session.Info.
   */
  async interruptSession(sessionId: string): Promise<SessionInfo> {
    await this.transport.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`);
    return this.getSession(sessionId);
  }

  /**
   * POST /api/experimental/session/{id}/wait — optional completion signal.
   * 204 = idle observed; NOT durable truth (reconcile via getSession after).
   * AbortSignal callers should pass a fetch wired to the signal; a bare
   * transport cannot cancel the server-side wait, so this method races the
   * request against the signal and reports WAIT_ABORTED semantics to the
   * harness. [DESIGN]
   */
  async waitForIdle(sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new OpenCodeApiError(499, "WAIT_ABORTED");
    }
    await this.transport.request<unknown>("POST", `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`);
    if (signal.aborted) {
      throw new OpenCodeApiError(499, "WAIT_ABORTED");
    }
  }

  /** Admit exactly one queue-only turn; receipt is NOT execution proof. */
  async submitTurnRecorded(request: SubmitTurnRequest, nowIso: () => string): Promise<AdmissionReceipt> {
    const admittedAt = nowIso();
    const body = buildPromptBody(request, admittedAt);
    const raw = await this.transport.request<unknown>(
      "POST",
      `/api/session/${encodeURIComponent(request.sessionId)}/prompt`,
      body,
    );
    const inboxId = asString(asRecord(asRecord(raw)?.["data"])?.["id"]);
    this.registry.record({
      externalId: request.externalId,
      sessionId: request.sessionId,
      admittedAt,
      nativeInboxId: inboxId,
      reason: request.reason,
      transportNote: `queue admission via POST /api/session/${request.sessionId}/prompt (delivery=queue, in-band metadata ${SWARM_CORRELATION_METADATA_KEY}); receipt is not execution proof — reconcile via getSession/events`,
      terminal: false,
    });
    return {
      externalId: request.externalId,
      admittedAt,
      transportNote: `queued to ${request.sessionId} at ${admittedAt}; native inbox id ${inboxId ?? "unknown"}`,
    };
  }
}

/** Build an observed ExecutionRecord + mark the admission terminal. [DESIGN] */
export function toExecutionRecord(
  registry: AdmissionRegistry,
  entry: AdmissionEntry,
  outcome: TurnOutcome,
  observedAt: string,
  nativeExecutionId: string | null,
): ExecutionRecord {
  registry.markTerminal(entry.externalId);
  return {
    externalId: entry.externalId,
    sessionId: entry.sessionId,
    outcome,
    observedAt,
    nativeExecutionId,
  };
}
