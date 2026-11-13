/**
 * M1-04 coordinator activation service (contracts C-PROTOCOL-01 / C-DB-01 /
 * C-HARNESS-01; daemon side of C-DAEMON-01).
 *
 * Owns the M1-04 activation flow: validate the `/swarm <requirement>` input,
 * bind the current session as coordinator (lead), create exactly two named
 * workers with non-colliding ownership, post one immutable `brief` board post
 * per worker (PAR-05), then dispatch each brief through the harness
 * QUEUE-ONLY (`delivery: "queue"` — steering is never used; the harness
 * rejects it) and expose a zero-model-call status projection.
 *
 * Boundaries (do NOT cross):
 * - Persists ONLY through the M1-01 `SwarmStore` (imported, never
 *   reimplemented). No schema changes, no direct SQL here.
 * - Drives workers ONLY through the injected harness abstraction, whose
 *   shape is the C-HARNESS-01 subset used here. The concrete
 *   `OpenCodeHarness` (M1-03, owned by another worker) satisfies this
 *   interface structurally, so this file imports NO adapter code.
 * - Never performs model inference: no `session.prompt`, no `generate`,
 *   no fetch to an inference endpoint. `getStatusSnapshot` reads SQLite
 *   only; every status call reports `telemetry.modelCalls: 0`.
 *
 * Lead write restriction (spec: "route all modifications via
 * server-validated role policy, not prompt instructions alone"):
 * - `ROLE_PERMISSIONS` + `assertRoleAllows` enforce the role policy in code
 *   on the daemon side. The coordinator (`lead`) may coordinate, post and
 *   manage members; it may NOT `edit-code` or `merge`.
 * - `activateSwarm` additionally applies `COORDINATOR_WRITE_DENY_RULES` to
 *   the coordinator session via `harness.applyPermissionRules`, so the
 *   restriction is a tool/session enforcement, not a prompt instruction.
 *   The plugin mirrors the same table in tool authorization
 *   (`packages/plugin/src/commands/swarm.ts`); the two tables must stay
 *   identical until the policy moves into `packages/protocol` by contract
 *   amendment.
 */

import { ProtocolError } from "@vuminkosi/protocol";
import type {
  BoardPost,
  Member,
  MemberRole,
  ModelRef,
  Swarm,
  Task,
} from "@vuminkosi/protocol";
import { SwarmStore } from "../db/store.js";
import {
  ModelResolutionError,
  resolveWorkerModel,
  type ModelResolutionContext,
} from "./model-resolver.js";

/** C-HARNESS-01 subset used by activation. Satisfied structurally by the
 *  M1-03 `OpenCodeHarness` (import it, do not reimplement it). Queue-only:
 *  callers must pass `delivery: "queue"`; anything else is rejected here
 *  before it reaches the harness. */
export interface ActivationHarness {
  createSession(title: string, directory: string): Promise<{ sessionId: string }>;
  switchAgent(sessionId: string, agentId: string): Promise<void>;
  submitTurn(request: {
    readonly sessionId: string;
    readonly text: string;
    readonly delivery: "queue";
    readonly externalId: string;
    readonly reason: "assigned_task";
  }): Promise<{ readonly externalId: string; readonly admittedAt: string; readonly transportNote: string }>;
  applyPermissionRules(
    sessionId: string,
    rules: readonly { readonly scope: string; readonly action: "allow" | "deny" }[],
  ): Promise<void>;
}

/** Actions gated by the server-side role policy (spec §5 tool restrictions). */
export type SwarmAction =
  | "coordinate"
  | "post"
  | "manage-members"
  | "edit-code"
  | "merge"
  | "verify";

/**
 * Server-validated role policy. Coordinator allocates/kills members, assigns
 * ownership and finalizes; workers post and edit their own task scope;
 * verifiers publish verification evidence. MUST stay identical to the
 * plugin tool-authorization table.
 */
export const ROLE_PERMISSIONS: Readonly<Record<MemberRole, readonly SwarmAction[]>> = {
  coordinator: ["coordinate", "post", "manage-members"],
  coder: ["post", "edit-code"],
  verifier: ["post", "verify"],
  monitor: ["coordinate", "post"],
  researcher: ["post"],
};

/** Tool/session enforcement of the lead write restriction: the coordinator
 *  session is denied edit/write scopes at the harness layer (not a prompt). */
export const COORDINATOR_WRITE_DENY_RULES = [
  { scope: "edit", action: "deny" },
  { scope: "write", action: "deny" },
] as const;

/** M1-04 activation always creates exactly two workers (spec M1 milestone). */
export const WORKER_COUNT = 2 as const;

export const DEFAULT_WORKER_NAMES = ["worker-a", "worker-b"] as const;

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function assertRoleAllows(role: MemberRole, action: SwarmAction): void {
  const allowed = ROLE_PERMISSIONS[role] ?? [];
  if (!allowed.includes(action)) {
    throw new ProtocolError(
      "VALIDATION_FAILED",
      `Role ${role} may not perform ${action} (server role policy)`,
      { role, action },
    );
  }
}

