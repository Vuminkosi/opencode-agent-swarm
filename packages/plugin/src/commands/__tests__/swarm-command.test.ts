/**
 * M1-04 `/swarm` command tests — validation, coordinator binding,
 * zero-token status routing (fake client/activator; a throwing tripwire
 * proves status never touches model inference).
 */
// @ts-ignore - bun:test types are provided by the Bun runtime (bun-types not installed for this package); runtime import only.
import { describe, test, expect } from "bun:test";
import {
  AGENTS_NAVIGATION_HINT,
  BOARD_FALLBACK_HINT,
  STOP_POLICY,
  SWARM_HELP,
  SwarmCommand,
  SwarmValidationError,
  UNSUPPORTED_COMMAND_APIS,
  WORKTREE_PRESERVATION_POLICY,
  authorizeToolCall,
  bindCoordinatorSession,
  parseSwarmInput,
  SwarmToolDeniedError,
  type BoardReader,
  type DirectSteerer,
  type LastSwarmStore,
  type StatusReader,
  type SwarmActivator,
  type SwarmLifecycleGateway,
} from "../swarm.ts";
import { SwarmDaemonClient } from "../../client.ts";
import type { PostSummary } from "../../client.ts";
import type { SwarmSnapshot } from "../../client.ts";

const SNAPSHOT: SwarmSnapshot = {
  swarm: {
    id: "swarm-1",
    title: "Swarm: demo",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/x",
    mode: "parity",
    status: "planning",
    revision: 2,
  },
  members: [
    { id: "m-lead", name: "lead", role: "coordinator", sessionId: "sess-lead" },
    { id: "m-a", name: "worker-a", role: "coder", sessionId: "sess-a" },
  ],
  tasks: [{ id: "t-1", title: "t", state: "draft", ownerId: "m-a" }],
};

function fakes(): {
  client: StatusReader & { snapshots: number };
  activator: SwarmActivator & { activations: number };
  lastSwarm: LastSwarmStore & { id: string | undefined };
} {
  const client = {
    snapshots: 0,
    async snapshot(_swarmId: string): Promise<SwarmSnapshot> {
      this.snapshots += 1;
      return SNAPSHOT;
    },
  };
  const activator = {
    activations: 0,
    async activateSwarm(input: { requirement: string; coordinatorSessionId: string; projectRoot: string }) {
      this.activations += 1;
      return {
        swarm: { id: "swarm-1", title: `Swarm: ${input.requirement.slice(0, 10)}` },
        workers: [{ member: { name: "worker-a" } }, { member: { name: "worker-b" } }],
      };
    },
  };
  const lastSwarm = {
    id: undefined as string | undefined,
    getLastSwarmId(): string | undefined {
      return this.id;
    },
    setLastSwarmId(id: string): void {
      this.id = id;
    },
  };
  return { client, activator, lastSwarm };
}

describe("parseSwarmInput validation", () => {
  test("bare /swarm is EMPTY_REQUIREMENT, not an implicit activation", () => {
    expect(() => parseSwarmInput("   ")).toThrow(SwarmValidationError);
    try {
      parseSwarmInput("");
    } catch (err) {
      expect((err as SwarmValidationError).code).toBe("EMPTY_REQUIREMENT");
    }
  });

  test("free text is an activation requirement", () => {
    const intent = parseSwarmInput("Add tests to two independent fixture modules");
    expect(intent).toEqual({ kind: "activate", requirement: "Add tests to two independent fixture modules" });
  });

  test("status/board/agents route with optional swarm id", () => {
    expect(parseSwarmInput("status")).toEqual({ kind: "status", swarmId: undefined });
    expect(parseSwarmInput("status swarm-9")).toEqual({ kind: "status", swarmId: "swarm-9" });
    expect(parseSwarmInput("board")).toEqual({ kind: "board", swarmId: undefined });
    expect(parseSwarmInput("agents s-1")).toEqual({ kind: "agents", swarmId: "s-1" });
  });

  test("pause/resume/stop require a swarm id", () => {
    expect(parseSwarmInput("pause s-1")).toEqual({ kind: "pause", swarmId: "s-1" });
    expect(() => parseSwarmInput("pause")).toThrow(SwarmValidationError);
    expect(() => parseSwarmInput("stop")).toThrow(SwarmValidationError);
  });

  test("message requires @mention + text", () => {
    expect(parseSwarmInput("message @worker-a keep going")).toEqual({
      kind: "message",
      mention: "worker-a",
      text: "keep going",
    });
    expect(() => parseSwarmInput("message hello")).toThrow(SwarmValidationError);
  });
});

