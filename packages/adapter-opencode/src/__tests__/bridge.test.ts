/**
 * M1-03 bridge test — CodingHarness queue-only submit, session lifecycle,
 * permission preservation, event mapping, overlap analysis.
 *
 * Run: `bun src/__tests__/bridge.test.ts` (from packages/adapter-opencode).
 * Typechecks under the adapter tsconfig with ZERO new dependencies: no
 * test-framework or node: imports (the adapter package has no @types/node or
 * bun-types; manifests are outside M1-03 ownership and stay untouched).
 * Failures throw (nonzero exit); live-only checks print NOT VERIFIED and
 * never fail.
 *
 * Tiers:
 *  A (deterministic, fake transport) — must PASS.
 *  B (isolated live lifecycle) + C (live execution overlap) — NOT VERIFIED
 *    in this task: overlapping execution requires model inference (provider
 *    spend, not authorized) and no isolated disposable server was started
 *    (the user-owned background service is out of bounds for probes).
 *    Resumption commands are printed by the live section for M1-04.
 */

import { OpenCodeHarness } from "../harness.js";
import {
  assertDisposableCapturePath,
  executionsOverlap,
  executionOutcomeFor,
  formatRawCapture,
  parseSseFrame,
  subscribeHarnessEvents,
  toHarnessEvent,
} from "../events.js";
import type { HarnessEvent } from "../port.js";
import {
  AdmissionRegistry,
  FetchTransport,
  LiveServerUnavailableError,
  OpenCodeApiError,
  SessionManager,
  buildPromptBody,
  mapPermissionRule,
  parseInboxList,
  parseSessionInfo,
  toExecutionRecord,
  type OpenCodeTransport,
} from "../sessions.js";

/** Mandated disposable root for M1-03 live execution (never canonical tree). */
const DISPOSABLE_ROOT = "C:\\Users\\Vuminkosi\\AppData\\Local\\Temp\\opencode\\swarm-probes\\m103-disposable";

let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) throw new Error(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  passed += 1;
  console.log(`ok - ${name}`);
}

function expectThrow(name: string, fn: () => void, code: string): void {
  try {
    fn();
  } catch (err) {
    const got = err instanceof OpenCodeApiError ? err.code : err instanceof Error ? err.name : String(err);
    check(name, got === code, `expected ${code}, got ${got}`);
    return;
  }
  throw new Error(`FAIL ${name} — expected throw ${code}`);
}

/** Scripted fake over the verified REST surface; logs every request. */
class FakeTransport implements OpenCodeTransport {
  readonly baseUrl = "http://127.0.0.1:4096";
  readonly log: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
  routes = new Map<string, unknown>();
  failWith: Error | null = null;

  on(method: string, path: string, response: unknown): void {
    this.routes.set(`${method} ${path}`, response);
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    this.log.push({ method, path, body });
    if (this.failWith !== null) throw this.failWith;
    if (!this.routes.has(`${method} ${path}`)) throw new OpenCodeApiError(404, "NOT_FOUND");
    const hit = this.routes.get(`${method} ${path}`);
    return hit as T;
  }

  bodiesFor(method: string, path: string): unknown[] {
    return this.log.filter((e) => e.method === method && e.path === path).map((e) => e.body);
  }
}

function sessionInfoRaw(id: string, directory: string, perms: unknown[] = []): unknown {
  return {
    data: {
      id,
      projectID: "prj_fake",
      agent: "agent-a",
      model: { id: "m", providerID: "p" },
      time: { created: 1, updated: 2, busy: 10, idle: 5 },
      location: { directory },
      permissions: perms,
    },
  };
}

// ---------- Tier A: session lifecycle + location binding ----------

const fakeA = new FakeTransport();
const dirA = `${DISPOSABLE_ROOT}\\ws-a`;
const dirB = `${DISPOSABLE_ROOT}\\ws-b`;
fakeA.on("POST", "/api/session", sessionInfoRaw("ses_fake_A", dirA));
fakeA.on("GET", "/api/session/ses_fake_A", sessionInfoRaw("ses_fake_A", dirA));
const mgrA = new SessionManager(fakeA);
const createdA = await mgrA.createSession({ title: "m103 worker A", directory: dirA });
check("create-A returns native session id", createdA.sessionId === "ses_fake_A", createdA.sessionId);
check("create-A binds disposable location", createdA.info.directory === dirA, createdA.info.directory ?? "null");
const createBody = fakeA.bodiesFor("POST", "/api/session")[0] as Record<string, unknown>;
check("create-A body carries location.directory", (createBody["location"] as { directory: string }).directory === dirA);
check("create-A body leaks no externalId", !("externalId" in createBody) && !("external_id" in createBody));

