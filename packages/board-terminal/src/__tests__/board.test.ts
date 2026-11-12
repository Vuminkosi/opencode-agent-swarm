/**
 * M6-02 board-terminal tests — ordering, filters, private isolation, roster
 * transitions, live-update + reconnect, session-nav data, task/verification
 * visibility, usage accuracy, zero-inference.
 *
 * Hermetic: InMemoryBoardSource only (no store import, no daemon, no
 * network). tmp DBs: none needed — the source is in-memory by design (the
 * contract forbids new persistence in this package).
 */

import { describe, test, expect } from "bun:test";
import {
  BoardSession,
  FakeHarness,
  InMemoryBoardSource,
  assertZeroInference,
  buildRoster,
  buildTaskViews,
  collapseWakes,
  deliveryForPost,
  filterPosts,
  renderBoard,
  renderDeliveryLine,
  renderPostLine,
  renderRosterLine,
  renderTaskLine,
  renderUsage,
  sessionNav,
  type BoardMember,
  type BoardPost,
  type BoardWake,
  type PrivateInput,
} from "../board.js";

let seq = 0;

function member(over: Partial<BoardMember> & { id: string; name: string }): BoardMember {
  return {
    swarmId: "swarm-1",
    groups: [],
    role: "coder",
    nativeAgentId: `agent-${over.name}`,
    sessionId: `ses-${over.name}`,
    model: { providerID: "conn-test", id: "model-a" },
    publicState: "working",
    internalState: "working",
    generation: 1,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    killedAt: null,
    ...over,
  };
}

function post(over: Partial<BoardPost> & { body: string }): BoardPost {
  seq += 1;
  return {
    id: `post-${seq}`,
    swarmId: "swarm-1",
    sequence: seq,
    authorMemberId: null,
    kind: "message",
    mentions: [],
    groupMentions: [],
    mentionAll: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    idempotencyKey: `key-${seq}`,
    relatedTaskId: null,
    ...over,
  };
}

function wake(over: Partial<BoardWake> & { id: string; memberId: string }): BoardWake {
  return {
    swarmId: "swarm-1",
    memberGeneration: 1,
    reason: "mention",
    postSequence: null,
    taskId: null,
    payloadHash: `ph-${over.id}`,
    state: "queued",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("ordering", () => {
  test("stream renders in sequence order regardless of insert order", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const p2 = post({ sequence: 2, authorMemberId: "m-alice", body: "second" });
    const p1 = post({ sequence: 1, authorMemberId: "m-alice", body: "first" });
    const src = new InMemoryBoardSource({ members: [alice], posts: [p2, p1] });
    const lines = renderBoard(src, "swarm-1");
    const stream = lines.filter((l) => l.startsWith("#"));
    expect(stream[0]?.includes("#1")).toBe(true);
    expect(stream[1]?.includes("#2")).toBe(true);
  });
});

describe("filters", () => {
  test("member filter matches author, recipient, and @name text", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const bob = member({ id: "m-bob", name: "bob" });
    const posts = [
      post({ authorMemberId: "m-alice", body: "hello @bob", mentions: ["m-bob"] }),
      post({ authorMemberId: "m-bob", kind: "question", body: "unrelated work" }),
    ];
    const byMember = filterPosts(posts, [alice, bob], { memberId: "m-bob" });
    expect(byMember.length).toBe(2);
    const byKind = filterPosts(posts, [alice, bob], { kind: "question" });
    expect(byKind.length).toBe(1);
    const bySearch = filterPosts(posts, [alice, bob], { search: "hello" });
    expect(bySearch.length).toBe(1);
  });

  test("group and broadcast mentions render from canonical ids", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice", groups: ["frontend"] });
    const g = post({ authorMemberId: null, kind: "brief", body: "team sync", groupMentions: ["frontend"] });
    const b = post({ authorMemberId: null, kind: "system", body: "all hands", mentionAll: true });
    expect(renderPostLine(g, [alice])).toContain("@frontend");
    expect(renderPostLine(b, [alice])).toContain("@all");
    const groupOnly = filterPosts([g, b], [alice], { search: "team" });
    expect(groupOnly.length).toBe(1);
  });
});

