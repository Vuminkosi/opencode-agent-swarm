/**
 * M1-05 fixture module-a tests: objective assertions proving deterministic
 * behavior and independence (AC1). No network, no inference.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownsPath, buildTaskSummary, checksum } from "./index.ts";

const ownSource = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const siblingSource = readFileSync(join(import.meta.dir, "..", "module-b", "index.ts"), "utf8");

describe("module-a logic", () => {
  test("owns only workers/worker-a paths", () => {
    expect(ownsPath("workers/worker-a/task.json")).toBe(true);
    expect(ownsPath("workers/worker-a/")).toBe(true);
    expect(ownsPath("workers/worker-b/task.json")).toBe(false);
    expect(ownsPath("other/x")).toBe(false);
    expect(ownsPath("")).toBe(false);
  });

  test("buildTaskSummary is deterministic", () => {
    const task = { id: "t1", title: "Do thing", ownedPath: "workers/worker-a/t1" };
    expect(buildTaskSummary(task)).toBe("[worker-a] t1: Do thing @ workers/worker-a/t1");
    expect(buildTaskSummary(task)).toBe(buildTaskSummary({ ...task }));
  });

  test("checksum is deterministic and input-sensitive", () => {
    expect(checksum("abc")).toBe(checksum("abc"));
    expect(checksum("abc")).not.toBe(checksum("abd"));
    expect(checksum("")).toBe(0);
  });
});

describe("module-a independence (AC1)", () => {
  test("no cross-module import and no node imports", () => {
    expect(ownSource).not.toContain("module-b");
    expect(ownSource).not.toContain("node:");
  });

  test("ownership is disjoint from module-b", () => {
    expect(siblingSource).toContain("workers/worker-b/");
    expect(ownSource).toContain("workers/worker-a/");
    expect(ownSource).not.toContain("workers/worker-b/");
  });
});
