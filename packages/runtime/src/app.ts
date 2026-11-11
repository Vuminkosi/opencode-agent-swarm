/**
 * Daemon HTTP application — M1-02 (contracts C-DAEMON-01, C-PROTOCOL-01).
 *
 * Loopback-authenticated Bun transport over the M1-01 `SwarmStore`
 * (imported, never duplicated). Implements the spec §5 endpoint table:
 *
 *   POST /v1/swarms                      create swarm
 *   GET  /v1/swarms/:id                   snapshot (swarm + members + tasks)
 *   POST /v1/swarms/:id/members           add named member
 *   POST /v1/swarms/:id/tasks             create task
 *   POST /v1/swarms/:id/posts             append board post (transactional)
 *   GET  /v1/swarms/:id/posts?after=&limit=  board replay (JSON; SSE on
 *                                         Accept: text/event-stream)
 *   POST /v1/swarms/:id/pause|resume|cancel  lifecycle intents
 *   POST /v1/swarms/:id/events/ingest     OpenCode event ingress (deduped)
 *   GET  /v1/swarms/:id/events/stream?after= SSE board projections
 *   GET  /healthz                         liveness (unauthenticated)
 *
 * Guards: bearer token on every /v1/* route (401, no body sniffing before
 * auth), 1 MiB request cap (413), origin restriction (403 for
 * non-loopback Origin). Errors use the safe public shape
 * `{error:{code,message}}` — never stack traces, SQL, or file paths.
 * SSE reconnects replay exactly from `getPostsAfter(swarmId, after)`.
 */
import {
  AddMemberInputSchema,
  AppendPostInputSchema,
  CreateSwarmInputSchema,
  CreateTaskInputSchema,
  ProtocolError,
  SCHEMA_VERSION,
  type AddMemberInput,
  type AppendPostInput,
  type BoardPost,
  type CreateSwarmInput,
  type CreateTaskInput,
} from "@opencode-swarm/protocol";
import { z } from "zod";
import { PROTOCOL_VERSION, isLoopbackHost } from "./config.js";
import type { SwarmStore } from "./db/store.js";
import { BroadcastHub } from "./services/broadcast.js";
import { EventIngest } from "./services/ingest.js";
import { SwarmLifecycle } from "./services/lifecycle.js";

export const MAX_BODY_BYTES = 1024 * 1024;

const IngestBodySchema = z.object({
  source: z.string().min(1).max(128),
  externalEventId: z.string().min(1).max(256),
  type: z.string().min(1).max(128).optional(),
  payload: z.unknown().optional(),
});

export interface AppOptions {
  readonly store: SwarmStore;
  readonly lifecycle: SwarmLifecycle;
  readonly ingest: EventIngest;
  readonly token: string;
  readonly hub?: BroadcastHub;
}

interface RouteContext {
  readonly store: SwarmStore;
  readonly lifecycle: SwarmLifecycle;
  readonly ingest: EventIngest;
  readonly token: string;
  readonly hub: BroadcastHub;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function publicError(code: string, message: string): Response {
  return json(statusForCode(code), { error: { code, message } });
}

function statusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
      return 400;
    case "BODY_TOO_LARGE":
      return 413;
    case "INVALID_TRANSITION":
    case "DUPLICATE_NAME":
    case "KILLED_MEMBER":
    case "STALE_GENERATION":
    case "LIVE_TURN_ACTIVE":
    case "DAG_CYCLE":
    case "SELF_DEP":
    case "UNKNOWN_DEP":
      return 409;
    case "SELF_ACCEPT":
    case "AMBIGUOUS_MENTION":
    case "UNKNOWN_MENTION":
      return 422;
    default:
      return 500;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function checkAuth(req: Request, token: string): boolean {
  const header = req.headers.get("authorization");
  if (header === null) return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match === null || match[1] === undefined) return false;
  return timingSafeEqual(match[1], token);
}

/** Reject browser-driven cross-origin calls from non-loopback origins. */
function checkOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null || origin.trim() === "") return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return isLoopbackHost(host);
}

