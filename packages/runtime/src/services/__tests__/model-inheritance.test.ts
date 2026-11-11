/**
 * MODEL-INHERIT-01 model/auth inheritance tests (12 required).
 *
 * Uses a FakeHarness (queue-only, records everything) + disposable
 * `:memory:` SwarmStore: no network, no model inference, no paid calls.
 * `LIVE_MODEL` / `LIVE_MODEL_APIKey` decoys are set in-process to prove
 * production paths ignore them; env is restored after each such test.
 * No test persists, logs, or transmits the decoy secret — the leak scan
 * (test 5/7) would fail if it did.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { ProtocolError } from "@opencode-swarm/protocol";
import { SwarmStore } from "../../db/store.js";
import { SwarmService, type ActivationHarness } from "../swarm-service.js";
import {
  ModelResolutionError,
  isAuthBlockedStatus,
  isQuotaStatus,
  resolutionRetryPolicy,
  resolveWakeModel,
  resolveWorkerModel,
} from "../model-resolver.js";

const ACTIVE = { providerID: "prov-active", id: "model-active" };
const NATIVE = { providerID: "prov-native", id: "model-native" };
const OVERRIDE = { providerID: "prov-override", id: "model-override" };
const HOST_DEFAULT = { providerID: "prov-host", id: "model-host" };

// Credential-shaped decoys: production must never echo these anywhere.
const DECOY_LIVE_MODEL = "prov-live/model-live-decoy";
const DECOY_API_KEY = "sk-test-decoy-0123456789abcdef";

const LIVE_KEYS = ["SWARM_ALLOW_LIVE_INFERENCE", "LIVE_MODEL", "LIVE_MODEL_APIKey"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of LIVE_KEYS) savedEnv[k] = process.env[k];
afterEach(() => {
  for (const k of LIVE_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setLiveDecoys(): void {
  process.env["SWARM_ALLOW_LIVE_INFERENCE"] = "1";
  process.env["LIVE_MODEL"] = DECOY_LIVE_MODEL;
  process.env["LIVE_MODEL_APIKey"] = DECOY_API_KEY;
}

/** Credential-shaped material must never appear in daemon artifacts. */
const SECRET_SHAPES: readonly RegExp[] = [
  /sk-[A-Za-z0-9-_]{8,}/,
  /sk-ant-[A-Za-z0-9-_]{8,}/,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/,
  /api[_-]?key\s*[:=]/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

interface SubmittedTurn {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string;
  readonly externalId: string;
  readonly reason: string;
}

class FakeHarness implements ActivationHarness {
  submitted: SubmittedTurn[] = [];
  appliedRules: Array<{ sessionId: string; rules: readonly { scope: string; action: string }[] }> = [];
  sessions = 0;

  async createSession(title: string, _directory: string): Promise<{ sessionId: string }> {
    this.sessions += 1;
    return { sessionId: `sess-fake-${this.sessions}-${title.length}` };
  }

  async switchAgent(_sessionId: string, _agentId: string): Promise<void> {}

  async submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "assigned_task";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }> {
    if (request.delivery !== "queue") throw new Error(`STEER_REJECTED: ${request.delivery}`);
    this.submitted.push({ ...request });
    return { externalId: request.externalId, admittedAt: new Date().toISOString(), transportNote: "fake-queue-admit" };
  }

  async applyPermissionRules(
    sessionId: string,
    rules: readonly { readonly scope: string; readonly action: "allow" | "deny" }[],
  ): Promise<void> {
    this.appliedRules.push({ sessionId, rules: [...rules] });
  }
}

function setup(): { store: SwarmStore; harness: FakeHarness; service: SwarmService } {
  const store = new SwarmStore(":memory:");
  const harness = new FakeHarness();
  return { store, harness, service: new SwarmService(store, harness) };
}

