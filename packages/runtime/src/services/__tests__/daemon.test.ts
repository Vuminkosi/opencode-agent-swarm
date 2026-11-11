/**
 * M1-02 daemon transport tests — auth negative, lifecycle
 * (plugin kill → daemon lives), SSE reconnect replay.
 *
 * Uses a disposable temp dir for the SQLite file (never the canonical
 * tree) and an ephemeral in-process Bun server, plus one real daemon
 * subprocess for the survival test.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../app.js";
import { SwarmStore } from "../../db/store.js";
import { BroadcastHub } from "../broadcast.js";
import { EventIngest } from "../ingest.js";
import { SwarmLifecycle } from "../lifecycle.js";
import type { BoardPost } from "@opencode-swarm/protocol";

const TOKEN = "m1-02-test-bearer-token-0123456789";

let dir: string;
let dbPath: string;
let store: SwarmStore;
let lifecycle: SwarmLifecycle;
let ingest: EventIngest;
let baseUrl: string;
let server: ReturnType<typeof Bun.serve>;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...extra };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function collectStream(
  url: string,
  opts: { after: number; minPosts: number; timeoutMs?: number },
): Promise<BoardPost[]> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`stream HTTP ${res.status}`);
    if (res.body === null) throw new Error("empty stream body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const posts: BoardPost[] = [];
    let ready = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice("event:".length).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
        }
        if (event === "post") posts.push(JSON.parse(dataLines.join("\n")) as BoardPost);
        else if (event === "ready") ready = true;
      }
      if (ready && posts.length >= opts.minPosts) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    return posts;
  } finally {
    clearTimeout(timeout);
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "m102-daemon-"));
  dbPath = join(dir, "state.sqlite");
  store = new SwarmStore(dbPath);
  lifecycle = new SwarmLifecycle(dbPath);
  ingest = new EventIngest(dbPath);
  const app = createApp({ store, lifecycle, ingest, token: TOKEN, hub: new BroadcastHub() });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try {
    server.stop(true);
  } catch {
    /* ignore */
  }
  ingest.close();
  lifecycle.close();
  store.close();
});