export interface ActivateSwarmInput {
  readonly requirement: string;
  readonly coordinatorSessionId: string;
  readonly projectRoot: string;
  readonly mode?: "parity" | "safe-coding";
  /** Native agent profile id bound to both workers (PAR-16 default: lead model). */
  readonly agentId?: string;
  /** Explicit per-swarm member model override (precedence 1: highest).
   *  Malformed values fail closed (no silent fallback). */
  readonly model?: { readonly providerID: string; readonly id: string };
  /** Verified model context reads supplied by the caller (daemon/plugin
   *  layer) — native agent model via verified `GET /api/agent`, active
   *  session model via verified `GET /api/session/{id}`, host default from
   *  daemon config (host-default source is NOT VERIFIED — see
   *  model-resolver.ts). Precedence: member override > native agent >
   *  active session > host default. Absent entirely => fail closed. */
  readonly modelContext?: ModelResolutionContext;
  /** Exactly two unique worker names; defaults to `worker-a`/`worker-b`. */
  readonly workerNames?: readonly string[];
}

export interface ActivatedWorker {
  readonly member: Member;
  readonly sessionId: string;
  readonly task: Task;
  readonly brief: BoardPost;
  readonly admittedAt: string;
}

export interface ActivationResult {
  readonly swarm: Swarm;
  readonly coordinator: Member;
  readonly workers: readonly ActivatedWorker[];
}

export interface SwarmStatusSnapshot {
  readonly swarm: Swarm;
  readonly members: readonly Member[];
  readonly tasks: readonly Task[];
  readonly posts: readonly BoardPost[];
  readonly telemetry: {
    /** Queue-only dispatches performed by this service instance. */
    readonly dispatchedTurns: number;
    /** Model inference calls performed by status: always zero. */
    readonly modelCalls: 0;
  };
}

const DEFAULT_AGENT_ID = "inherit-lead" as const;
/** No hardcoded production model default (MODEL-INHERIT-01): an unresolvable
 *  worker model fails closed via the resolver instead of substituting a
 *  placeholder. */
const MAX_REQUIREMENT_CHARS = 4000;

function fail(message: string, details: Record<string, string> = {}): never {
  throw new ProtocolError("VALIDATION_FAILED", message, details);
}

export function validateRequirement(requirement: string): string {
  const trimmed = requirement.trim();
  if (trimmed.length === 0) fail("Requirement must not be empty (usage: /swarm <requirement>)");
  if (trimmed.length > MAX_REQUIREMENT_CHARS) {
    fail(`Requirement exceeds ${MAX_REQUIREMENT_CHARS} characters`, { length: String(trimmed.length) });
  }
  return trimmed;
}

export function validateWorkerNames(names: readonly string[] | undefined): [string, string] {
  const list = names ?? [...DEFAULT_WORKER_NAMES];
  if (list.length !== WORKER_COUNT) {
    fail(`M1-04 activation requires exactly ${WORKER_COUNT} workers`, { count: String(list.length) });
  }
  const [first, second] = list;
  if (first === undefined || second === undefined || first.trim() === "" || second.trim() === "") {
    fail("Worker names must be non-empty");
  }
  if (first === second) fail("Worker names must be unique", { first });
  for (const name of [first, second]) {
    if (name.length > 64 || !NAME_RE.test(name)) {
      fail(`Invalid worker name ${name}: must match [A-Za-z0-9_-]+, max 64 chars`, { name });
    }
  }
  return [first, second];
}

function swarmTitle(requirement: string): string {
  const firstLine = requirement.split("\n", 1)[0] ?? requirement;
  const trimmed = firstLine.trim();
  return `Swarm: ${trimmed.slice(0, 80)}`;
}

function briefBody(opts: {
  workerName: string;
  index: number;
  total: number;
  requirement: string;
  taskId: string;
  ownedPath: string;
  excludedPaths: readonly string[];
}): string {
  return (
    `@${opts.workerName} Brief ${opts.index}/${opts.total}: ${opts.requirement}\n\n` +
    `Ownership: ${opts.ownedPath}\n` +
    `Exclusions: ${opts.excludedPaths.join(", ")}\n` +
    `Done when: acceptance criteria met and the result is posted on this board.\n` +
    `Task: ${opts.taskId}`
  );
}

export class SwarmService {
  private dispatchedTurns = 0;

  constructor(
    private readonly store: SwarmStore,
    private readonly harness: ActivationHarness,
  ) {}

  /** Queue-only dispatches performed so far (status calls never move this). */
  getDispatchCount(): number {
    return this.dispatchedTurns;
  }

