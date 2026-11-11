/**
 * Transition + DAG tests — M1-01 (spec §13 unit list, §7 guards).
 */
import { describe, expect, test } from "bun:test";
import {
  ProtocolError,
  assertDepsAcyclic,
  assertMemberTransition,
  assertTaskTransition,
  assertVerifierAccept,
  assertWakeTransition,
  depsSatisfied,
  findCycle,
  projectPublicState,
} from "../index.js";

function throwsCode(fn: () => void, code: ProtocolError["code"]): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

describe("member transitions", () => {
  test("happy path starting -> working -> waiting -> working", () => {
    expect(() => assertMemberTransition("starting", "working")).not.toThrow();
    expect(() => assertMemberTransition("working", "waiting")).not.toThrow();
    expect(() => assertMemberTransition("waiting", "working")).not.toThrow();
  });

  test("quota/approval/recovering loops", () => {
    expect(() => assertMemberTransition("working", "quota_paused")).not.toThrow();
    expect(() => assertMemberTransition("quota_paused", "working")).not.toThrow();
    expect(() => assertMemberTransition("working", "recovering")).not.toThrow();
    expect(() => assertMemberTransition("recovering", "waiting")).not.toThrow();
  });

  test("killed is terminal", () => {
    throwsCode(() => assertMemberTransition("killed", "working"), "INVALID_TRANSITION");
    throwsCode(() => assertMemberTransition("waiting", "quota_paused"), "INVALID_TRANSITION");
  });

  test("public projection never leaks internal names", () => {
    expect(projectPublicState("quota_paused")).toBe("working");
    expect(projectPublicState("recovering")).toBe("working");
    expect(projectPublicState("waiting")).toBe("waiting");
    expect(projectPublicState("killed")).toBe("killed");
  });
});

describe("task transitions", () => {
  test("draft -> ready -> leased -> running -> verifying -> accepted", () => {
    for (const [from, to] of [
      ["draft", "ready"],
      ["ready", "leased"],
      ["leased", "running"],
      ["running", "verifying"],
      ["verifying", "accepted"],
    ] as const) {
      expect(() => assertTaskTransition(from, to)).not.toThrow();
    }
  });

  test("remediation + blocked loops", () => {
    expect(() => assertTaskTransition("verifying", "ready")).not.toThrow();
    expect(() => assertTaskTransition("running", "blocked")).not.toThrow();
    expect(() => assertTaskTransition("blocked", "ready")).not.toThrow();
  });

  test("invalid jumps rejected", () => {
    throwsCode(() => assertTaskTransition("draft", "leased"), "INVALID_TRANSITION");
    throwsCode(() => assertTaskTransition("ready", "accepted"), "INVALID_TRANSITION");
    throwsCode(() => assertTaskTransition("accepted", "ready"), "INVALID_TRANSITION");
    throwsCode(() => assertTaskTransition("failed", "ready"), "INVALID_TRANSITION");
  });

  test("worker cannot self-accept", () => {
    throwsCode(() => assertVerifierAccept("m-1", "m-1"), "SELF_ACCEPT");
    expect(() => assertVerifierAccept("m-1", "m-2")).not.toThrow();
    expect(() => assertVerifierAccept(null, "m-2")).not.toThrow();
  });
});

describe("wake transitions", () => {
  test("queued -> admitted -> observed_running -> succeeded", () => {
    expect(() => assertWakeTransition("queued", "admitted")).not.toThrow();
    expect(() => assertWakeTransition("admitted", "observed_running")).not.toThrow();
    expect(() => assertWakeTransition("observed_running", "succeeded")).not.toThrow();
  });

  test("no resurrection from terminal states", () => {
    throwsCode(() => assertWakeTransition("succeeded", "queued"), "INVALID_TRANSITION");
    throwsCode(() => assertWakeTransition("cancelled", "admitted"), "INVALID_TRANSITION");
  });
});

describe("DAG", () => {
  test("diamond is acyclic", () => {
    expect(findCycle(["a", "b", "c", "d"], [["b", "a"], ["c", "a"], ["d", "b"], ["d", "c"]])).toBeNull();
  });

  test("cycle detected with path", () => {
    const cycle = findCycle(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]);
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
  });

  test("self-dep rejected", () => {
    throwsCode(() => assertDepsAcyclic("a", ["a"], [], []), "SELF_DEP");
  });

  test("unknown dep rejected", () => {
    throwsCode(() => assertDepsAcyclic("b", ["ghost"], ["a"], []), "UNKNOWN_DEP");
  });

  test("cycle-creating edge rejected at creation", () => {
    throwsCode(() => assertDepsAcyclic("c", ["a"], ["a", "b"], [["a", "b"], ["b", "c"]]), "DAG_CYCLE");
  });

  test("release only after accepted", () => {
    expect(depsSatisfied({ a: "accepted", b: "accepted" })).toBe(true);
    expect(depsSatisfied({ a: "accepted", b: "verifying" })).toBe(false);
    expect(depsSatisfied({})).toBe(true);
  });
});
