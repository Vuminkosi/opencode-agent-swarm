/**
 * M1-03 volatile event bridge — SSE subscription + overlap analysis.
 *
 * Talks ONLY to the verified 2.2.7 `event.subscribe` surface
 * (GET /api/event SSE; verified type enum from the live 2.2.7 OpenAPI spec,
 * saved to the disposable probe dir). The stream is explicitly VOLATILE
 * (overflow / disconnect drops); durability lives in the daemon journal +
 * `getSession` snapshots, never here. Reconnect callers MUST reconcile via
 * `SessionManager.getSession` before any state transition (probe 08).
 *
 * Dependency-free (fetch + DOM globals only); no node: imports so the file
 * typechecks under packages/adapter-opencode/tsconfig.json.
 */

import type { HarnessEvent } from "./port.js";
import type { OpenCodeTransport } from "./sessions.js";

/**
 * Verified 2.2.7 event types relevant to the harness. Full enum in the
 * disposable openapi-2.2.7.json; only the subset the daemon reconciles is
 * subscribed by default. [OC2-REST: event.subscribe]
 */
export const HARNESS_EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "permission.asked",
  "permission.replied",
  "session.usage.updated",
  "session.status",
  "session.idle",
  "session.agent.selected",
  "session.model.selected",
] as const;

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[number];

/** Terminal execution types → port-level outcome. [OC2-REST] */
export const TERMINAL_EXECUTION_TYPES = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

export function executionOutcomeFor(type: string): "succeeded" | "failed" | "interrupted" | null {
  if (type === "session.execution.succeeded") return "succeeded";
  if (type === "session.execution.failed") return "failed";
  if (type === "session.execution.interrupted") return "interrupted";
  return null;
}

interface RawSseEvent {
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Map a raw SSE envelope to a port HarnessEvent. Returns null for envelopes
 * without a session (global events) or unparseable payloads — the caller
 * keeps them for diagnostics, never for transitions. `nativeExecutionId` is
 * best-effort: carried when the backend exposes an execution/message id in
 * the payload, else null (probe 07 to confirm the exact correlation id).
 * [DESIGN]
 */
export function toHarnessEvent(raw: RawSseEvent, receivedAt: string): HarnessEvent | null {
  const props = raw.properties;
  const sessionId =
    asString(props["sessionID"]) ?? asString(asRecord(props["session"])?.["id"]) ?? asString(props["sessionId"]);
  if (sessionId === null) return null;
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      payload[key] = String(value);
    }
  }
  const nativeExecutionId =
    asString(props["executionID"]) ??
    asString(props["executionId"]) ??
    asString(asRecord(asRecord(props["message"])?.["id"])?.["id"] ?? asRecord(props["message"])?.["id"]) ??
    asString(props["messageID"]) ??
    null;
  return {
    type: raw.type,
    sessionId,
    at: receivedAt,
    nativeExecutionId,
    payload,
  };
}

/** Parse one SSE frame (`event:` + `data:` lines) into type + payload. */
export function parseSseFrame(frame: string): RawSseEvent | null {
  let type = "";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (type === "") {
    // LIVE-HARNESS-FIX-E03 (F-EXEC17-01, live-observed): disposable
    // `opencode serve` 2.2.7 emits lifecycle as TYPELESS `data:` JSON
    // envelopes with an inner `type` name and ZERO `event:`-keyed lines.
    // Map those via the inner type exactly as the typed form below.
    return parseTypelessPayload(dataLines);
  }
  const text = dataLines.join("\n").trim();
  if (text === "" || text === "[DONE]") return null;
  let properties: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    const record = asRecord(parsed);
    if (record !== null && "type" in record && "properties" in record) {
      const withEnvelope = record as { readonly type?: unknown; readonly properties?: unknown };
      const inner = asRecord(withEnvelope.properties);
      return {
        type: asString(withEnvelope.type) ?? type,
        properties: inner ?? {},
      };
    }
    properties = record ?? {};
  } catch {
    return null;
  }
  return { type, properties };
}

/**
 * LIVE-HARNESS-FIX-E03: parse a typeless frame (no `event:` line) via the
 * inner `type` of its `data:` JSON payload. Returns the same RawSseEvent
 * shape as the typed form so downstream mapping (session-key extraction via
 * toHarnessEvent, subscription allowlist, onDrop diagnostics) applies
 * unchanged. Returns null for keepalive comments, empty/`[DONE]` payloads,
 * unparseable JSON, and payloads without a string inner `type` — the caller
 * reports those as `unparseable-frame` drops, exactly like before.
 */