const fakeB = new FakeTransport();
fakeB.on("POST", "/api/session", sessionInfoRaw("ses_fake_B", dirB));
const mgrB = new SessionManager(fakeB);
const createdB = await mgrB.createSession({ title: "m103 worker B", directory: dirB });
check("two sessions have distinct ids (separate histories)", createdB.sessionId !== createdA.sessionId);
check("two sessions bind distinct disposable dirs", createdB.info.directory === dirB);

// ---------- Tier A: queue-only admission + internal correlation ----------

const registry = new AdmissionRegistry();
const mgr = new SessionManager(fakeA, registry);
const FIXED_NOW = "2026-11-11T12:00:00.000Z";
fakeA.on("POST", "/api/session/ses_fake_A/prompt", { data: { id: "msg_inbox_1", sessionID: "ses_fake_A" } });
const receipt = await mgr.submitTurnRecorded(
  { sessionId: "ses_fake_A", text: "worker A brief: list fixture files", delivery: "queue", externalId: "wake-1", reason: "assigned_task" },
  () => FIXED_NOW,
);
check("receipt echoes adapter-internal externalId", receipt.externalId === "wake-1");
check("receipt admittedAt is deterministic", receipt.admittedAt === FIXED_NOW);
const promptBody = fakeA.bodiesFor("POST", "/api/session/ses_fake_A/prompt")[0] as Record<string, unknown>;
check("prompt delivery is queue-only", promptBody["delivery"] === "queue");
check("prompt carries no top-level externalId arg", !("externalId" in promptBody));
const meta = promptBody["metadata"] as Record<string, unknown>;
check("correlation lives in verified metadata field", meta["swarm.externalId"] === "wake-1");
check(
  "prompt text carries readable wake header",
  typeof promptBody["text"] === "string" && (promptBody["text"] as string).startsWith("[swarm-wake:wake-1]"),
);
const entry = registry.resolve("wake-1");
check("registry maps externalId to native inbox id", entry?.nativeInboxId === "msg_inbox_1");

expectThrow(
  "steer delivery rejected (probe-06 territory)",
  () =>
    buildPromptBody(
      { sessionId: "s", text: "x", delivery: "steer", externalId: "w", reason: "mention" },
      FIXED_NOW,
    ),
  "UNSUPPORTED_DELIVERY_STEER_NOT_VERIFIED",
);
expectThrow(
  "empty turn text rejected",
  () =>
    buildPromptBody({ sessionId: "s", text: "  ", delivery: "queue", externalId: "w", reason: "mention" }, FIXED_NOW),
  "EMPTY_TURN_TEXT",
);

// ---------- Tier A: agent/model switch + permission preservation ----------

const permsBefore = [
  { action: "*", resource: `${DISPOSABLE_ROOT}\\*`, effect: "deny" },
];
fakeA.on("GET", "/api/session/ses_fake_A", sessionInfoRaw("ses_fake_A", dirA, permsBefore));
const snapBefore = await mgr.getSession("ses_fake_A");
fakeA.on("POST", "/api/session/ses_fake_A/agent", {});
await mgr.switchAgent("ses_fake_A", "agent-b");
const agentBodies = fakeA.bodiesFor("POST", "/api/session/ses_fake_A/agent");
check("switchAgent sends verified {agent} body", (agentBodies[0] as { agent: string }).agent === "agent-b");
check(
  "switchAgent issues no permission PATCH (preservation by construction)",
  fakeA.bodiesFor("PATCH", "/api/session/ses_fake_A").length === 0,
);
const snapAfter = await mgr.getSession("ses_fake_A");
check(
  "permissions identical across switchAgent (preserved)",
  JSON.stringify(snapAfter.permissions) === JSON.stringify(snapBefore.permissions),
);