describe("model inheritance precedence (resolver)", () => {
  test("(1) active session model is inherited when it is the only source", () => {
    const resolved = resolveWorkerModel({ activeSessionModel: ACTIVE });
    expect(resolved.model).toEqual(ACTIVE);
    expect(resolved.source).toBe("active-session");
    expect(resolved.authReuse).toBe("host-existing");
    expect(resolved.historyPreserved).toBe(true);
  });

  test("(2) native agent model overrides the active session model", () => {
    const resolved = resolveWorkerModel({ nativeAgentModel: NATIVE, activeSessionModel: ACTIVE });
    expect(resolved.model).toEqual(NATIVE);
    expect(resolved.source).toBe("native-agent");
  });

  test("(3) explicit member override wins over native agent and active session", () => {
    const resolved = resolveWorkerModel({
      memberOverride: OVERRIDE,
      nativeAgentModel: NATIVE,
      activeSessionModel: ACTIVE,
      hostDefaultModel: HOST_DEFAULT,
    });
    expect(resolved.model).toEqual(OVERRIDE);
    expect(resolved.source).toBe("member-override");
  });

  test("(4) existing host credentials are reused — resolution carries refs only, performs no new auth", () => {
    const resolved = resolveWorkerModel({ nativeAgentModel: NATIVE, activeSessionModel: ACTIVE });
    // Reuse is structural: the resolution carries provider/model refs and an
    // explicit host-existing marker, and exposes no secret/auth channel.
    expect(resolved.authReuse).toBe("host-existing");
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toMatch(/key|secret|token|bearer|password|credential/i);
    for (const re of SECRET_SHAPES) expect(serialized).not.toMatch(re);
  });
});