  /**
   * Bind the current session as coordinator, create two named workers with
   * partitioned ownership, post one immutable `brief` per worker mentioning
   * it (durable fanout mints the wake intent), then dispatch each brief via
   * a single queue-only harness turn correlated to that wake intent.
   */
  async activateSwarm(input: ActivateSwarmInput): Promise<ActivationResult> {
    const requirement = validateRequirement(input.requirement);
    const [firstName, secondName] = validateWorkerNames(input.workerNames);
    if (input.coordinatorSessionId.trim() === "") fail("Coordinator session id must not be empty");
    if (input.projectRoot.trim() === "") fail("Project root must not be empty");

    const mode = input.mode ?? "parity";
    const agentId = input.agentId ?? DEFAULT_AGENT_ID;
    // MODEL-INHERIT-01: resolve the worker model by production precedence
    // (member override > native agent > active session > host default).
    // Fail-closed: unresolvable or malformed combos throw (mapped to the
    // service's established VALIDATION_FAILED contract) — never a
    // placeholder, never a LIVE_* env fallback (production never reads
    // SWARM_ALLOW_LIVE_INFERENCE / LIVE_MODEL / LIVE_MODEL_APIKey).
    // The resolved ref is stored on the lead + workers ONCE at creation and
    // reused verbatim by every later wake (session continuity); wakes never
    // re-resolve. Only refs are stored — credentials stay host-resolved at
    // execution time.
    let model: ModelRef;
    try {
      model = resolveWorkerModel({
        memberOverride: input.model,
        nativeAgentModel: input.modelContext?.nativeAgentModel,
        activeSessionModel: input.modelContext?.activeSessionModel,
        hostDefaultModel: input.modelContext?.hostDefaultModel,
      }).model;
    } catch (err) {
      if (err instanceof ModelResolutionError) {
        fail(`Unresolvable worker model (${err.code}): ${err.message}`, {
          code: err.code,
        });
      }
      throw err;
    }

    // Lead write restriction, enforced in code (role policy) and at the
    // session tool layer (deny rules) — never by prompt text alone.
    assertRoleAllows("coordinator", "coordinate");
    const swarm = this.store.createSwarm({
      title: swarmTitle(requirement),
      coordinatorSessionId: input.coordinatorSessionId,
      projectRoot: input.projectRoot,
      mode,
    });
    const coordinator = this.store.addMember(swarm.id, {
      name: "lead",
      role: "coordinator",
      nativeAgentId: agentId,
      sessionId: input.coordinatorSessionId,
      model,
    });
    await this.harness.applyPermissionRules(input.coordinatorSessionId, [...COORDINATOR_WRITE_DENY_RULES]);

    const workerNames = [firstName, secondName];
    const workers: ActivatedWorker[] = [];
    let index = 0;
    for (const workerName of workerNames) {
      index += 1;
      const ownedPath = `workers/${workerName}/**`;
      const excludedPaths = workerNames.filter((n) => n !== workerName).map((n) => `workers/${n}/**`);
      const created = await this.harness.createSession(`swarm ${swarm.title} — ${workerName}`, input.projectRoot);
      await this.harness.switchAgent(created.sessionId, agentId);
      const member = this.store.addMember(swarm.id, {
        name: workerName,
        role: "coder",
        nativeAgentId: agentId,
        sessionId: created.sessionId,
        model,
      });
      const task = this.store.createTask(swarm.id, {
        title: `${workerName}: ${requirement.split("\n", 1)[0]?.trim().slice(0, 120) ?? requirement}`,
        brief: requirement,
        ownerId: member.id,
        ownedPaths: [ownedPath],
        forbiddenPaths: excludedPaths,
        acceptanceCriteria: [`${workerName} brief completed and result posted on board`],
      });
      const body = briefBody({
        workerName,
        index,
        total: WORKER_COUNT,
        requirement,
        taskId: task.id,
        ownedPath,
        excludedPaths,
      });
      const posted = this.store.appendPost(swarm.id, {
        authorMemberId: coordinator.id,
        kind: "brief",
        body,
        relatedTaskId: task.id,
        idempotencyKey: `m104-brief-${swarm.id}-${workerName}`,
      });
      // Correlate the turn to the durable wake intent fanned out for the
      // @mention; on a deduped re-post there is no new wake, so fall back
      // to the immutable post id as the correlation key.
      const wakeId = posted.wakeIds[0] ?? `brief-${posted.post.id}`;
      const receipt = await this.harness.submitTurn({
        sessionId: created.sessionId,
        text: body,
        delivery: "queue",
        externalId: wakeId,
        reason: "assigned_task",
      });
      this.dispatchedTurns += 1;
      workers.push({ member, sessionId: created.sessionId, task, brief: posted.post, admittedAt: receipt.admittedAt });
    }
    return { swarm, coordinator, workers };
  }

  /**
   * Zero-token status: pure SQLite projection (swarm + members + tasks +
   * recent board posts). Performs no harness calls and zero model inference;
   * `telemetry.modelCalls` is the literal `0` counter proving it.
   */
  getStatusSnapshot(swarmId: string, after = 0, limit = 100): SwarmStatusSnapshot {
    const swarm = this.store.getSwarm(swarmId);
    const members = this.store.listMembers(swarmId);
    const tasks = this.store.listTasks(swarmId);
    const posts = this.store.getPostsAfter(swarmId, after, limit);
    return {
      swarm,
      members,
      tasks,
      posts,
      telemetry: { dispatchedTurns: this.dispatchedTurns, modelCalls: 0 },
    };
  }
}