describe("bindCoordinatorSession (PAR-01)", () => {
  test("binds the current session as coordinator", () => {
    const binding = bindCoordinatorSession("sess-current", "/tmp/proj", () => "2026-11-11T00:00:00.000Z");
    expect(binding).toEqual({
      coordinatorSessionId: "sess-current",
      projectRoot: "/tmp/proj",
      boundAt: "2026-11-11T00:00:00.000Z",
    });
  });

  test("empty session or root is rejected", () => {
    expect(() => bindCoordinatorSession("", "/tmp/x")).toThrow(SwarmValidationError);
    expect(() => bindCoordinatorSession("s", "  ")).toThrow(SwarmValidationError);
  });
});

describe("authorizeToolCall (tool auth, not prompt-only)", () => {
  test("coordinator is denied edit-code/merge, allowed coordinate/post/manage-members", () => {
    expect(() => authorizeToolCall("coordinator", "coordinate")).not.toThrow();
    expect(() => authorizeToolCall("coordinator", "post")).not.toThrow();
    expect(() => authorizeToolCall("coordinator", "edit-code")).toThrow(SwarmToolDeniedError);
    expect(() => authorizeToolCall("coordinator", "merge")).toThrow(SwarmToolDeniedError);
    expect(() => authorizeToolCall("coder", "edit-code")).not.toThrow();
    expect(() => authorizeToolCall("coder", "merge")).toThrow(SwarmToolDeniedError);
  });
});

describe("SwarmCommand routing", () => {
  test("activate binds the current session and delegates once", async () => {
    const { client, activator, lastSwarm } = fakes();
    const command = new SwarmCommand({ client, activator, lastSwarm });
    const result = await command.execute("Add tests to two modules", {
      sessionId: "sess-current",
      projectRoot: "/tmp/proj",
      role: "coordinator",
    });
    expect(activator.activations).toBe(1);
    expect(result).toEqual({
      kind: "activated",
      swarmId: "swarm-1",
      title: "Swarm: Add tests ",
      workers: ["worker-a", "worker-b"],
    });
    expect(lastSwarm.id).toBe("swarm-1");
  });

  test("status serves the daemon snapshot with modelCalls 0 and no inference", async () => {
    const { client, activator, lastSwarm } = fakes();
    lastSwarm.id = "swarm-1";
    // Structural guard: status is served from the injected client projection
    // only (activations stay 0 below); no inference surface exists on deps.
    const command = new SwarmCommand({ client, activator, lastSwarm });
    const result = await command.execute("status", { sessionId: "sess-current", projectRoot: "/tmp/proj" });
    expect(client.snapshots).toBe(1);
    expect(activator.activations).toBe(0);
    expect(result).toEqual({ kind: "status", snapshot: SNAPSHOT, modelCalls: 0 });
  });

  test("status without an active swarm is a validation failure, not a model call", async () => {
    const { client, activator, lastSwarm } = fakes();
    const command = new SwarmCommand({ client, activator, lastSwarm });
    await expect(command.execute("status", { sessionId: "s", projectRoot: "/tmp/p" })).rejects.toBeInstanceOf(
      SwarmValidationError,
    );
    expect(client.snapshots).toBe(0);
  });
});

describe("M6-01 parseSwarmInput full family", () => {
  test("help routes explicitly; matching is case-insensitive", () => {
    expect(parseSwarmInput("help")).toEqual({ kind: "help" });
    expect(parseSwarmInput("HELP")).toEqual({ kind: "help" });
    expect(parseSwarmInput("STATUS")).toEqual({ kind: "status", swarmId: undefined });
    expect(parseSwarmInput("Board s-1")).toEqual({ kind: "board", swarmId: "s-1" });
  });

  test("unknown words stay requirements (no inference, no error)", () => {
    expect(parseSwarmInput("status-quo review")).toEqual({ kind: "activate", requirement: "status-quo review" });
    expect(parseSwarmInput("stopgap fix")).toEqual({ kind: "activate", requirement: "stopgap fix" });
  });

  test("resume requires a swarm id, like pause/stop", () => {
    expect(parseSwarmInput("resume r-1")).toEqual({ kind: "resume", swarmId: "r-1" });
    expect(() => parseSwarmInput("resume")).toThrow(SwarmValidationError);
  });

  test("message without @mention or without text is INVALID_MESSAGE", () => {
    expect(() => parseSwarmInput("message @worker-a")).toThrow(SwarmValidationError);
    expect(() => parseSwarmInput("message @worker-a   ")).toThrow(SwarmValidationError);
  });
});