function parseTypelessPayload(dataLines: readonly string[]): RawSseEvent | null {
  const text = dataLines.join("\n").trim();
  if (text === "" || text === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const innerType = asString(record["type"]);
  if (innerType === null || innerType === "") return null;
  const envelope = asRecord(record["properties"]);
  return { type: innerType, properties: envelope ?? record };
}

/**
 * Dropped-frame diagnostics (DEBUG-SSE-01). Volatile-stream drops are
 * otherwise silent: unparseable frames, session-less envelopes, and events
 * for unwatched sessions never reach the handler. When `onDrop` is set it is
 * invoked once per dropped frame with a running counter and the last raw
 * event type (`null` when the frame carried no parseable type). Default
 * `undefined` preserves the current behavior exactly (no filter change).
 *
 * LIVE-HARNESS-FIX-E03: `reason` distinguishes the drop class. Existing
 * callers keep working — `droppedTotal`/`lastRawType` semantics are unchanged;
 * `unknown-inner-type` is new (inner `type` outside the subscription
 * allowlist, e.g. live-observed `server.connected` on a typeless envelope).
 */
export type SseDropReason = "unparseable-frame" | "unknown-inner-type" | "sessionless-envelope" | "unwatched-session";

export interface SseDropInfo {
  readonly droppedTotal: number;
  readonly lastRawType: string | null;
  readonly reason: SseDropReason;
}

/**
 * Volatile SSE subscription. Resolves when the signal aborts; rejects only
 * on transport failure. Reconnect = call again AFTER reconciling via
 * getSession (probe 08 pattern). [OC2-REST: event.subscribe]
 */
export async function subscribeHarnessEvents(
  transport: OpenCodeTransport,
  opts: {
    readonly sessionIds: readonly string[];
    readonly types?: readonly string[];
    readonly handler: (event: HarnessEvent) => void;
    readonly signal: AbortSignal;
    readonly fetchImpl?: typeof fetch;
    readonly onDrop?: (drop: SseDropInfo) => void;
  },
): Promise<void> {
  if (opts.signal.aborted) return;
  const wanted = [...(opts.types ?? HARNESS_EVENT_TYPES)].map((t) => `types=${encodeURIComponent(t)}`).join("&");
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${transport.baseUrl}/api/event${wanted === "" ? "" : `?${wanted}`}`, {
      headers: { accept: "text/event-stream" },
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal.aborted) return;
    throw err;
  }
  if (!res.ok || res.body === null) {
    throw new Error(`Event stream subscription failed (http ${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const watch = new Set(opts.sessionIds);
  let buf = "";
  // LIVE-HARNESS-FIX-E03: the subscription allowlist (query `types=` above)
  // applies equally to typed and typeless frames — same vocabulary, same
  // onDrop diagnostics. Unknown inner types are reported drops, never silent
  // and never mapped.
  const allowed = new Set<string>(opts.types ?? HARNESS_EVENT_TYPES);
  // DEBUG-SSE-01: dropped frames are otherwise silent (a blackout looks like
  // "no events"). Count every drop and report the last raw type through the
  // optional onDrop hook; diagnostics must never break the stream.
  let droppedTotal = 0;
  const noteDrop = (lastRawType: string | null, reason: SseDropReason): void => {
    droppedTotal += 1;
    try {
      opts.onDrop?.({ droppedTotal, lastRawType, reason });
    } catch {
      /* drop diagnostics stay best-effort */
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const raw = parseSseFrame(frame);
        if (raw === null) {
          noteDrop(null, "unparseable-frame");
          continue;
        }
        if (!allowed.has(raw.type)) {
          noteDrop(raw.type, "unknown-inner-type");
          continue;
        }
        const mapped = toHarnessEvent(raw, new Date().toISOString());
        if (mapped === null) {
          noteDrop(raw.type, "sessionless-envelope");
          continue;
        }
        if (!watch.has(mapped.sessionId)) {
          noteDrop(raw.type, "unwatched-session");
          continue;
        }
        opts.handler(mapped);
      }
      if (opts.signal.aborted) break;
    }
  } catch (err) {
    if (opts.signal.aborted) return;
    throw err;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** Overlap proof for M1-03 acceptance: open intervals must intersect. [DESIGN] */
export function executionsOverlap(
  a: { readonly startedAt: string; readonly terminalAt: string | null },
  b: { readonly startedAt: string; readonly terminalAt: string | null },
): boolean {
  const aStart = Date.parse(a.startedAt);
  const bStart = Date.parse(b.startedAt);
  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return false;
  const aEnd = a.terminalAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.terminalAt);
  const bEnd = b.terminalAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.terminalAt);
  if (Number.isNaN(aEnd) || Number.isNaN(bEnd)) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** Disposable-dir guard: raw captures may ONLY land under the disposable root. [DESIGN] */
export function assertDisposableCapturePath(path: string, disposableRoot: string): void {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const root = disposableRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!normalized.startsWith(`${root}/`) && normalized !== root) {
    throw new Error(`Capture refused: ${path} is outside the disposable dir ${disposableRoot}`);
  }
}

/** Render raw event payloads for probe-07-style capture (caller writes the file). [DESIGN] */
export function formatRawCapture(events: readonly HarnessEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}