describe("auth negative + guards", () => {
  test("healthz is unauthenticated and carries the contract shape", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["protocolVersion", "schemaVersion", "status"]);
    expect(body["status"]).toBe("ok");
    expect(body["schemaVersion"]).toBe(1);
    expect(body["protocolVersion"]).toBe(1);
  });

  test("missing bearer is 401 and leaks no internals", async () => {
    const res = await fetch(`${baseUrl}/v1/swarms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("wrong bearer is 401", async () => {
    const res = await postJson("/v1/swarms", {}, { authorization: "Bearer wrong-token", "content-type": "application/json" });
    expect(res.status).toBe(401);
  });

  test("non-loopback Origin is rejected", async () => {
    const res = await postJson("/v1/swarms", {}, authHeaders({ origin: "http://evil.example.com" }));
    expect(res.status).toBe(403);
  });

  test("oversized body is 413", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(`${baseUrl}/v1/swarms`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ title: big, coordinatorSessionId: "s", projectRoot: "p", mode: "parity" }),
    });
    expect(res.status).toBe(413);
    const shape = (await res.json()) as { error: { code: string } };
    expect(shape.error.code).toBe("BODY_TOO_LARGE");
  });
});

describe("swarm lifecycle + board", () => {
  test("create → member → task → posts → pause/resume/cancel with guards", async () => {
    const created = await postJson("/v1/swarms", {
      title: "m102 flow",
      coordinatorSessionId: "sess-coord",
      projectRoot: "/tmp/m102",
      mode: "parity",
    });
    expect(created.status).toBe(201);
    const { swarm } = (await created.json()) as { swarm: { id: string } };

    const memberRes = await postJson(`/v1/swarms/${swarm.id}/members`, {
      name: "coder1",
      role: "coder",
      nativeAgentId: "agent-a",
      sessionId: "sess-1",
      model: { providerID: "p", id: "m" },
    });
    expect(memberRes.status).toBe(201);
    const { member } = (await memberRes.json()) as { member: { id: string } };

    const taskRes = await postJson(`/v1/swarms/${swarm.id}/tasks`, {
      title: "t1",
      brief: "do it",
      ownedPaths: [],
      forbiddenPaths: [],
      acceptanceCriteria: ["a1"],
    });
    expect(taskRes.status).toBe(201);

    const postRes = await postJson(`/v1/swarms/${swarm.id}/posts`, {
      authorMemberId: null,
      kind: "brief",
      body: `hello @coder1`,
      idempotencyKey: "k-1",
    });
    expect(postRes.status).toBe(201);
    const posted = (await postRes.json()) as { post: BoardPost; deduped: boolean; wakeIds: string[] };
    expect(posted.deduped).toBe(false);
    expect(posted.post.sequence).toBe(1);
    expect(posted.wakeIds.length).toBe(1);

    // idempotent re-post
    const dupe = await postJson(`/v1/swarms/${swarm.id}/posts`, {
      authorMemberId: null,
      kind: "brief",
      body: `hello @coder1`,
      idempotencyKey: "k-1",
    });
    expect((((await dupe.json()) as { deduped: boolean }).deduped)).toBe(true);

    // replay
    const replay = await fetch(`${baseUrl}/v1/swarms/${swarm.id}/posts?after=0`, { headers: authHeaders() });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { posts: BoardPost[]; after: number };
    expect(replayBody.posts.map((p) => p.sequence)).toEqual([1]);

    // ingest dedupe
    const ing1 = await postJson(`/v1/swarms/${swarm.id}/events/ingest`, { source: "opencode", externalEventId: "e-1" });
    expect((((await ing1.json()) as { deduped: boolean }).deduped)).toBe(false);
    const ing2 = await postJson(`/v1/swarms/${swarm.id}/events/ingest`, { source: "opencode", externalEventId: "e-1" });
    expect((((await ing2.json()) as { deduped: boolean }).deduped)).toBe(true);

    // pause / resume / cancel
    expect((await (await postJson(`/v1/swarms/${swarm.id}/pause`, {})).json()) as { swarm: { status: string } }).toMatchObject({
      swarm: { status: "paused" },
    });
    expect((await (await postJson(`/v1/swarms/${swarm.id}/resume`, {})).json()) as { swarm: { status: string } }).toMatchObject({
      swarm: { status: "running" },
    });
    expect((await (await postJson(`/v1/swarms/${swarm.id}/cancel`, {})).json()) as { swarm: { status: string } }).toMatchObject({
      swarm: { status: "cancelled" },
    });
    // terminal state: resume must fail, never resurrect
    const badResume = await postJson(`/v1/swarms/${swarm.id}/resume`, {});
    expect(badResume.status).toBe(409);
    expect(member.id.length).toBeGreaterThan(0);
  });

  test("unknown swarm is 404 with safe shape", async () => {
    const res = await fetch(`${baseUrl}/v1/swarms/nope`, { headers: authHeaders() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("SSE reconnect replay", () => {
  test("stream replays exactly from after= and delivers live posts", async () => {
    const created = await postJson("/v1/swarms", {
      title: "m102 sse",
      coordinatorSessionId: "sess-sse",
      projectRoot: "/tmp/m102sse",
      mode: "parity",
    });
    const { swarm } = (await created.json()) as { swarm: { id: string } };

    for (let i = 1; i <= 3; i += 1) {
      const r = await postJson(`/v1/swarms/${swarm.id}/posts`, {
        authorMemberId: null,
        kind: "message",
        body: `msg ${i}`,
        idempotencyKey: `sse-${i}`,
      });
      expect(r.status).toBe(201);
    }

    const first = await collectStream(`${baseUrl}/v1/swarms/${swarm.id}/events/stream?after=0`, { after: 0, minPosts: 3 });
    expect(first.map((p) => p.body)).toEqual(["msg 1", "msg 2", "msg 3"]);

    for (const i of [4, 5]) {
      const r = await postJson(`/v1/swarms/${swarm.id}/posts`, {
        authorMemberId: null,
        kind: "message",
        body: `msg ${i}`,
        idempotencyKey: `sse-${i}`,
      });
      expect(r.status).toBe(201);
    }

    // reconnect-from-sequence: exactly the missed posts
    const second = await collectStream(`${baseUrl}/v1/swarms/${swarm.id}/events/stream?after=3`, { after: 3, minPosts: 2 });
    expect(second.map((p) => p.sequence)).toEqual([4, 5]);

    // SSE content negotiation on the posts route replays exactly too
    const negotiated = await (async () => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(`${baseUrl}/v1/swarms/${swarm.id}/posts?after=4`, {
          headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
          signal: ctrl.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
        if (res.body === null) throw new Error("empty body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const posts: BoardPost[] = [];
        let ready = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = "";
            const data: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trim());
            }
            if (event === "post") posts.push(JSON.parse(data.join("\n")) as BoardPost);
            else if (event === "ready") ready = true;
          }
          if (ready && posts.length >= 1) break;
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return posts;
      } finally {
        clearTimeout(timeout);
      }
    })();
    expect(negotiated.map((p) => p.sequence)).toEqual([5]);

    // live delivery on an open stream
    const livePromise = collectStream(`${baseUrl}/v1/swarms/${swarm.id}/events/stream?after=5`, { after: 5, minPosts: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const live = await postJson(`/v1/swarms/${swarm.id}/posts`, {
      authorMemberId: null,
      kind: "message",
      body: "msg 6 live",
      idempotencyKey: "sse-6",
    });
    expect(live.status).toBe(201);
    expect((await livePromise).map((p) => p.body)).toEqual(["msg 6 live"]);
  }, 30000);
});

describe("F1 paged SSE replay beyond the old 100-row cap", () => {
  test("250 posts replay exactly in order 1..250", async () => {
    const created = await postJson("/v1/swarms", {
      title: "m102 paged",
      coordinatorSessionId: "sess-paged",
      projectRoot: "/tmp/m102paged",
      mode: "parity",
    });
    expect(created.status).toBe(201);
    const { swarm } = (await created.json()) as { swarm: { id: string } };

    for (let i = 1; i <= 250; i += 1) {
      store.appendPost(swarm.id, {
        authorMemberId: null,
        kind: "message",
        body: `paged msg ${i}`,
        idempotencyKey: `paged-${i}`,
      });
    }

    const posts = await collectStream(`${baseUrl}/v1/swarms/${swarm.id}/events/stream?after=0`, {
      after: 0,
      minPosts: 250,
      timeoutMs: 30000,
    });
    expect(posts.length).toBe(250);
    expect(posts.map((p) => p.sequence)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
  }, 60000);
});

describe("F2 connect-race: subscribe-to-buffer before replay", () => {
  test("posts committed while the stream opens are neither lost nor duplicated", async () => {
    const created = await postJson("/v1/swarms", {
      title: "m102 race",
      coordinatorSessionId: "sess-race",
      projectRoot: "/tmp/m102race",
      mode: "parity",
    });
    const { swarm } = (await created.json()) as { swarm: { id: string } };
    for (let i = 1; i <= 5; i += 1) {
      store.appendPost(swarm.id, {
        authorMemberId: null,
        kind: "message",
        body: `race base ${i}`,
        idempotencyKey: `race-base-${i}`,
      });
    }

    const streamPromise = collectStream(`${baseUrl}/v1/swarms/${swarm.id}/events/stream?after=5`, {
      after: 5,
      minPosts: 5,
      timeoutMs: 30000,
    });
    // Commit while the stream is opening / replaying — these must all arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let i = 6; i <= 10; i += 1) {
      const r = await postJson(`/v1/swarms/${swarm.id}/posts`, {
        authorMemberId: null,
        kind: "message",
        body: `race live ${i}`,
        idempotencyKey: `race-live-${i}`,
      });
      expect(r.status).toBe(201);
    }
    const posts = await streamPromise;
    expect(posts.map((p) => p.sequence)).toEqual([6, 7, 8, 9, 10]);
  }, 60000);
});

describe("SEC-02 lifecycle body guard", () => {
  test("oversized body on pause/resume/cancel is 413", async () => {
    const created = await postJson("/v1/swarms", {
      title: "m102 guard",
      coordinatorSessionId: "sess-guard",
      projectRoot: "/tmp/m102guard",
      mode: "parity",
    });
    const { swarm } = (await created.json()) as { swarm: { id: string } };
    const big = "x".repeat(1024 * 1024 + 1);
    for (const action of ["pause", "resume", "cancel"]) {
      const res = await fetch(`${baseUrl}/v1/swarms/${swarm.id}/${action}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ title: big }),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BODY_TOO_LARGE");
    }
  });
});