describe("private isolation", () => {
  test("private user→worker input NEVER renders on the public board", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const secret: PrivateInput = {
      toMemberId: "m-alice",
      body: "SECRET-TOKEN private steering for alice only",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const src = new InMemoryBoardSource({
      members: [alice],
      posts: [post({ authorMemberId: "m-alice", body: "public hello" })],
    });
    // The renderer has no parameter slot for PrivateInput: prove the secret
    // cannot leak even when held beside the board.
    const lines = renderBoard(src, "swarm-1");
    const joined = lines.join("\n");
    expect(joined).toContain("public hello");
    expect(joined).not.toContain(secret.body);
    expect(joined).not.toContain("SECRET-TOKEN");
  });
});

describe("delivery and wake status", () => {
  test("unrelated posts wake nobody (visible)", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const p = post({ authorMemberId: "m-alice", body: "thinking out loud" });
    const src = new InMemoryBoardSource({ members: [alice], posts: [p] });
    const lines = renderBoard(src, "swarm-1", { deliveryWakes: [] });
    expect(lines.join("\n")).toContain("woke nobody");
    expect(lines.join("\n")).toContain("no wakes (unrelated posts wake nobody)");
    expect(deliveryForPost(p, [])).toEqual([]);
  });

  test("duplicate delivery keys collapse to a single logical action", () => {
    const w1 = wake({ id: "w-1", memberId: "m-bob", postSequence: 3, state: "queued" });
    const w2 = { ...w1, id: "w-2", state: "admitted" as const, attempts: 2 };
    const collapsed = collapseWakes([w1, w2]);
    expect(collapsed.length).toBe(1);
    expect(collapsed[0]?.collapsed).toBe(2);
    expect(collapsed[0]?.state).toBe("admitted");
  });
});