fakeA.on("POST", "/api/session/ses_fake_A/model", {});
await mgr.switchModel("ses_fake_A", { id: "model-x", providerID: "prov-y" });
const modelBodies = fakeA.bodiesFor("POST", "/api/session/ses_fake_A/model");
check(
  "switchModel sends native providerID+id refs",
  JSON.stringify((modelBodies[0] as { model: unknown }).model) === JSON.stringify({ id: "model-x", providerID: "prov-y" }),
);

fakeA.on("PATCH", "/api/session/ses_fake_A", {});
await mgr.applyPermissionRules("ses_fake_A", [{ scope: `${DISPOSABLE_ROOT}\\*`, action: "deny" }]);
const patchBodies = fakeA.bodiesFor("PATCH", "/api/session/ses_fake_A");
check(
  "applyPermissionRules maps scope to native resource + deny effect (explicit edit/write actions, no wildcard)",
  JSON.stringify((patchBodies[0] as { permissions: unknown }).permissions) ===
    JSON.stringify([
      { action: "edit", resource: `${DISPOSABLE_ROOT}\\*`, effect: "deny" },
      { action: "write", resource: `${DISPOSABLE_ROOT}\\*`, effect: "deny" },
    ]),
);
const mapped = mapPermissionRule({ scope: "C:\\scratch\\*", action: "allow" });
check(
  "permission map expands to explicit edit/write entries keeping allow effect",
  mapped.length === 2 &&
    mapped.every((entry) => entry.effect === "allow" && entry.resource === "C:\\scratch\\*") &&
    mapped.map((entry) => entry.action).join(",") === "edit,write",
);
check(
  "permission map emits no wildcard action",
  !(mapped.map((entry) => entry.action as string) as string[]).includes("*"),
);
expectThrow("empty permission scope rejected", () => mapPermissionRule({ scope: "  ", action: "deny" }), "EMPTY_PERMISSION_SCOPE");

// ---------- Tier A: snapshot / interrupt / wait reconciliation ----------

const snap = mgr.toSnapshot({ ...createdA.info, busyAt: 20, idleAt: 9 }, "ses_fake_A");
check("snapshot flags live execution (busy>idle heuristic)", snap.hasLiveExecution === true);
check("snapshot starts with no terminal externals", snap.knownTerminalExternalIds.length === 0);

fakeA.on("POST", "/api/session/ses_fake_A/interrupt", {});
fakeA.on("GET", "/api/session/ses_fake_A", {
  data: {
    id: "ses_fake_A",
    projectID: "prj_fake",
    outcome: "interrupted",
    time: { created: 1, updated: 3, busy: 9, idle: 20 },
    location: { directory: dirA },
    permissions: [],
  },
});
const harness = new OpenCodeHarness({ transport: fakeA, registry, now: () => "2026-11-11T12:01:00.000Z" });
const interrupted = await harness.interrupt("ses_fake_A");
check("interrupt resolves terminal outcome", interrupted === "interrupted");
check("interrupt marks admission terminal (idempotent dedupe)", registry.resolve("wake-1")?.terminal === true);
const snap2 = await harness.getSession("ses_fake_A");
check("post-interrupt snapshot not live", snap2.hasLiveExecution === false);
check("terminal external recorded for session", snap2.knownTerminalExternalIds.includes("wake-1"));

const rec = toExecutionRecord(registry, { ...(entry as NonNullable<typeof entry>), terminal: false }, "succeeded", FIXED_NOW, null);
check("execution record correlates externalId", rec.externalId === "wake-1" && rec.outcome === "succeeded");

const waitCtrl = new AbortController();
const waitResult = await (async () => {
  const r2 = new AdmissionRegistry();
  const f2 = new FakeTransport();
  f2.on("POST", "/api/session/ses2/prompt", { data: { id: "msg_9", sessionID: "ses2" } });
  f2.on("POST", "/api/experimental/session/ses2/wait", undefined);
  f2.on("GET", "/api/session/ses2", { data: { id: "ses2", projectID: "p", outcome: "succeeded", time: { created: 1, updated: 2 }, location: { directory: dirA }, permissions: [] } });
  const h2 = new OpenCodeHarness({ transport: f2, registry: r2, now: () => FIXED_NOW });
  await h2.submitTurn({ sessionId: "ses2", text: "brief", delivery: "queue", externalId: "wake-9", reason: "monitor_intervention" });
  return h2.wait("ses2", waitCtrl.signal);
})();
check("wait reconciles to succeeded record", waitResult.externalId === "wake-9" && waitResult.outcome === "succeeded");