describe("SEC-01 safe SSE error frame", () => {
  test("replay failure emits a generic frame and leaks no internals", async () => {
    const created = await postJson("/v1/swarms", {
      title: "m102 errframe",
      coordinatorSessionId: "sess-err",
      projectRoot: "/tmp/m102err",
      mode: "parity",
    });
    const { swarm } = (await created.json()) as { swarm: { id: string } };

    const broken: SwarmStore = Object.create(store);
    (broken as unknown as Record<string, unknown>)["getPostsAfter"] = () => {
      throw new Error("sqlite exploded: /secret/path.sql");
    };
    (broken as unknown as Record<string, unknown>)["getSwarm"] = (...args: unknown[]) =>
      (store.getSwarm as (...a: never[]) => unknown)(...(args as never[]));
    const brokenApp = createApp({ store: broken, lifecycle, ingest, token: TOKEN, hub: new BroadcastHub() });
    const brokenServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: brokenApp.fetch });
    try {
      const url = `http://127.0.0.1:${brokenServer.port}/v1/swarms/${swarm.id}/events/stream?after=0`;
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
          signal: ctrl.signal,
        });
        expect(res.status).toBe(200);
        if (res.body === null) throw new Error("empty stream body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let errorData = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = "";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) event = line.slice("event:".length).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
            }
            if (event === "post") throw new Error("expected no posts from a broken replay");
            if (event === "error") errorData = dataLines.join("\n");
          }
          if (errorData !== "") break;
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        expect(errorData).not.toBe("");
        const parsed = JSON.parse(errorData) as { code: string; message: string };
        expect(parsed.code).toBe("REPLAY_FAILED");
        expect(parsed.message).toBe("Board replay failed");
        expect(errorData).not.toContain("exploded");
        expect(errorData).not.toContain(".sql");
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      try {
        brokenServer.stop(true);
      } catch {
        /* ignore */
      }
    }
  });
});