const BOARD_POSTS: PostSummary[] = [
  { id: "p-1", sequence: 1, kind: "brief", body: "@worker-a Brief 1/2" },
  { id: "p-2", sequence: 2, kind: "brief", body: "@worker-b Brief 2/2" },
];

function wiredFakes(): {
  client: StatusReader & { snapshots: number };
  board: BoardReader & { reads: number; posts: PostSummary[] };
  lifecycle: SwarmLifecycleGateway & { pauses: number; resumes: number; cancels: number };
  steerer: DirectSteerer & { steers: number; lastSeed: string | undefined };
  activator: SwarmActivator & { activations: number };
  lastSwarm: LastSwarmStore & { id: string | undefined };
} {
  const base = fakes();
  const boardPosts = [...BOARD_POSTS];
  const board = {
    posts: boardPosts,
    reads: 0,
    async listPosts(swarmId: string, _after = 0, _limit = 100): Promise<{ posts: readonly PostSummary[]; after: number }> {
      this.reads += 1;
      void swarmId;
      return { posts: this.posts, after: this.posts.length };
    },
  };
  const lifecycle = {
    pauses: 0,
    resumes: 0,
    cancels: 0,
    async pauseSwarm(swarmId: string): Promise<{ swarm: { id: string; status: string } }> {
      this.pauses += 1;
      return { swarm: { id: swarmId, status: "paused" } };
    },
    async resumeSwarm(swarmId: string): Promise<{ swarm: { id: string; status: string } }> {
      this.resumes += 1;
      return { swarm: { id: swarmId, status: "running" } };
    },
    async cancelSwarm(swarmId: string): Promise<{ swarm: { id: string; status: string } }> {
      this.cancels += 1;
      return { swarm: { id: swarmId, status: "cancelled" } };
    },
  };
  const steerer = {
    steers: 0,
    lastSeed: undefined as string | undefined,
    async steerWorker(input: {
      swarmId: string;
      workerId: string;
      workerName: string;
      text: string;
      idempotencySeed: string;
    }): Promise<{ dispatched: boolean; dispatchStatus?: string | undefined }> {
      this.steers += 1;
      this.lastSeed = input.idempotencySeed;
      void input.swarmId;
      void input.workerId;
      void input.workerName;
      void input.text;
      return { dispatched: true, dispatchStatus: "dispatched" };
    },
  };
  return { ...base, board, lifecycle, steerer };
}

describe("M6-01 zero-inference reads (status/board/agents)", () => {
  test("board serves the posts-after projection with modelCalls 0 and the terminal fallback hint", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    const result = await command.execute("board", { sessionId: "s", projectRoot: "/tmp/p" });
    expect(board.reads).toBe(1);
    expect(client.snapshots).toBe(0);
    expect(activator.activations).toBe(0);
    expect(lifecycle.pauses + lifecycle.resumes + lifecycle.cancels).toBe(0);
    expect(steerer.steers).toBe(0);
    expect(result).toEqual({
      kind: "board",
      swarmId: "swarm-1",
      posts: BOARD_POSTS,
      after: 2,
      modelCalls: 0,
      fallbackHint: BOARD_FALLBACK_HINT,
    });
    expect(BOARD_FALLBACK_HINT).toContain("bunx opencode-swarm board");
  });

  test("agents serves the roster with native sessionIds and the navigation hint", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    const result = await command.execute("agents", { sessionId: "s", projectRoot: "/tmp/p" });
    expect(client.snapshots).toBe(1);
    expect(board.reads).toBe(0);
    expect(activator.activations).toBe(0);
    expect(result).toEqual({
      kind: "agents",
      swarmId: "swarm-1",
      members: [
        { name: "lead", role: "coordinator", sessionId: "sess-lead" },
        { name: "worker-a", role: "coder", sessionId: "sess-a" },
      ],
      modelCalls: 0,
      navigationHint: AGENTS_NAVIGATION_HINT,
    });
  });

  test("reads are allowed for non-coordinator roles (no manage-members gate on reads)", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    const result = await command.execute("status", { sessionId: "s", projectRoot: "/tmp/p", role: "coder" });
    expect(result).toEqual({ kind: "status", snapshot: SNAPSHOT, modelCalls: 0 });
  });

  test("unwired board preserves the exact M1-04 status projection", async () => {
    const { client, activator, lastSwarm } = fakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm });
    const result = await command.execute("board", { sessionId: "s", projectRoot: "/tmp/p" });
    expect(result).toEqual({ kind: "status", snapshot: SNAPSHOT, modelCalls: 0 });
  });
});