let waitNoAdmission = "";
try {
  const r3 = new AdmissionRegistry();
  const h3 = new OpenCodeHarness({ transport: new FakeTransport(), registry: r3 });
  await h3.wait("ses-none", new AbortController().signal);
} catch (err) {
  waitNoAdmission = err instanceof OpenCodeApiError ? err.code : "WRONG";
}
check("wait without admitted turn throws safe code", waitNoAdmission === "WAIT_WITHOUT_ADMITTED_TURN");

const abortCtrl = new AbortController();
abortCtrl.abort();
let waitAborted = "";
try {
  const r4 = new AdmissionRegistry();
  r4.record({ externalId: "w", sessionId: "s", admittedAt: FIXED_NOW, nativeInboxId: null, reason: "mention", transportNote: "t", terminal: false });
  const h4 = new OpenCodeHarness({ transport: new FakeTransport(), registry: r4 });
  await h4.wait("s", abortCtrl.signal);
} catch (err) {
  waitAborted = err instanceof OpenCodeApiError ? err.code : "WRONG";
}
check("aborted wait reports WAIT_ABORTED", waitAborted === "WAIT_ABORTED");

// ---------- Tier A: agent inventory ----------

fakeA.on("GET", "/api/agent", {
  data: [
    { id: "agent-a", model: { id: "m1", providerID: "p1" } },
    { id: "agent-b", model: { id: "m2", providerID: "p2" } },
  ],
});
const agents = await mgr.listAgents();
check("agent inventory preserves native ids verbatim", agents.map((a) => a.id).join(",") === "agent-a,agent-b");
check("agent inventory carries native models", agents[0]?.model.providerID === "p1");

// ---------- Tier A: parsing defensiveness ----------

const parsed = parseSessionInfo({ unexpected: "shape" });
check("parseSessionInfo tolerates unknown envelopes", parsed.id === "" && parsed.permissions.length === 0);
check("parseInboxList tolerates non-envelopes", parseInboxList({ nope: 1 }).length === 0);

// ---------- Tier A: events ----------

const frame1 = 'event: session.execution.started\ndata: {"type":"session.execution.started","properties":{"sessionID":"ses_fake_A","executionID":"exe_1"}}\n';
const parsed1 = parseSseFrame(frame1);
check("SSE frame parses typed envelope", parsed1?.type === "session.execution.started");
const ev1 = parsed1 === null ? null : toHarnessEvent(parsed1, FIXED_NOW);
check("execution.started maps to harness event", ev1?.sessionId === "ses_fake_A" && ev1?.nativeExecutionId === "exe_1");
check("terminal outcome mapping", executionOutcomeFor("session.execution.failed") === "failed");
check("non-terminal maps to null", executionOutcomeFor("session.execution.started") === null);
// Global (session-less) envelopes are diagnostics-only, never transitions.
const globalEv = toHarnessEvent({ type: "provider.updated", properties: { ok: true } }, FIXED_NOW);
check("session-less envelopes map to null", globalEv === null);

// Subscription filtering over a canned SSE stream (volatile-stream shape).
const ssePayload =
  'event: session.execution.started\ndata: {"type":"session.execution.started","properties":{"sessionID":"ses_fake_A"}}\n\n' +
  'event: session.execution.started\ndata: {"type":"session.execution.started","properties":{"sessionID":"ses_fake_B"}}\n\n';