async function readCappedBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return { ok: false, response: publicError("BODY_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes`) };
  }
  if (req.body === null) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return { ok: false, response: publicError("BODY_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes`) };
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

function parseQueryPositiveInt(value: string | null, name: string, max: number): number {
  if (value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ProtocolError("VALIDATION_FAILED", `Invalid query parameter ${name}`, { [name]: value });
  }
  return parsed;
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

function encodeEvent(event: string, data: string): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`);
}

/** SSE page size for board replay; paged loop runs to the high-water mark. */
const REPLAY_PAGE_SIZE = 200;

/**
 * SSE board projection: replay committed posts after `after`, announce
 * readiness, then stream live appends. Durability comes from the journal;
 * the hub only wakes this connection.
 *
 * Race safety: subscribe-to-buffer FIRST, then run the paged replay, then
 * flush buffered posts beyond the replay high-water mark before flipping
 * to live forwarding. A post committed between subscribe and replay
 * appears in both the buffer and the replay page — flush dedupes by id —
 * so no committed post is lost and none is delivered twice.
 */
function streamBoard(ctx: RouteContext, swarmId: string, after: number): Response {
  try {
    ctx.store.getSwarm(swarmId);
  } catch (err) {
    return mapError(err);
  }
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string): void => {
        controller.enqueue(encodeEvent(event, data));
      };
      const buffered: BoardPost[] = [];
      const seen = new Set<string>();
      let highWater = after;
      let live = false;
      // Subscribe BEFORE replay: closes the connect race (a post committed
      // after this point is either in the replay pages or in `buffered`).
      unsubscribe = ctx.hub.subscribe(swarmId, (post: BoardPost) => {
        if (live) {
          try {
            if (post.sequence > highWater) send("post", JSON.stringify(post));
          } catch {
            /* client gone; cancel() below cleans up */
          }
        } else {
          buffered.push(post);
        }
      });
      try {
        // Paged replay to the high-water mark (no 100-row default cap).
        let cursor = after;
        for (;;) {
          const page = ctx.store.getPostsAfter(swarmId, cursor, REPLAY_PAGE_SIZE);
          for (const post of page) {
            send("post", JSON.stringify(post));
            seen.add(post.id);
            if (post.sequence > highWater) highWater = post.sequence;
          }
          if (page.length === 0) break;
          const last = page[page.length - 1];
          if (last === undefined || page.length < REPLAY_PAGE_SIZE) break;
          cursor = last.sequence;
        }
        const replayHigh = highWater;
        send("ready", JSON.stringify({ swarmId, after: replayHigh }));
        // Flush posts committed during replay; dedupe by id against replay.
        for (const post of buffered) {
          if (post.sequence > replayHigh && !seen.has(post.id)) {
            send("post", JSON.stringify(post));
            seen.add(post.id);
            if (post.sequence > highWater) highWater = post.sequence;
          }
        }
        live = true;
      } catch (err) {
        if (unsubscribe !== undefined) {
          try {
            unsubscribe();
          } catch {
            /* ignore */
          }
          unsubscribe = undefined;
        }
        // Safe error frame: generic message only; detail stays server-side.
        console.error(`[daemon] board replay failed swarm=${swarmId} after=${after}`, err);
        send("error", JSON.stringify({ code: "REPLAY_FAILED", message: "Board replay failed" }));
        controller.close();
        return;
      }
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        } catch {
          /* client gone */
        }
      }, 15000);
    },
    cancel() {
      if (unsubscribe !== undefined) unsubscribe();
      if (heartbeat !== undefined) clearInterval(heartbeat);
    },
  });
  return new Response(stream, { status: 200, headers: sseHeaders() });
}

function mapError(err: unknown): Response {
  if (err instanceof ProtocolError) {
    return publicError(err.code, err.message);
  }
  return publicError("INTERNAL", "Internal daemon error");
}

async function handleRequest(req: Request, ctx: RouteContext): Promise<Response> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return publicError("VALIDATION_FAILED", "Invalid request URL");
  }
  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (method === "GET" && pathname === "/healthz") {
    return json(200, { status: "ok", schemaVersion: SCHEMA_VERSION, protocolVersion: PROTOCOL_VERSION });
  }

  if (!pathname.startsWith("/v1/")) {
    return publicError("NOT_FOUND", `Unknown route ${pathname}`);
  }

  if (!checkAuth(req, ctx.token)) {
    return json(401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" } });
  }
  if (!checkOrigin(req)) {
    return json(403, { error: { code: "FORBIDDEN_ORIGIN", message: "Non-loopback Origin rejected" } });
  }

  const segments = pathname.split("/").filter((s) => s.length > 0);
  // segments: ["v1", "swarms", ...]
  if (segments.length < 2 || segments[0] !== "v1" || segments[1] !== "swarms") {
    return publicError("NOT_FOUND", `Unknown route ${pathname}`);
  }

  try {
    // POST /v1/swarms
    if (method === "POST" && segments.length === 2) {
      const body = await readCappedBody(req);
      if (!body.ok) return body.response;
      let parsed: CreateSwarmInput;
      try {
        parsed = CreateSwarmInputSchema.parse(body.text === "" ? {} : JSON.parse(body.text));
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        throw new ProtocolError("VALIDATION_FAILED", "Invalid swarm input", {});
      }
      const swarm = ctx.store.createSwarm(parsed);
      return json(201, { swarm });
    }

    const swarmId = segments[2];
    if (swarmId === undefined || swarmId === "") {
      return publicError("NOT_FOUND", `Unknown route ${pathname}`);
    }
    const rest = segments.slice(3);

    // GET /v1/swarms/:id
    if (method === "GET" && rest.length === 0) {
      const swarm = ctx.store.getSwarm(swarmId);
      const members = ctx.store.listMembers(swarmId);
      const tasks = ctx.store.listTasks(swarmId);
      return json(200, { swarm, members, tasks });
    }

    // POST /v1/swarms/:id/members
    if (method === "POST" && rest.length === 1 && rest[0] === "members") {
      const body = await readCappedBody(req);
      if (!body.ok) return body.response;
      let parsed: AddMemberInput;
      try {
        parsed = AddMemberInputSchema.parse(JSON.parse(body.text));
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        throw new ProtocolError("VALIDATION_FAILED", "Invalid member input", {});
      }
      const member = ctx.store.addMember(swarmId, parsed);
      return json(201, { member });
    }

    // POST /v1/swarms/:id/tasks
    if (method === "POST" && rest.length === 1 && rest[0] === "tasks") {
      const body = await readCappedBody(req);
      if (!body.ok) return body.response;
      let parsed: CreateTaskInput;
      try {
        parsed = CreateTaskInputSchema.parse(JSON.parse(body.text));
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        throw new ProtocolError("VALIDATION_FAILED", "Invalid task input", {});
      }
      const task = ctx.store.createTask(swarmId, parsed);
      return json(201, { task });
    }

    // POST /v1/swarms/:id/posts  +  GET replay (JSON or SSE via Accept)
    if (rest.length === 1 && rest[0] === "posts") {
      if (method === "POST") {
        const body = await readCappedBody(req);
        if (!body.ok) return body.response;
        let parsed: AppendPostInput;
        try {
          parsed = AppendPostInputSchema.parse(JSON.parse(body.text));
        } catch (err) {
          if (err instanceof ProtocolError) throw err;
          throw new ProtocolError("VALIDATION_FAILED", "Invalid post input", {});
        }
        const result = ctx.store.appendPost(swarmId, parsed);
        if (!result.deduped) ctx.hub.publish(swarmId, result.post);
        return json(201, { post: result.post, deduped: result.deduped, wakeIds: result.wakeIds });
      }
      if (method === "GET") {
        const after = parseQueryPositiveInt(url.searchParams.get("after"), "after", Number.MAX_SAFE_INTEGER);
        const wantsSse = (req.headers.get("accept") ?? "").includes("text/event-stream");
        if (wantsSse) return streamBoard(ctx, swarmId, after);
        ctx.store.getSwarm(swarmId);
        const limit = parseQueryPositiveInt(url.searchParams.get("limit") ?? "100", "limit", 1000);
        const posts = ctx.store.getPostsAfter(swarmId, after, limit === 0 ? 100 : limit);
        return json(200, { posts, after });
      }
    }

    // POST /v1/swarms/:id/pause | resume | cancel
    if (method === "POST" && rest.length === 1 && (rest[0] === "pause" || rest[0] === "resume" || rest[0] === "cancel")) {
      // No body is read for lifecycle intents, but the capped drain still
      // applies so an oversized body is rejected with 413, not ignored.
      const drained = await readCappedBody(req);
      if (!drained.ok) return drained.response;
      const action = rest[0] as "pause" | "resume" | "cancel";
      const swarm =
        action === "pause"
          ? ctx.lifecycle.pauseSwarm(swarmId)
          : action === "resume"
            ? ctx.lifecycle.resumeSwarm(swarmId)
            : ctx.lifecycle.cancelSwarm(swarmId);
      return json(200, { swarm });
    }

    // POST /v1/swarms/:id/events/ingest
    if (method === "POST" && rest.length === 2 && rest[0] === "events" && rest[1] === "ingest") {
      const body = await readCappedBody(req);
      if (!body.ok) return body.response;
      let parsed: { source: string; externalEventId: string };
      try {
        const input = IngestBodySchema.parse(JSON.parse(body.text));
        parsed = { source: input.source, externalEventId: input.externalEventId };
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        throw new ProtocolError("VALIDATION_FAILED", "Invalid ingest input", {});
      }
      const result = ctx.ingest.record(swarmId, parsed);
      return json(200, result);
    }

    // GET /v1/swarms/:id/events/stream?after=
    if (method === "GET" && rest.length === 2 && rest[0] === "events" && rest[1] === "stream") {
      const after = parseQueryPositiveInt(url.searchParams.get("after"), "after", Number.MAX_SAFE_INTEGER);
      return streamBoard(ctx, swarmId, after);
    }

    return publicError("NOT_FOUND", `Unknown route ${pathname}`);
  } catch (err) {
    return mapError(err);
  }
}

export function createApp(options: AppOptions): { fetch: (req: Request) => Promise<Response>; hub: BroadcastHub } {
  const hub = options.hub ?? new BroadcastHub();
  const ctx: RouteContext = {
    store: options.store,
    lifecycle: options.lifecycle,
    ingest: options.ingest,
    token: options.token,
    hub,
  };
  return {
    hub,
    fetch: (req: Request) => handleRequest(req, ctx),
  };
}
