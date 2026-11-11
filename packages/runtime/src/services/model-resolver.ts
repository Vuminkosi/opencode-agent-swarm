/**
 * MODEL-INHERIT-01 model inheritance resolver — production precedence for
 * swarm worker models (contracts C-PROTOCOL-01 / C-DB-01 / C-HARNESS-01).
 *
 * Production precedence (highest first):
 *   1. explicit member override (`ActivateSwarmInput.model`),
 *   2. native agent model assignment (verified `GET /api/agent` model field,
 *      supplied by the caller — this module never modifies agent definitions),
 *   3. active session model (verified `GET /api/session/{id}` model field,
 *      supplied by the caller),
 *   4. host default model (daemon-config supplied ONLY when no active model
 *      exists — there is NO hardcoded production default in this file).
 *
 * Verified OpenCode 2.2.7 interfaces actually used for model data:
 *   - `GET /api/session/{id}` -> `Session.Info.model { id, providerID }`
 *     (parsed by `SessionManager.getSession` / `parseSessionInfo` in
 *     `packages/adapter-opencode/src/sessions.ts`).
 *   - `GET /api/agent` -> `AgentDescriptor[].model { id, providerID }`
 *     (parsed by `SessionManager.listAgents`).
 *   - `POST /api/session/{id}/model` with `{ model: { id, providerID } }`
 *     (explicit switch only, via `SessionManager.switchModel` — history is
 *     retained by the backend per the bridge comment; Q-06 history-retention
 *     semantics remain a live probe, NOT asserted here).
 *   - Host default: NO verified dedicated endpoint was found in the 2.2.7
 *     surface for "the host default model". The `hostDefaultModel` input is
 *     therefore caller-supplied (daemon config) and optional. A missing host
 *     default with no higher-precedence source is UNRESOLVABLE (fail closed),
 *     never defaulted. [NOT VERIFIED — probe]
 *
 * Trust boundary (credentials):
 *   - The daemon holds ONLY `{ providerID, id }` refs (persisted on members,
 *     carried in wake payloads/logs). It NEVER holds, copies, logs, or
 *     persists provider API keys.
 *   - The host (OpenCode server) resolves the matching existing credentials
 *     at execution time. Reuse of existing host auth is structural: this
 *     module has no auth input, no env access, and no transport — there is
 *     no channel through which a key could enter.
 *   - Production code (this file + `swarm-service.ts`) NEVER reads
 *     `SWARM_ALLOW_LIVE_INFERENCE`, `LIVE_MODEL`, or `LIVE_MODEL_APIKey`.
 *     Those names appear ONLY in the isolated harness
 *     (`scripts/live-cd-harness.ts`) and in tests asserting they are ignored.
 *     A `grep LIVE_MODEL packages/runtime/src` must return no production hit
 *     outside test files.
 *
 * Failure discipline: every resolution failure throws `ModelResolutionError`
 * with `retryable: false` (blocked/quota paths never retry — the M2
 * dispatcher already quota-pauses on 402 with zero auto-retry). There is no
 * silent fallback: an unresolvable combo throws instead of substituting a
 * placeholder (the old `{ inherit, lead-model }` placeholder is deleted).
 */

import type { ModelRef } from "@opencode-swarm/protocol";

/** Where a resolved worker model came from (precedence order). */
export type ModelSource =
  | "member-override"
  | "native-agent"
  | "active-session"
  | "host-default"
  | "explicit-reconfigure";

/** Caller-supplied model context. Every field is a pure `{providerID,id}`
 *  ref — never credentials. Sources are READS of verified OpenCode state
 *  performed by the caller (daemon/plugin layer); this module only orders
 *  them. Omitted/invalid fields are treated as absent (except an explicit
 *  member override, which is validated strictly and throws when malformed). */
export interface ModelResolutionContext {
  readonly memberOverride?: unknown;
  readonly nativeAgentModel?: unknown;
  readonly activeSessionModel?: unknown;
  readonly hostDefaultModel?: unknown;
}

export interface ResolvedModel {
  readonly model: ModelRef;
  readonly source: ModelSource;
  /** Credentials are ALWAYS the host's existing auth, resolved at execution
   *  time. The daemon performs no auth of its own for inference. */
  readonly authReuse: "host-existing";
  /** Model switches go through the explicit verified switch endpoint only;
   *  wake/dispatch never re-resolves or silently resets the stored model. */
  readonly historyPreserved: true;
}

export type ModelResolutionErrorCode =
  | "MODEL_UNRESOLVABLE"
  | "MODEL_OVERRIDE_INVALID"
  | "AUTH_UNAVAILABLE";

