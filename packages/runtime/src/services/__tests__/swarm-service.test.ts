/**
 * M1-04 swarm-service tests — validation, brief immutability, queue-only
 * dispatch, lead write restriction, zero-token status.
 *
 * Uses a fake queue-only harness (records every call; rejects `steer`) and
 * a disposable `:memory:` SwarmStore: no network, no model inference, no
 * canonical-tree writes.
 */
import { describe, test, expect } from "bun:test";
import { ProtocolError } from "@vuminkosi/protocol";
import { SwarmStore } from "../../db/store.js";
import {
  COORDINATOR_WRITE_DENY_RULES,
  SwarmService,
  assertRoleAllows,
  validateRequirement,
  validateWorkerNames,
  type ActivationHarness,
} from "../swarm-service.js";

interface SubmittedTurn {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string;
  readonly externalId: string;
  readonly reason: string;
}

class FakeHarness implements ActivationHarness {
  submitted: SubmittedTurn[] = [];
  appliedRules: Array<{ sessionId: string; rules: readonly { scope: string; action: string }[] }> = [];
  sessions = 0;

  async createSession(title: string, _directory: string): Promise<{ sessionId: string }> {
    this.sessions += 1;
    return { sessionId: `sess-fake-${this.sessions}-${title.length}` };
  }

  async switchAgent(_sessionId: string, _agentId: string): Promise<void> {}

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "assigned_task";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    if (request.delivery !== "queue") throw new Error(`STEER_REJECTED: ${request.delivery}`);
    this.submitted.push({ ...request });
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async applyPermissionRules(
    sessionId: string,
    rules: readonly { readonly scope: string; readonly action: "allow" | "deny" }[],
  ): Promise<void> {
    this.appliedRules.push({ sessionId, rules: [...rules] });
  }
}

function setup(): { store: SwarmStore; harness: FakeHarness; service: SwarmService } {
  const store = new SwarmStore(":memory:");
  const harness = new FakeHarness();
  return { store, harness, service: new SwarmService(store, harness) };
}

/** Fail-closed resolver fixture: every successful activation supplies an
 *  explicit active-session model (MODEL-INHERIT-01). */
const ACTIVE_MODEL = { providerID: "prov-active", id: "model-active" } as const;

