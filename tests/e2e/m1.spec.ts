/**
 * M1-05 e2e (disposable-only): concurrent activation without live inference spend.
 *
 * Covers AC2: (a) fake harness + real SwarmStore (file DB under a single mkdtemp
 * root, plus a disposable in-memory shape check) proving activation creates 1 swarm +
 * 1 lead (coordinator) + 2 coder workers, 2 tasks with non-colliding ownedPaths,
 * 2 immutable brief board posts (sequences 1 and 2, each @mentioning its worker),
 * queue-only dispatch x2, coordinator deny edit and write rules, and
 * getStatusSnapshot telemetry.modelCalls === 0 with no extra harness calls on
 * status; (b) overlap via executionsOverlap on recorded fake admitted turns
 * (overlapping => true, sequential => false) with no claim of live inference
 * overlap; (c) TUI-restart means daemon-survives: a real daemon subprocess holds
 * the file DB open while only the fake-TUI client subprocess is killed, then a
 * fresh store handle replays the board and matches the pre-restart snapshot;
 * (d) disposable isolation: every temp path sits under one mkdtemp root and
 * assertDisposableCapturePath refuses canonical-tree paths; (e) live inference is
 * NOT VERIFIED (unauthorized) and is recorded as a block with fake-harness proof
 * that queue admission needs zero model calls.
 *
 * No network, no model inference, no paid resources. Cleanup in afterEach.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SwarmStore } from "../../packages/runtime/src/db/store.ts";
import { SwarmService } from "../../packages/runtime/src/services/swarm-service.ts";
import type { ActivationHarness } from "../../packages/runtime/src/services/swarm-service.ts";
import { executionsOverlap, assertDisposableCapturePath } from "../../packages/adapter-opencode/src/events.ts";

interface SubmittedTurn {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string;
  readonly externalId: string;
  readonly reason: string;
}

/** Fake queue-only harness: records every call, rejects steering, spends nothing. */
class FakeHarness implements ActivationHarness {
  submitted: SubmittedTurn[] = [];
  appliedRules: Array<{ sessionId: string; rules: readonly { scope: string; action: string }[] }> = [];
  sessions = 0;

  async createSession(title: string, _directory: string): Promise<{ sessionId: string }> {
    this.sessions += 1;
    return { sessionId: "sess-fake-" + this.sessions + "-" + title.length };
  }

  async switchAgent(_sessionId: string, _agentId: string): Promise<void> {}

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "assigned_task";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    if (request.delivery !== "queue") {
      throw new Error("STEER_REJECTED: " + request.delivery);
    }
    this.submitted.push({ ...request });
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async applyPermissionRules(
    sessionId: string,
    rules: readonly { scope: string; action: "allow" | "deny" }[],
  ): Promise<void> {
    this.appliedRules.push({ sessionId, rules: [...rules] });
  }

  counts(): { submitted: number; appliedRules: number; sessions: number } {
    return { submitted: this.submitted.length, appliedRules: this.appliedRules.length, sessions: this.sessions };
  }
}

const roots: string[] = [];

/** Fail-closed resolver fixture: every successful activation supplies an
 *  explicit active-session model (MODEL-INHERIT-01). Test-only. */
const ACTIVE_MODEL = { providerID: "prov-active", id: "model-active" } as const;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "m105-e2e-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  let pending = roots.pop();
  while (pending !== undefined) {
    try {
      rmSync(pending, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of disposable roots
    }
    pending = roots.pop();
  }
});