/** Fail-closed resolution failure. NEVER retried: callers must block (auth)
 *  or pause (quota, handled by the M2 dispatcher) rather than re-attempt. */
export class ModelResolutionError extends Error {
  readonly code: ModelResolutionErrorCode;
  readonly retryable = false as const;
  constructor(code: ModelResolutionErrorCode, message: string) {
    super(message);
    this.name = "ModelResolutionError";
    this.code = code;
  }
}

function isValidModelRef(value: unknown): value is ModelRef {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["providerID"] === "string" &&
    (rec["providerID"] as string).length > 0 &&
    typeof rec["id"] === "string" &&
    (rec["id"] as string).length > 0
  );
}

function cleanRef(value: unknown): ModelRef {
  const rec = value as Record<string, unknown>;
  return {
    providerID: rec["providerID"] as string,
    id: rec["id"] as string,
  };
}

/**
 * Resolve one worker model by production precedence. Pure: no env access, no
 * I/O, no inference. Throws `ModelResolutionError` (retryable=false) when no
 * valid source exists — never a placeholder, never an env fallback.
 */
export function resolveWorkerModel(ctx: ModelResolutionContext): ResolvedModel {
  if (ctx.memberOverride !== undefined && ctx.memberOverride !== null) {
    if (!isValidModelRef(ctx.memberOverride)) {
      throw new ModelResolutionError(
        "MODEL_OVERRIDE_INVALID",
        "Explicit member model override is malformed (expected { providerID, id } with non-empty strings); refusing to fall back silently",
      );
    }
    return {
      model: cleanRef(ctx.memberOverride),
      source: "member-override",
      authReuse: "host-existing",
      historyPreserved: true,
    };
  }
  if (isValidModelRef(ctx.nativeAgentModel)) {
    return {
      model: cleanRef(ctx.nativeAgentModel),
      source: "native-agent",
      authReuse: "host-existing",
      historyPreserved: true,
    };
  }
  if (isValidModelRef(ctx.activeSessionModel)) {
    return {
      model: cleanRef(ctx.activeSessionModel),
      source: "active-session",
      authReuse: "host-existing",
      historyPreserved: true,
    };
  }
  if (isValidModelRef(ctx.hostDefaultModel)) {
    return {
      model: cleanRef(ctx.hostDefaultModel),
      source: "host-default",
      authReuse: "host-existing",
      historyPreserved: true,
    };
  }
  throw new ModelResolutionError(
    "MODEL_UNRESOLVABLE",
    "No worker model resolvable (member override, native agent model, active session model, and host default are all absent); refusing placeholder fallback",
  );
}

/**
 * Wake-path model rule: a wake REUSES the member's stored model verbatim
 * (session continuity across wakes). A change requires an explicit
 * `reconfigureTo` — the caller must then apply it through the verified
 * `POST /api/session/{id}/model` endpoint (history retained by backend),
 * never by silent reassignment. Returns the stored ref unchanged otherwise.
 */
export function resolveWakeModel(
  stored: ModelRef,
  opts?: { readonly reconfigureTo?: unknown },
): ResolvedModel {
  if (opts?.reconfigureTo !== undefined && opts.reconfigureTo !== null) {
    if (!isValidModelRef(opts.reconfigureTo)) {
      throw new ModelResolutionError(
        "MODEL_OVERRIDE_INVALID",
        "Explicit wake reconfigure model is malformed (expected { providerID, id }); stored model retained",
      );
    }
    return {
      model: cleanRef(opts.reconfigureTo),
      source: "explicit-reconfigure",
      authReuse: "host-existing",
      historyPreserved: true,
    };
  }
  return {
    model: { providerID: stored.providerID, id: stored.id },
    source: "active-session",
    authReuse: "host-existing",
    historyPreserved: true,
  };
}

/**
 * Transport-status classifiers shared with the daemon lanes. Resolution and
 * admission failures on these statuses are terminal for the attempt:
 * blocked (auth) or quota-paused (402) with ZERO retries. Transient
 * transport errors (429/5xx/timeout) remain the dispatcher's bounded
 * backoff domain — they are NOT auth/quota and must never be confused
 * with them (a 402 is never retried as if transient).
 */
export function isQuotaStatus(status: unknown): boolean {
  return status === 402 || status === "402";
}

export function isAuthBlockedStatus(status: unknown): boolean {
  return status === 401 || status === 403 || status === "401" || status === "403";
}

/** Resolution/credential failures are never retried: blocked, not queued. */
export function resolutionRetryPolicy(): "no-retry" {
  return "no-retry";
}
