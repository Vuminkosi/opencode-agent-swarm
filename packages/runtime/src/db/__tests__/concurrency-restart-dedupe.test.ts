/**
 * Journal durability tests — M1-01 acceptance:
 * - 100-way concurrent appends: unique + contiguous board sequence.
 * - Restart lossless: file close/reopen preserves posts, sequence continues.
 * - Wake dedupe incl. the NULL-composite caveat closed by delivery_key.
 * - Migration repeatability across restarts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../store.js";

const stores: SwarmStore[] = [];
function openStore(path: string): SwarmStore {
  const s = new SwarmStore(path);
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function seedSwarm(store: SwarmStore): string {
  const swarm = store.createSwarm({
    title: "conc",
    coordinatorSessionId: "ses-c",
    projectRoot: "C:/repo",
    mode: "parity",
  });
  for (const [name, session] of [["w1", "s1"], ["w2", "s2"], ["w3", "s3"]] as const) {
    store.addMember(swarm.id, {
      name,
      groups: [],
      role: "coder",
      nativeAgentId: "build",
      sessionId: session,
      model: { providerID: "p", id: "m" },
    });
  }
  return swarm.id;
}

describe("concurrent appends", () => {
  test("100 appends yield unique contiguous sequences 1..100", async () => {
    const store = openStore(":memory:");
    const swarmId = seedSwarm(store);
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        (async (): Promise<number> => {
          const { post } = store.appendPost(swarmId, {
            authorMemberId: null,
            kind: "message",
            body: `concurrent message ${i}`,
            idempotencyKey: `conc-${i}`,
          });
          return post.sequence;
        })(),
      ),
    );
    const sorted = [...results].sort((a, b) => a - b);
    expect(new Set(results).size).toBe(100);
    expect(sorted).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    // Replay order matches commit order.
    const replay = store.getPostsAfter(swarmId, 0, 200);
    expect(replay.map((p) => p.sequence)).toEqual(sorted);
  });
});

describe("restart lossless", () => {
  test("close/reopen preserves posts and continues the sequence", () => {
    const path = join(tmpdir(), `swarm-m101-restart-${Date.now()}.sqlite`);
    const first = openStore(path);
    const swarmId = seedSwarm(first);
    for (let i = 0; i < 5; i++) {
      first.appendPost(swarmId, {
        authorMemberId: null,
        kind: "message",
        body: `pre-restart ${i}`,
        idempotencyKey: `pre-${i}`,
      });
    }
    expect(first.runMigrations()).toEqual([]);
    first.close();
    stores.splice(0);

    const second = openStore(path);
    expect(second.runMigrations()).toEqual([]); // repeatable across restarts
    const replay = second.getPostsAfter(swarmId, 0, 100);
    expect(replay).toHaveLength(5);
    expect(replay.map((p) => p.body)).toEqual(
      Array.from({ length: 5 }, (_, i) => `pre-restart ${i}`),
    );
    const next = second.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "post-restart",
      idempotencyKey: "post-1",
    });
    expect(next.post.sequence).toBe(6);
    expect(second.getSwarm(swarmId).revision).toBe(6);
  });
});

describe("wake dedupe (delivery_key)", () => {
  test("identical assigned_task intent dedupes even with NULL post_sequence", () => {
    const store = openStore(":memory:");
    const swarmId = seedSwarm(store);
    const member = store.listMembers(swarmId)[0];
    if (member === undefined) throw new Error("seed failed");
    const payload = {
      memberId: member.id,
      memberGeneration: member.generation,
      reason: "assigned_task" as const,
      payloadHash: "task-body-hash",
    };
    const first = store.createWakeIntent(swarmId, payload);
    const second = store.createWakeIntent(swarmId, payload);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.intent.id).toBe(first.intent.id);
    // Same member+reason but different payload (different task) stays distinct.
    const third = store.createWakeIntent(swarmId, { ...payload, payloadHash: "other-task-hash" });
    expect(third.deduped).toBe(false);
  });

  test("mention wakes for two posts are distinct (post sequence in key)", () => {
    const store = openStore(":memory:");
    const swarmId = seedSwarm(store);
    const target = store.listMembers(swarmId).find((m) => m.name === "w1");
    if (target === undefined) throw new Error("seed failed");
    const p1 = store.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "@w1 first",
      idempotencyKey: "m-1",
    });
    const p2 = store.appendPost(swarmId, {
      authorMemberId: null,
      kind: "message",
      body: "@w1 second",
      idempotencyKey: "m-2",
    });
    expect(p1.wakeIds).toHaveLength(1);
    expect(p2.wakeIds).toHaveLength(1);
    expect(p1.wakeIds[0]).not.toBe(p2.wakeIds[0]);
    void target;
  });
});
