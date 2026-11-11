/**
 * M1-01 remediation guard tests (R3-R6):
 * - R3: addMember INSERT + groups commit atomically.
 * - R4: setWakeState SELECT-guard-UPDATE runs in one txn.
 * - R5: same-state transitions are no-ops with no side effects
 *        (no generation/attempt bump, no timestamp rewrite).
 * - R6: task acceptance requires >= 1 exit_code === 0 evidence row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ProtocolError } from "@opencode-swarm/protocol";
import { SwarmStore } from "../store.js";

const stores: SwarmStore[] = [];
function openStore(): SwarmStore {
  const s = new SwarmStore(":memory:");
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function throwsCode(fn: () => unknown, code: ProtocolError["code"]): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected ProtocolError ${code}`);
}

function seed(store: SwarmStore): { swarmId: string; alice: string; bob: string } {
  const swarm = store.createSwarm({
    title: "guards",
    coordinatorSessionId: "ses-coord",
    projectRoot: "C:/repo",
    mode: "parity",
  });
  const add = (name: string, sessionId: string): string =>
    store.addMember(swarm.id, {
      name,
      groups: [],
      role: "coder",
      nativeAgentId: "build",
      sessionId,
      model: { providerID: "p", id: "m" },
    }).id;
  const alice = add("alice", "ses-alice");
  const bob = add("bob", "ses-bob");
  return { swarmId: swarm.id, alice, bob };
}

describe("R5 same-state no-ops", () => {
  test("member starting->starting: no timestamp rewrite", () => {
    const store = openStore();
    const { alice } = seed(store);
    const before = store.getMember(alice).lastActivityAt;
    Bun.sleepSync(5);
    const after = store.transitionMember(alice, "starting");
    expect(after.internalState).toBe("starting");
    expect(after.lastActivityAt).toBe(before);
  });

  test("member working->working: no timestamp rewrite", () => {
    const store = openStore();
    const { alice } = seed(store);
    store.transitionMember(alice, "working");
    const before = store.getMember(alice).lastActivityAt;
    Bun.sleepSync(5);
    const after = store.transitionMember(alice, "working");
    expect(after.internalState).toBe("working");
    expect(after.lastActivityAt).toBe(before);
  });

  test("member killed->killed: stays terminal, no throw", () => {
    const store = openStore();
    const { alice } = seed(store);
    store.transitionMember(alice, "killed");
    const again = store.transitionMember(alice, "killed");
    expect(again.internalState).toBe("killed");
    expect(again.publicState).toBe("killed");
  });

  test("task draft->draft: no-op", () => {
    const store = openStore();
    const { swarmId } = seed(store);
    const t = store.createTask(swarmId, { title: "t", brief: "b" });
    const again = store.transitionTask(t.id, "draft");
    expect(again.state).toBe("draft");
    expect(again.generation).toBe(1);
    expect(again.attempt).toBe(0);
  });

  test("task leased->leased: no generation bump", () => {
    const store = openStore();
    const { swarmId, alice } = seed(store);
    const t = store.createTask(swarmId, { title: "t", brief: "b", ownerId: alice });
    store.transitionTask(t.id, "ready");
    store.transitionTask(t.id, "leased");
    expect(store.getTask(t.id).generation).toBe(2);
    const again = store.transitionTask(t.id, "leased");
    expect(again.state).toBe("leased");
    expect(again.generation).toBe(2);
  });

  test("task verifying->verifying: no attempt bump", () => {
    const store = openStore();
    const { swarmId, alice } = seed(store);
    const t = store.createTask(swarmId, { title: "t", brief: "b", ownerId: alice });
    store.transitionTask(t.id, "ready");
    store.transitionTask(t.id, "leased");
    store.transitionTask(t.id, "running");
    store.transitionTask(t.id, "verifying");
    const again = store.transitionTask(t.id, "verifying");
    expect(again.state).toBe("verifying");
    expect(again.attempt).toBe(0);
  });

  test("wake admitted->admitted: attempts unchanged", () => {
    const store = openStore();
    const { swarmId, alice } = seed(store);
    const { intent } = store.createWakeIntent(swarmId, {
      memberId: alice,
      memberGeneration: 1,
      reason: "user_direct",
      payloadHash: "h",
    });
    const claimed = store.claimWakeIntent(intent.id);
    expect(claimed.status).toBe("admitted");
    const again = store.setWakeState(intent.id, "admitted");
    expect(again.state).toBe("admitted");
    expect(again.attempts).toBe(1);
  });

  test("wake succeeded->succeeded: no throw, state kept", () => {
    const store = openStore();
    const { swarmId, alice } = seed(store);
    const { intent } = store.createWakeIntent(swarmId, {
      memberId: alice,
      memberGeneration: 1,
      reason: "user_direct",
      payloadHash: "h",
    });
    store.claimWakeIntent(intent.id);
    store.setWakeState(intent.id, "observed_running");
    store.setWakeState(intent.id, "succeeded");
    const again = store.setWakeState(intent.id, "succeeded");
    expect(again.state).toBe("succeeded");
  });
});

describe("R6 accepted gate: passing evidence required", () => {
  function toVerifying(store: SwarmStore): { taskId: string; verifierId: string } {
    const { swarmId, alice } = seed(store);
    const verifier = store.addMember(swarmId, {
      name: "vera",
      groups: [],
      role: "verifier",
      nativeAgentId: "build",
      sessionId: "ses-vera",
      model: { providerID: "p", id: "m" },
    });
    const t = store.createTask(swarmId, { title: "t", brief: "b", ownerId: alice });
    store.transitionTask(t.id, "ready");
    store.transitionTask(t.id, "leased");
    store.transitionTask(t.id, "running");
    store.transitionTask(t.id, "verifying");
    return { taskId: t.id, verifierId: verifier.id };
  }

  const ts = "2026-11-11T12:00:00.000Z";

  test("no evidence -> VALIDATION_FAILED", () => {
    const store = openStore();
    const { taskId, verifierId } = toVerifying(store);
    throwsCode(() => store.transitionTask(taskId, "accepted", { verifierMemberId: verifierId }), "VALIDATION_FAILED");
  });

  test("failing-only evidence -> VALIDATION_FAILED", () => {
    const store = openStore();
    const { taskId, verifierId } = toVerifying(store);
    store.recordVerificationEvidence({
      taskId,
      executorMemberId: verifierId,
      command: "bun test",
      cwd: "C:/repo",
      exitCode: 1,
      startedAt: ts,
      finishedAt: ts,
      stdout: { sha256: "s1", filePath: ".swarm/a.stdout.log" },
      stderr: { sha256: "s2", filePath: ".swarm/a.stderr.log" },
    });
    throwsCode(() => store.transitionTask(taskId, "accepted", { verifierMemberId: verifierId }), "VALIDATION_FAILED");
    expect(store.getTask(taskId).state).toBe("verifying");
  });

  test("one passing row unlocks acceptance", () => {
    const store = openStore();
    const { taskId, verifierId } = toVerifying(store);
    store.recordVerificationEvidence({
      taskId,
      executorMemberId: verifierId,
      command: "bun test",
      cwd: "C:/repo",
      exitCode: 1,
      startedAt: ts,
      finishedAt: ts,
      stdout: { sha256: "s1", filePath: ".swarm/a.stdout.log" },
      stderr: { sha256: "s2", filePath: ".swarm/a.stderr.log" },
    });
    store.recordVerificationEvidence({
      taskId,
      executorMemberId: verifierId,
      command: "bun test",
      cwd: "C:/repo",
      exitCode: 0,
      startedAt: ts,
      finishedAt: ts,
      stdout: { sha256: "s3", filePath: ".swarm/b.stdout.log" },
      stderr: { sha256: "s4", filePath: ".swarm/b.stderr.log" },
    });
    store.transitionTask(taskId, "accepted", { verifierMemberId: verifierId });
    expect(store.getTask(taskId).state).toBe("accepted");
  });
});

describe("R3 addMember atomicity", () => {
  test("duplicate name: DUPLICATE_NAME, no member, no orphan groups", () => {
    const store = openStore();
    const { swarmId } = seed(store);
    const beforeMembers = store.listMembers(swarmId).length;
    const beforeGroups = store.listMembers(swarmId).flatMap((m) => m.groups);
    throwsCode(
      () =>
        store.addMember(swarmId, {
          name: "alice",
          groups: ["orphan-group"],
          role: "coder",
          nativeAgentId: "build",
          sessionId: "ses-clash",
          model: { providerID: "p", id: "m" },
        }),
      "DUPLICATE_NAME",
    );
    expect(store.listMembers(swarmId)).toHaveLength(beforeMembers);
    expect(store.listMembers(swarmId).flatMap((m) => m.groups)).toEqual(beforeGroups);
  });

  test("duplicate session: DUPLICATE_NAME, no partial member", () => {
    const store = openStore();
    const { swarmId } = seed(store);
    const before = store.listMembers(swarmId).length;
    throwsCode(
      () =>
        store.addMember(swarmId, {
          name: "zed",
          groups: ["g"],
          role: "coder",
          nativeAgentId: "build",
          sessionId: "ses-alice",
          model: { providerID: "p", id: "m" },
        }),
      "DUPLICATE_NAME",
    );
    expect(store.listMembers(swarmId)).toHaveLength(before);
  });

  test("groups persist atomically with the member", () => {
    const store = openStore();
    const { swarmId } = seed(store);
    const m = store.addMember(swarmId, {
      name: "cara",
      groups: ["frontend", "api"],
      role: "coder",
      nativeAgentId: "build",
      sessionId: "ses-cara",
      model: { providerID: "p", id: "m" },
    });
    expect(m.groups).toEqual(["api", "frontend"]);
    expect(store.getMember(m.id).groups).toEqual(["api", "frontend"]);
  });
});

describe("R4 setWakeState regression", () => {
  test("full wake lifecycle still transitions in order", () => {
    const store = openStore();
    const { swarmId, alice } = seed(store);
    const { intent } = store.createWakeIntent(swarmId, {
      memberId: alice,
      memberGeneration: 1,
      reason: "user_direct",
      payloadHash: "h",
    });
    store.claimWakeIntent(intent.id);
    expect(store.setWakeState(intent.id, "observed_running").state).toBe("observed_running");
    expect(store.setWakeState(intent.id, "succeeded").state).toBe("succeeded");
    expect(store.getWake(intent.id).state).toBe("succeeded");
  });
});