describe("production isolation (service + store)", () => {
  test("(5) no credentials land in SQLite rows, harness payloads, or transport notes", async () => {
    setLiveDecoys();
    const { store, harness, service } = setup();
    try {
      const result = await service.activateSwarm({
        requirement: "Inheritance isolation check",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m-inherit",
        model: OVERRIDE,
        modelContext: { nativeAgentModel: NATIVE, activeSessionModel: ACTIVE },
      });
      const members = store.listMembers(result.swarm.id);
      const tasks = store.listTasks(result.swarm.id);
      const posts = store.getPostsAfter(result.swarm.id, 0);
      const corpus = [
        JSON.stringify(members),
        JSON.stringify(tasks),
        JSON.stringify(posts),
        JSON.stringify(harness.submitted),
      ].join("\n");
      expect(corpus).not.toContain(DECOY_API_KEY);
      expect(corpus).not.toContain(DECOY_LIVE_MODEL);
      for (const re of SECRET_SHAPES) expect(corpus).not.toMatch(re);
      // The resolved override is what was stored — refs only.
      for (const m of members) expect(m.model).toEqual(OVERRIDE);
    } finally {
      store.close();
    }
  });

  test("(6) LIVE_MODEL is ignored in production paths even when set", async () => {
    setLiveDecoys();
    // Resolver never consults the environment: context wins outright.
    const resolved = resolveWorkerModel({ activeSessionModel: ACTIVE });
    expect(resolved.model).toEqual(ACTIVE);
    const { store, service } = setup();
    try {
      const result = await service.activateSwarm({
        requirement: "Live model must not leak into production",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m-inherit",
        modelContext: { activeSessionModel: ACTIVE },
      });
      for (const w of result.workers) expect(w.member.model).toEqual(ACTIVE);
      expect(JSON.stringify(result)).not.toContain("model-live-decoy");
    } finally {
      store.close();
    }
  });

  test("(7) LIVE_MODEL_APIKey is ignored in production paths even when set", async () => {
    setLiveDecoys();
    const { store, harness, service } = setup();
    try {
      const result = await service.activateSwarm({
        requirement: "Live API key must not leak into production",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m-inherit",
        modelContext: { nativeAgentModel: NATIVE },
      });
      const corpus = [
        JSON.stringify(store.listMembers(result.swarm.id)),
        JSON.stringify(harness.submitted),
        JSON.stringify(result),
      ].join("\n");
      expect(corpus).not.toContain(DECOY_API_KEY);
      for (const re of SECRET_SHAPES) expect(corpus).not.toMatch(re);
    } finally {
      store.close();
    }
  });

  test("(8) live mismatch fails closed — env values never backfill an unresolvable combo", () => {
    setLiveDecoys();
    // No context at all: fail closed with MODEL_UNRESOLVABLE even though the
    // environment names a (decoy) live model. No silent fallback to env.
    let err: unknown = null;
    try {
      resolveWorkerModel({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModelResolutionError);
    expect((err as ModelResolutionError).code).toBe("MODEL_UNRESOLVABLE");
    expect((err as ModelResolutionError).retryable).toBe(false);
    // And a malformed explicit override fails closed rather than falling
    // through to a lower-precedence source.
    expect(() => resolveWorkerModel({ memberOverride: { providerID: "", id: "" }, activeSessionModel: ACTIVE })).toThrow(
      ModelResolutionError,
    );
  });
});

describe("session continuity + failure discipline", () => {
  test("(9) wake preserves the assigned model (stored ref reused verbatim)", async () => {
    const { store, service } = setup();
    try {
      const result = await service.activateSwarm({
        requirement: "Wake continuity check",
        coordinatorSessionId: "sess-lead",
        projectRoot: "/tmp/m-inherit",
        modelContext: { nativeAgentModel: NATIVE, activeSessionModel: ACTIVE },
      });
      for (const w of result.workers) {
        // Simulate the wake path: re-read the stored member (what the
        // dispatcher reconciles against) and re-resolve for the wake.
        const stored = store.getMember(w.member.id);
        expect(stored.model).toEqual(NATIVE);
        const wakeResolved = resolveWakeModel(stored.model);
        expect(wakeResolved.model).toEqual(stored.model);
        expect(wakeResolved.authReuse).toBe("host-existing");
      }
    } finally {
      store.close();
    }
  });

  test("(10) model switch is never silent — wake keeps history unless explicitly reconfigured", () => {
    const frozen = Object.freeze({ ...NATIVE });
    // No reconfigure flag: stored model returned untouched (same values, no
    // mutation of the input ref).
    const kept = resolveWakeModel(frozen);
    expect(kept.model).toEqual(NATIVE);
    expect(kept.historyPreserved).toBe(true);
    expect(frozen).toEqual(NATIVE);
    // Explicit reconfigure: new ref adopted AND flagged as requiring the
    // explicit verified switch endpoint (history retained by backend).
    const switched = resolveWakeModel(frozen, { reconfigureTo: OVERRIDE });
    expect(switched.model).toEqual(OVERRIDE);
    expect(switched.source).toBe("explicit-reconfigure");
    expect(switched.historyPreserved).toBe(true);
  });

  test("(11) missing/invalid auth blocks with no retries", () => {
    expect(isAuthBlockedStatus(401)).toBe(true);
    expect(isAuthBlockedStatus(403)).toBe(true);
    expect(isAuthBlockedStatus("401")).toBe(true);
    expect(resolutionRetryPolicy()).toBe("no-retry");
    // Unresolvable/invalid combos are terminal, never re-queued.
    try {
      resolveWorkerModel({});
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelResolutionError);
      expect((err as ModelResolutionError).retryable).toBe(false);
    }
    // Service maps resolution failure to its established VALIDATION_FAILED
    // contract (fail closed, no retry) rather than leaking internals.
    const { store, service } = setup();
    return service
      .activateSwarm({ requirement: "x", coordinatorSessionId: "s", projectRoot: "/tmp/m" })
      .then(
        () => {
          throw new Error("must reject");
        },
        (err: unknown) => {
          expect(err).toBeInstanceOf(ProtocolError);
          expect((err as ProtocolError).code).toBe("VALIDATION_FAILED");
        },
      )
      .finally(() => {
        store.close();
      });
  });

  test("(12) 402 pauses with no retry and is never confused with transient", () => {
    expect(isQuotaStatus(402)).toBe(true);
    expect(isQuotaStatus("402")).toBe(true);
    expect(resolutionRetryPolicy()).toBe("no-retry");
    // 402 is quota — not auth-blocked, not transient: the M2 dispatcher maps
    // it to quota_paused (member preserved, lease released, zero auto-retry).
    expect(isAuthBlockedStatus(402)).toBe(false);
    expect(isQuotaStatus(429)).toBe(false);
    expect(isQuotaStatus(503)).toBe(false);
    expect(isAuthBlockedStatus(429)).toBe(false);
  });
});