const seen: HarnessEvent[] = [];
await subscribeHarnessEvents(fakeA, {
  sessionIds: ["ses_fake_A"],
  handler: (e) => {
    seen.push(e);
  },
  signal: new AbortController().signal,
  fetchImpl: (async () => new Response(ssePayload, { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
});
check("subscription filters to the bound session", seen.length === 1 && seen[0]?.sessionId === "ses_fake_A");

const preAborted = new AbortController();
preAborted.abort();
await subscribeHarnessEvents(fakeA, { sessionIds: ["x"], handler: () => {}, signal: preAborted.signal });
check("pre-aborted subscription resolves without transport", true);

// Overlap analysis incl. evidence-grade timestamps.
check(
  "overlapping executions detected",
  executionsOverlap(
    { startedAt: "2026-11-11T12:00:00.000Z", terminalAt: "2026-11-11T12:00:10.000Z" },
    { startedAt: "2026-11-11T12:00:05.000Z", terminalAt: "2026-11-11T12:00:08.000Z" },
  ) === true,
);
check(
  "sequential executions do not overlap",
  executionsOverlap(
    { startedAt: "2026-11-11T12:00:00.000Z", terminalAt: "2026-11-11T12:00:05.000Z" },
    { startedAt: "2026-11-11T12:00:05.000Z", terminalAt: "2026-11-11T12:00:08.000Z" },
  ) === false,
);
check(
  "open-ended executions overlap",
  executionsOverlap({ startedAt: "2026-11-11T12:00:00.000Z", terminalAt: null }, { startedAt: "2026-11-11T12:00:05.000Z", terminalAt: null }) === true,
);
check(
  "unparseable timestamps never claim overlap",
  executionsOverlap({ startedAt: "not-a-time", terminalAt: null }, { startedAt: "2026-11-11T12:00:05.000Z", terminalAt: null }) === false,
);

// Capture guard + formatting (probe-07 style; file write happens in the live phase).
assertDisposableCapturePath(`${DISPOSABLE_ROOT}\\probe-07-events\\a.jsonl`, DISPOSABLE_ROOT);
let guardFired = false;
try {
  assertDisposableCapturePath("C:\\DevOps\\opencode-agent-swarm\\packages\\adapter-opencode\\src\\x.json", DISPOSABLE_ROOT);
} catch {
  guardFired = true;
}
check("capture guard refuses canonical-tree paths", guardFired === true);
const evForCapture: HarnessEvent = { type: "session.execution.started", sessionId: "ses_fake_A", at: FIXED_NOW, nativeExecutionId: "exe_1", payload: {} };
check("raw capture formats one JSON line per event", formatRawCapture([evForCapture]).split("\n").length === 1);

// Transport failure mapping (no fiction when the server is down).
const down = new FakeTransport();
down.failWith = new Error("socket hang up");
let downCode = "";
try {
  await new FetchTransport("http://127.0.0.1:9", {
    fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
  }).request("GET", "/api/info");
} catch (err) {
  downCode = err instanceof LiveServerUnavailableError ? "LIVE_UNAVAILABLE" : "WRONG";
}
check("unreachable server maps to LiveServerUnavailableError", downCode === "LIVE_UNAVAILABLE");
void down;

// ---------- Tier B/C: live attempt (NOT VERIFIED without isolated server + spend auth) ----------

async function liveVerbatim(): Promise<void> {
  const base = "http://127.0.0.1:4096";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${base}/api/info`, { signal: ctrl.signal });
    console.log(`LIVE probe GET ${base}/api/info -> http ${res.status} (read-only, no sessions created)`);
    if (res.status === 401 || res.status === 200) {
      console.log("NOT VERIFIED (live-lifecycle): server reachable but M1-03 live execution requires an ISOLATED disposable server + inference spend authorization; resumption below.");
    }
  } catch (err) {
    console.log(
      `NOT VERIFIED (live-lifecycle + execution-overlap): no live server at ${base} — ${(err as Error).name}. ` +
        "No sessions created; Tier A remains the verified evidence. Resumption for M1-04 below.",
    );
  } finally {
    clearTimeout(timer);
  }
  console.log("RESUMPTION (M1-04, disposable only):");
  console.log(`  1. git init ${DISPOSABLE_ROOT} (disposable; never the canonical tree)`);
  console.log("  2. start an isolated server bound to the disposable dir (standalone, ephemeral port)");
  console.log("  3. create 2 sessions via OpenCodeHarness.createSession (location = disposable ws-a/ws-b)");
  console.log("  4. submitTurn queue-only with distinct briefs + SWARM_LIVE_HARNESS=1 inference authorization");
  console.log("  5. record session.execution.started -> terminal timestamps per session; assert executionsOverlap() === true");
  console.log("  6. dump raw payloads under <disposable>/probe-07-events (assertDisposableCapturePath enforced)");
}

await liveVerbatim();

console.log(`\nBRIDGE TIER-A RESULT: PASS (${passed} checks). Live tiers: NOT VERIFIED (see lines above).`);
