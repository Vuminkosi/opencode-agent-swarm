/**
 * M5 fault-injection: provider pressure without speculative inference spend.
 *
 * Disposable file DBs under mkdtemp only; FakeHarness counts every
 * submitTurn (no network, no model inference, no paid calls). Injects:
 * (a) rate-limit storm (429 on every transport) → bounded admissions +
 *     queued spillover, dispatcher terminates (no polling loop);
 * (b) quota exhausted (402) → member quota-paused, attempts frozen, zero
 *     follow-up submits after a +60s virtual advance;
 * (c) auth failure (401) → terminal, exactly one submit, zero retries;
 * (d) concurrency cap under parallel dispatch (10 workers simulated through
 *     one RateLimiter gate: peak never exceeds the cap).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../../packages/runtime/src/db/store.ts";
import { WakeQueue } from "../../packages/runtime/src/services/wake-queue.ts";
import { WakeDispatcher, type DispatchHarness } from "../../packages/runtime/src/services/wake-dispatcher.ts";
import {
  BlockRegistry,
  RateLimiter,
  rateLimitKeyFor,
} from "../../packages/runtime/src/services/rate-limiter.ts";
import { UsageLedger } from "../../packages/runtime/src/services/usage-ledger.ts";

function transportError(status: number, code: string): unknown {
  return Object.assign(new Error(`${code} (simulated ${status}, no inference)`), { status, code });
}

interface SubmittedTurn {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string;
  readonly externalId: string;
  readonly reason: string;
}

class FakeHarness implements DispatchHarness {
  submitted: SubmittedTurn[] = [];
  liveSessions = new Set<string>();
  failures = new Map<string, unknown>();

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "mention" | "assigned_task" | "verifier_request" | "monitor_intervention" | "user_direct";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    const failure = this.failures.get(request.sessionId);
    if (failure !== undefined) throw failure;
    this.submitted.push({ ...request });
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async getSession(sessionId: string): Promise<{
    readonly hasLiveExecution: boolean;
    readonly knownTerminalExternalIds: readonly string[];
  }> {
    return { hasLiveExecution: this.liveSessions.has(sessionId), knownTerminalExternalIds: [] };
  }
}

const dirs: string[] = [];
let nowMs = Date.parse("2026-11-11T00:00:00.000Z");

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  nowMs = Date.parse("2026-11-11T00:00:00.000Z");
});

function setupFileStore(): { dir: string; store: SwarmStore } {
  const dir = mkdtempSync(join(tmpdir(), "m5-fault-"));
  dirs.push(dir);
  return { dir, store: new SwarmStore(join(dir, "state.sqlite")) };
}

function makeSwarm(store: SwarmStore): string {
  return store.createSwarm({
    title: "m5 fault injection",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m5f",
    mode: "parity",
  }).id;
}

function addWaitingMember(store: SwarmStore, swarmId: string, name: string, sessionId: string): string {
  const member = store.addMember(swarmId, {
    name,
    role: "coder",
    nativeAgentId: "fake-agent",
    sessionId,
    model: { providerID: "fake-provider", id: "fake-model" },
  });
  return store.transitionMember(member.id, "waiting").id;
}

function setupDispatch(store: SwarmStore, harness: FakeHarness): WakeDispatcher {
  return new WakeDispatcher(store, harness, undefined, {
    now: () => new Date(nowMs).toISOString(),
    random: () => 1,
    backoffBaseMs: 100,
    backoffCapMs: 1000,
    maxAttempts: 3,
  });
}

describe("fault injection: rate-limit storm stays bounded", () => {
  test("429 on every transport → bounded submits, queued spillover, dispatch terminates", async () => {
    const { store } = setupFileStore();
    try {
      const swarmId = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-storm", "sess-storm");
      const harness = new FakeHarness();
      harness.failures.set("sess-storm", transportError(429, "RATE_LIMITED"));
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);
      const limiter = new RateLimiter({
        maxConcurrentPerKey: 2,
        maxQueuedPerKey: 64,
        maxAttempts: 3,
        sleep: () => Promise.resolve(),
        random: () => 1,
      });
      const key = rateLimitKeyFor("fake-provider", "fake-model");

      // 6 committed intents under one throttle gate: at most 2 admitted,
      // the rest wait in the bounded FIFO spending zero inference.
      const wakeIds: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        wakeIds.push(
          queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: i + 1, payloadHash: `storm-${i}` }).intent.id,
        );
      }
      const verdicts = wakeIds.map((id) => limiter.admit(key, id));
      expect(verdicts.filter((v) => v === "admitted").length).toBeLessThanOrEqual(2);
      expect(verdicts.filter((v) => v === "queued").length).toBeGreaterThan(0);
      expect(limiter.queued(key)).toBe(6 - verdicts.filter((v) => v === "admitted").length);

      // Dispatch the admitted wake directly: each 429 transport failure burns
      // exactly one M2 retry-budget attempt (maxAttempts=3), then the wake
      // goes terminal — bounded submits, no storm, no polling loop.
      const admittedId = wakeIds.find((id, i) => verdicts[i] === "admitted") as string;
      let current = await dispatcher.dispatchWake(swarmId, admittedId);
      expect(current.status).toBe("failed-transient-scheduled");
      let rounds = 1;
      while (current.status === "failed-transient-scheduled" && rounds < 10) {
        nowMs += 5_000; // virtual backoff elapses; the dispatcher never polls
        current = await dispatcher.retryAdmittedWake(swarmId, admittedId);
        rounds += 1;
      }
      expect(current.status).toBe("failed-permanent");
      expect(current.attempts).toBe(3);
      expect(harness.submitted.length).toBe(0); // 429 transport threw before any admission receipt
      expect(store.getWake(admittedId).state).toBe("failed");

      // Queued spillover never submitted: zero inference while throttled.
      limiter.release(key);
      limiter.release(key);
      expect(limiter.inflight(key)).toBe(0);
      expect(harness.submitted.length).toBe(0);
      expect(store.getMember(memberId).internalState).not.toBe("quota_paused");
    } finally {
      store.close();
    }
  });
});

describe("fault injection: quota exhausted freezes with zero follow-ups", () => {
  test("402 → quota-paused; +60s virtual advance performs zero submits", async () => {
    const { store } = setupFileStore();
    try {
      const swarmId = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-quota", "sess-quota");
      const harness = new FakeHarness();
      harness.failures.set("sess-quota", transportError(402, "QUOTA_EXHAUSTED"));
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);
      const blocks = new BlockRegistry();
      const ledgerDb = new Database(":memory:");
      const ledger = new UsageLedger(ledgerDb);

      const wakeId = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "q-1" }).intent.id;
      const result = await dispatcher.dispatchWake(swarmId, wakeId);
      expect(result.status).toBe("quota-blocked");
      expect(store.getMember(memberId).internalState).toBe("quota_paused");
      blocks.markQuotaPaused(memberId, "402", new Date(nowMs).toISOString());
      const attemptsAtBlock = store.getWake(wakeId).attempts;

      // Record the terminal outcome in the ledger (refs + counts only).
      ledger.record({
        swarmId, memberId, wakeId, providerId: "fake-provider", modelId: "fake-model",
        attempt: attemptsAtBlock, outcome: "quota-paused", correlationId: result.correlationId,
      });

      // +60s passes with no trigger: no polling, no retry, attempts frozen.
      nowMs += 60_000;
      expect(blocks.isBlocked(memberId)).toBe(true);
      expect(await dispatcher.dispatchAll(swarmId, 10)).toEqual([]);
      expect(harness.submitted.length).toBe(0);
      expect(store.getWake(wakeId).attempts).toBe(attemptsAtBlock);

      // Only a documented trigger resumes.
      expect(blocks.resume(memberId, "new-post")).toBe(true);
      expect(blocks.isBlocked(memberId)).toBe(false);
      expect(ledger.count()).toBe(1);
      ledgerDb.close();
    } finally {
      store.close();
    }
  });
});

describe("fault injection: auth failure blocks with zero retries", () => {
  test("401 → terminal after exactly one submit; member preserved for approval surface", async () => {
    const { store } = setupFileStore();
    try {
      const swarmId = makeSwarm(store);
      const memberId = addWaitingMember(store, swarmId, "coder-auth", "sess-auth");
      const harness = new FakeHarness();
      harness.failures.set("sess-auth", transportError(401, "UNAUTHENTICATED"));
      const queue = new WakeQueue(store);
      const dispatcher = setupDispatch(store, harness);
      const blocks = new BlockRegistry();

      const wakeId = queue.enqueue({ swarmId, memberId, reason: "mention", postSequence: 1, payloadHash: "a-1" }).intent.id;
      const before = harness.submitted.length;
      const result = await dispatcher.dispatchWake(swarmId, wakeId);
      // The M2 dispatcher maps non-quota/non-transient to failed-permanent:
      // exactly one transport attempt, never retried, never auto-approved.
      expect(result.status).toBe("failed-permanent");
      expect(harness.submitted.length).toBe(before);
      blocks.markAuthBlocked(memberId, "401", new Date(nowMs).toISOString());
      expect(blocks.isBlocked(memberId)).toBe(true);

      nowMs += 60_000;
      expect(await dispatcher.dispatchAll(swarmId, 10)).toEqual([]);
      expect(harness.submitted.length).toBe(before);
    } finally {
      store.close();
    }
  });
});

describe("fault injection: concurrency cap under parallel dispatch", () => {
  test("10 workers through one gate: peak never exceeds cap 2", async () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 2, sleep: () => Promise.resolve() });
    const key = rateLimitKeyFor("fake-provider", "fake-model");
    const harness = new FakeHarness();
    let live = 0;
    let peak = 0;
    const oneTurn = async (i: number): Promise<void> => {
      const res = await limiter.execute(key, async () => {
        live += 1;
        peak = Math.max(peak, live);
        await harness.submitTurn({
          sessionId: `sess-p-${i}`,
          text: `turn ${i}`,
          delivery: "queue",
          externalId: `w-p-${i}`,
          reason: "mention",
        });
        live -= 1;
      });
      expect(res.status).toBe("ok");
    };
    await Promise.all(Array.from({ length: 10 }, (_, i) => oneTurn(i)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(harness.submitted.length).toBe(10);
    expect(limiter.inflight(key)).toBe(0);
  });
});