describe("roster transitions", () => {
  test("working/waiting/paused/killed + supplementary labels render", () => {
    const rows = [
      member({ id: "m-1", name: "w1", internalState: "working", publicState: "working" }),
      member({ id: "m-2", name: "w2", internalState: "waiting", publicState: "waiting" }),
      member({ id: "m-3", name: "q1", internalState: "quota_paused", publicState: "waiting" }),
      member({ id: "m-4", name: "k1", internalState: "killed", publicState: "killed", killedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const liveWake = wake({ id: "w-live", memberId: "m-1", state: "admitted" });
    const src = new InMemoryBoardSource({ members: rows, wakes: [liveWake] });
    const roster = buildRoster(src, "swarm-1");
    expect(roster.find((r) => r.member.id === "m-1")?.hasLiveTurn).toBe(true);
    expect(roster.find((r) => r.member.id === "m-2")?.hasLiveTurn).toBe(false);
    const lines = renderBoard(src, "swarm-1");
    const joined = lines.join("\n");
    expect(joined).toContain("Paused—quota");
    expect(joined).toContain("Ended");
    expect(joined).toContain("w1");
    // Raw ids/codes surface only in verbose mode.
    const verbose = renderBoard(src, "swarm-1", { verbose: true }).join("\n");
    expect(verbose).toContain("paused:quota");
    expect(verbose).toContain("live-turn=w-live");
  });
});

describe("live-update and reconnect", () => {
  test("follow ticks advance; paused follow holds; reconnect replays exactly", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({ members: [alice], posts: [post({ body: "one" }), post({ body: "two" })] });
    const session = new BoardSession(0, true);
    const first = session.pageNext(src, "swarm-1", 100);
    expect(first.map((p) => p.sequence)).toEqual([1, 2]);
    // Pause for history review: live ticks must not jump the page.
    session.setFollow(false);
    expect(session.liveTick(src, "swarm-1")).toEqual([]);
    // New post lands while paused; resume and tick picks it up.
    const src2 = new InMemoryBoardSource({
      members: [alice],
      posts: [...src.getPostsAfter("swarm-1", 0, 100), post({ sequence: 3, body: "three" })],
    });
    session.setFollow(true);
    const live = session.liveTick(src2, "swarm-1");
    expect(live.map((p) => p.sequence)).toEqual([3]);
    // Restart: new session replays from last sequence exactly (no offsets).
    const afterRestart = new BoardSession(2, true);
    const replayed = afterRestart.reconnect(src2, "swarm-1");
    expect(replayed.map((p) => p.sequence)).toEqual([3]);
    // Unread divider renders after lastSeen.
    session.markSeen(2);
    const lines = renderBoard(src2, "swarm-1", { lastSeenSequence: session.divider().afterSequence });
    expect(lines).toContain("── unread ──");
  });
});

describe("session-nav compat", () => {
  test("per-post author session ids present for navigator", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice", sessionId: "ses-alice-1" });
    const posts = [post({ authorMemberId: "m-alice", body: "hi" }), post({ authorMemberId: null, kind: "system", body: "boot" })];
    const nav = sessionNav(posts, [alice]);
    expect(nav[0]).toMatchObject({ authorMemberId: "m-alice", authorSessionId: "ses-alice-1" });
    expect(nav[1]?.authorSessionId).toBeNull();
  });
});

describe("task and verification visibility", () => {
  test("deps, blocked, evidence, remediation posts, monitor wakes render", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const defect = post({ kind: "verification", body: "@alice DEFECT", mentions: ["m-alice"], relatedTaskId: "t-1" });
    const src = new InMemoryBoardSource({
      members: [alice],
      posts: [defect],
      tasks: [
        {
          id: "t-0",
          swarmId: "swarm-1",
          title: "base",
          brief: "b",
          ownerId: "m-alice",
          deps: [],
          state: "accepted",
          attempt: 0,
          generation: 1,
          resultEvidenceIds: [],
        },
        {
          id: "t-1",
          swarmId: "swarm-1",
          title: "fix",
          brief: "b",
          ownerId: "m-alice",
          deps: ["t-0"],
          state: "blocked",
          attempt: 1,
          generation: 2,
          resultEvidenceIds: ["e-1", "e-2"],
        },
      ],
      evidence: [
        { id: "e-1", taskId: "t-1", executorMemberId: "m-alice", command: "bun test", exitCode: 1, commitSha: null, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z" },
        { id: "e-2", taskId: "t-1", executorMemberId: "m-alice", command: "bun test", exitCode: 0, commitSha: "abc", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.001Z" },
      ],
      wakes: [wake({ id: "w-mon", memberId: "m-alice", reason: "monitor_intervention", taskId: "t-1", state: "queued" })],
    });
    const views = buildTaskViews(src, "swarm-1", src.getPostsAfter("swarm-1", 0), src.listWakes("swarm-1", "queued"));
    const fix = views.find((v) => v.task.id === "t-1");
    expect(fix?.depsSatisfied).toBe(true);
    expect(fix?.blocked).toBe(true);
    expect(fix?.passingEvidence).toBe(1);
    expect(fix?.failingEvidence).toBe(1);
    expect(fix?.defectPostSequences).toEqual([defect.sequence]);
    expect(fix?.monitorWake).toBe(true);
    const lines = renderBoard(src, "swarm-1", { deliveryWakes: src.listWakes("swarm-1", "queued") });
    expect(lines.join("\n")).toContain("Blocked");
    expect(lines.join("\n")).toContain("monitor stepped in");
  });
});

describe("usage accuracy", () => {
  test("recorded costs render; unobserved labeled, never estimated", () => {
    const src = new InMemoryBoardSource({
      usage: [
        { providerId: "conn-a", modelId: "m1", calls: 3, inputTokens: 100, outputTokens: 50, costMicro: 1200 },
        { providerId: "conn-b", modelId: "m2", calls: 1, inputTokens: 10, outputTokens: 5, costMicro: 0 },
      ],
    });
    const lines = renderUsage(src);
    expect(lines[0]).toContain("(recorded)");
    expect(lines[1]).toContain("unobserved");
    expect(lines.join("\n")).not.toContain("~$");
    expect(lines.join("\n")).not.toContain("approx");
  });

  test("empty ledger labels unobserved instead of zero-cost claims", () => {
    const src = new InMemoryBoardSource({});
    expect(renderUsage(src)[0]).toContain("unobserved");
  });
});

describe("zero-inference", () => {
  test("roster/status/stream/usage/reconnect reads never submit turns", () => {
    seq = 0;
    const harness = new FakeHarness();
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      posts: [post({ authorMemberId: "m-alice", body: "hello @alice", mentions: ["m-alice"] })],
      tasks: [
        { id: "t-1", swarmId: "swarm-1", title: "t", brief: "b", ownerId: "m-alice", deps: [], state: "ready", attempt: 0, generation: 1, resultEvidenceIds: [] },
      ],
      usage: [{ providerId: "c", modelId: "m", calls: 1, inputTokens: 1, outputTokens: 1, costMicro: 0 }],
    });
    buildRoster(src, "swarm-1");
    renderBoard(src, "swarm-1", { deliveryWakes: src.listWakes("swarm-1", "queued"), showUsage: true });
    sessionNav(src.getPostsAfter("swarm-1", 0), src.listMembers("swarm-1"));
    new BoardSession(0).pageNext(src, "swarm-1");
    new BoardSession(0).reconnect(src, "swarm-1");
    renderUsage(src);
    // The board has no handle on the harness at all; the counter proves it.
    assertZeroInference(harness);
    expect(harness.submits).toBe(0);
  });
});

