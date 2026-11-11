/**
 * Protocol schema tests — M1-01 acceptance (1): Zod-single-source
 * Swarm/Member/Task/BoardPost/WakeIntent/VerificationEvidence +
 * envelope (schemaVersion/correlationId/idempotency).
 */
import { describe, expect, test } from "bun:test";
import {
  AppendPostInputSchema,
  BoardPostSchema,
  CreateSwarmInputSchema,
  EnvelopeSchema,
  MemberSchema,
  SCHEMA_VERSION,
  SwarmSchema,
  TaskSchema,
  VerificationEvidenceSchema,
  WakeIntentSchema,
  makeEnvelope,
} from "../index.js";

const ts = "2026-11-11T12:00:00.000Z";

describe("envelope", () => {
  test("carries schemaVersion + correlationId", () => {
    const env = makeEnvelope("swarm-1");
    expect(env.schemaVersion).toBe(SCHEMA_VERSION);
    expect(env.swarmId).toBe("swarm-1");
    expect(() => EnvelopeSchema.parse(env)).not.toThrow();
  });

  test("rejects wrong schemaVersion", () => {
    expect(() =>
      EnvelopeSchema.parse({ schemaVersion: 999, swarmId: "s", correlationId: crypto.randomUUID() }),
    ).toThrow();
  });

  test("rejects non-uuid correlationId", () => {
    expect(() => EnvelopeSchema.parse({ schemaVersion: 1, swarmId: "s", correlationId: "nope" })).toThrow();
  });
});

describe("entity schemas", () => {
  test("swarm round-trips", () => {
    const swarm = SwarmSchema.parse({
      id: "swarm-1",
      title: "demo",
      coordinatorSessionId: "ses-1",
      projectRoot: "C:/repo",
      mode: "parity",
      status: "planning",
      createdAt: ts,
      updatedAt: ts,
      revision: 0,
    });
    expect(swarm.revision).toBe(0);
  });

  test("member requires valid name + model ref", () => {
    expect(() =>
      MemberSchema.parse({
        id: "m-1",
        swarmId: "s",
        name: "bad name!",
        groups: [],
        role: "coder",
        nativeAgentId: "build",
        sessionId: "ses-2",
        model: { providerID: "p", id: "m" },
        publicState: "working",
        internalState: "starting",
        generation: 1,
        lastActivityAt: ts,
        killedAt: null,
      }),
    ).toThrow();
  });

  test("task defaults collections", () => {
    const task = TaskSchema.parse({
      id: "t-1",
      swarmId: "s",
      title: "t",
      brief: "b",
      ownerId: null,
      state: "draft",
      attempt: 0,
      generation: 1,
      worktreePath: null,
      baseCommit: null,
    });
    expect(task.deps).toEqual([]);
    expect(task.acceptanceCriteria).toEqual([]);
  });

  test("board post requires idempotency key", () => {
    expect(() =>
      BoardPostSchema.parse({
        id: "p-1",
        swarmId: "s",
        sequence: 1,
        authorMemberId: null,
        kind: "message",
        body: "hi",
        mentions: [],
        groupMentions: [],
        mentionAll: false,
        createdAt: ts,
        idempotencyKey: "",
        relatedTaskId: null,
      }),
    ).toThrow();
  });

  test("wake intent + evidence parse", () => {
    const wake = WakeIntentSchema.parse({
      id: "w-1",
      swarmId: "s",
      memberId: "m-1",
      memberGeneration: 1,
      reason: "mention",
      postSequence: 3,
      taskId: null,
      payloadHash: "abc",
      state: "queued",
      attempts: 0,
      createdAt: ts,
    });
    expect(wake.postSequence).toBe(3);
    const ev = VerificationEvidenceSchema.parse({
      id: "e-1",
      taskId: "t-1",
      commitSha: null,
      command: "bun test",
      cwd: "C:/repo",
      exitCode: 0,
      startedAt: ts,
      finishedAt: ts,
      stdoutArtifactId: "a-1",
      stderrArtifactId: "a-2",
      executorMemberId: "m-9",
    });
    expect(ev.exitCode).toBe(0);
  });

  test("daemon inputs validate at the boundary", () => {
    expect(() => CreateSwarmInputSchema.parse({ title: "", coordinatorSessionId: "s", projectRoot: "r", mode: "parity" })).toThrow();
    expect(() =>
      AppendPostInputSchema.parse({ authorMemberId: null, kind: "nope", body: "x", idempotencyKey: "k" }),
    ).toThrow();
  });
});