describe("M6-01 private steer (message never board-posted)", () => {
  test("message resolves the roster and steers via user_direct; board length unchanged", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const before = board.posts.length;
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    const result = await command.execute("message @worker-a keep going", {
      sessionId: "sess-lead",
      projectRoot: "/tmp/p",
    });
    expect(steerer.steers).toBe(1);
    expect(board.posts.length).toBe(before);
    expect(activator.activations).toBe(0);
    expect(lifecycle.pauses + lifecycle.resumes + lifecycle.cancels).toBe(0);
    expect(result).toEqual({
      kind: "steered",
      swarmId: "swarm-1",
      worker: "worker-a",
      workerId: "m-a",
      dispatched: true,
      dispatchStatus: "dispatched",
    });
  });

  test("message to an unknown worker fails closed with UNKNOWN_MENTION and zero steers", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    try {
      await command.execute("message @ghost hello", { sessionId: "sess-lead", projectRoot: "/tmp/p" });
      expect.unreachable();
    } catch (err) {
      expect((err as SwarmValidationError).code).toBe("UNKNOWN_MENTION");
    }
    expect(steerer.steers).toBe(0);
    expect(board.posts.length).toBe(2);
  });

  test("unwired message preserves the exact M1-04 info message", async () => {
    const { client, activator, lastSwarm } = fakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm });
    const result = await command.execute("message @worker-a hi", { sessionId: "s", projectRoot: "/tmp/p" });
    expect(result).toEqual({ kind: "info", message: "Message for @worker-a queued (daemon board post)" });
  });
});