describe("activation validation", () => {
  test("empty requirement is rejected", () => {
    expect(() => validateRequirement("   ")).toThrow(ProtocolError);
  });

  test("worker names must be exactly two, unique, well-formed", () => {
    expect(() => validateWorkerNames(["only-one"])).toThrow(ProtocolError);
    expect(() => validateWorkerNames(["a", "a"])).toThrow(ProtocolError);
    expect(() => validateWorkerNames(["bad name!", "ok"])).toThrow(ProtocolError);
    expect(validateWorkerNames(["worker-a", "worker-b"])).toEqual(["worker-a", "worker-b"]);
  });

  test("activateSwarm rejects empty requirement without touching the harness", async () => {
    const { store, harness, service } = setup();
    try {
      await expect(
        service.activateSwarm({ requirement: "  ", coordinatorSessionId: "sess-lead", projectRoot: "/tmp/x" }),
      ).rejects.toBeInstanceOf(ProtocolError);
      expect(harness.sessions).toBe(0);
      expect(harness.submitted.length).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("activation creates swarm + lead + 2 workers + briefs", () => {
  test("one swarm, one lead, two workers, two public briefs, recorded dispatch", async () => {
    const { store, harness, service } = setup();
    try {
      const result = await service.activateSwarm({
        requirement: "Add tests to two independent fixture modules",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m104",
        modelContext: { activeSessionModel: ACTIVE_MODEL },
      });

      expect(result.workers.length).toBe(2);
      expect(result.coordinator.role).toBe("coordinator");
      expect(result.coordinator.name).toBe("lead");

      const members = store.listMembers(result.swarm.id);
      expect(members.map((m) => m.role).sort()).toEqual(["coder", "coder", "coordinator"]);

      const tasks = store.listTasks(result.swarm.id);
      expect(tasks.length).toBe(2);
      // Non-colliding ownership: each task owns exactly its own area.
      const owned = tasks.map((t) => t.ownedPaths);
      expect(owned[0]).not.toEqual(owned[1]);

      const posts = store.getPostsAfter(result.swarm.id, 0);
      expect(posts.length).toBe(2);
      expect(posts.map((p) => p.kind)).toEqual(["brief", "brief"]);
      expect(posts.map((p) => p.sequence)).toEqual([1, 2]);
      // Every brief mentions its worker and carries ownership/exclusions/done criteria.
      for (const w of result.workers) {
        expect(w.brief.body).toContain(`@${w.member.name} `);
        expect(w.brief.mentions).toContain(w.member.id);
        expect(w.brief.body).toContain("Ownership:");
        expect(w.brief.body).toContain("Exclusions:");
        expect(w.brief.body).toContain("Done when:");
      }

      // Queue-only dispatch: exactly two turns, both delivery "queue".
      expect(harness.submitted.length).toBe(2);
      for (const turn of harness.submitted) expect(turn.delivery).toBe("queue");
      expect(service.getDispatchCount()).toBe(2);
    } finally {
      store.close();
    }
  });

  test("briefs are immutable: same idempotency key dedupes, body unchanged", async () => {
    const { store, service } = setup();
    try {
      const result = await service.activateSwarm({
        requirement: "Add tests to two independent fixture modules",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m104",
        modelContext: { activeSessionModel: ACTIVE_MODEL },
      });
      const before = store.getPostsAfter(result.swarm.id, 0);
      const dupe = store.appendPost(result.swarm.id, {
        authorMemberId: result.coordinator.id,
        kind: "brief",
        body: "tampered body",
        relatedTaskId: result.workers[0]?.task.id,
        idempotencyKey: `m104-brief-${result.swarm.id}-worker-a`,
      });
      expect(dupe.deduped).toBe(true);
      const after = store.getPostsAfter(result.swarm.id, 0);
      expect(after.length).toBe(before.length);
      expect(after[0]?.body).toBe(before[0]?.body);
      expect(service.getDispatchCount()).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("lead write restriction (role policy + tool auth, not prompt-only)", () => {
  test("coordinator may coordinate but may not edit-code or merge", () => {
    expect(() => assertRoleAllows("coordinator", "coordinate")).not.toThrow();
    expect(() => assertRoleAllows("coordinator", "edit-code")).toThrow(ProtocolError);
    expect(() => assertRoleAllows("coordinator", "merge")).toThrow(ProtocolError);
    expect(() => assertRoleAllows("coder", "edit-code")).not.toThrow();
    expect(() => assertRoleAllows("coder", "merge")).toThrow(ProtocolError);
  });

  test("activation denies edit/write scopes on the coordinator session via the harness", async () => {
    const { store, harness, service } = setup();
    try {
      await service.activateSwarm({
        requirement: "Add tests to two independent fixture modules",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m104",
        modelContext: { activeSessionModel: ACTIVE_MODEL },
      });
      const leadRules = harness.appliedRules.find((r) => r.sessionId === "sess-lead");
      expect(leadRules).toBeDefined();
      const scopes = new Map(leadRules?.rules.map((r) => [r.scope, r.action] as const) ?? []);
      expect(scopes.get("edit")).toBe("deny");
      expect(scopes.get("write")).toBe("deny");
      expect([...COORDINATOR_WRITE_DENY_RULES].length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});

describe("zero-token status", () => {
  test("status reads SQLite only: no harness calls, modelCalls is 0", async () => {
    const { store, harness, service } = setup();
    try {
      const result = await service.activateSwarm({
        requirement: "Add tests to two independent fixture modules",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m104",
        modelContext: { activeSessionModel: ACTIVE_MODEL },
      });
      const submittedBefore = harness.submitted.length;
      const appliedBefore = harness.appliedRules.length;
      const sessionsBefore = harness.sessions;

      const first = service.getStatusSnapshot(result.swarm.id);
      const second = service.getStatusSnapshot(result.swarm.id, 1);

      expect(first.telemetry.modelCalls).toBe(0);
      expect(second.telemetry.modelCalls).toBe(0);
      expect(first.swarm.id).toBe(result.swarm.id);
      expect(first.members.length).toBe(3);
      expect(first.tasks.length).toBe(2);
      expect(first.posts.length).toBe(2);
      expect(second.posts.map((p) => p.sequence)).toEqual([2]);
      // Status moved no harness counters: zero-token proof.
      expect(harness.submitted.length).toBe(submittedBefore);
      expect(harness.appliedRules.length).toBe(appliedBefore);
      expect(harness.sessions).toBe(sessionsBefore);
      expect(service.getDispatchCount()).toBe(2);
    } finally {
      store.close();
    }
  });
});
