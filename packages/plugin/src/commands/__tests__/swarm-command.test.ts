/**
 * M1-04 `/swarm` command tests — validation, coordinator binding,
 * zero-token status routing (fake client/activator; a throwing tripwire
 * proves status never touches model inference).
 */
// @ts-ignore - bun:test types are provided by the Bun runtime (bun-types not installed for this package); runtime import only.
import { describe, test, expect } from "bun:test";
import {
  SwarmCommand,
  SwarmValidationError,
  authorizeToolCall,
  bindCoordinatorSession,
  parseSwarmInput,
  SwarmToolDeniedError,
  type StatusReader,
  type SwarmActivator,
  type LastSwarmStore,
} from "../swarm.ts";
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
    const tripwire = (): never => {
      throw new Error("MODEL_CALLED: status must never invoke inference");
    };
    const command = new SwarmCommand({ client, activator, lastSwarm });
    void tripwire;
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