describe("D-01 collapse progression order", () => {
  test("queued + succeeded collapses to succeeded (terminal never shadowed)", () => {
    const base = wake({ id: "w-q", memberId: "m-bob", postSequence: 5, state: "queued", attempts: 0 });
    const done = { ...base, id: "w-s", state: "succeeded" as const, attempts: 1 };
    const collapsed = collapseWakes([base, done]);
    expect(collapsed.length).toBe(1);
    expect(collapsed[0]?.state).toBe("succeeded");
    expect(collapsed[0]?.attempts).toBe(1);
  });

  test("admitted + cancelled collapses to cancelled", () => {
    const base = wake({ id: "w-a", memberId: "m-bob", postSequence: 6, state: "admitted", attempts: 1 });
    const gone = { ...base, id: "w-c", state: "cancelled" as const, attempts: 1 };
    const collapsed = collapseWakes([gone, base]);
    expect(collapsed.length).toBe(1);
    expect(collapsed[0]?.state).toBe("cancelled");
  });
});

describe("D-02 reconnect advances cursor", () => {
  test("reconnect is one-shot: follow-up pageNext has no duplicates", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      posts: [post({ body: "one" }), post({ body: "two" }), post({ body: "three" })],
    });
    const session = new BoardSession(1, true);
    const replayed = session.reconnect(src, "swarm-1");
    expect(replayed.map((p) => p.sequence)).toEqual([2, 3]);
    expect(session.cursor).toBe(3);
    expect(session.pageNext(src, "swarm-1")).toEqual([]);
  });
});

describe("D-03 generation-pinned live wakes", () => {
  test("stale-generation wake does not mark the current generation live", () => {
    const current = member({ id: "m-bob", name: "bob", generation: 2 });
    const stale = wake({ id: "w-stale", memberId: "m-bob", memberGeneration: 1, state: "observed_running" });
    const src = new InMemoryBoardSource({ members: [current], wakes: [stale] });
    const roster = buildRoster(src, "swarm-1");
    expect(roster[0]?.hasLiveTurn).toBe(false);
    expect(roster[0]?.liveWakeId).toBeNull();
  });

  test("current-generation wake still marks the member live", () => {
    const current = member({ id: "m-bob", name: "bob", generation: 2 });
    const live = wake({ id: "w-live2", memberId: "m-bob", memberGeneration: 2, state: "admitted" });
    const src = new InMemoryBoardSource({ members: [current], wakes: [live] });
    const roster = buildRoster(src, "swarm-1");
    expect(roster[0]?.hasLiveTurn).toBe(true);
    expect(roster[0]?.liveWakeId).toBe("w-live2");
  });
});

