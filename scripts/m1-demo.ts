/**
 * M1-05 demonstrator (disposable-only): version record + fake activation summary.
 *
 * Runnable via: bun scripts/m1-demo.ts (exit 0 on success). Prints a version
 * record table (opencode version best-effort, bun version, git SHA, provider auth
 * presence only, never secrets) plus a disposable demo flow summary: init a temp Git
 * fixture, activate one swarm via SwarmService plus a fake queue-only harness,
 * check overlap on recorded fake turns, and show status modelCalls as 0.
 *
 * Touches only a fresh mkdtemp root (removed on exit). Never writes the
 * canonical tree, never performs inference, never prints secrets.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../packages/runtime/src/db/store.ts";
import { SwarmService } from "../packages/runtime/src/services/swarm-service.ts";
import type { ActivationHarness } from "../packages/runtime/src/services/swarm-service.ts";
import { executionsOverlap } from "../packages/adapter-opencode/src/events.ts";

/** Fake queue-only harness: admits turns without inference or spend. */
class FakeHarness implements ActivationHarness {
  sessions = 0;

  async createSession(title: string, _directory: string): Promise<{ sessionId: string }> {
    this.sessions += 1;
    return { sessionId: "sess-demo-" + this.sessions + "-" + title.length };
  }

  async switchAgent(_sessionId: string, _agentId: string): Promise<void> {}

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "assigned_task";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    if (request.delivery !== "queue") {
      throw new Error("STEER_REJECTED: " + request.delivery);
    }
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async applyPermissionRules(_sessionId: string, _rules: readonly { scope: string; action: string }[]): Promise<void> {}
}

async function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string } | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: cwd === undefined ? process.cwd() : cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const combined = (out + "\n" + err).trim();
    return { code, out: combined.length > 300 ? combined.slice(0, 300) : combined };
  } catch {
    return null;
  }
}

const root = mkdtempSync(join(tmpdir(), "m105-demo-"));
let store: SwarmStore | undefined;
let tryError: unknown = null;
try {
  const opencode = await run("opencode", ["--version"]);
  const firstLine = opencode === null ? "" : (opencode.out.split("\n")[0] ?? "");
  const opencodeVersion = opencode === null ? "NOT VERIFIED (opencode not on PATH)" : "exit " + opencode.code + " " + firstLine;
  const git = await run("git", ["rev-parse", "HEAD"]);
  const gitSha = git === null || git.code !== 0 ? "NOT VERIFIED" : git.out.trim();
  const authKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  const authStatus = authKeys
    .map((k) => k + "=" + (process.env[k] === undefined || process.env[k] === "" ? "absent" : "set"))
    .join(", ");

  const init = await run("git", ["init"], root);
  const gitInit = init !== null && init.code === 0 ? "ok" : "NOT VERIFIED";
  mkdirSync(join(root, "workers", "worker-a"), { recursive: true });
  mkdirSync(join(root, "workers", "worker-b"), { recursive: true });
  writeFileSync(join(root, "workers", "worker-a", "index.ts"), "export const area = \"worker-a\";\n", "utf8");
  writeFileSync(join(root, "workers", "worker-b", "index.ts"), "export const area = \"worker-b\";\n", "utf8");

  store = new SwarmStore(join(root, "swarm.db"));
  const harness = new FakeHarness();
  const service = new SwarmService(store, harness);
  const result = await service.activateSwarm({
    requirement: "M1-05 demo: two independent fixture modules",
    coordinatorSessionId: "sess-lead",
    projectRoot: root,
    // Explicit test-only ModelRef (FakeHarness queue-only, zero inference).
    // Required by fail-closed MODEL-INHERIT-01: no model/modelContext would
    // throw MODEL_UNRESOLVABLE here (see model-inheritance.test.ts).
    model: { providerID: "prov-demo", id: "model-demo" },
  });
  const snap = service.getStatusSnapshot(result.swarm.id);
  const overlapTrue = executionsOverlap(
    { startedAt: "2026-01-01T00:00:00.000Z", terminalAt: "2026-01-01T00:00:10.000Z" },
    { startedAt: "2026-01-01T00:00:05.000Z", terminalAt: "2026-01-01T00:00:15.000Z" },
  );
  const overlapFalse = executionsOverlap(
    { startedAt: "2026-01-01T00:00:00.000Z", terminalAt: "2026-01-01T00:00:10.000Z" },
    { startedAt: "2026-01-01T00:00:10.000Z", terminalAt: "2026-01-01T00:00:20.000Z" },
  );
  // store remains open until finally: closing there guarantees the SQLite
  // handle is released before directory removal even on try-block failure.

  const rows: Array<[string, string]> = [
    ["opencode version", opencodeVersion],
    ["bun version", Bun.version],
    ["git SHA", gitSha],
    ["provider auth (presence only)", authStatus],
    ["temp fixture git init", gitInit],
    ["swarm", result.swarm.id],
    ["members (1 lead + 2 coders)", String(snap.members.length)],
    ["tasks (non-colliding)", String(snap.tasks.length)],
    ["brief posts (seq 1,2)", snap.posts.map((p) => String(p.sequence)).join(",")],
    ["queue dispatches", String(service.getDispatchCount())],
    ["status modelCalls", String(snap.telemetry.modelCalls)],
    ["overlap (admitted fake turns)", overlapTrue ? "true" : "false"],
    ["no-overlap (sequential)", overlapFalse ? "true" : "false"],
    ["live overlap", "NOT VERIFIED (inference unauthorized)"],
    ["temp root (removed on exit)", root],
  ];
  console.log("| check | result |");
  console.log("|---|---|");
  for (const row of rows) {
    console.log("| " + (row[0] ?? "") + " | " + (row[1] ?? "") + " |");
  }
} catch (err) {
  // Log the try-block error FIRST so a Windows EBUSY cleanup failure can
  // never mask the real failure.
  tryError = err;
  console.error("[m1-demo] failed: " + (err instanceof Error ? err.message : String(err)));
  throw err;
} finally {
  try {
    store?.close();
  } catch (closeErr) {
    console.error("[m1-demo] store close warning: " + (closeErr instanceof Error ? closeErr.message : String(closeErr)));
  }
  // Windows holds SQLite file locks briefly after close: retry removal so
  // EBUSY/EPERM never masks the try-block result.
  let removed = false;
  let lastCleanupErr: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      removed = true;
      break;
    } catch (cleanupErr) {
      lastCleanupErr = cleanupErr;
      await Bun.sleep(100 * attempt);
    }
  }
  if (!removed) {
    console.error(
      "[m1-demo] cleanup warning: temp root removal failed after retries: " +
        (lastCleanupErr instanceof Error ? lastCleanupErr.message : String(lastCleanupErr)),
    );
    // Never mask a try-block failure with a cleanup failure; only fail on
    // cleanup when the demo itself succeeded.
    if (tryError === null) {
      throw lastCleanupErr;
    }
  }
}
