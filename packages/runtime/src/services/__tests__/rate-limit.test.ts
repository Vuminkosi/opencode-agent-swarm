/**
 * M5-02 rate-limit unit tests (spec §14 M5 + §8.4 + §13).
 *
 * Fake transports only (no network, no inference, no spend): a FakeHarness
 * counts every submitTurn, and injectable `sleep`/`random` make backoff
 * deterministic. Covers: concurrency cap under parallel dispatch (12
 * workers), 429 bounded retries then terminal with growing spacing, 402 /
 * 401 / 403 zero follow-up submits with state preserved, throttle queues
 * spending zero inference while queued, and usage-ledger rollups.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  AUTH_RESUME_TRIGGERS,
  BlockRegistry,
  QUOTA_RESUME_TRIGGERS,
  RateLimiter,
  RateLimitOverflowError,
  classifyProviderStatus,
  classifyTransportError,
  computeRateLimitBackoffMs,
  rateLimitKeyFor,
  type ProviderOutcomeClass,
} from "../rate-limiter.js";
import { isDispatchAuthError, isQuotaError as isDispatchQuotaError, isTransientError } from "../wake-dispatcher.js";
import { UsageLedger, describeTaskAttemptAccounting, ensureUsageLedgerSchema } from "../usage-ledger.js";

function providerError(status: number, code: string): unknown {
  return Object.assign(new Error(`${code} (simulated ${status}, no inference)`), { status, code });
}

const KEY = rateLimitKeyFor("fake-provider", "fake-model");

describe("rate limiter: concurrency cap under parallel dispatch", () => {
  test("12 parallel workers never exceed cap 3; all complete", async () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 3, sleep: () => Promise.resolve() });
    let live = 0;
    let peak = 0;
    const work = async (i: number): Promise<number> => {
      const res = await limiter.execute(KEY, async () => {
        live += 1;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live -= 1;
        return i;
      });
      expect(res.status).toBe("ok");
      return res.value as number;
    };
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => work(i)));
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(peak).toBeLessThanOrEqual(3);
    expect(limiter.maxObserved(KEY)).toBeLessThanOrEqual(3);
    expect(limiter.inflight(KEY)).toBe(0);
    expect(limiter.getAdmissions()).toBe(12);
  });

  test("admit() queues under pressure; overflow rejects newcomers, never drops queued", () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 1, maxQueuedPerKey: 2 });
    expect(limiter.admit(KEY, "w-1")).toBe("admitted");
    expect(limiter.admit(KEY, "w-2")).toBe("queued");
    expect(limiter.admit(KEY, "w-3")).toBe("queued");
    // Backpressure: the newcomer is refused; queued work is preserved.
    expect(limiter.admit(KEY, "w-4")).toBe("rejected-overflow");
    expect(limiter.queued(KEY)).toBe(2);
    expect(limiter.dequeueNext(KEY)).toBe("w-2");
    expect(limiter.dequeueNext(KEY)).toBe("w-3");
    expect(limiter.dequeueNext(KEY)).toBeNull();
  });
});

describe("rate limiter: 429 bounded retries then terminal", () => {
  test("429 retries up to budget with growing spacing, then terminal", async () => {
    const delays: number[] = [];
    const limiter = new RateLimiter({
      maxConcurrentPerKey: 2,
      maxAttempts: 3,
      backoffBaseMs: 100,
      backoffCapMs: 10_000,
      random: () => 1, // full-window roll: delay == ceiling, spacing must grow
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    let calls = 0;
    const res = await limiter.execute(KEY, async () => {
      calls += 1;
      throw providerError(429, "RATE_LIMITED");
    });
    expect(res.status).toBe("rate-limited-terminal");
    expect(res.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(delays).toEqual([200, 400]);
    expect(delays[1] as number).toBeGreaterThan(delays[0] as number);
    expect(limiter.inflight(KEY)).toBe(0);
  });

  test("429 then success recovers without burning the budget", async () => {
    const limiter = new RateLimiter({ maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 0 });
    let calls = 0;
    const res = await limiter.execute(KEY, async () => {
      calls += 1;
      if (calls < 3) throw providerError(429, "RATE_LIMITED");
      return "admitted";
    });
    expect(res.status).toBe("ok");
    expect(res.value).toBe("admitted");
    expect(res.attempts).toBe(3);
    expect(res.delaysMs).toEqual([0, 0]); // jitter 0 roll: zero wait, still bounded
  });

  test("backoff helper is bounded by the cap", () => {
    expect(computeRateLimitBackoffMs(0, 100, 500, () => 1)).toBe(100);
    expect(computeRateLimitBackoffMs(30, 100, 500, () => 1)).toBe(500);
  });
});

describe("rate limiter: quota/auth block with zero retries", () => {
  test("402 → quota-paused after exactly one submit; state preserved", async () => {
    const limiter = new RateLimiter({ sleep: () => Promise.resolve() });
    let calls = 0;
    const res = await limiter.execute(KEY, async () => {
      calls += 1;
      throw providerError(402, "QUOTA_EXHAUSTED");
    });
    expect(res.status).toBe("quota-paused");
    expect(res.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(res.delaysMs).toEqual([]);
  });

  for (const status of [401, 403]) {
    test(`${status} → auth-blocked after exactly one submit; never auto-approved`, async () => {
      const limiter = new RateLimiter({ sleep: () => Promise.resolve() });
      let calls = 0;
      const res = await limiter.execute(KEY, async () => {
        calls += 1;
        throw providerError(status, status === 401 ? "UNAUTHENTICATED" : "PERMISSION_DENIED");
      });
      expect(res.status).toBe("auth-blocked");
      expect(res.attempts).toBe(1);
      expect(calls).toBe(1);
      expect(res.delaysMs).toEqual([]);
    });
  }

  test("classifier separates quota/auth/rate-limited/transient/permanent", () => {
    expect(classifyProviderStatus(402)).toBe("quota");
    expect(classifyProviderStatus(401)).toBe("auth-blocked");
    expect(classifyProviderStatus(403)).toBe("auth-blocked");
    expect(classifyProviderStatus(429)).toBe("rate-limited");
    expect(classifyProviderStatus(503)).toBe("transient");
    expect(classifyProviderStatus(500)).toBe("transient");
    expect(classifyProviderStatus(400)).toBe("permanent");
    expect(classifyTransportError(providerError(402, "QUOTA_EXHAUSTED"))).toBe("quota");
    expect(classifyTransportError(providerError(429, "RATE_LIMITED"))).toBe("rate-limited");
  });
});

describe("rate limiter: throttle queues spend zero inference", () => {
  test("queued waiters never invoke the transport until a slot frees", async () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 1, sleep: () => Promise.resolve() });
    let submits = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = limiter.execute(KEY, async () => {
      submits += 1;
      await gate;
      return "first";
    });
    // Second dispatch waits in the local FIFO — transport not yet invoked.
    const second = limiter.execute(KEY, async () => {
      submits += 1;
      return "second";
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(submits).toBe(1);
    releaseFirst();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(submits).toBe(2);
    expect(limiter.inflight(KEY)).toBe(0);
  });
});

describe("block registry: pause with no elapsed-time auto-retry", () => {
  test("blocked members stay blocked; only documented triggers resume", () => {
    const registry = new BlockRegistry();
    const at = new Date("2026-11-11T00:00:00.000Z").toISOString();
    registry.markQuotaPaused("m-q", "402", at);
    registry.markAuthBlocked("m-a", "401", at);
    expect(registry.isBlocked("m-q")).toBe(true);
    expect(registry.isBlocked("m-a")).toBe(true);
    // Passing time is not a trigger: no resumeIfElapsed exists; blocks hold.
    expect(registry.isBlocked("m-q")).toBe(true);
    expect(registry.get("m-q")?.followUpSubmits).toBe(0);
    // Documented triggers only.
    expect([...QUOTA_RESUME_TRIGGERS].sort()).toEqual(["model-switch", "new-post", "user-input"]);
    expect(registry.resume("m-q", "new-post")).toBe(true);
    expect(registry.isBlocked("m-q")).toBe(false);
    expect(registry.resume("m-q", "user-input")).toBe(false);
    expect(() =>
      registry.resume("m-a", "elapsed-60s" as never),
    ).toThrow();
    expect(registry.isBlocked("m-a")).toBe(true);
  });
});

describe("usage ledger: service-owned record + read-only telemetry", () => {
  test("ensure is idempotent; records roll up by provider/model; no estimates", () => {
    const db = new Database(":memory:");
    try {
      ensureUsageLedgerSchema(db);
      ensureUsageLedgerSchema(db);
      const ledger = new UsageLedger(db);
      ledger.record({
        providerId: "fake-provider", modelId: "fake-model", outcome: "ok",
        inputTokens: 10, outputTokens: 5, costMicro: 120, taskId: "t-1", attempt: 1,
      });
      ledger.record({
        providerId: "fake-provider", modelId: "fake-model", outcome: "rate-limited-terminal",
        taskId: "t-1", attempt: 2,
      });
      ledger.record({
        providerId: "other", modelId: "m", outcome: "quota-paused", taskId: "t-2",
      });
      expect(ledger.count()).toBe(3);
      const totals = ledger.totalsByProviderModel();
      expect(totals.length).toBe(2);
      const fake = totals.find((t) => t.providerId === "fake-provider");
      expect(fake?.calls).toBe(2);
      expect(fake?.inputTokens).toBe(10);
      expect(fake?.outputTokens).toBe(5);
      expect(fake?.costMicro).toBe(120);
      expect(fake?.outcomes).toEqual({ ok: 1, "rate-limited-terminal": 1 });
      // Cost-per-verified-task: observed cost only, averaged over verified ids.
      const cpp = ledger.costPerVerifiedTask(["t-1"]);
      expect(cpp).toEqual({ verifiedTasks: 1, totalCostMicro: 120, avgCostMicroPerVerifiedTask: 120 });
      expect(ledger.costPerVerifiedTask([])).toEqual({
        verifiedTasks: 0, totalCostMicro: 0, avgCostMicroPerVerifiedTask: 0,
      });
    } finally {
      db.close();
    }
  });

  test("invalid refs and negative counts fail closed", () => {
    const db = new Database(":memory:");
    try {
      const ledger = new UsageLedger(db);
      expect(() =>
        ledger.record({ providerId: "", modelId: "m", outcome: "ok" }),
      ).toThrow();
      expect(() =>
        ledger.record({ providerId: "p", modelId: "m", outcome: "ok", inputTokens: -1 }),
      ).toThrow();
      expect(ledger.count()).toBe(0);
    } finally {
      db.close();
    }
  });

  test("task attempts stay in tasks.attempt + evidence rows (no separate ledger)", () => {
    const accounting = describeTaskAttemptAccounting({ attempt: 2, resultEvidenceIds: ["e-1", "e-2"] });
    expect(accounting.attempt).toBe(2);
    expect(accounting.evidenceCount).toBe(2);
    expect(accounting.separateLedgerNeeded).toBe(false);
  });
});

describe("rate limiter S2 remediation: bounded waiters + unified admission", () => {
  test("F-C01 overflow-execute: newcomer refused when the unified line is full", async () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 1, maxQueuedPerKey: 1, sleep: () => Promise.resolve() });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = limiter.execute(KEY, async () => {
      await gate;
      return "first";
    });
    await Promise.resolve();
    await Promise.resolve();
    // Unified line now full (0 waiters + 1 queued >= maxQueued 1).
    expect(limiter.admit(KEY, "q-1")).toBe("queued");
    await expect(limiter.execute(KEY, async () => "second")).rejects.toThrow(RateLimitOverflowError);
    // Refused newcomer never ran; committed work intact; busy slot => atomic no-op.
    expect(limiter.queued(KEY)).toBe(1);
    expect(limiter.admitNext(KEY)).toBeNull();
    expect(limiter.queued(KEY)).toBe(1);
    releaseFirst();
    expect((await first).status).toBe("ok");
    // Drained atomically once a slot frees.
    expect(limiter.admitNext(KEY)).toBe("q-1");
    expect(limiter.queued(KEY)).toBe(0);
    limiter.release(KEY);
    expect(limiter.inflight(KEY)).toBe(0);
  });

  test("F-C02 mixed-path fairness: one bound, FIFO waiters, atomic admitNext", async () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 1, maxQueuedPerKey: 2, sleep: () => Promise.resolve() });
    expect(limiter.admit(KEY, "w-1")).toBe("admitted"); // holds the only slot
    expect(limiter.admit(KEY, "q-1")).toBe("queued"); // id line: 1
    // One execute waiter joins the same unified line (1 queued + 1 waiter >= 2 → full).
    let waiterRan = false;
    const waiter = limiter.execute(KEY, async () => {
      waiterRan = true;
      return "w";
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(waiterRan).toBe(false); // parked: zero inference while waiting
    expect(limiter.admit(KEY, "q-2")).toBe("rejected-overflow"); // both lines counted
    expect(limiter.queued(KEY)).toBe(1); // committed queue preserved
    // Release wakes the longest-waiting execute waiter (FIFO).
    limiter.release(KEY);
    expect((await waiter).status).toBe("ok");
    expect(waiterRan).toBe(true);
    // Queued ids advance only via atomic admitNext (slot free again after release).
    expect(limiter.admitNext(KEY)).toBe("q-1");
    expect(limiter.inflight(KEY)).toBe(1);
    limiter.release(KEY);
    expect(limiter.inflight(KEY)).toBe(0);
    expect(limiter.queued(KEY)).toBe(0);
  });

  test("F-C04 duplicate→queued: re-admit is idempotent, never overflow", () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 1, maxQueuedPerKey: 2 });
    expect(limiter.admit(KEY, "w-1")).toBe("admitted");
    expect(limiter.admit(KEY, "q-1")).toBe("queued");
    expect(limiter.admit(KEY, "q-1")).toBe("queued"); // duplicate → queued
    expect(limiter.queued(KEY)).toBe(1); // not double-counted
    expect(limiter.enqueue(KEY, "q-1")).toBe("duplicate"); // direct call still reports duplicate
  });
});

describe("rate limiter S2 remediation: status-less auth is auth-blocked, never transient", () => {
  test("F-C03 code-only UNAUTHENTICATED (no .status) → auth-blocked, exactly 1 attempt", async () => {
    const limiter = new RateLimiter({ maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 1 });
    let calls = 0;
    const res = await limiter.execute(KEY, async () => {
      calls += 1;
      throw Object.assign(new Error("UNAUTHENTICATED: bad credential (no inference)"), {
        code: "UNAUTHENTICATED",
      });
    });
    expect(res.status).toBe("auth-blocked");
    expect(res.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(res.delaysMs).toEqual([]);
  });

  test("F-C03 message-only '403 Forbidden' (no .status/.code) → auth-blocked, exactly 1 attempt", async () => {
    const limiter = new RateLimiter({ maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 1 });
    let calls = 0;
    const res = await limiter.execute(KEY, async (): Promise<string> => {
      calls += 1;
      throw new Error("Request failed: 403 Forbidden (no inference)");
    });
    expect(res.status).toBe("auth-blocked");
    expect(res.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(res.delaysMs).toEqual([]);
  });

  test("F-C03 classifier: auth regex on code+message before transient fallback", () => {
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "PERMISSION_DENIED" }))).toBe("auth-blocked");
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "unauthenticated" }))).toBe("auth-blocked");
    expect(classifyTransportError(new Error("Request failed with status code 403"))).toBe("auth-blocked");
    expect(classifyTransportError(new Error("socket hang up ECONNRESET"))).toBe("transient");
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "RATE_LIMITED" }))).toBe("rate-limited");
  });
});

describe("rate limiter S3 hardening: backoff sanitize, reasonCode allowlist, auth resume split", () => {
  test("backoff NaN/negative inputs fail closed to zero delay", () => {
    expect(computeRateLimitBackoffMs(0, NaN, 500, () => 1)).toBe(0);
    expect(computeRateLimitBackoffMs(0, -100, 500, () => 1)).toBe(0);
    expect(computeRateLimitBackoffMs(0, 100, -5, () => 1)).toBe(0);
    expect(computeRateLimitBackoffMs(0, 100, NaN, () => 1)).toBe(0);
    expect(computeRateLimitBackoffMs(0, 100, 500, () => 1)).toBe(100); // sane path unchanged
  });

  test("reasonCode allowlist rejects secret-shaped values", () => {
    const registry = new BlockRegistry();
    const at = new Date("2026-11-11T00:00:00.000Z").toISOString();
    expect(registry.markQuotaPaused("m-q", "402", at).reasonCode).toBe("402");
    expect(() => registry.markAuthBlocked("m-s", "xoxb-fake-token", at)).toThrow();
    expect(() => registry.markAuthBlocked("m-s", "ASIAIOSFODNN7EXAMPLE", at)).toThrow();
    expect(() => registry.markQuotaPaused("m-s", "402; DROP TABLE x", at)).toThrow();
    expect(registry.isBlocked("m-s")).toBe(false);
  });

  test("auth resume split: traffic triggers cannot clear auth blocks", () => {
    const registry = new BlockRegistry();
    const at = new Date("2026-11-11T00:00:00.000Z").toISOString();
    registry.markAuthBlocked("m-a", "401", at);
    expect(() => registry.resume("m-a", "new-post")).toThrow();
    expect(registry.isBlocked("m-a")).toBe(true);
    expect(registry.resume("m-a", "approval-granted")).toBe(true);
    expect(registry.isBlocked("m-a")).toBe(false);
    registry.markQuotaPaused("m-q", "402", at);
    expect(registry.resume("m-q", "new-post")).toBe(true);
    expect([...AUTH_RESUME_TRIGGERS].sort()).toEqual(["approval-granted", "credential-rotated"]);
  });
});

describe("rate limiter M5-02-FIX-02 FINDING-01: re-admit queued id never ghosts", () => {
  test("queue under pressure → release → admit same id → queued, single admitNext", () => {
    const limiter = new RateLimiter({ maxConcurrentPerKey: 1, maxQueuedPerKey: 2 });
    expect(limiter.admit(KEY, "w-1")).toBe("admitted"); // holds the only slot
    expect(limiter.admit(KEY, "q-1")).toBe("queued"); // queued under pressure
    limiter.release(KEY); // slot frees, but q-1 is still queued
    // Re-admitting the already-queued id must stay queued (not admitted),
    // otherwise the queued entry ghosts and drains twice via admitNext.
    expect(limiter.admit(KEY, "q-1")).toBe("queued");
    expect(limiter.queued(KEY)).toBe(1);
    expect(limiter.admitNext(KEY)).toBe("q-1");
    expect(limiter.queued(KEY)).toBe(0);
    expect(limiter.admitNext(KEY)).toBeNull(); // no double-drain
    limiter.release(KEY);
    expect(limiter.inflight(KEY)).toBe(0);
  });
});

describe("rate limiter M5-02-FIX-02 S2-01: extended auth vocab is zero-retry", () => {
  const codeOnlyShapes: ReadonlyArray<{ code: string; message?: string }> = [
    { code: "ACCESS_DENIED" },
    { code: "INVALID_API_KEY" },
    { code: "TOKEN_EXPIRED" },
    { code: "AUTH_FAILED" },
    { code: "invalid_token" },
  ];
  for (const { code } of codeOnlyShapes) {
    test(`code-only ${code} (no .status) → auth-blocked, exactly 1 attempt`, async () => {
      const limiter = new RateLimiter({ maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 1 });
      let calls = 0;
      const res = await limiter.execute(KEY, async (): Promise<string> => {
        calls += 1;
        throw Object.assign(new Error(`${code} (no inference)`), { code });
      });
      expect(res.status).toBe("auth-blocked");
      expect(res.attempts).toBe(1);
      expect(calls).toBe(1);
      expect(res.delaysMs).toEqual([]);
    });
  }

  const messageOnlyShapes: readonly string[] = [
    "ACCESS_DENIED: caller lacks permission (no inference)",
    "Invalid API key provided (no inference)",
    "TOKEN_EXPIRED: refresh required (no inference)",
    "AUTH_FAILED: credential rejected (no inference)",
    "invalid_token: bearer rejected (no inference)",
  ];
  for (const message of messageOnlyShapes) {
    test(`message-only '${message.slice(0, 24)}…' (no .status/.code) → auth-blocked, exactly 1 attempt`, async () => {
      const limiter = new RateLimiter({ maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 1 });
      let calls = 0;
      const res = await limiter.execute(KEY, async (): Promise<string> => {
        calls += 1;
        throw new Error(message);
      });
      expect(res.status).toBe("auth-blocked");
      expect(res.attempts).toBe(1);
      expect(calls).toBe(1);
      expect(res.delaysMs).toEqual([]);
    });
  }

  test("classifier: extended auth vocab never falls to transient", () => {
    for (const code of ["ACCESS_DENIED", "INVALID_API_KEY", "TOKEN_EXPIRED", "AUTH_FAILED", "invalid_token"]) {
      expect(classifyTransportError(Object.assign(new Error("x"), { code }))).toBe("auth-blocked");
    }
    for (const message of [
      "ACCESS_DENIED",
      "Invalid API key",
      "TOKEN_EXPIRED",
      "AUTH_FAILED",
      "invalid_token",
    ]) {
      expect(classifyTransportError(new Error(message))).toBe("auth-blocked");
    }
  });
});

describe("rate limiter M8-01 hardening: digit-guarded codes, status strings, deadline", () => {
  test("digit-adjacent lookalikes never classify as quota/auth/rate-limited", () => {
    // Bare-substring matching would read 402/429 inside these digit runs.
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "14029" }))).not.toBe("quota");
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "14029" }))).not.toBe("rate-limited");
    expect(classifyTransportError(new Error("upstream error 4021, retry later"))).not.toBe("quota");
    expect(classifyTransportError(new Error("upstream error 4021, retry later"))).not.toBe("auth-blocked");
    expect(classifyTransportError(new Error("fault 240314 in module 7"))).not.toBe("auth-blocked");
    expect(classifyTransportError(new Error("fault 240314 in module 7"))).not.toBe("rate-limited");
    expect(classifyProviderStatus("error 14029 occurred")).not.toBe("rate-limited");
    expect(classifyProviderStatus("error 14029 occurred")).toBe("permanent");
    expect(classifyProviderStatus("error 4021 occurred")).not.toBe("quota");
  });

  test("anchored standalone codes still classify (letters/punctuation boundaries count)", () => {
    expect(classifyProviderStatus("HTTP 429 Too Many Requests")).toBe("rate-limited");
    expect(classifyProviderStatus("Error 402 Payment Required")).toBe("quota");
    expect(classifyProviderStatus("401 Unauthorized")).toBe("auth-blocked");
    expect(classifyProviderStatus("denied: 403 Forbidden")).toBe("auth-blocked");
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "ERR_429_RETRY" }))).toBe("rate-limited");
    expect(classifyTransportError(new Error("failed with 429 after gateway"))).toBe("rate-limited");
    expect(classifyTransportError(new Error("quota exceeded: 402 for project"))).toBe("quota");
  });

  test("status-less auth shapes stay auth-blocked with exactly one attempt", async () => {
    for (const shape of [
      Object.assign(new Error("bad key (no inference)"), { code: "INVALID_API_KEY" }),
      new Error("request denied: 403 Forbidden (no inference)"),
      Object.assign(new Error("expired (no inference)"), { code: "TOKEN_EXPIRED" }),
    ]) {
      const limiter = new RateLimiter({ maxAttempts: 5, sleep: () => Promise.resolve(), random: () => 1 });
      let calls = 0;
      const res = await limiter.execute(KEY, async (): Promise<string> => {
        calls += 1;
        throw shape;
      });
      expect(res.status).toBe("auth-blocked");
      expect(res.attempts).toBe(1);
      expect(calls).toBe(1);
      expect(res.delaysMs).toEqual([]);
    }
  });

  test("deadline breach is transient with bounded retries, then transient-terminal", async () => {
    const limiter = new RateLimiter({
      maxAttempts: 3,
      timeoutMs: 20,
      backoffBaseMs: 1,
      backoffCapMs: 1,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    let calls = 0;
    const res = await limiter.execute(KEY, async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return "never";
    });
    expect(res.status).toBe("transient-terminal");
    expect(res.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(res.delaysMs.length).toBe(2);
  });

  test("fast transport under a generous deadline succeeds on the first attempt", async () => {
    const limiter = new RateLimiter({ timeoutMs: 5000, sleep: () => Promise.resolve() });
    const res = await limiter.execute(KEY, async () => "fast");
    expect(res.status).toBe("ok");
    expect(res.value).toBe("fast");
    expect(res.attempts).toBe(1);
  });

  test("invalid timeoutMs disables the deadline (legacy no-deadline behavior)", async () => {
    for (const timeoutMs of [NaN, -5, 0, Number.POSITIVE_INFINITY]) {
      const limiter = new RateLimiter({ timeoutMs, sleep: () => Promise.resolve() });
      const res = await limiter.execute(KEY, async () => "ok-no-deadline");
      expect(res.status).toBe("ok");
      expect(res.attempts).toBe(1);
    }
  });
});

describe("rate limiter M8-01-FIX-01 F-M8-02: null-status auth never retries transient", () => {
  test("classifier: null-status + auth code/message → auth-blocked, never transient", () => {
    expect(classifyTransportError(Object.assign(new Error("x"), { status: null, code: "UNAUTHENTICATED" }))).toBe(
      "auth-blocked",
    );
    expect(classifyTransportError(Object.assign(new Error("x"), { status: null, code: "PERMISSION_DENIED" }))).toBe(
      "auth-blocked",
    );
    expect(classifyTransportError(Object.assign(new Error("401 Unauthorized (no inference)"), { status: null }))).toBe(
      "auth-blocked",
    );
    expect(classifyTransportError(Object.assign(new Error("403 Forbidden (no inference)"), { status: null }))).toBe(
      "auth-blocked",
    );
    // Null status WITHOUT auth markers keeps the documented unknown fallback.
    expect(classifyTransportError(Object.assign(new Error("weird"), { status: null, code: "SOME_WEIRD" }))).toBe(
      "transient",
    );
    expect(classifyTransportError(Object.assign(new Error("weird"), { status: null }))).toBe("transient");
  });

  test("execute: null-status UNAUTHENTICATED costs exactly 1 attempt, zero retries", async () => {
    for (const shape of [
      Object.assign(new Error("bad credential (no inference)"), { status: null, code: "UNAUTHENTICATED" }),
      Object.assign(new Error("401 Unauthorized (no inference)"), { status: null }),
    ]) {
      const limiter = new RateLimiter({ maxAttempts: 5, sleep: () => Promise.resolve(), random: () => 1 });
      let calls = 0;
      const res = await limiter.execute(KEY, async (): Promise<string> => {
        calls += 1;
        throw shape;
      });
      expect(res.status).toBe("auth-blocked");
      expect(res.attempts).toBe(1);
      expect(calls).toBe(1);
      expect(res.delaysMs).toEqual([]);
    }
  });
});

describe("rate limiter M8-01-FIX-01 F-M8-04: numeric/string transient agreement", () => {
  test("408/502/503/504 agree as numbers and as digit-guarded strings", () => {
    for (const code of [408, 502, 503, 504]) {
      expect(classifyProviderStatus(code)).toBe("transient");
      expect(classifyProviderStatus(String(code))).toBe("transient");
      expect(classifyProviderStatus(`HTTP ${code} gateway trouble (no inference)`)).toBe("transient");
    }
    expect(classifyProviderStatus("HTTP 503 Service Unavailable")).toBe("transient");
    expect(classifyProviderStatus("gateway 502 bad gateway")).toBe("transient");
    expect(classifyProviderStatus("request 408 timeout")).toBe("transient");
    expect(classifyProviderStatus("504 gateway timeout")).toBe("transient");
  });

  test("digit-run lookalikes stay permanent, never transient/quota", () => {
    expect(classifyProviderStatus("error 5021 occurred")).toBe("permanent");
    expect(classifyProviderStatus("job 14081 cached")).toBe("permanent");
    expect(classifyProviderStatus("build 5031 green")).toBe("permanent");
    expect(classifyProviderStatus("trace 15040 ok")).toBe("permanent");
    expect(classifyProviderStatus("error 5021 occurred")).not.toBe("transient");
    expect(classifyProviderStatus("error 5021 occurred")).not.toBe("quota");
  });
});

describe("rate limiter M8-01-FIX-01 F-M8-03: dispatcher parity (auth never retries, 14029 transient)", () => {
  test("limiter and dispatcher agree on the core shapes", () => {
    type Shape = { readonly err: unknown; readonly limiter: ProviderOutcomeClass; readonly quota: boolean; readonly transient: boolean };
    const shapes: readonly Shape[] = [
      { err: { status: 402 }, limiter: "quota", quota: true, transient: false },
      { err: { status: 401 }, limiter: "auth-blocked", quota: false, transient: false },
      { err: { status: 403 }, limiter: "auth-blocked", quota: false, transient: false },
      { err: { status: 429 }, limiter: "rate-limited", quota: false, transient: true },
      { err: { status: 503 }, limiter: "transient", quota: false, transient: true },
      { err: { status: "503" }, limiter: "transient", quota: false, transient: true },
      { err: Object.assign(new Error("bad credential (no inference)"), { code: "UNAUTHENTICATED" }), limiter: "auth-blocked", quota: false, transient: false },
      { err: Object.assign(new Error("denied (no inference)"), { code: "PERMISSION_DENIED" }), limiter: "auth-blocked", quota: false, transient: false },
      { err: new Error("Invalid API key provided (no inference)"), limiter: "auth-blocked", quota: false, transient: false },
      { err: new Error("request rate-limited, retry later (no inference)"), limiter: "rate-limited", quota: false, transient: true },
      { err: Object.assign(new Error("x"), { code: "14029" }), limiter: "transient", quota: false, transient: true },
      { err: new Error("upstream error 4021, retry later"), limiter: "transient", quota: false, transient: true },
      { err: { status: "error 5021" }, limiter: "permanent", quota: false, transient: false },
      { err: { status: "error 14029" }, limiter: "permanent", quota: false, transient: false },
      { err: { status: "fault 240314" }, limiter: "permanent", quota: false, transient: false },
    ];
    for (const { err, limiter, quota, transient } of shapes) {
      expect(classifyTransportError(err)).toBe(limiter);
      expect(isDispatchQuotaError(err)).toBe(quota);
      expect(isDispatchAuthError(err)).toBe(limiter === "auth-blocked");
      expect(isTransientError(err)).toBe(transient);
    }
  });
});