describe("daemon survival after plugin exit", () => {
  test("real daemon subprocess outlives a killed plugin process", async () => {
    const lifeDir = mkdtempSync(join(tmpdir(), "m102-life-"));
    const lifeDb = join(lifeDir, "life.sqlite");
    const lifeCfg = join(lifeDir, "swarm.config.json");
    writeFileSync(
      lifeCfg,
      JSON.stringify({ schemaVersion: 1, runtime: { listen: "127.0.0.1", port: 48790, databasePath: lifeDb } }),
    );
    const serverPath = fileURLToPath(new URL("../../server.ts", import.meta.url));
    const daemon = Bun.spawn(["bun", serverPath, "--config", lifeCfg], {
      env: { ...process.env, SWARM_DAEMON_TOKEN: TOKEN },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const health = "http://127.0.0.1:48790/healthz";
      let up = false;
      for (let i = 0; i < 100; i += 1) {
        try {
          const res = await fetch(health);
          if (res.ok) {
            up = true;
            break;
          }
        } catch {
          /* not up yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(up).toBe(true);

      // fake plugin process: start it, then kill it like a TUI exit
      const plugin = Bun.spawn(["bun", "-e", "setInterval(()=>{}, 1000)"], { stdout: "ignore", stderr: "ignore" });
      expect(plugin.exitCode).toBe(null);
      plugin.kill(9);
      await plugin.exited;

      // daemon must be unaffected: healthz + real write path
      const after = await fetch(health);
      expect(after.status).toBe(200);
      const created = await fetch("http://127.0.0.1:48790/v1/swarms", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          title: "after plugin death",
          coordinatorSessionId: "sess-x",
          projectRoot: "/tmp/x",
          mode: "parity",
        }),
      });
      expect(created.status).toBe(201);
    } finally {
      daemon.kill(9);
      await daemon.exited;
    }
  }, 30000);
});