describe("D-04 human roster lines", () => {
  test("default line is compact (≤80ch) with no raw ids; verbose carries ids", () => {
    const m = member({ id: "m-1", name: "amy", internalState: "quota_paused", publicState: "waiting" });
    const row = {
      member: m,
      hasLiveTurn: false,
      liveWakeId: null,
      assignedTaskIds: ["t-9"],
    } as const;
    const line = renderRosterLine(row);
    expect(line).toContain("Paused—quota");
    expect(line).toContain("1 task");
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line).not.toContain("agent-amy");
    expect(line).not.toContain("ses-amy");
    expect(line).not.toContain("t-9");
    const verbose = renderRosterLine(row, true);
    expect(verbose).toContain("agent-amy");
    expect(verbose).toContain("t-9");
  });

  test("approval/starting/recovering/ended labels render human words", () => {
    const states = [
      ["approval_paused", "Paused—approval"],
      ["starting", "Starting"],
      ["recovering", "Recovering"],
      ["killed", "Ended"],
      ["working", "Working"],
      ["waiting", "Waiting"],
    ] as const;
    for (const [internal, label] of states) {
      const m = member({ id: `m-${internal}`, name: "x", internalState: internal, publicState: "working" });
      const line = renderRosterLine({ member: m, hasLiveTurn: false, liveWakeId: null, assignedTaskIds: [] });
      expect(line).toContain(label);
    }
  });
});

describe("D-05 human delivery lines", () => {
  test("null correlation hidden, attempts as attempt N, human state words", () => {
    const alice = member({ id: "m-alice", name: "alice" });
    const line = renderDeliveryLine(
      {
        deliveryKey: "k",
        memberId: "m-alice",
        reason: "assigned_task",
        postSequence: 3,
        taskId: null,
        state: "observed_running",
        attempts: 2,
        correlationId: null,
        collapsed: 1,
      },
      [alice],
    );
    expect(line).toContain("Running");
    expect(line).toContain("attempt 2");
    expect(line).not.toContain("observed_running");
    expect(line).not.toContain("attempts=");
    expect(line).not.toContain("corr");
    const verbose = renderDeliveryLine(
      {
        deliveryKey: "k",
        memberId: "m-alice",
        reason: "assigned_task",
        postSequence: 3,
        taskId: null,
        state: "observed_running",
        attempts: 2,
        correlationId: "c-1",
        collapsed: 2,
      },
      [alice],
      true,
    );
    expect(verbose).toContain("corr=c-1");
    expect(verbose).toContain("key=k");
  });
});

describe("D-06 human task lines", () => {
  test("default hides raw ids; verbose carries ids and codes", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      tasks: [
        { id: "t-1", swarmId: "swarm-1", title: "fix login", brief: "b", ownerId: "m-alice", deps: [], state: "blocked", attempt: 1, generation: 1, resultEvidenceIds: [] },
      ],
    });
    const views = buildTaskViews(src, "swarm-1", [], []);
    const line = renderTaskLine(views[0]!);
    expect(line).toContain("fix login");
    expect(line).toContain("Blocked");
    expect(line).not.toContain("t-1");
    const verbose = renderTaskLine(views[0]!, true);
    expect(verbose).toContain("id=t-1");
  });

  test("monitor wake counts regardless of terminal state", () => {
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      tasks: [
        { id: "t-9", swarmId: "swarm-1", title: "t", brief: "b", ownerId: null, deps: [], state: "ready", attempt: 0, generation: 1, resultEvidenceIds: [] },
      ],
      wakes: [wake({ id: "w-mon2", memberId: "m-alice", reason: "monitor_intervention", taskId: "t-9", state: "succeeded" })],
    });
    const views = buildTaskViews(src, "swarm-1", [], src.listWakes("swarm-1", "succeeded"));
    expect(views.find((v) => v.task.id === "t-9")?.monitorWake).toBe(true);
  });
});

