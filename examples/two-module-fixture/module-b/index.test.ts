/**
 * M1-05 fixture module-b tests: objective assertions proving deterministic
 * behavior and independence (AC1). No network, no inference.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownsPath, formatBriefLine, isForbidden } from "./index.ts";

const ownSource = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const siblingSource = readFileSync(join(import.meta.dir, "..", "module-a", "index.ts"), "utf8");

describe("module-b logic", () => {
  test("owns only workers/worker-b paths", () => {
    expect(ownsPath("workers/worker-b/task.json")).toBe(true);
    expect(ownsPath("workers/worker-b/")).toBe(true);
    expect(ownsPath("workers/worker-a/task.json")).toBe(false);
    expect(ownsPath("other/x")).toBe(false);
    expect(ownsPath("")).toBe(false);
  });

  test("formatBriefLine mentions the worker with position", () => {
    expect(formatBriefLine("worker-b", 2, 2)).toBe("@worker-b Brief 2/2");
    expect(formatBriefLine("worker-b", 2, 2)).toBe(formatBriefLine("worker-b", 2, 2));
  });

  test("isForbidden detects sibling areas only", () => {
    expect(isForbidden("workers/worker-a/t1", ["workers/worker-a/"])).toBe(true);
    expect(isForbidden("workers/worker-b/t2", ["workers/worker-a/"])).toBe(false);
    expect(isForbidden("workers/worker-b/t2", [])).toBe(false);
  });
});

describe("module-b independence (AC1)", () => {
  test("no cross-module import and no node imports", () => {
    expect(ownSource).not.toContain("module-a");
    expect(ownSource).not.toContain("node:");
  });

  test("ownership is disjoint from module-a", () => {
    expect(siblingSource).toContain("workers/worker-a/");
    expect(ownSource).toContain("workers/worker-b/");
    expect(ownSource).not.toContain("workers/worker-a/");
  });
});
