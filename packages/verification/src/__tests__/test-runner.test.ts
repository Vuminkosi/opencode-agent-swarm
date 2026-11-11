/**
 * M4-02 test-runner tests (spec §14 M4): pass / fail gate / timeout-kill /
 * secret redaction / output caps / artifact capture. Tmp git repos only —
 * never the canonical checkout. No model inference.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  VERIFICATION_TIMEOUT_EXIT_CODE,
  isVerificationPassing,
  redactSecrets,
  runVerification,
} from "../test-runner.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of disposable evidence */
    }
  }
});

function makeDisposableRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "m4-02-test-"));
  tmpRoots.push(root);
  return root;
}

function git(args: readonly string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args] as [string, ...string[]], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

/** Tmp repo with one commit so `commitSha` capture has a real HEAD. */
function makeTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "m4-02-repo-"));
  tmpRoots.push(dir);
  git(["init"], dir);
  git(["config", "user.email", "m4-02@example.test"], dir);
  git(["config", "user.name", "m4-02"], dir);
  writeFileSync(join(dir, "fixture.txt"), "fixture\n");
  git(["add", "fixture.txt"], dir);
  git(["commit", "-m", "fixture"], dir);
  return dir;
}

function headSha(dir: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "ignore",
  });
  return String(proc.stdout ?? "").trim();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}