describe("D-07/D-08 board chrome and empty states", () => {
  test("stream header shows Live by default and Paused with new count", () => {
    const src = new InMemoryBoardSource({});
    expect(renderBoard(src, "swarm-1").join("\n")).toContain("-- stream (Live) --");
    expect(renderBoard(src, "swarm-1", { follow: false, pausedNewCount: 3 }).join("\n")).toContain(
      "-- stream (Paused — 3 new) --",
    );
  });

  test("empty roster and stream render friendly lines, never null dumps", () => {
    const src = new InMemoryBoardSource({});
    const joined = renderBoard(src, "swarm-1").join("\n");
    expect(joined).toContain("No members yet");
    expect(joined).toContain("No posts yet");
    expect(joined).not.toContain("null");
  });
});

describe("FIX-02 CODE F-01 taskWakes full-set", () => {
  test("queued-only delivery subset hides a succeeded monitor wake in task views", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      tasks: [
        { id: "t-1", swarmId: "swarm-1", title: "ship", brief: "b", ownerId: "m-alice", deps: [], state: "ready", attempt: 0, generation: 1, resultEvidenceIds: [] },
      ],
      wakes: [
        wake({ id: "w-q", memberId: "m-alice", reason: "mention", postSequence: 1, state: "queued" }),
        wake({ id: "w-mon", memberId: "m-alice", reason: "monitor_intervention", taskId: "t-1", state: "succeeded" }),
      ],
    });
    // Documents the bug shape: a queued-only subset has no monitor history.
    const subsetViews = buildTaskViews(src, "swarm-1", [], src.listWakes("swarm-1", "queued"));
    expect(subsetViews.find((v) => v.task.id === "t-1")?.monitorWake).toBe(false);
  });

  test("renderBoard taskWakes restores monitor history beside a filtered delivery section", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const queuedOnly = [wake({ id: "w-q", memberId: "m-alice", reason: "mention", postSequence: 1, state: "queued" })];
    const full = [
      ...queuedOnly,
      wake({ id: "w-mon", memberId: "m-alice", reason: "monitor_intervention", taskId: "t-1", state: "succeeded" }),
    ];
    const src = new InMemoryBoardSource({
      members: [alice],
      tasks: [
        { id: "t-1", swarmId: "swarm-1", title: "ship", brief: "b", ownerId: "m-alice", deps: [], state: "ready", attempt: 0, generation: 1, resultEvidenceIds: [] },
      ],
      wakes: full,
    });
    const filteredOnly = renderBoard(src, "swarm-1", { deliveryWakes: queuedOnly }).join("\n");
    expect(filteredOnly).not.toContain("monitor stepped in");
    const withFull = renderBoard(src, "swarm-1", { deliveryWakes: queuedOnly, taskWakes: full }).join("\n");
    expect(withFull).toContain("monitor stepped in");
    // Delivery section still renders the queued subset (collapsed proof intact).
    expect(withFull).toContain("-- delivery --");
  });

  test("renderBoard without a delivery prefilter keeps monitor history (fallback intact)", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const queuedOnly = [wake({ id: "w-q", memberId: "m-alice", reason: "mention", postSequence: 1, state: "queued" })];
    const src = new InMemoryBoardSource({
      members: [alice],
      tasks: [
        { id: "t-1", swarmId: "swarm-1", title: "ship", brief: "b", ownerId: "m-alice", deps: [], state: "ready", attempt: 0, generation: 1, resultEvidenceIds: [] },
      ],
      wakes: [
        ...queuedOnly,
        wake({ id: "w-mon", memberId: "m-alice", reason: "monitor_intervention", taskId: "t-1", state: "queued" }),
      ],
    });
    const lines = renderBoard(src, "swarm-1", { deliveryWakes: src.listWakes("swarm-1", "queued") }).join("\n");
    expect(lines).toContain("monitor stepped in");
  });
});