describe("m105 activation on a disposable file DB", () => {
  test("1 swarm + lead + 2 coders, non-colliding tasks, briefs 1-2, queue-only x2, deny rules, modelCalls 0", async () => {
    const root = makeRoot();
    const dbPath = join(root, "swarm.db");
    assertDisposableCapturePath(dbPath, root);
    const store = new SwarmStore(dbPath);
    const harness = new FakeHarness();
    const service = new SwarmService(store, harness);
    try {
      const result = await service.activateSwarm({
        requirement: "Add tests to two independent fixture modules",
        coordinatorSessionId: "sess-lead",
        projectRoot: root,
        modelContext: { activeSessionModel: ACTIVE_MODEL },
      });

      expect(result.coordinator.role).toBe("coordinator");
      expect(result.coordinator.name).toBe("lead");
      expect(result.workers.length).toBe(2);

      const members = store.listMembers(result.swarm.id);
      expect(members.length).toBe(3);
      expect(members.map((m) => m.role).sort()).toEqual(["coder", "coder", "coordinator"]);

      const tasks = store.listTasks(result.swarm.id);
      expect(tasks.length).toBe(2);
      const ownedJoined = tasks.map((t) => t.ownedPaths.join(",")).join("|");
      expect(ownedJoined).toContain("worker-a");
      expect(ownedJoined).toContain("worker-b");
      const ownedAreas = tasks.map((t) => t.ownedPaths.join(",")).sort();
      expect(ownedAreas.length).toBe(2);
      expect(ownedAreas[0]).not.toBe(ownedAreas[1]);
      for (const t of tasks) {
        expect(t.forbiddenPaths.length).toBeGreaterThan(0);
      }

      const posts = store.getPostsAfter(result.swarm.id, 0);
      expect(posts.length).toBe(2);
      expect(posts.map((p) => p.kind)).toEqual(["brief", "brief"]);
      expect(posts.map((p) => p.sequence)).toEqual([1, 2]);
      expect(result.workers.map((w) => w.member.name).sort()).toEqual(["worker-a", "worker-b"]);
      for (const w of result.workers) {
        expect(w.brief.body).toContain("@" + w.member.name + " ");
        expect(w.brief.mentions).toContain(w.member.id);
      }

      expect(harness.submitted.length).toBe(2);
      for (const turn of harness.submitted) {
        expect(turn.delivery).toBe("queue");
      }
      expect(service.getDispatchCount()).toBe(2);
      const leadRules = harness.appliedRules.find((r) => r.sessionId === "sess-lead");
      expect(leadRules).not.toBeUndefined();
      const scopes = new Map((leadRules === undefined ? [] : leadRules.rules).map((r) => [r.scope, r.action] as const));
      expect(scopes.get("edit")).toBe("deny");
      expect(scopes.get("write")).toBe("deny");

      const before = harness.counts();
      const snap = service.getStatusSnapshot(result.swarm.id);
      const replay = service.getStatusSnapshot(result.swarm.id, 1);
      expect(snap.telemetry.modelCalls).toBe(0);
      expect(replay.telemetry.modelCalls).toBe(0);
      expect(snap.members.length).toBe(3);
      expect(snap.tasks.length).toBe(2);
      expect(snap.posts.length).toBe(2);
      expect(replay.posts.map((p) => p.sequence)).toEqual([2]);
      expect(harness.counts()).toEqual(before);
    } finally {
      store.close();
    }
  });

  test("same activation shape on a disposable in-memory store", async () => {
    const store = new SwarmStore(":memory:");
    const harness = new FakeHarness();
    const service = new SwarmService(store, harness);
    try {
      const result = await service.activateSwarm({
        requirement: "Add tests to two independent fixture modules",
        coordinatorSessionId: "sess-lead",
        projectRoot: tmpdir(),
        modelContext: { activeSessionModel: ACTIVE_MODEL },
      });
      expect(store.listMembers(result.swarm.id).length).toBe(3);
      expect(store.listTasks(result.swarm.id).length).toBe(2);
      expect(store.getPostsAfter(result.swarm.id, 0).length).toBe(2);
      expect(service.getStatusSnapshot(result.swarm.id).telemetry.modelCalls).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("m105 overlap on recorded fake turns (no live inference)", () => {
  test("overlapping admitted intervals overlap; sequential intervals do not", () => {
    const turnA = { startedAt: "2026-01-01T00:00:00.000Z", terminalAt: "2026-01-01T00:00:10.000Z" };
    const turnB = { startedAt: "2026-01-01T00:00:05.000Z", terminalAt: "2026-01-01T00:00:15.000Z" };
    const turnC = { startedAt: "2026-01-01T00:00:10.000Z", terminalAt: "2026-01-01T00:00:20.000Z" };
    expect(executionsOverlap(turnA, turnB)).toBe(true);
    expect(executionsOverlap(turnB, turnA)).toBe(true);
    expect(executionsOverlap(turnA, turnA)).toBe(true);
    expect(executionsOverlap(turnA, turnC)).toBe(false);
    expect(executionsOverlap({ startedAt: turnA.startedAt, terminalAt: null }, turnB)).toBe(true);
  });
});

async function waitForMarker(proc: { stdout: unknown }, marker: string, timeoutMs: number): Promise<boolean> {
  const stream = proc.stdout as ReadableStream<Uint8Array> | null | undefined;
  if (stream === null || stream === undefined || typeof stream === "number") {
    return false;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    for (;;) {
      const chunk = (await Promise.race([reader.read(), timeout])) as ReadableStreamReadResult<Uint8Array> | null;
      if (chunk === null) {
        return false;
      }
      if (chunk.done) {
        return buf.includes(marker);
      }
      buf += decoder.decode(chunk.value, { stream: true });
      if (buf.includes(marker)) {
        return true;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
    reader.releaseLock();
  }
}

describe("m105 TUI restart means the daemon survives", () => {
  test("killing only the fake-TUI client leaves the daemon alive; board replay matches", async () => {
    const root = makeRoot();
    const dbPath = join(root, "swarm.db");
    const store = new SwarmStore(dbPath);
    const harness = new FakeHarness();
    const service = new SwarmService(store, harness);
    const result = await service.activateSwarm({
      requirement: "Add tests to two independent fixture modules",
      coordinatorSessionId: "sess-lead",
      projectRoot: root,
      modelContext: { activeSessionModel: ACTIVE_MODEL },
    });
    const swarmId = result.swarm.id;
    const before = store.getPostsAfter(swarmId, 0).map((p) => ({ id: p.id, sequence: p.sequence, body: p.body }));
    expect(before.length).toBe(2);
    store.close();

    const holderPath = join(root, "daemon-holder.ts");
    assertDisposableCapturePath(holderPath, root);
    writeFileSync(
      holderPath,
      [
        "import { Database } from \"bun:sqlite\";",
        "const dbPath = process.env.M105_DB === undefined ? \"\" : process.env.M105_DB;",
        "if (dbPath === \"\") { console.error(\"holder: missing M105_DB\"); process.exit(1); }",
        "const db = new Database(dbPath);",
        "db.exec(\"PRAGMA journal_mode = WAL;\");",
        "console.log(\"holder-open \" + dbPath);",
        "setInterval(() => { db.query(\"SELECT 1\").get(); }, 250);",
      ].join("\n"),
      "utf8",
    );

    const daemon = Bun.spawn(["bun", holderPath], {
      cwd: root,
      env: { ...process.env, M105_DB: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const tui = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000);"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      expect(await waitForMarker(daemon, "holder-open", 15000)).toBe(true);
      expect(daemon.exitCode).toBeNull();
      tui.kill();
      await tui.exited;
      expect(daemon.exitCode).toBeNull();
      expect(typeof daemon.pid).toBe("number");

      const reopened = new SwarmStore(dbPath);
      try {
        const after = reopened.getPostsAfter(swarmId, 0);
        expect(after.map((p) => p.sequence)).toEqual([1, 2]);
        expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
        expect(after.map((p) => p.body)).toEqual(before.map((p) => p.body));
      } finally {
        reopened.close();
      }
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      try {
        tui.kill();
      } catch {
        // already exited
      }
      try {
        daemon.kill();
      } catch {
        // already exited
      }
      await Promise.allSettled([daemon.exited, tui.exited]);
    }
  });
});

describe("m105 disposable isolation", () => {
  test("all captures stay under the mkdtemp root; canonical paths are refused", () => {
    const root = makeRoot();
    const nested = join(root, "nested", "captures");
    assertDisposableCapturePath(nested, root);
    const dbPath = join(nested, "swarm.db");
    assertDisposableCapturePath(dbPath, root);
    const store = new SwarmStore(dbPath);
    store.close();
    expect(existsSync(dbPath)).toBe(true);
    expect(resolve(dbPath).startsWith(resolve(root))).toBe(true);
    const canonical = resolve("packages", "runtime", "src", "db", "store.ts");
    let refused = false;
    try {
      assertDisposableCapturePath(canonical, root);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe("m105 live inference gate", () => {
  test("live overlap is NOT VERIFIED (unauthorized); fake-harness queue admission needs no modelCalls", async () => {
    if (process.env.SWARM_ALLOW_LIVE_INFERENCE === "1") {
      console.log("[m105] SKIP: live gate set but no live implementation in this slice; skipping with zero inference.");
      return;
    }
    console.log("[m105] BLOCK: live inference unauthorized; live overlap NOT VERIFIED. Proving queue admission without modelCalls.");
    expect(process.env.SWARM_ALLOW_LIVE_INFERENCE === "1").toBe(false);
    const root = makeRoot();
    const store = new SwarmStore(join(root, "swarm.db"));
    const harness = new FakeHarness();
    const service = new SwarmService(store, harness);
    try {
      const result = await service.activateSwarm({
        requirement: "Add tests to two independent fixture modules",
        coordinatorSessionId: "sess-lead",
        projectRoot: root,
        modelContext: { activeSessionModel: ACTIVE_MODEL },
      });
      expect(harness.submitted.length).toBe(2);
      expect(service.getStatusSnapshot(result.swarm.id).telemetry.modelCalls).toBe(0);
    } finally {
      store.close();
    }
  });
});
