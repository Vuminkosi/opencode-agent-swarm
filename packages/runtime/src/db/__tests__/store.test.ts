/**
 * Store behavior tests — M1-01: migrations repeatable, CRUD, transition
 * guards, self-accept, killed-never-wakes, outbox atomicity, batching.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ProtocolError } from "@vuminkosi/protocol";
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

function seed(store: SwarmStore): { swarmId: string; alice: string; bob: string; coord: string } {
  const swarm = store.createSwarm({
    title: "swarm-1",
    coordinatorSessionId: "ses-coord",
    projectRoot: "C:/repo",
    mode: "parity",
  });
  const add = (name: string, sessionId: string, role: "coordinator" | "coder" = "coder"): string =>
    store.addMember(swarm.id, {
      name,
      groups: name === "alice" || name === "bob" ? ["frontend"] : [],
      role,
      nativeAgentId: "build",
      sessionId,
      model: { providerID: "p", id: "m" },
    }).id;
  const coord = add("coord", "ses-coord", "coordinator");
  const alice = add("alice", "ses-alice");
  const bob = add("bob", "ses-bob");
  return { swarmId: swarm.id, alice, bob, coord };
}

describe("migrations", () => {
  test("repeatable: second run applies nothing", () => {
    const store = openStore();
    expect(store.runMigrations()).toEqual([]);
  });

  test("enum CHECKs enforced", () => {
    const store = openStore();
    const swarm = store.createSwarm({
      title: "t",
      coordinatorSessionId: "s",
      projectRoot: "r",
      mode: "safe-coding",
    });
    expect(swarm.mode).toBe("safe-coding");
    throwsCode(
      () =>
        store.createSwarm({ title: "t", coordinatorSessionId: "s", projectRoot: "r", mode: "yolo" as never }),
      "VALIDATION_FAILED",
    );
  });
});

describe("members", () => {
  test("duplicate name rejected", () => {
    const store = openStore();
    const { swarmId } = seed(store);
    throwsCode(
      () =>
        store.addMember(swarmId, {
          name: "alice",
          groups: [],
          role: "coder",
          nativeAgentId: "build",
          sessionId: "ses-other",
          model: { providerID: "p", id: "m" },
        }),
      "DUPLICATE_NAME",
    );
  });

  test("invalid transition rejected; killed terminal", () => {
    const store = openStore();
    const { alice } = seed(store);
    throwsCode(() => store.transitionMember(alice, "quota_paused"), "INVALID_TRANSITION");
    store.transitionMember(alice, "working");
    const m = store.getMember(alice);
    expect(m.internalState).toBe("working");
    store.transitionMember(alice, "killed");
    expect(store.getMember(alice).publicState).toBe("killed");
    throwsCode(() => store.transitionMember(alice, "working"), "INVALID_TRANSITION");
  });

  test("killed member cannot post or be woken", () => {
    const store = openStore();
    const { swarmId, alice, bob } = seed(store);
    store.transitionMember(alice, "working");
    store.transitionMember(alice, "killed");
    throwsCode(
      () => store.appendPost(swarmId, { authorMemberId: alice, kind: "message", body: "hi", idempotencyKey: "k1" }),
      "KILLED_MEMBER",
    );
    throwsCode(
      () =>
        store.createWakeIntent(swarmId, {
          memberId: alice,
          memberGeneration: 1,
          reason: "user_direct",
          payloadHash: "h",
        }),
      "KILLED_MEMBER",
    );
    // A mention of a killed member records the recipient but creates no wake.
    const res = store.appendPost(swarmId, {
      authorMemberId: bob,
      kind: "message",
      body: "@alice are you there?",
      idempotencyKey: "k2",
    });
    expect(res.post.mentions).toContain(alice);
    expect(res.wakeIds).toEqual([]);
  });
});

describe("tasks", () => {
  test("unknown dep rejected; invalid jump rejected", () => {
    const store = openStore();
    const { swarmId } = seed(store);
    throwsCode(
      () => store.createTask(swarmId, { title: "t", brief: "b", deps: ["ghost"] }),
      "UNKNOWN_DEP",
    );
    const t = store.createTask(swarmId, { title: "t", brief: "b" });
    throwsCode(() => store.transitionTask(t.id, "leased"), "INVALID_TRANSITION");
  });

  test("lease requires owner + accepted deps; remediation bumps attempt", () => {
    const store = openStore();
    const { swarmId, alice, bob } = seed(store);
    const a = store.createTask(swarmId, { title: "a", brief: "ba", ownerId: alice });
    const b = store.createTask(swarmId, { title: "b", brief: "bb", ownerId: bob, deps: [a.id] });
    store.transitionTask(b.id, "ready");
    throwsCode(() => store.transitionTask(b.id, "leased"), "VALIDATION_FAILED"); // dep not accepted

    // Drive A to accepted (with real evidence from a non-owner verifier).
    const verifier = store.addMember(swarmId, {
      name: "vera",
      groups: [],
      role: "verifier",
      nativeAgentId: "build",
      sessionId: "ses-vera",
      model: { providerID: "p", id: "m" },
    });
    store.transitionTask(a.id, "ready");
    store.transitionTask(a.id, "leased");
    store.transitionTask(a.id, "running");
    store.transitionTask(a.id, "verifying");
    throwsCode(() => store.transitionTask(a.id, "accepted", { verifierMemberId: alice }), "SELF_ACCEPT");
    throwsCode(() => store.transitionTask(a.id, "accepted", { verifierMemberId: verifier.id }), "VALIDATION_FAILED"); // no evidence yet
    const ts = "2026-11-11T12:00:00.000Z";
    store.recordVerificationEvidence({
      taskId: a.id,
      executorMemberId: verifier.id,
      command: "bun test",
      cwd: "C:/repo",
      exitCode: 0,
      startedAt: ts,
      finishedAt: ts,
      stdout: { sha256: "s1", filePath: ".swarm/a.stdout.log" },
      stderr: { sha256: "s2", filePath: ".swarm/a.stderr.log" },
    });
    store.transitionTask(a.id, "accepted", { verifierMemberId: verifier.id });
    expect(store.getTask(a.id).state).toBe("accepted");

    // B unblocked now.
    store.transitionTask(b.id, "leased");
    expect(store.getTask(b.id).generation).toBe(2); // fenced lease bumps generation

    // Remediation loop bumps attempt.
    store.transitionTask(b.id, "running");
    store.transitionTask(b.id, "verifying");
    store.transitionTask(b.id, "ready");
    expect(store.getTask(b.id).attempt).toBe(1);
  });
});

describe("board + outbox", () => {
  test("@all batching fans out once per live member; author excluded", () => {
    const store = openStore();
    const { swarmId, alice, bob, coord } = seed(store);
    const res = store.appendPost(swarmId, {
      authorMemberId: alice,
      kind: "brief",
      body: "@all start now",
      idempotencyKey: "batch-1",
    });
    expect(res.deduped).toBe(false);
    expect(res.post.sequence).toBe(1);
    expect(res.post.mentionAll).toBe(true);
    const queued = store.listWakes(swarmId, "queued");
    const ids = queued.map((w) => w.memberId).sort();
    expect(ids).toEqual([bob, coord].sort());
  });

  test("duplicate idempotency key returns existing post with no new wakes", () => {
    const store = openStore();
    const { swarmId, bob } = seed(store);
    const first = store.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "@bob hello",
      idempotencyKey: "dup-1",
    });
    const before = store.listWakes(swarmId, "queued").length;
    expect(before).toBe(1);
    const second = store.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "@bob hello",
      idempotencyKey: "dup-1",
    });
    expect(second.deduped).toBe(true);
    expect(second.post.id).toBe(first.post.id);
    expect(second.wakeIds).toEqual([]);
    expect(store.listWakes(swarmId, "queued").length).toBe(before);
    void bob;
  });

  test("outbox committed atomically; delivery tracked", () => {
    const store = openStore();
    const { swarmId } = seed(store);
    store.appendPost(swarmId, { authorMemberId: null, kind: "system", body: "boot", idempotencyKey: "o-1" });
    const pending = store.listPendingOutbox();
    expect(pending.some((e) => e.kind === "post_committed")).toBe(true);
    for (const e of pending) store.markOutboxDelivered(e.id);
    expect(store.listPendingOutbox()).toEqual([]);
  });

  test("one live turn: second claim defers while first is admitted", () => {
    const store = openStore();
    const { swarmId, bob } = seed(store);
    const p1 = store.appendPost(swarmId, { authorMemberId: null, kind: "message", body: "@bob one", idempotencyKey: "c-1" });
    const p2 = store.appendPost(swarmId, { authorMemberId: null, kind: "message", body: "@bob two", idempotencyKey: "c-2" });
    const first = store.claimWakeIntent(p1.wakeIds[0] as string);
    expect(first.status).toBe("admitted");
    const second = store.claimWakeIntent(p2.wakeIds[0] as string);
    expect(second.status).toBe("deferred-live-turn");
    store.setWakeState(p1.wakeIds[0] as string, "observed_running");
    store.setWakeState(p1.wakeIds[0] as string, "succeeded");
    const retry = store.claimWakeIntent(p2.wakeIds[0] as string);
    expect(retry.status).toBe("admitted");
    void bob;
  });
});