describe("FIX-02 UX F-01 verbose-gated delivery task ids", () => {
  test("default delivery line hides raw task id; verbose carries it", () => {
    const alice = member({ id: "m-alice", name: "alice" });
    const row = {
      deliveryKey: "k-task",
      memberId: "m-alice",
      reason: "assigned_task" as const,
      postSequence: 3,
      taskId: "t-42",
      state: "queued" as const,
      attempts: 0,
      correlationId: null,
      collapsed: 1,
    };
    const line = renderDeliveryLine(row, [alice]);
    expect(line).not.toContain("t-42");
    expect(line).not.toContain("on task");
    const verbose = renderDeliveryLine(row, [alice], true);
    expect(verbose).toContain("t-42");
    expect(verbose).toContain("task=t-42");
  });

  test("renderBoard delivery section default hides task ids, verbose shows them", () => {
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      tasks: [
        { id: "t-42", swarmId: "swarm-1", title: "ship", brief: "b", ownerId: "m-alice", deps: [], state: "ready", attempt: 0, generation: 1, resultEvidenceIds: [] },
      ],
      wakes: [wake({ id: "w-t", memberId: "m-alice", reason: "assigned_task", postSequence: 1, taskId: "t-42", state: "queued" })],
    });
    const wakes = src.listWakes("swarm-1", "queued");
    expect(renderBoard(src, "swarm-1", { deliveryWakes: wakes }).join("\n")).not.toContain("t-42");
    expect(renderBoard(src, "swarm-1", { deliveryWakes: wakes, verbose: true }).join("\n")).toContain("t-42");
  });
});

describe("FIX-02 UX F-02 post line clean default", () => {
  test("default post line hides related task id; verbose carries task=t-N", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const p = post({ authorMemberId: "m-alice", body: "update", relatedTaskId: "t-7" });
    expect(renderPostLine(p, [alice])).not.toContain("t-7");
    expect(renderPostLine(p, [alice])).not.toContain("task=");
    expect(renderPostLine(p, [alice], true)).toContain("task=t-7");
  });

  test("renderBoard stream default hides task refs, verbose shows them", () => {
    seq = 0;
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      posts: [post({ authorMemberId: "m-alice", body: "update", relatedTaskId: "t-7" })],
    });
    expect(renderBoard(src, "swarm-1").join("\n")).not.toContain("t-7");
    expect(renderBoard(src, "swarm-1", { verbose: true }).join("\n")).toContain("task=t-7");
  });
});

describe("FIX-02 S3 one-liners", () => {
  test("unowned tasks render Unassigned, never system", () => {
    const src = new InMemoryBoardSource({
      members: [],
      tasks: [
        { id: "t-u", swarmId: "swarm-1", title: "orphan", brief: "b", ownerId: null, deps: [], state: "ready", attempt: 0, generation: 1, resultEvidenceIds: [] },
      ],
    });
    const views = buildTaskViews(src, "swarm-1", [], []);
    expect(views[0]?.ownerName).toBe("Unassigned");
    expect(renderTaskLine(views[0]!)).toContain("Unassigned");
    expect(renderTaskLine(views[0]!)).not.toContain("system");
  });

  test("task lines never emit the dead BLOCKED suffix", () => {
    const alice = member({ id: "m-alice", name: "alice" });
    const src = new InMemoryBoardSource({
      members: [alice],
      tasks: [
        { id: "t-b", swarmId: "swarm-1", title: "stuck", brief: "b", ownerId: "m-alice", deps: [], state: "blocked", attempt: 1, generation: 1, resultEvidenceIds: [] },
      ],
    });
    const views = buildTaskViews(src, "swarm-1", [], []);
    expect(renderTaskLine(views[0]!)).toContain("Blocked");
    expect(renderTaskLine(views[0]!)).not.toContain("BLOCKED");
  });
});