describe("runVerification", () => {
  test("passing command records exit 0 + artifacts + timing + commitSha", async () => {
    const repo = makeTmpRepo();
    const evidenceDir = makeDisposableRoot();
    const result = await runVerification({
      taskId: "task-pass",
      worktreePath: repo,
      command: `bun -e "console.log('hello-stdout'); console.error('hello-stderr')"`,
      executorMemberId: "verifier-1",
      evidenceDir,
    });

    expect(result.timedOut).toBe(false);
    expect(result.evidenceInput.exitCode).toBe(0);
    expect(isVerificationPassing(result)).toBe(true);
    expect(result.evidenceInput.taskId).toBe("task-pass");
    expect(result.evidenceInput.executorMemberId).toBe("verifier-1");
    expect(result.evidenceInput.cwd).toBe(repo);
    expect(result.evidenceInput.commitSha).toBe(headSha(repo));
    expect(Date.parse(result.evidenceInput.startedAt)).toBeLessThanOrEqual(
      Date.parse(result.evidenceInput.finishedAt),
    );
    // Artifacts live under the disposable dir, never the worktree.
    expect(result.stdoutPath.startsWith(evidenceDir)).toBe(true);
    expect(result.stderrPath.startsWith(evidenceDir)).toBe(true);
    expect(statSync(result.stdoutPath).isFile()).toBe(true);
    expect(statSync(result.stderrPath).isFile()).toBe(true);
    expect(readFileSync(result.stdoutPath, "utf8")).toContain("hello-stdout");
    expect(readFileSync(result.stderrPath, "utf8")).toContain("hello-stderr");
    expect(result.evidenceInput.stdout.filePath).toBe(result.stdoutPath);
    expect(result.evidenceInput.stderr.filePath).toBe(result.stderrPath);
    expect(result.evidenceInput.stdout.sha256).toBe(sha256File(result.stdoutPath));
    expect(result.evidenceInput.stderr.sha256).toBe(sha256File(result.stderrPath));
  });

  test("failing command records non-zero exit and blocks the caller gate", async () => {
    const repo = makeTmpRepo();
    const result = await runVerification({
      taskId: "task-fail",
      worktreePath: repo,
      command: `bun -e "console.error('boom'); process.exit(3)"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
    });

    expect(result.timedOut).toBe(false);
    expect(result.evidenceInput.exitCode).toBe(3);
    // The documented gate: caller MUST block integration on non-zero exit
    // and route into the M3 defect/remediation loop (never merge).
    expect(isVerificationPassing(result)).toBe(false);
    if (isVerificationPassing(result)) {
      expect.unreachable("failing evidence must block integration");
    }
    expect(readFileSync(result.stderrPath, "utf8")).toContain("boom");
  });

  test("timeout kills the command and reports a timeout exit", async () => {
    const repo = makeTmpRepo();
    const result = await runVerification({
      taskId: "task-timeout",
      worktreePath: repo,
      command: `bun -e "await new Promise((r) => setTimeout(r, 10000))"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.evidenceInput.exitCode).toBe(VERIFICATION_TIMEOUT_EXIT_CODE);
    expect(isVerificationPassing(result)).toBe(false);
    expect(statSync(result.stdoutPath).isFile()).toBe(true);
    expect(statSync(result.stderrPath).isFile()).toBe(true);
  });

  test("secret patterns are redacted from artifacts", async () => {
    const repo = makeTmpRepo();
    const secret = `sk-abcdefgh12345678`;
    const result = await runVerification({
      taskId: "task-redact",
      worktreePath: repo,
      command: `bun -e "console.log('api_key=${secret}'); console.error('Bearer abcdefgh12345678')"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
    });

    const stdout = readFileSync(result.stdoutPath, "utf8");
    const stderr = readFileSync(result.stderrPath, "utf8");
    expect(stdout).not.toContain(secret);
    expect(stdout).toContain("[REDACTED]");
    expect(stderr).not.toContain("Bearer abcdefgh12345678");
    expect(stderr).toContain("[REDACTED]");
    // Pure helper coverage for non-spawned paths.
    expect(redactSecrets(`password=hunter2 secret`)).toContain("[REDACTED]");
    expect(redactSecrets(`password=hunter2 secret`)).not.toContain("hunter2");
  });

  test("output caps truncate with flags and preserved artifacts", async () => {
    const repo = makeTmpRepo();
    const result = await runVerification({
      taskId: "task-caps",
      worktreePath: repo,
      command: `bun -e "console.log('x'.repeat(10000)); console.error('y'.repeat(10000))"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
      maxOutputBytes: 64,
    });

    expect(result.evidenceInput.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(readFileSync(result.stdoutPath, "utf8")).toContain("[truncated:");
    expect(result.evidenceInput.stdout.sha256).toBe(sha256File(result.stdoutPath));
  });

  test("invalid input and missing worktree throw before spawning", async () => {
    const repo = makeTmpRepo();
    await expect(
      runVerification({ taskId: "t", worktreePath: repo, command: "  ", executorMemberId: "v" }),
    ).rejects.toThrow(/command/);
    await expect(
      runVerification({
        taskId: "t",
        worktreePath: join(repo, "does-not-exist"),
        command: "bun -e \"1\"",
        executorMemberId: "v",
      }),
    ).rejects.toThrow(/worktreePath/);
    await expect(
      runVerification({
        taskId: "t",
        worktreePath: repo,
        command: "bun -e \"1\"",
        executorMemberId: "v",
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/timeoutMs/);
  });

  test("non-git worktree yields undefined commitSha but still records evidence", async () => {
    const plain = makeDisposableRoot();
    const result = await runVerification({
      taskId: `task-nogit-${randomUUID()}`,
      worktreePath: plain,
      command: `bun -e "process.exit(0)"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
    });
    expect(result.evidenceInput.exitCode).toBe(0);
    expect(result.evidenceInput.commitSha ?? null).toBeNull();
    expect(isVerificationPassing(result)).toBe(true);
  });
});

describe("M4-02-REVIEW-01 fixes", () => {
  test("F-01: non-capturing secret pattern emits bare [REDACTED], never <offset>=", () => {
    // Regression: (_match, group) typed the numeric offset as `group`, which
    // produced e.g. `12=[REDACTED]`. Exact-match assertions pin the shape.
    expect(redactSecrets("token sk-abcdefgh12345678 end")).toBe("token [REDACTED] end");
    expect(redactSecrets("Bearer abcdefgh12345678")).toBe("[REDACTED]");
    expect(redactSecrets("ghp_abcdefghij123456")).toBe("[REDACTED]");
  });

  test("F-01: key=value pattern keeps the exact `name=[REDACTED]` shape", () => {
    expect(redactSecrets("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactSecrets('api_key: "s3cr3t-value"')).toBe("api_key=[REDACTED]");
  });

  test("SEC F5: extended secret vectors are redacted", () => {
    expect(redactSecrets("deploy ghs_abcdefghij1234567890 now")).toContain("[REDACTED]");
    expect(redactSecrets("deploy ghu_abcdefghij1234567890 now")).toContain("[REDACTED]");
    expect(redactSecrets("deploy ghr_abcdefghij1234567890 now")).toContain("[REDACTED]");
    expect(redactSecrets("token glpat-abcdefghij1234567890")).toContain("[REDACTED]");
    expect(redactSecrets("key npm_abcdefghij1234567890")).toContain("[REDACTED]");
    expect(redactSecrets("key AIzaSyA-abcdefghijklmnopqrstuvwxy123456")).toContain("[REDACTED]");
    expect(redactSecrets("hook xoxo-abcdefghij1234567890")).toContain("[REDACTED]");
    expect(redactSecrets("-----BEGIN PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(redactSecrets("aws_secret_access_key=abcdefghij1234567890qrst")).toContain("[REDACTED]");
    // ...and none of the raw values survive.
    for (const raw of [
      "ghs_abcdefghij1234567890",
      "glpat-abcdefghij1234567890",
      "AIzaSyA-abcdefghijklmnopqrstuvwxy123456",
      "xoxo-abcdefghij1234567890",
    ]) {
      expect(redactSecrets(`v=${raw}`)).not.toContain(raw);
    }
  });

  test("F1: symlink/junction worktree is denied before spawning", async () => {
    const repo = makeTmpRepo();
    const link = join(makeDisposableRoot(), "linked-repo");
    symlinkSync(repo, link, "junction");
    await expect(
      runVerification({
        taskId: "task-symlink",
        worktreePath: link,
        command: `bun -e "process.exit(0)"`,
        executorMemberId: "verifier-1",
        evidenceDir: makeDisposableRoot(),
      }),
    ).rejects.toThrow(/symlink or junction/);
  });

  test("F1: worktree inside the canonical root is denied (explicit + discovered)", async () => {
    const canonical = makeTmpRepo();
    // Explicit canonicalRoot: the worktree IS the canonical checkout.
    await expect(
      runVerification({
        taskId: "task-canon",
        worktreePath: canonical,
        command: `bun -e "process.exit(0)"`,
        executorMemberId: "verifier-1",
        evidenceDir: makeDisposableRoot(),
        canonicalRoot: canonical,
      }),
    ).rejects.toThrow(/canonical/);
    // Discovered canonicalRoot (git toplevel of cwd) also denies canonical:
    // the real checkout must never be a verification worktree.
    const { execSync } = await import("node:child_process");
    const top = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
    await expect(
      runVerification({
        taskId: "task-canon-discovered",
        worktreePath: realpathSync(top),
        command: `bun -e "process.exit(0)"`,
        executorMemberId: "verifier-1",
        evidenceDir: makeDisposableRoot(),
      }),
    ).rejects.toThrow(/canonical/);
  });

  test("F2: persisted DTO command is redacted and the run script is removed", async () => {
    const repo = makeTmpRepo();
    const secret = "ghp_abcdefghij1234567890";
    const result = await runVerification({
      taskId: "task-dto-redact",
      worktreePath: repo,
      command: `bun -e "console.log('ok ${secret}')"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
    });
    expect(result.evidenceInput.command).not.toContain(secret);
    expect(result.evidenceInput.command).toContain("[REDACTED]");
    // No run script lingers next to the artifacts.
    expect(existsSync(join(result.stdoutPath, "..", process.platform === "win32" ? "run.cmd" : "run.sh"))).toBe(
      false,
    );
  });

  test("F-02: streaming cap bounds artifacts without unbounded buffering", async () => {
    const repo = makeTmpRepo();
    const result = await runVerification({
      taskId: "task-stream-cap",
      worktreePath: repo,
      command: `bun -e "console.log('z'.repeat(500000))"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
      maxOutputBytes: 1024,
    });
    expect(result.stdoutTruncated).toBe(true);
    const bytes = Buffer.byteLength(readFileSync(result.stdoutPath, "utf8"), "utf8");
    expect(bytes).toBeLessThan(1024 + 512);
  });

  test("F-05: truncated multibyte output never persists a U+FFFD artifact", async () => {
    const repo = makeTmpRepo();
    const result = await runVerification({
      taskId: "task-no-fffd",
      worktreePath: repo,
      command: `bun -e "console.log('\u{1F389}'.repeat(500))"`,
      executorMemberId: "verifier-1",
      evidenceDir: makeDisposableRoot(),
      maxOutputBytes: 10,
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(readFileSync(result.stdoutPath, "utf8")).not.toContain("�");
  });

  test("F-04: overlong inputs fail before spawning (no side effects)", async () => {
    const repo = makeTmpRepo();
    const evidenceDir = makeDisposableRoot();
    await expect(
      runVerification({
        taskId: "t",
        worktreePath: repo,
        command: `bun -e "1"`,
        executorMemberId: "v",
        evidenceDir,
        timeoutMs: 1.5,
      }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      runVerification({
        taskId: "t",
        worktreePath: repo,
        command: `bun -e "1"`,
        executorMemberId: "v",
        evidenceDir,
        maxOutputBytes: 10.5,
      }),
    ).rejects.toThrow(/maxOutputBytes/);
    await expect(
      runVerification({
        taskId: "t",
        worktreePath: repo,
        command: `x`.repeat(4097),
        executorMemberId: "v",
        evidenceDir,
      }),
    ).rejects.toThrow(/command/);
    await expect(
      runVerification({
        taskId: "t".repeat(129),
        worktreePath: repo,
        command: `bun -e "1"`,
        executorMemberId: "v",
        evidenceDir,
      }),
    ).rejects.toThrow(/taskId/);
  });

  test("SEC F4: evidenceDir outside the system temp dir is denied", async () => {
    const repo = makeTmpRepo();
    const { execSync } = await import("node:child_process");
    const top = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
    await expect(
      runVerification({
        taskId: "task-evroot",
        worktreePath: repo,
        command: `bun -e "process.exit(0)"`,
        executorMemberId: "verifier-1",
        evidenceDir: realpathSync(top),
      }),
    ).rejects.toThrow(/evidenceDir/);
  });
});

describe("M4-02-FIX-02 round2 (REVIEW-01 S2s)", () => {
  test("SEC-01: Bearer + PRIVATE KEY match case-insensitively", () => {
    // Lowercase scheme/footer must redact exactly like the canonical case.
    expect(redactSecrets("bearer abcdefgh12345678")).toBe("[REDACTED]");
    expect(redactSecrets("BEARER abcdefgh12345678")).toBe("[REDACTED]");
    expect(redactSecrets("-----begin private key-----")).toBe("[REDACTED]");
    expect(redactSecrets("-----begin rsa private key-----")).toBe("[REDACTED]");
    expect(redactSecrets("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("[REDACTED]");
  });

  test("SEC-01: key=value without colon keeps the `name=[REDACTED]` shape", () => {
    expect(redactSecrets("api_key=s3cr3t-value")).toBe("api_key=[REDACTED]");
    expect(redactSecrets("token=abc12345")).toBe("token=[REDACTED]");
    expect(redactSecrets("client_secret=hunter2")).toBe("client_secret=[REDACTED]");
  });

  test("SEC-01/S3: extended prefixes (xox family, ASIA) are redacted", () => {
    for (const raw of [
      "xoxe-abcdefghij1234567890",
      "xoxc-abcdefghij1234567890",
      "xoxd-abcdefghij1234567890",
      "xoxr-abcdefghij1234567890",
      "ASIAIOSFODNN7EXAMPLE",
    ]) {
      expect(redactSecrets(`v=${raw}`)).not.toContain(raw);
      expect(redactSecrets(`deploy ${raw} now`)).toContain("[REDACTED]");
    }
  });

  test("SEC-02: not-yet-created leaf under a symlinked parent is gated on the physical path", async () => {
    const repo = makeTmpRepo();
    const tmpRoot = realpathSync(tmpdir());
    // `link -> <parent-of-tmpdir>`: lexically inside tmp, physically outside.
    const link = join(tmpRoot, `m4-02-evlink-${randomUUID()}`);
    tmpRoots.push(link);
    symlinkSync(dirname(tmpRoot), link, "junction");
    const outsideLeaf = join(link, `m4-02-evleaf-${randomUUID()}`);
    await expect(
      runVerification({
        taskId: "task-evlink",
        worktreePath: repo,
        command: `bun -e "process.exit(0)"`,
        executorMemberId: "verifier-1",
        evidenceDir: outsideLeaf,
      }),
    ).rejects.toThrow(/evidenceDir/);
    // Denied before mkdir: nothing created outside the temp dir.
    expect(existsSync(outsideLeaf)).toBe(false);
  });

  test("SEC-02: not-yet-created nested leaf inside tmp still works", async () => {
    const repo = makeTmpRepo();
    const nested = join(makeDisposableRoot(), `new-nested-${randomUUID()}`, "leaf");
    const result = await runVerification({
      taskId: "task-evleaf-ok",
      worktreePath: repo,
      command: `bun -e "console.log('leaf-ok')"`,
      executorMemberId: "verifier-1",
      evidenceDir: nested,
    });
    expect(result.evidenceInput.exitCode).toBe(0);
    expect(result.stdoutPath.startsWith(realpathSync(nested))).toBe(true);
  });

  test("R01-01: timeout kills the whole detached group, not just the shell", async () => {
    // POSIX-only vector: win32 uses taskkill /T (covered by the basic
    // timeout test); the detached-spawn invariant is POSIX-specific.
    if (process.platform === "win32") return;
    const repo = makeTmpRepo();
    const scope = makeDisposableRoot();
    const marker = join(scope, "grandchild.marker");
    // `bun … &` backgrounds a grandchild that appends to `marker` in a loop;
    // the foreground bun just sleeps past the timeout. All share the
    // detached group, so kill(-pid) must stop the marker growth.
    const result = await runVerification({
      taskId: "task-groupkill",
      worktreePath: repo,
      command: `bun -e "import{appendFileSync}from'node:fs';setInterval(()=>{try{appendFileSync('${marker}','x')}catch{}},50)" & bun -e "await new Promise((r) => setTimeout(r, 30000))"`,
      executorMemberId: "verifier-1",
      evidenceDir: scope,
      timeoutMs: 1000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.evidenceInput.exitCode).toBe(VERIFICATION_TIMEOUT_EXIT_CODE);
    expect(isVerificationPassing(result)).toBe(false);
    // The grandchild actually ran (non-vacuous), then died with the group.
    const sizeAfterKill = statSync(marker).size;
    expect(sizeAfterKill).toBeGreaterThan(0);
    await Bun.sleep(700);
    expect(statSync(marker).size).toBe(sizeAfterKill);
  });
});
