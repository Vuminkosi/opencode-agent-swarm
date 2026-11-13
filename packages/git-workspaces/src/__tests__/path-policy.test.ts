/**
 * M4-01 path-policy tests: Windows normalization (drive-letter/UNC/casefold),
 * root confinement, grant overlap, and worker write validation.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOwnedPathConflict,
  grantsOverlap,
  isWithinRoot,
  isWindowsDeviceSegment,
  normalizeForCompare,
  normalizeGrant,
  physicalFormForNewPath,
  resolveWithinRoot,
  rootKey,
  validateWorktreeWrite,
} from "../path-policy.js";

describe("normalizeForCompare — Windows rules", () => {
  test("drive letter casefold + separator unification", () => {
    expect(normalizeForCompare("c:/Repo/pkg")).toBe("c:\\repo\\pkg");
    expect(normalizeForCompare("c:/Repo/pkg")).toBe(normalizeForCompare("C:\\REPO\\pkg"));
  });

  test("trailing separators stripped except roots", () => {
    expect(normalizeForCompare("C:\\repo\\")).toBe(normalizeForCompare("C:\\repo"));
    expect(normalizeForCompare("C:\\")).toBe("c:\\");
    expect(normalizeForCompare("\\\\srv\\share\\")).toBe("\\\\srv\\share");
  });

  test("UNC server/share casefold", () => {
    expect(normalizeForCompare("\\\\SRV\\Share\\dir")).toBe(normalizeForCompare("\\\\srv\\share\\DIR"));
  });

  test("dot segments collapse, dotdot clamps at root", () => {
    expect(normalizeForCompare("C:\\a\\.\\b")).toBe(normalizeForCompare("C:\\a\\b"));
    expect(normalizeForCompare("C:\\a\\..\\b")).toBe(normalizeForCompare("C:\\b"));
    // `..` above the drive root is absorbed, never escapes the root token.
    expect(normalizeForCompare("C:\\..\\..\\b")).toBe(normalizeForCompare("C:\\b"));
  });

  test("empty path rejected", () => {
    expect(() => normalizeForCompare("   ")).toThrow();
  });

  test("rootKey equality across spellings", () => {
    expect(rootKey("c:/Work/Root")).toBe(rootKey("C:\\WORK\\root\\"));
  });
});

describe("resolveWithinRoot — confinement", () => {
  test("relative candidate joins under root", () => {
    expect(resolveWithinRoot("C:\\root", "sub/dir")).toBe(normalizeForCompare("C:\\root\\sub\\dir"));
  });

  test("absolute candidate inside root accepted", () => {
    expect(resolveWithinRoot("C:\\root", "C:\\root\\sub")).toBe(normalizeForCompare("C:\\root\\sub"));
  });

  test("dotdot escape rejected", () => {
    expect(() => resolveWithinRoot("C:\\root", "..\\evil")).toThrow();
    expect(() => resolveWithinRoot("C:\\root", "sub\\..\\..\\evil")).toThrow();
  });

  test("absolute candidate outside root rejected", () => {
    expect(() => resolveWithinRoot("C:\\root", "D:\\other")).toThrow();
    expect(() => resolveWithinRoot("C:\\root", "\\\\srv\\share\\x")).toThrow();
  });

  test("prefix-boundary trap: C:\\rooted is NOT within C:\\root", () => {
    const root = normalizeForCompare("C:\\root");
    expect(isWithinRoot(root, normalizeForCompare("C:\\rooted"))).toBe(false);
    expect(isWithinRoot(root, normalizeForCompare("C:\\root\\sub"))).toBe(true);
    expect(isWithinRoot(root, root)).toBe(true);
  });

  test("case-variant escape still rejected (casefolded comparison)", () => {
    expect(() => resolveWithinRoot("C:\\Root", "C:\\ROOT\\..\\Other")).toThrow();
  });
});

describe("normalizeGrant + grantsOverlap", () => {
  test("relative grants normalize slashes + case", () => {
    expect(normalizeGrant("packages\\Foo\\")).toBe("packages/foo");
  });

  test("overlap: equal, nested either direction", () => {
    expect(grantsOverlap("a/b", "A\\B")).toBe(true);
    expect(grantsOverlap("a/b", "a/b/c")).toBe(true);
    expect(grantsOverlap("a/b/c", "a/b")).toBe(true);
  });

  test("no overlap: siblings and prefix-trap", () => {
    expect(grantsOverlap("a/b", "a/bc")).toBe(false);
    expect(grantsOverlap("a/b", "a/c")).toBe(false);
  });

  test("repo-escaping grant rejected", () => {
    expect(() => normalizeGrant("../outside")).toThrow();
  });

  test("absolute vs relative grants never overlap", () => {
    expect(grantsOverlap("C:\\repo\\a", "a")).toBe(false);
  });
});

describe("findOwnedPathConflict — admission exclusivity", () => {
  const live = new Map<string, readonly string[]>([
    ["t-01", ["packages/foo"]],
    ["t-02", ["apps/bar"]],
  ]);

  test("no conflict for disjoint grants", () => {
    expect(findOwnedPathConflict(live, "t-03", ["packages/baz"])).toBeNull();
  });

  test("same task id is not a conflict (refresh path)", () => {
    expect(findOwnedPathConflict(live, "t-01", ["packages/foo/sub"])).toBeNull();
  });

  test("nested overlap conflicts", () => {
    const c = findOwnedPathConflict(live, "t-09", ["packages/foo/deep"]);
    expect(c?.conflictingTaskId).toBe("t-01");
  });

  test("parent overlap conflicts", () => {
    const c = findOwnedPathConflict(live, "t-09", ["packages"]);
    expect(c?.conflictingTaskId).toBe("t-01");
  });

  test("case/separator-insensitive conflict", () => {
    const c = findOwnedPathConflict(live, "t-09", ["PACKAGES\\FOO"]);
    expect(c?.conflictingTaskId).toBe("t-01");
  });
});

describe("validateWorktreeWrite — worker confinement", () => {
  const ctx = {
    canonicalRoot: "C:\\repo",
    worktreePath: "C:\\wt\\task-t1",
    ownedPaths: ["packages/foo", "docs"],
    forbiddenPaths: ["packages/foo/secrets"],
  };

  test("owned relative write allowed", () => {
    const v = validateWorktreeWrite(ctx, "packages/foo/a.ts");
    expect(v.allowed).toBe(true);
  });

  test("absolute write inside owned grant allowed", () => {
    const v = validateWorktreeWrite(ctx, "C:\\wt\\task-t1\\docs\\x.md");
    expect(v.allowed).toBe(true);
  });

  test("canonical checkout denied even though shape matches", () => {
    const v = validateWorktreeWrite(ctx, "C:\\repo\\packages\\foo\\a.ts");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("CANONICAL_CHECKOUT");
  });

  test("canonical denied via relative trickery", () => {
    const evil = { ...ctx, worktreePath: "C:\\repo\\.wt\\t1" };
    const v = validateWorktreeWrite(evil, "C:\\repo\\x.ts");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("CANONICAL_CHECKOUT");
  });

  test("outside worktree denied", () => {
    const v = validateWorktreeWrite(ctx, "C:\\wt\\task-t2\\packages\\foo\\a.ts");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("OUTSIDE_WORKTREE");
  });

  test("dotdot escape denied", () => {
    const v = validateWorktreeWrite(ctx, "..\\task-t2\\x.ts");
    expect(v.allowed).toBe(false);
  });

  test("outside ownedPaths denied (default-deny)", () => {
    const v = validateWorktreeWrite(ctx, "packages/other/a.ts");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("OUTSIDE_OWNED_PATHS");
  });

  test("empty grants deny everything", () => {
    const v = validateWorktreeWrite({ ...ctx, ownedPaths: [] }, "packages/foo/a.ts");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("OUTSIDE_OWNED_PATHS");
  });

  test("forbidden wins over owned", () => {
    const v = validateWorktreeWrite(ctx, "packages/foo/secrets/token.txt");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("FORBIDDEN_PATH");
  });

  test("forbidden directory itself denied", () => {
    const v = validateWorktreeWrite(ctx, "packages/foo/secrets");
    expect(v.allowed).toBe(false);
  });

  test("empty candidate denied", () => {
    const v = validateWorktreeWrite(ctx, "   ");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("INVALID_PATH");
  });

  test("absolute grant outside worktree never authorizes", () => {
    const c2 = { ...ctx, ownedPaths: ["C:\\elsewhere\\lib"] };
    const v = validateWorktreeWrite(c2, "C:\\elsewhere\\lib\\x.ts");
    expect(v.allowed).toBe(false);
  });
});

describe("validateWorktreeWrite — symlink/junction confinement (S1 F-01)", () => {
  function sandbox(): string {
    const base = mkdtempSync(join(tmpdir(), "gw-pol-"));
    mkdirSync(join(base, "canon"), { recursive: true });
    mkdirSync(join(base, "wt"), { recursive: true });
    mkdirSync(join(base, "outside"), { recursive: true });
    return base;
  }

  test("symlink inside worktree pointing outside is denied even when lexically owned", () => {
    const base = sandbox();
    try {
      const wt = join(base, "wt");
      const outside = join(base, "outside");
      writeFileSync(join(outside, "evil.txt"), "x");
      symlinkSync(outside, join(wt, "link"), "junction");
      const c = { canonicalRoot: join(base, "canon"), worktreePath: wt, ownedPaths: ["link"], forbiddenPaths: [] };
      // Lexically wt\link\evil.txt sits inside the owned grant — the
      // ancestor-resolved physical form (outside\evil.txt) must deny.
      const v = validateWorktreeWrite(c, "link/evil.txt");
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("OUTSIDE_WORKTREE");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("not-yet-created file through a link into canonical is denied", () => {
    const base = sandbox();
    try {
      const wt = join(base, "wt");
      const canon = join(base, "canon");
      writeFileSync(join(canon, "secret.txt"), "s");
      symlinkSync(canon, join(wt, "leak"), "junction");
      const c = { canonicalRoot: canon, worktreePath: wt, ownedPaths: ["leak"], forbiddenPaths: [] };
      const v = validateWorktreeWrite(c, "leak/new-file.txt");
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("CANONICAL_CHECKOUT");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("intra-worktree link escaping its owned dir is denied", () => {
    const base = sandbox();
    try {
      const wt = join(base, "wt");
      mkdirSync(join(wt, "a"), { recursive: true });
      mkdirSync(join(wt, "b"), { recursive: true });
      writeFileSync(join(wt, "b", "evil.txt"), "x");
      symlinkSync(join(wt, "b"), join(wt, "a", "shortcut"), "junction");
      const c = { canonicalRoot: join(base, "canon"), worktreePath: wt, ownedPaths: ["a"], forbiddenPaths: [] };
      // Lexically wt\a\shortcut\evil.txt is inside owned `a`; physically it
      // is wt\b\evil.txt — inside the worktree but outside every grant.
      const v = validateWorktreeWrite(c, "a/shortcut/evil.txt");
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("OUTSIDE_OWNED_PATHS");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("allowed write resolves to the ancestor-resolved physical form", () => {
    const base = sandbox();
    try {
      const wt = join(base, "wt");
      const c = { canonicalRoot: join(base, "canon"), worktreePath: wt, ownedPaths: ["pkgs"], forbiddenPaths: [] as string[] };
      const lexical = normalizeForCompare(join(wt, "pkgs", "a.ts"));
      const v = validateWorktreeWrite(c, "pkgs/a.ts");
      expect(v.allowed).toBe(true);
      if (v.allowed) expect(v.resolvedPath).toBe(physicalFormForNewPath(lexical));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("forbidden dir reached through a link is still denied", () => {
    const base = sandbox();
    try {
      const wt = join(base, "wt");
      mkdirSync(join(wt, "pkgs", "keys"), { recursive: true });
      symlinkSync(join(wt, "pkgs", "keys"), join(wt, "pkgs", "alias"), "junction");
      const c = {
        canonicalRoot: join(base, "canon"),
        worktreePath: wt,
        ownedPaths: ["pkgs"],
        forbiddenPaths: ["pkgs/keys"],
      };
      const v = validateWorktreeWrite(c, "pkgs/alias/token.txt");
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("FORBIDDEN_PATH");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("grant namespace unification (SEC-F-01)", () => {
  test("absolute owned grant inside the worktree never authorizes (default-deny)", () => {
    const c = {
      canonicalRoot: "C:\\repo",
      worktreePath: "C:\\wt\\task-t1",
      ownedPaths: ["C:\\wt\\task-t1\\packages\\foo"],
      forbiddenPaths: [] as string[],
    };
    // Lexically inside the worktree AND inside the absolute grant — the
    // old code authorized this; unified-namespace enforcement denies it.
    const v = validateWorktreeWrite(c, "C:\\wt\\task-t1\\packages\\foo\\a.ts");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("OUTSIDE_OWNED_PATHS");
  });

  test("cross-namespace admission conflict: absolute spelling of a live relative grant", () => {
    const live = new Map<string, readonly string[]>([["t-01", ["packages/foo"]]]);
    const c = findOwnedPathConflict(live, "t-02", ["C:\\wt\\task-t2\\packages\\foo"]);
    expect(c?.conflictingTaskId).toBe("t-01");
  });

  test("cross-namespace nested: absolute deeper inside a live relative grant conflicts", () => {
    const live = new Map<string, readonly string[]>([["t-01", ["packages/foo"]]]);
    const c = findOwnedPathConflict(live, "t-02", ["C:\\wt\\task-t2\\packages\\foo\\deep"]);
    expect(c?.conflictingTaskId).toBe("t-01");
  });

  test("cross-namespace ancestor: absolute naming an ancestor of a live grant conflicts", () => {
    const live = new Map<string, readonly string[]>([["t-01", ["packages/foo"]]]);
    const c = findOwnedPathConflict(live, "t-02", ["C:\\wt\\task-t2\\packages"]);
    expect(c?.conflictingTaskId).toBe("t-01");
  });

  test("genuinely disjoint absolute does not conflict", () => {
    const live = new Map<string, readonly string[]>([["t-01", ["packages/foo"]]]);
    expect(findOwnedPathConflict(live, "t-02", ["C:\\wt\\task-t2\\packages\\other"])).toBeNull();
  });
});

describe("M8 COMPAT F-01 — long-prefix and device-namespace paths", () => {
  test("\\\\?\\-prefixed drive spelling compares equal to the plain spelling", () => {
    expect(normalizeForCompare("\\\\?\\C:\\root\\sub")).toBe(normalizeForCompare("C:\\root\\sub"));
    expect(normalizeForCompare("//?/C:/root/sub")).toBe(normalizeForCompare("C:\\root\\sub"));
    expect(rootKey("\\\\?\\C:\\Work\\Root")).toBe(rootKey("c:\\work\\root\\"));
  });

  test("\\\\?\\UNC\\ spelling compares equal to the plain UNC spelling", () => {
    expect(normalizeForCompare("\\\\?\\UNC\\srv\\share\\dir")).toBe(normalizeForCompare("\\\\srv\\share\\dir"));
  });

  test("\\\\.\\ drive spelling compares equal to the plain spelling", () => {
    expect(normalizeForCompare("\\\\.\\C:\\root\\sub")).toBe(normalizeForCompare("C:\\root\\sub"));
  });

  test("prefixed absolute candidate inside the root resolves", () => {
    expect(resolveWithinRoot("C:\\root", "\\\\?\\C:\\root\\sub")).toBe(normalizeForCompare("C:\\root\\sub"));
    expect(resolveWithinRoot("C:\\root", "\\\\.\\C:\\root\\sub")).toBe(normalizeForCompare("C:\\root\\sub"));
  });

  test("prefixed spelling of an outside path still escapes (fail-closed)", () => {
    expect(() => resolveWithinRoot("C:\\root", "\\\\?\\C:\\other\\x")).toThrow();
    expect(() => resolveWithinRoot("C:\\root", "\\\\.\\D:\\root\\sub")).toThrow();
  });

  test("prefix cannot bypass canonical-root denial (same code as plain)", () => {
    const ctx = {
      canonicalRoot: "C:\\repo",
      worktreePath: "C:\\wt\\task-t1",
      ownedPaths: ["packages/foo"],
      forbiddenPaths: [] as string[],
    };
    for (const cand of ["C:\\repo\\x.ts", "\\\\?\\C:\\repo\\x.ts", "\\\\.\\C:\\repo\\x.ts"]) {
      const v = validateWorktreeWrite(ctx, cand);
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("CANONICAL_CHECKOUT");
    }
  });

  test("mixed root spellings still confine (prefixed worktree root)", () => {
    const ctx = {
      canonicalRoot: "\\\\?\\C:\\repo",
      worktreePath: "C:\\wt\\task-t1",
      ownedPaths: ["packages/foo"],
      forbiddenPaths: [] as string[],
    };
    const v = validateWorktreeWrite(ctx, "C:\\repo\\x.ts");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("CANONICAL_CHECKOUT");
    const ok = validateWorktreeWrite(ctx, "\\\\?\\C:\\wt\\task-t1\\packages\\foo\\a.ts");
    expect(ok.allowed).toBe(true);
  });

  test("unmappable namespaces fail closed (INVALID_PATH, never allow)", () => {
    for (const bad of [
      "\\\\?\\Volume{b75e2c83-0000-0000-0000-602f00000000}\\x",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x",
      "\\\\.\\COM1",
      "\\\\.\\PhysicalDrive0",
      "\\Device\\HarddiskVolume1\\root\\sub",
      "\\??\\C:\\root\\sub",
    ]) {
      expect(() => normalizeForCompare(bad)).toThrow();
    }
    const ctx = {
      canonicalRoot: "C:\\repo",
      worktreePath: "C:\\wt\\task-t1",
      ownedPaths: ["packages/foo"],
      forbiddenPaths: [] as string[],
    };
    for (const bad of ["\\\\.\\COM1", "\\Device\\HarddiskVolume1\\x", "\\\\?\\Volume{abc}\\x"]) {
      const v = validateWorktreeWrite(ctx, bad);
      expect(v.allowed).toBe(false);
    }
  });
});

describe("M8 COMPAT F-02 — device names and NUL bytes", () => {
  test("isWindowsDeviceSegment: reserved names any case, with extensions/trailing dots-spaces", () => {
    for (const seg of ["CON", "con", "Prn", "AUX", "nul", "NUL.txt", "con.txt", "COM1", "com9", "LPT1", "lpt9.log", "aux.", "CON "]) {
      expect(isWindowsDeviceSegment(seg)).toBe(true);
    }
    for (const seg of ["console", "contest.txt", "com10", "lpt0", "aux1", "mine", "null", "a.ts", "C:"]) {
      expect(isWindowsDeviceSegment(seg)).toBe(false);
    }
  });

  test("device name in any component rejected (fail-closed)", () => {
    for (const bad of [
      "C:\\root\\CON",
      "C:\\root\\con.txt",
      "C:\\root\\sub\\PRN",
      "C:\\root\\COM1",
      "C:\\wt\\lpt9.log\\x",
      "C:\\root\\AUX\\deep\\a.ts",
      "C:\\NUL",
    ]) {
      expect(() => normalizeForCompare(bad)).toThrow();
    }
    // Lowercase + extension variants compare-reject too.
    expect(() => resolveWithinRoot("C:\\root", "C:\\root\\nul")).toThrow();
    expect(() => rootKey("C:\\root\\com5")).toThrow();
  });

  test("embedded NUL rejected in every entry point (fail-closed)", () => {
    expect(() => normalizeForCompare("C:\\root\\a\0b")).toThrow();
    expect(() => normalizeForCompare("C:\\root\\\0")).toThrow();
    expect(() => resolveWithinRoot("C:\\root", "sub\0dir")).toThrow();
    const ctx = {
      canonicalRoot: "C:\\repo",
      worktreePath: "C:\\wt\\task-t1",
      ownedPaths: ["packages/foo"],
      forbiddenPaths: [] as string[],
    };
    for (const bad of ["packages/foo/a\0b.ts", "C:\\wt\\task-t1\\packages\\foo\\\0", "packages/foo/CON", "C:\\wt\\task-t1\\docs\\NUL.txt"]) {
      const v = validateWorktreeWrite(ctx, bad);
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("INVALID_PATH");
    }
  });
});

describe("M8-S3 UNC/device-namespace negative rows (uncovered variants, fail-closed)", () => {
  test("bare extended-length prefix is unmappable (INVALID_PATH)", () => {
    expect(() => normalizeForCompare("\\\\?\\")).toThrow();
  });

  test("forward-slash device-namespace spelling fails closed", () => {
    expect(() => normalizeForCompare("//./COM1")).toThrow();
    expect(() => normalizeForCompare("//?/Volume{abc}/x")).toThrow();
  });

  test("NUL inside a \\\\-prefixed spelling rejected before comparison", () => {
    expect(() => normalizeForCompare("\\\\?\\C:\\root\\a\0b")).toThrow();
    expect(() => resolveWithinRoot("C:\\root", "\\\\?\\C:\\root\\a\0b")).toThrow();
  });

  test("device name as a UNC subdirectory rejected (fail-closed)", () => {
    expect(() => normalizeForCompare("\\\\server\\share\\COM1\\x")).toThrow();
    expect(() => normalizeForCompare("\\\\server\\share\\sub\\NUL.txt")).toThrow();
  });

  test("device name inside a prefixed candidate rejected at resolve time", () => {
    expect(() => resolveWithinRoot("C:\\root", "\\\\?\\C:\\root\\CON")).toThrow();
  });
});