describe("M6-01 coordinator-only lifecycle (scheduler gate + preservation policy)", () => {
  test("pause/resume/stop call the gateway once and attach gate + preservation text", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    const coord = { sessionId: "s", projectRoot: "/tmp/p", role: "coordinator" as const };
    const paused = await command.execute("pause swarm-1", coord);
    expect(lifecycle.pauses).toBe(1);
    expect(paused).toEqual({
      kind: "lifecycle",
      action: "pause",
      swarmId: "swarm-1",
      status: "paused",
      policy: expect.stringContaining("Scheduler gate"),
    });
    expect((paused as { policy: string }).policy).toContain(WORKTREE_PRESERVATION_POLICY);

    const resumed = await command.execute("resume swarm-1", coord);
    expect(lifecycle.resumes).toBe(1);
    expect(resumed).toEqual({
      kind: "lifecycle",
      action: "resume",
      swarmId: "swarm-1",
      status: "running",
      policy: expect.stringContaining("FIFO"),
    });

    const stopped = await command.execute("stop swarm-1", coord);
    expect(lifecycle.cancels).toBe(1);
    expect(stopped).toEqual({
      kind: "lifecycle",
      action: "stop",
      swarmId: "swarm-1",
      status: "cancelled",
      policy: STOP_POLICY,
    });
    expect(client.snapshots).toBe(0);
    expect(activator.activations).toBe(0);
    expect(steerer.steers).toBe(0);

    // SEC-M6-01 fail-closed: the same mutating calls with an omitted role
    // (least-privilege researcher default) are denied with zero side effects.
    const omitted = { sessionId: "s", projectRoot: "/tmp/p" };
    const counts = () => lifecycle.pauses + lifecycle.resumes + lifecycle.cancels;
    const before = counts();
    await expect(command.execute("pause swarm-1", omitted)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    await expect(command.execute("resume swarm-1", omitted)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    await expect(command.execute("stop swarm-1", omitted)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    await expect(command.execute("add a feature", omitted)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    expect(counts()).toBe(before);
    expect(activator.activations).toBe(0);
  });

  test("coder is denied pause/resume/stop/activate with zero side effects", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    const ctx = { sessionId: "sess-a", projectRoot: "/tmp/p", role: "coder" as const};
    await expect(command.execute("pause swarm-1", ctx)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    await expect(command.execute("resume swarm-1", ctx)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    await expect(command.execute("stop swarm-1", ctx)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    await expect(command.execute("add a feature", ctx)).rejects.toBeInstanceOf(SwarmToolDeniedError);
    expect(lifecycle.pauses + lifecycle.resumes + lifecycle.cancels).toBe(0);
    expect(activator.activations).toBe(0);
    expect(client.snapshots).toBe(0);
  });

  test("unwired pause preserves the exact M1-04 info message", async () => {
    const { client, activator, lastSwarm } = fakes();
    lastSwarm.id = "s-9";
    const command = new SwarmCommand({ client, activator, lastSwarm });
    const result = await command.execute("pause s-9", { sessionId: "s", projectRoot: "/tmp/p", role: "coordinator" });
    expect(result).toEqual({ kind: "info", message: "Swarm s-9 pause requested (daemon lifecycle intent)" });
  });

  test("malformed swarm ids fail closed with INVALID_SWARM_ID and zero side effects", async () => {
    const { client, board, lifecycle, steerer, activator, lastSwarm } = wiredFakes();
    lastSwarm.id = "swarm-1";
    const command = new SwarmCommand({ client, activator, lastSwarm, board, lifecycle, steerer });
    const coord = { sessionId: "s", projectRoot: "/tmp/p", role: "coordinator" as const };
    for (const bad of ["has space", "semi;colon", "../escape", "x".repeat(129)]) {
      await expect(command.execute(`status ${bad}`, coord)).rejects.toMatchObject({ code: "INVALID_SWARM_ID" });
    }
    expect(client.snapshots).toBe(0);
    expect(board.reads).toBe(0);
  });

  test("idempotency seed carries a hash, never raw user text", async () => {
    const { idempotencySeedFor } = await import("../swarm.ts");
    const seed = idempotencySeedFor("swarm-1", "m-a", "keep going secret-text");
    expect(seed).toContain("swarm-1");
    expect(seed).toContain("m-a");
    expect(seed).not.toContain("secret-text");
    expect(seed).toBe(idempotencySeedFor("swarm-1", "m-a", "keep going secret-text"));
    expect(seed).not.toBe(idempotencySeedFor("swarm-1", "m-a", "different text"));
  });
});

describe("M6-01 help + unsupported-API record", () => {
  test("help serves the full family reference", async () => {
    const { client, activator, lastSwarm } = fakes();
    const command = new SwarmCommand({ client, activator, lastSwarm });
    const result = await command.execute("help", { sessionId: "s", projectRoot: "/tmp/p" });
    expect(result).toEqual({ kind: "info", message: SWARM_HELP });
    for (const token of ["/swarm status", "/swarm board", "/swarm agents", "/swarm message @worker", "/swarm pause", "/swarm resume", "/swarm stop", "/swarm help"]) {
      expect(SWARM_HELP).toContain(token);
    }
  });

  test("unsupported command APIs are recorded as fallback, never invoked", () => {
    expect(UNSUPPORTED_COMMAND_APIS.length).toBeGreaterThan(0);
    for (const entry of UNSUPPORTED_COMMAND_APIS) {
      expect(entry).toMatch(/M6-03|contract amendment/);
    }
  });
});

describe("M6-01 client versioned reads only", () => {
  function stubDaemon() {
    const seen: string[] = [];
    const swarmBody = {
      swarm: SNAPSHOT.swarm,
      members: SNAPSHOT.members,
      tasks: SNAPSHOT.tasks,
    };
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      seen.push(target);
      return new Response(
        target.includes("/posts") ? JSON.stringify({ posts: [], after: 0 }) : JSON.stringify(swarmBody),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const daemon = new SwarmDaemonClient({ baseUrl: "http://127.0.0.1:9", token: "t", fetchImpl });
    return { daemon, seen };
  }

  test("snapshot/listPosts/listMembers/listTasks hit only versioned routes", async () => {
    const { daemon, seen } = stubDaemon();
    await daemon.snapshot("s-1");
    await daemon.listPosts("s-1", 0, 10);
    const members = await daemon.listMembers("s-1");
    const tasks = await daemon.listTasks("s-1");
    expect(members.members.length).toBe(2);
    expect(tasks.tasks.length).toBe(1);
    expect(seen.length).toBe(4);
    for (const url of seen) {
      expect(url.startsWith("http://127.0.0.1:9/v1/") || url.startsWith("http://127.0.0.1:9/healthz")).toBe(true);
    }
    expect(seen.filter((u) => u.includes("/posts?")).length).toBe(1);
    expect(seen.filter((u) => u === "http://127.0.0.1:9/v1/swarms/s-1").length).toBe(3);
  });

  test("pause/resume/cancel hit only versioned lifecycle routes", async () => {
    const { daemon, seen } = stubDaemon();
    await daemon.pauseSwarm("s-1");
    await daemon.resumeSwarm("s-1");
    await daemon.cancelSwarm("s-1");
    expect(seen).toEqual([
      "http://127.0.0.1:9/v1/swarms/s-1/pause",
      "http://127.0.0.1:9/v1/swarms/s-1/resume",
      "http://127.0.0.1:9/v1/swarms/s-1/cancel",
    ]);
  });
});
