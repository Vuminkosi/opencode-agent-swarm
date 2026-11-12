/**
 * M8-01 Phase 1 residual hardening (spec §14 M8 + §12/§13 follow-ons).
 *
 * Disposable tmp file DBs/Git repos ONLY (never the canonical checkout or
 * user projects). Fake transports only (no network, no model inference, no
 * paid calls). Tmp DBs/repos; zero inference; no canonical mutation.
 *
 * Rows:
 * (1) 10k-row outbox replay: >10,000 committed rows drain across passes
 *     with EVERY pass scan-bounded (scanned <= REPLAY_SCAN_CAP) — bounded
 *     scan proof + full eventual redelivery, zero loss, zero dupes.
 * (2) Independent-connection contention: TWO separate bun:sqlite handles
 *     (two SwarmStore instances + two usage-ledger Database handles, same
 *     file DB, WAL + busy_timeout) interleave board/wake/ledger writes —
 *     zero SQLITE_BUSY, zero lost rows.
 * (3) Non-vacuous secrets canaries: secret-shaped canaries flow LIVE
 *     through error inputs (positive control: the in-memory error DID
 *     carry the canary) and are asserted ABSENT from every persisted or
 *     rendered surface (throttle results, block records, rejection texts,
 *     ledger telemetry, outbox rows, board output, ingest reports, error
 *     details). A leak anywhere fails the suite.
 * (4) Provider classification hardening rows: anchored digit-guarded
 *     401/403/402/429 (no substring false-positives), status-less auth
 *     shapes (single attempt, zero retries), timeout handling (deadline
 *     breach is bounded transient, then terminal).
 * (5) Windows path/junction safety on the live target: real `mklink /J`
 *     junction escape refused (lexical-inside/physical-outside denied);
 *     true symlinks best-effort (skip with reason when privilege-blocked);
 *     case-insensitive alias + 8.3 short-name confinement asserted.
 * (6) Model/permission inheritance re-verification (report-only: asserts
 *     current green behavior, adds no logic).
 * (7) Codex adapter stays explicitly unsupported — no transport change in
 *     this file (asserted by absence: this suite never imports the stub).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore } from "../../packages/runtime/src/db/store.js";
import {
  BlockRegistry,
  RateLimiter,
  classifyProviderStatus,
  classifyTransportError,
  rateLimitKeyFor,
} from "../../packages/runtime/src/services/rate-limiter.js";
import { CrashRecovery, REPLAY_SCAN_CAP } from "../../packages/runtime/src/services/recovery.js";
import { EventIngest } from "../../packages/runtime/src/services/ingest.js";
import { UsageLedger, ensureUsageLedgerSchema } from "../../packages/runtime/src/services/usage-ledger.js";
import { isAuthBlockedStatus, isQuotaStatus, resolutionRetryPolicy } from "../../packages/runtime/src/services/model-resolver.js";
import {
  bestEffortRealpathNoThrow,
  isWithinRoot,
  normalizeForCompare,
  resolveConfined,
  validateWorktreeWrite,
} from "../../packages/git-workspaces/src/path-policy.js";

const dirs: string[] = [];
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
});

// M8-01-FIX-01 SKIP-free junction proof: every privilege-gated leg records
// its outcome here. A skip pushes to `skippedLegs` (still logging the
// `[m8-junction]`/`[m8-symlink]` reason); a live refusal proof pushes to
// `provedLegs`. The trailing proof test fails the suite on ANY skip — a
// SKIP warning in the log is a FAIL, not a pass.
const skippedLegs: string[] = [];
const provedLegs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function rawHandle(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 10000;");
  return db;
}

function makeSwarm(store: SwarmStore): string {
  return store.createSwarm({
    title: "m8 release",
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m8",
    mode: "parity",
  }).id;
}

function addCoder(store: SwarmStore, swarmId: string): string {
  return store.addMember(swarmId, {
    name: "coder-a",
    role: "coder",
    nativeAgentId: "fake-agent",
    sessionId: "sess-a",
    model: { providerID: "fake", id: "fake-model" },
  }).id;
}

// ---------------------------------------------------------------------------
// (1) 10k-row replay: bounded scan per pass + full eventual redelivery.
// ---------------------------------------------------------------------------

describe("M8-01 10k replay: bounded scan per pass, full eventual redelivery", () => {
  test("10050 committed rows drain across scan-bounded passes, once each", async () => {
    const dir = tmpDir("m8-10k-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmId = makeSwarm(store);
      const TOTAL = 10_050;
      for (let i = 1; i <= TOTAL; i += 1) {
        store.appendPost(swarmId, {
          authorMemberId: null,
          kind: "message",
          body: `bulk ${i}`,
          idempotencyKey: `m8-bulk-${i}`,
        });
      }
      expect(store.listPendingOutbox(1).length).toBe(1);
      const recovery = new CrashRecovery({ store, db: raw });
      const seen = new Set<string>();
      let passes = 0;
      let deliveredTotal = 0;
      for (;;) {
        passes += 1;
        if (passes > 50) throw new Error("replay did not drain within 50 passes");
        const report = await recovery.replayOutbox(async () => {}, { maxPerRun: 1000 });
        // BOUNDED SCAN PROOF: the store read never exceeds the documented cap.
        expect(report.scanned).toBeLessThanOrEqual(REPLAY_SCAN_CAP);
        expect(report.delivered).toBeLessThanOrEqual(1000);
        expect(report.checked).toBe(report.delivered + report.failed);
        expect(report.failed).toBe(0);
        for (const id of report.deliveredIds) {
          expect(seen.has(id)).toBe(false); // never redelivered
          seen.add(id);
        }
        deliveredTotal += report.delivered;
        if (report.checked === 0) break;
      }
      expect(deliveredTotal).toBe(TOTAL);
      expect(seen.size).toBe(TOTAL);
      expect(store.listPendingOutbox(10).length).toBe(0); // zero lost, zero left
      expect(passes).toBeLessThanOrEqual(50);
    } finally {
      store.close();
      raw.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// (2) Independent-connection contention: two handles, one file, zero BUSY.
// ---------------------------------------------------------------------------

describe("M8-01 contention: two independent handles serialize with zero BUSY, zero loss", () => {
  test("interleaved board/wake/ledger writes across two SwarmStores + two ledger handles", async () => {
    const dir = tmpDir("m8-contend-");
    const dbPath = join(dir, "state.sqlite");
    const storeA = new SwarmStore(dbPath);
    const storeB = new SwarmStore(dbPath);
    const ledgerDbA = rawHandle(dbPath);
    const ledgerDbB = rawHandle(dbPath);
    ensureUsageLedgerSchema(ledgerDbA);
    const ledgerA = new UsageLedger(ledgerDbA);
    const ledgerB = new UsageLedger(ledgerDbB);
    let busyErrors = 0;
    const busy = (err: unknown): void => {
      if (/SQLITE_BUSY/i.test(String(err))) busyErrors += 1;
      else throw err;
    };
    try {
      const swarmId = makeSwarm(storeA);
      // Second handle sees the swarm committed by the first (shared file).
      expect(storeB.getSwarm(swarmId).id).toBe(swarmId);
      addCoder(storeA, swarmId);
      const ROUNDS = 120;
      const wakeIds: string[] = [];
      for (let i = 1; i <= ROUNDS; i += 1) {
        try {
          const a = storeA.appendPost(swarmId, {
            authorMemberId: null,
            kind: "message",
            body: `ping @coder-a a-${i}`,
            idempotencyKey: `m8-ct-a-${i}`,
          });
          const b = storeB.appendPost(swarmId, {
            authorMemberId: null,
            kind: "message",
            body: `ping @coder-a b-${i}`,
            idempotencyKey: `m8-ct-b-${i}`,
          });
          wakeIds.push(...a.wakeIds, ...b.wakeIds);
          ledgerA.record({ providerId: "fake", modelId: "m", outcome: "ok", taskId: `ct-a-${i}` });
          ledgerB.record({ providerId: "fake", modelId: "m", outcome: "ok", taskId: `ct-b-${i}` });
          // Cross-handle lifecycle: claim on one handle, complete on the other.
          for (const wid of [...a.wakeIds, ...b.wakeIds]) {
            const claimer = i % 2 === 0 ? storeA : storeB;
            const completer = i % 2 === 0 ? storeB : storeA;
            if (claimer.claimWakeForDispatch(wid).status === "admitted") {
              completer.completeWake(wid, "succeeded");
            }
          }
        } catch (err) {
          busy(err);
        }
      }
      expect(busyErrors).toBe(0);
      // Zero lost rows: every post persisted, every wake terminal, ledger whole.
      expect(storeA.getPostsAfter(swarmId, 0, ROUNDS * 2 + 10).length).toBe(ROUNDS * 2);
      for (const wid of wakeIds) {
        expect(storeA.getWake(wid).state).toBe("succeeded");
      }
      expect(ledgerA.count()).toBe(ROUNDS * 2);
      // Outbox fully redelivers across handles (restart-style drain on handle B).
      const raw = rawHandle(dbPath);
      try {
        const recovery = new CrashRecovery({ store: storeB, db: raw });
        let delivered = 0;
        for (let pass = 0; pass < 20; pass += 1) {
          const report = await recovery.replayOutbox(async () => {}, { maxPerRun: 1000 });
          expect(report.scanned).toBeLessThanOrEqual(REPLAY_SCAN_CAP);
          delivered += report.delivered;
          if (report.checked === 0) break;
        }
        expect(storeB.listPendingOutbox(10).length).toBe(0);
        expect(delivered).toBeGreaterThan(0);
      } finally {
        raw.close();
      }
    } finally {
      storeA.close();
      storeB.close();
      ledgerDbA.close();
      ledgerDbB.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// (3) Non-vacuous secrets canaries: live flow, absent everywhere persisted.
// ---------------------------------------------------------------------------

const CANARY_SK = "sk-canary-M8-9f8e7d6c5b4a";
const CANARY_XOX = "xoxb-canary-M8-112233";

function assertNoCanary(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.includes(CANARY_SK)) throw new Error(`${label} leaked the sk canary: ${text.slice(0, 300)}`);
  if (text.includes(CANARY_XOX)) throw new Error(`${label} leaked the xox canary: ${text.slice(0, 300)}`);
}

describe("M8-01 secrets canaries: live secret flow never reaches persisted/rendered surfaces", () => {
  test("auth-failure canary: in-memory error carries it, nothing persisted does", async () => {
    const limiter = new RateLimiter({ maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 0 });
    const key = rateLimitKeyFor("fake-provider", "fake-model");
    let calls = 0;
    const res = await limiter.execute(key, async (): Promise<string> => {
      calls += 1;
      // Real SDK failures sometimes embed key-like tokens in messages.
      throw Object.assign(new Error(`401 Unauthorized: key ${CANARY_SK} rejected (no inference)`), {
        code: "UNAUTHENTICATED",
      });
    });
    expect(res.status).toBe("auth-blocked");
    expect(res.attempts).toBe(1); // single attempt, zero retries
    expect(calls).toBe(1);
    assertNoCanary("throttle result", res);
  });

  test("block registry rejects secret-shaped reason codes WITHOUT echoing them", () => {
    const registry = new BlockRegistry();
    const at = new Date("2026-11-12T00:00:00.000Z").toISOString();
    let message = "";
    try {
      registry.markAuthBlocked("m-s", CANARY_SK, at);
      throw new Error("must have rejected the secret-shaped reasonCode");
    } catch (err) {
      message = String(err);
      expect(String(err)).toMatch(/redacted code only/);
    }
    assertNoCanary("rejection error", message); // redaction verified live
    expect(registry.isBlocked("m-s")).toBe(false);
    // Benign blocks still work and render clean.
    registry.markQuotaPaused("m-q", "402", at);
    assertNoCanary("block record", registry.get("m-q"));
    expect(registry.resume("m-q", "new-post")).toBe(true);
  });

  test("recovery + store + outbox + board + ledger + ingest surfaces stay clean after canary flow", async () => {
    const dir = tmpDir("m8-canary-");
    const dbPath = join(dir, "state.sqlite");
    const store = new SwarmStore(dbPath);
    const raw = rawHandle(dbPath);
    try {
      const swarmId = makeSwarm(store);
      addCoder(store, swarmId);
      const recovery = new CrashRecovery({ store, db: raw });
      // Error inputs CONTAIN the canary (positive control: they flowed).
      const badInput = { wakeId: "", memberId: CANARY_XOX, sessionId: "s", externalId: "ext" };
      expect(JSON.stringify(badInput).includes(CANARY_XOX)).toBe(true);
      try {
        recovery.recordAdmission(badInput);
        throw new Error("must have rejected the empty wakeId");
      } catch (err) {
        assertNoCanary("recovery error", { message: String(err), details: (err as { details?: unknown }).details });
      }
      // Benign durable writes + failure carrying the canary in-memory only.
      store.appendPost(swarmId, { authorMemberId: null, kind: "message", body: "benign hello", idempotencyKey: "m8cn-1" });
      const failing = await recovery.replayOutbox(async () => {
        throw Object.assign(new Error(`token ${CANARY_SK} expired mid-delivery (no inference)`), {
          code: "TOKEN_EXPIRED",
        });
      });
      expect(failing.failed).toBeGreaterThan(0);
      assertNoCanary("failing replay report", failing);
      assertNoCanary("pending outbox rows", store.listPendingOutbox(100));
      assertNoCanary("board output", store.getPostsAfter(swarmId, 0, 100));
      const ledger = new UsageLedger(raw);
      ledger.record({ providerId: "fake", modelId: "m", outcome: "auth-blocked", taskId: "m8cn-t1" });
      assertNoCanary("ledger totals", ledger.totalsByProviderModel());
      assertNoCanary("ledger cost telemetry", ledger.costPerVerifiedTask(["m8cn-t1"]));
      const ingest = new EventIngest(dbPath);
      try {
        const receipt = ingest.record(swarmId, { source: "opencode", externalEventId: "evt-m8cn-1" });
        assertNoCanary("ingest receipt", receipt);
        const dedupeRows = raw.query<{ external_event_id: string }, []>("SELECT external_event_id FROM inbox_dedupe").all();
        assertNoCanary("ingest persisted events", dedupeRows);
      } finally {
        ingest.close();
      }
    } finally {
      store.close();
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) Provider classification hardening rows.
// ---------------------------------------------------------------------------

describe("M8-01 classification: anchored codes, status-less auth, timeouts", () => {
  test("standalone numeric codes classify; digit-run lookalikes do not", () => {
    expect(classifyProviderStatus("429")).toBe("rate-limited");
    expect(classifyProviderStatus("402")).toBe("quota");
    expect(classifyProviderStatus("401")).toBe("auth-blocked");
    expect(classifyProviderStatus("HTTP status 429 from gateway")).toBe("rate-limited");
    expect(classifyProviderStatus("job 14029 result cached")).toBe("permanent");
    expect(classifyProviderStatus("build 4021 passed")).toBe("permanent");
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "ERR429" }))).toBe("rate-limited");
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "E402X" }))).toBe("quota");
    expect(classifyTransportError(Object.assign(new Error("x"), { code: "14029" }))).toBe("transient");
    expect(classifyTransportError(new Error("upstream error 4021, retry later"))).toBe("transient");
  });

  test("status-less auth shapes are auth-blocked with exactly one attempt", async () => {
    const shapes: unknown[] = [
      Object.assign(new Error("bad credential (no inference)"), { code: "UNAUTHENTICATED" }),
      Object.assign(new Error("denied (no inference)"), { code: "PERMISSION_DENIED" }),
      new Error("request failed: 401 Unauthorized (no inference)"),
      new Error("request failed: 403 Forbidden (no inference)"),
    ];
    for (const shape of shapes) {
      expect(classifyTransportError(shape)).toBe("auth-blocked");
      const limiter = new RateLimiter({ maxAttempts: 5, sleep: () => Promise.resolve(), random: () => 1 });
      let calls = 0;
      const res = await limiter.execute("k", async (): Promise<string> => {
        calls += 1;
        throw shape;
      });
      expect(res.status).toBe("auth-blocked");
      expect(res.attempts).toBe(1);
      expect(calls).toBe(1);
    }
  });

  test("timeout shapes and deadline breaches are bounded transient, never quota/auth", async () => {
    expect(classifyTransportError(Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }))).toBe(
      "transient",
    );
    expect(classifyTransportError(new Error("socket hang up ECONNRESET"))).toBe("transient");
    expect(classifyTransportError(new Error("fetch failed: FETCH_TIMEOUT"))).toBe("transient");
    const limiter = new RateLimiter({
      maxAttempts: 3,
      timeoutMs: 15,
      backoffBaseMs: 1,
      backoffCapMs: 1,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    let calls = 0;
    const res = await limiter.execute("k-timeout", async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return "never";
    });
    expect(res.status).toBe("transient-terminal");
    expect(res.attempts).toBe(3); // bounded retries, then terminal
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// (5) Windows path/junction safety on the live target.
// ---------------------------------------------------------------------------

describe("M8-01 win32 junction/case/8.3 confinement on the live target", () => {
  // Caller posture (matches worktree-manager: physical roots in, physical
  // comparison out): resolveConfined compares the ancestor-resolved
  // physical form against ONE root spelling, so roots are canonicalized
  // with realpathSync.native first — exactly as production call sites do
  // via realpathFsNoThrow. The tmp tree on this host is 8.3-short
  // (C:\Users\VUMINK~1\...), which would otherwise make even benign
  // candidates look "outside" a short root after native expansion.
  function physRoot(dir: string): string {
    return realpathSync.native(dir);
  }

  function expectLinkDeny(rootAbs: string, candidate: string): void {
    try {
      resolveConfined(rootAbs, candidate);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("PATH_ESCAPES_ROOT");
      expect(String(err)).toMatch(/outside its root via link/);
      return;
    }
    throw new Error(`link escape was NOT refused: ${candidate}`);
  }

  test("real mklink /J junction escape is refused (lexical-inside, physical-outside)", () => {
    const outside = tmpDir("m8-j-target-");
    const root = tmpDir("m8-j-root-");
    const canonical = tmpDir("m8-j-canon-");
    const link = join(root, "leak");
    const mk = Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, outside], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (mk.exitCode !== 0) {
      // Privilege/tool-blocked: record the reason, skip the live refusal proof.
      skippedLegs.push(`m8-junction: mklink /J unavailable: ${mk.stderr.toString().trim().slice(0, 200)}`);
      console.warn(`[m8-junction] SKIP: mklink /J unavailable: ${mk.stderr.toString().trim().slice(0, 200)}`);
      return;
    }
    expect(existsSync(link)).toBe(true);
    // resolveConfined: lexical form is inside the root, physical form lands
    // in the outside target → PATH_ESCAPES_ROOT (asserted on the code).
    expectLinkDeny(physRoot(root), join("leak", "evil.txt"));
    // Worktree gate denies before owned grants are even consulted.
    const verdict = validateWorktreeWrite(
      { canonicalRoot: canonical, worktreePath: root, ownedPaths: ["leak"], forbiddenPaths: [] },
      join("leak", "evil.txt"),
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("OUTSIDE_WORKTREE");
    // Control: a non-link path under the grant still resolves fine.
    mkdirSync(join(root, "plain"), { recursive: true });
    expect(resolveConfined(physRoot(root), join("plain", "ok.txt"))).toContain("plain");
    provedLegs.push("junction-refused-live");
  });

  test("true symlinks: refused when creatable, skipped with reason when privilege-blocked", () => {
    const outside = tmpDir("m8-s-target-");
    const root = tmpDir("m8-s-root-");
    const link = join(root, "slink");
    try {
      symlinkSync(outside, link, "dir");
    } catch (err) {
      skippedLegs.push(`m8-symlink: dir symlink needs privilege: ${String(err).slice(0, 160)}`);
      console.warn(`[m8-symlink] SKIP: dir symlink needs privilege on this host: ${String(err).slice(0, 160)}`);
      return;
    }
    expect(() => resolveConfined(physRoot(root), join("slink", "evil.txt"))).toThrow(/outside its root via link/);
    provedLegs.push("symlink-refused-live");
  });

  test("case-insensitive alias and 8.3 short-name spellings stay confined identically", () => {
    const root = tmpDir("m8-case-root-");
    const physicalRoot = physRoot(root);
    const longName = "a-very-long-directory-name-for-shortname-probe";
    const sub = join(root, longName);
    mkdirSync(sub, { recursive: true });
    // Case alias: every casing resolves to the same comparison form, inside.
    const lower = resolveConfined(physicalRoot, join(longName.toLowerCase(), "f.txt"));
    const upper = resolveConfined(physicalRoot, join(longName.toUpperCase(), "F.TXT"));
    expect(lower).toBe(upper);
    expect(isWithinRoot(normalizeForCompare(physicalRoot), lower)).toBe(true);
    // 8.3 short-name spelling (volume-dependent; %~s probes the live form).
    const probe = Bun.spawnSync(["cmd", "/c", "for", "%A", "in", `("${sub}")`, "do", "@echo", "%~sA"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const shortSpelling = probe.exitCode === 0 ? probe.stdout.toString().trim().split("\n").pop()?.trim() ?? "" : "";
    if (shortSpelling === "" || shortSpelling === sub) {
      // 8.3 disabled or unresolvable on this volume: comparison forms still agree.
      expect(bestEffortRealpathNoThrow(normalizeForCompare(sub))).toBe(
        bestEffortRealpathNoThrow(normalizeForCompare(sub.toUpperCase())),
      );
      return;
    }
    expect(shortSpelling).toContain("~"); // genuine short form observed live
    const shortNorm = bestEffortRealpathNoThrow(normalizeForCompare(shortSpelling));
    const longNorm = bestEffortRealpathNoThrow(normalizeForCompare(realpathSync.native(sub)));
    expect(shortNorm).toBe(longNorm);
    expect(isWithinRoot(normalizeForCompare(physicalRoot), shortNorm)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (6) Model/permission inheritance re-verification (report-only, green).
// ---------------------------------------------------------------------------

describe("M8-01 inheritance re-verify: classifiers unchanged, no new logic", () => {
  test("quota/auth classifiers and no-retry policy still hold; limiter agrees", () => {
    expect(isQuotaStatus(402)).toBe(true);
    expect(isQuotaStatus("402")).toBe(true);
    expect(isQuotaStatus(429)).toBe(false);
    expect(isQuotaStatus(503)).toBe(false);
    expect(isAuthBlockedStatus(401)).toBe(true);
    expect(isAuthBlockedStatus(403)).toBe(true);
    expect(isAuthBlockedStatus("401")).toBe(true);
    expect(isAuthBlockedStatus(402)).toBe(false);
    expect(isAuthBlockedStatus(429)).toBe(false);
    expect(resolutionRetryPolicy()).toBe("no-retry");
    // Limiter honors the same inheritance: quota/auth never retry.
    expect(classifyProviderStatus(402)).toBe("quota");
    expect(classifyProviderStatus(401)).toBe("auth-blocked");
    expect(classifyProviderStatus(403)).toBe("auth-blocked");
  });
});

// ---------------------------------------------------------------------------
// M8-01-FIX-01 SKIP-free junction proof: both privilege-gated legs proved
// their refusals LIVE on this host. Any SKIP is a suite failure.
// ---------------------------------------------------------------------------

describe("M8-01-FIX-01 SKIP-free junction proof", () => {
  test("junction + symlink legs proved live, zero SKIP warnings", () => {
    expect(skippedLegs).toEqual([]);
    expect(provedLegs.sort()).toEqual(["junction-refused-live", "symlink-refused-live"]);
  });
});
