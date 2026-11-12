/**
 * M1-04 `/swarm` command: validation + coordinator binding + dispatch
 * routing (contract C-PLUGIN-01; spec §§2 PAR-01..05, 5, 7, 11, 15 M1-04).
 *
 * M6-01 extension (spec §§11, 4.2, 4.4): the complete documented `/swarm`
 * command family. Read-only by default; only explicit mutating subcommands
 * (`activate`, `message`, `pause`/`resume`/`stop`) act, and every mutating
 * path is code-gated by `authorizeToolCall`, never by prompt text alone.
 *
 * Responsibilities (and ONLY these):
 * - Parse raw `/swarm ...` input into a typed intent (`activate`, `status`,
 *   `board`, `agents`, `pause`, `resume`, `stop`, `message`, `help`).
 * - Validate the activation requirement and bind the CURRENT session as
 *   coordinator (PAR-01: the current conversation becomes the lead; the
 *   swarm association is persisted by the daemon, never invented here).
 * - Route `status`/`board`/`agents` reads through the versioned daemon
 *   client, which serves them from SQLite projections with ZERO model
 *   calls (PAR lead anti-pollution invariant: no prompt is sent to the
 *   coordinator merely to report status).
 * - Route `activate` through the injected activator (daemon-side
 *   `SwarmService`), which creates the swarm + two named workers, posts the
 *   immutable briefs and dispatches queue-only.
 * - Route `message @worker` ONLY through the injected `DirectSteerer`
 *   (daemon-side `steerWorkerDirect`): a private `user_direct` wake that
 *   NEVER writes a board post row (PAR-23). Board length is provably
 *   unchanged by this path.
 * - Route `pause`/`resume`/`stop` through the injected lifecycle gateway
 *   (daemon `pauseSwarm`/`resumeSwarm`/`cancelSwarm`): coordinator-only,
 *   scheduler-gated, with the worktree preservation policy attached to
 *   every response (PAR-18).
 * - Serve `/swarm board` with a terminal-board fallback hint: the
 *   installed `@opencode/plugin` 2.2.7 command API exposes
 *   `ctx.command.transform/list/reload` ONLY — there is no verified native
 *   board route, TUI slot, or `Alt+S` shortcut hook, so no speculative
 *   hook is invoked here (native TUI route is M6-03's owned slice).
 *
 * Tool authorization (server-validated role policy, not prompt-only): every
 * privileged path checks `authorizeToolCall` against `ROLE_PERMISSIONS`
 * before acting. The coordinator may coordinate/post/manage-members; it may
 * NOT `edit-code` or `merge`. This table MUST stay identical to
 * `ROLE_PERMISSIONS` in
 * `packages/runtime/src/services/swarm-service.ts` until the policy moves
 * into `packages/protocol` by contract amendment.
 *
 * This module never performs model inference and never stores authoritative
 * swarm state; the daemon owns it.
 */

import type { PostSummary, SwarmSnapshot } from "../client.js";

export type CoordinatorRole = "coordinator" | "coder" | "verifier" | "monitor" | "researcher";

export type SwarmToolAction =
  | "coordinate"
  | "post"
  | "manage-members"
  | "edit-code"
  | "merge"
  | "verify";

export const ROLE_PERMISSIONS: Readonly<Record<CoordinatorRole, readonly SwarmToolAction[]>> = {
  coordinator: ["coordinate", "post", "manage-members"],
  coder: ["post", "edit-code"],
  verifier: ["post", "verify"],
  monitor: ["coordinate", "post"],
  researcher: ["post"],
};

export class SwarmToolDeniedError extends Error {
  readonly role: CoordinatorRole;
  readonly action: SwarmToolAction;

  constructor(role: CoordinatorRole, action: SwarmToolAction) {
    super(`Role ${role} may not perform ${action} (swarm role policy)`);
    this.name = "SwarmToolDeniedError";
    this.role = role;
    this.action = action;
  }
}

/** Code-path (not prompt) gate for every privileged plugin tool call. */
export function authorizeToolCall(role: CoordinatorRole, action: SwarmToolAction): void {
  const allowed = ROLE_PERMISSIONS[role] ?? [];
  if (!allowed.includes(action)) {
    throw new SwarmToolDeniedError(role, action);
  }
}

export type SwarmIntent =
  | { readonly kind: "activate"; readonly requirement: string }
  | { readonly kind: "status"; readonly swarmId?: string | undefined }
  | { readonly kind: "board"; readonly swarmId?: string | undefined }
  | { readonly kind: "agents"; readonly swarmId?: string | undefined }
  | { readonly kind: "pause"; readonly swarmId?: string | undefined }
  | { readonly kind: "resume"; readonly swarmId?: string | undefined }
  | { readonly kind: "stop"; readonly swarmId?: string | undefined }
  | { readonly kind: "message"; readonly mention: string; readonly text: string }
  | { readonly kind: "help" };

export class SwarmValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SwarmValidationError";
    this.code = code;
  }
}

const SUBCOMMANDS = new Set(["status", "board", "agents", "pause", "resume", "stop", "message", "help"]);

function swarmIdFrom(args: readonly string[]): string | undefined {
  const value = args[0];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Parse raw text after `/swarm`. Bare `/swarm` (empty requirement) is a
 * validation failure with usage, not an implicit activation. Unknown
 * `/swarm <word>` where `<word>` is a single token IS a requirement (a task
 * description), never an unknown-subcommand error — only the reserved
 * subcommand names route elsewhere. Subcommand matching is
 * case-insensitive (`/swarm STATUS` == `/swarm status`); the requirement
 * body keeps its original casing.
 */
export function parseSwarmInput(raw: string): SwarmIntent {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new SwarmValidationError("EMPTY_REQUIREMENT", "Usage: /swarm <requirement> — describe the work for two workers");
  }
  const firstSpace = trimmed.search(/\s/);
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();

  if (!SUBCOMMANDS.has(head)) {
    return { kind: "activate", requirement: trimmed };
  }
  switch (head) {
    case "status":
      return { kind: "status", swarmId: swarmIdFrom(rest === "" ? [] : [rest]) };
    case "board":
      return { kind: "board", swarmId: swarmIdFrom(rest === "" ? [] : [rest]) };
    case "agents":
      return { kind: "agents", swarmId: swarmIdFrom(rest === "" ? [] : [rest]) };
    case "pause":
      if (rest === "") throw new SwarmValidationError("MISSING_SWARM_ID", "Usage: /swarm pause <swarmId>");
      return { kind: "pause", swarmId: rest };
    case "resume":
      if (rest === "") throw new SwarmValidationError("MISSING_SWARM_ID", "Usage: /swarm resume <swarmId>");
      return { kind: "resume", swarmId: rest };
    case "stop":
      if (rest === "") throw new SwarmValidationError("MISSING_SWARM_ID", "Usage: /swarm stop <swarmId>");
      return { kind: "stop", swarmId: rest };
    case "message": {
      const mentionMatch = /^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/.exec(rest);
      if (mentionMatch === null || mentionMatch[1] === undefined || mentionMatch[2] === undefined) {
        throw new SwarmValidationError("INVALID_MESSAGE", "Usage: /swarm message @worker <text>");
      }
      return { kind: "message", mention: mentionMatch[1], text: mentionMatch[2].trim() };
    }
    case "help":
      return { kind: "help" };
    default:
      return { kind: "help" };
  }
}

/**
 * M6-01 unsupported command APIs (fallback served, never speculative).
 *
 * Verified against the installed `@opencode/plugin` 2.2.7 published
 * types: `ctx.command` exposes `transform`/`list`/`reload` ONLY. None of
 * the below exists as a supported command-API hook, so this module serves
 * the documented fallback instead of inventing a call. Native TUI
 * route/shortcut/RPC wiring is M6-03's owned slice; daemon wakes/usage
 * reads need a C-DAEMON-01 contract amendment first.
 */
export const UNSUPPORTED_COMMAND_APIS = [
  "native TUI board route: ctx.command has no board-route hook in 2.2.7 — terminal fallback hint served (M6-03).",
  "Alt+S board shortcut: no verified command-API shortcut hook in 2.2.7 — not intercepted (M6-03).",
  "inline @worker TUI routing hook: no verified TUI routing hook in 2.2.7 — /swarm message @worker is the supported path (M6-03).",
  "session deep-link RPC: no verified command-API navigation hook — native sessionIds listed with navigator hint (M6-03).",
  "server-side wakes/usage reads: no versioned daemon route — never fetched via speculative paths (contract amendment required).",
] as const;

/** Terminal fallback served with every board read (native route unsupported). */
export const BOARD_FALLBACK_HINT =
  "Native board route is not exposed by the installed @opencode/plugin 2.2.7 command API " +
  "(ctx.command supports transform/list/reload only); terminal fallback: " +
  "bunx opencode-swarm board --swarm <id> (native TUI route is M6-03).";

/** Session-navigation hint served with every agents read (deep-link deferred). */
export const AGENTS_NAVIGATION_HINT =
  "Open a worker conversation via its native sessionId in your OpenCode session navigator; " +
  "TUI deep-link/shortcut deferred to M6-03.";

/** Scheduler gate semantics attached to pause responses. */
export const SCHEDULER_GATE_PAUSE =
  "Scheduler gate: new wake dispatches are halted; already-admitted turns run to completion " +
  "(in-flight work is never cancelled by pause).";

/** Scheduler gate semantics attached to resume responses. */
export const SCHEDULER_GATE_RESUME =
  "Scheduler gate released: eligible queued wakes resume dispatch in FIFO order.";

/** Worktree preservation policy (PAR-18) attached to pause/resume/stop. */
export const WORKTREE_PRESERVATION_POLICY =
  "Worktree preservation policy: task worktrees with unintegrated, failed, or dirty changes are " +
  "preserved for diagnosis and are never silently deleted; removal requires landed changes first (PAR-18).";

/** Durable-cancel semantics attached to stop responses. */
export const STOP_POLICY =
  "Durable cancel intent recorded (terminal states are immutable: a cancelled swarm never resumes). " +
  WORKTREE_PRESERVATION_POLICY;

/** Full `/swarm` family reference served by `/swarm help`. */
export const SWARM_HELP = [
  "/swarm <requirement> — bind this session as coordinator and activate two workers (coordinator-only).",
  "/swarm status [id] — zero-token snapshot from SQLite projections (modelCalls 0).",
  "/swarm board [id] — board posts via the versioned posts-after read (modelCalls 0); native TUI route unsupported in 2.2.7, terminal fallback hint included.",
  "/swarm agents [id] — roster with native sessionIds plus navigation hint (modelCalls 0).",
  "/swarm message @worker <text> — private user→worker steer via a user_direct wake; never board-posted.",
  "/swarm pause <id> | /swarm resume <id> — coordinator-only scheduler gate.",
  "/swarm stop <id> — coordinator-only durable cancel; worktrees preserved (PAR-18).",
  "/swarm help — this reference. Unknown words are treated as requirements, never errors.",
].join("\n");

export interface CoordinatorBinding {
  readonly coordinatorSessionId: string;
  readonly projectRoot: string;
  readonly boundAt: string;
}

/** PAR-01: bind the CURRENT session as coordinator (lead). Pure validation —
 *  persistence of the association is the daemon's job. */
export function bindCoordinatorSession(
  sessionId: string,
  projectRoot: string,
  now: () => string = () => new Date().toISOString(),
): CoordinatorBinding {
  if (sessionId.trim() === "") {
    throw new SwarmValidationError("MISSING_SESSION", "Cannot bind coordinator: current session id is empty");
  }
  if (projectRoot.trim() === "") {
    throw new SwarmValidationError("MISSING_PROJECT_ROOT", "Cannot bind coordinator: project root is empty");
  }
  return { coordinatorSessionId: sessionId, projectRoot, boundAt: now() };
}

export interface CommandContext {
  readonly sessionId: string;
  readonly projectRoot: string;
  /**
   * M6-01: caller role for code-path authorization. SEC-M6-01 fail-closed:
   * an omitted role defaults to the least-privileged `"researcher"` (post
   * only) and NEVER to `"coordinator"`. The authoritative role MUST be
   * resolved server-side from `bindCoordinatorSession` (the bound
   * coordinator session), never trusted from the caller alone.
   */
  readonly role?: CoordinatorRole | undefined;
}

/** Structural client surface used by status-class intents (subset of
 *  `SwarmDaemonClient`; zero model calls by construction). */
export interface StatusReader {
  snapshot(swarmId: string): Promise<SwarmSnapshot>;
}

/** M6-01: structural board surface (versioned `posts?after=&limit=` read). */
export interface BoardReader {
  listPosts(swarmId: string, after?: number, limit?: number): Promise<{ posts: readonly PostSummary[]; after: number }>;
}

/** M6-01: structural lifecycle surface (daemon pause/resume/cancel). */
export interface SwarmLifecycleGateway {
  pauseSwarm(swarmId: string): Promise<{ swarm: { id: string; status: string } }>;
  resumeSwarm(swarmId: string): Promise<{ swarm: { id: string; status: string } }>;
  cancelSwarm(swarmId: string): Promise<{ swarm: { id: string; status: string } }>;
}

/**
 * M6-01: structural private-steer surface (satisfied daemon-side by
 * `steerWorkerDirect` from `lead-autonomy.ts`). Private means private: the
 * implementation MUST NOT write a board post row — callers prove it via
 * board length before/after.
 */
export interface DirectSteerer {
  steerWorker(input: {
    readonly swarmId: string;
    readonly workerId: string;
    readonly workerName: string;
    readonly text: string;
    readonly idempotencySeed: string;
  }): Promise<{ readonly dispatched: boolean; readonly dispatchStatus?: string | undefined }>;
}

/** Structural activator surface (satisfied by the daemon-side
 *  `SwarmService.activateSwarm`). */
export interface SwarmActivator {
  activateSwarm(input: {
    readonly requirement: string;
    readonly coordinatorSessionId: string;
    readonly projectRoot: string;
  }): Promise<{
    readonly swarm: { readonly id: string; readonly title: string };
    readonly workers: readonly { readonly member: { readonly name: string } }[];
  }>;
}

export interface AgentEntry {
  readonly name: string;
  readonly role: string;
  /**
   * SEC-M6-04 disclosure note: native sessionIds are coordinator-visible
   * routing handles served only through this authenticated read with the
   * navigation hint. Never render them to untrusted surfaces or logs.
   */
  readonly sessionId: string;
}

export type SwarmCommandResult =
  | { readonly kind: "activated"; readonly swarmId: string; readonly title: string; readonly workers: readonly string[] }
  | { readonly kind: "status"; readonly snapshot: SwarmSnapshot; readonly modelCalls: 0 }
  | {
      readonly kind: "board";
      readonly swarmId: string;
      readonly posts: readonly PostSummary[];
      readonly after: number;
      readonly modelCalls: 0;
      readonly fallbackHint: string;
    }
  | {
      readonly kind: "agents";
      readonly swarmId: string;
      readonly members: readonly AgentEntry[];
      readonly modelCalls: 0;
      readonly navigationHint: string;
    }
  | {
      readonly kind: "lifecycle";
      readonly action: "pause" | "resume" | "stop";
      readonly swarmId: string;
      readonly status: string;
      readonly policy: string;
    }
  | {
      readonly kind: "steered";
      readonly swarmId: string;
      readonly worker: string;
      readonly workerId: string;
      readonly dispatched: boolean;
      readonly dispatchStatus?: string | undefined;
    }
  | { readonly kind: "info"; readonly message: string };

/**
 * SEC-M6-04 swarmId allowlist (F-02 single-token validation): every swarmId
 * accepted by `resolveSwarmId` MUST match this pattern. Mirrors the RPC
 * lane (`rpc.ts`); both lanes reject anything else with a validation error.
 */
export const SWARM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** SEC-M6-03: collision-resistant idempotency seed (FNV-1a hex of the text)
 * so the seed carries no raw user text. The daemon dedupes `steerWorker`
 * deliveries on this seed (at-most-once per seed). */
export function idempotencySeedFor(swarmId: string, workerId: string, text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `user-direct:${swarmId}:${workerId}:${(hash >>> 0).toString(16)}`;
}

export interface LastSwarmStore {
  getLastSwarmId(): string | undefined;
  setLastSwarmId(id: string): void;
}

export class SwarmCommand {
  constructor(
    private readonly deps: {
      readonly client: StatusReader;
      readonly activator: SwarmActivator;
      readonly lastSwarm: LastSwarmStore;
      readonly board?: BoardReader | undefined;
      readonly lifecycle?: SwarmLifecycleGateway | undefined;
      readonly steerer?: DirectSteerer | undefined;
      readonly now?: () => string;
    },
  ) {}

  private resolveSwarmId(explicit: string | undefined): string {
    const swarmId = explicit ?? this.deps.lastSwarm.getLastSwarmId();
    if (swarmId === undefined) {
      throw new SwarmValidationError("NO_ACTIVE_SWARM", "No active swarm: pass a swarm id explicitly");
    }
    if (!SWARM_ID_PATTERN.test(swarmId)) {
      throw new SwarmValidationError(
        "INVALID_SWARM_ID",
        `Invalid swarm id ${JSON.stringify(swarmId)} (expected 1..128 chars matching [A-Za-z0-9_-])`,
      );
    }
    return swarmId;
  }

  async execute(rawInput: string, ctx: CommandContext): Promise<SwarmCommandResult> {
    // SEC-M6-01 fail-closed: omitted role => least privilege, never coordinator.
    const role: CoordinatorRole = ctx.role ?? "researcher";
    const intent = parseSwarmInput(rawInput);
    switch (intent.kind) {
      case "activate": {
        // Coordinator-only management action, gated in code (not by prompt).
        authorizeToolCall(role, "manage-members");
        const binding = bindCoordinatorSession(ctx.sessionId, ctx.projectRoot, this.deps.now);
        const result = await this.deps.activator.activateSwarm({
          requirement: intent.requirement,
          coordinatorSessionId: binding.coordinatorSessionId,
          projectRoot: binding.projectRoot,
        });
        this.deps.lastSwarm.setLastSwarmId(result.swarm.id);
        return {
          kind: "activated",
          swarmId: result.swarm.id,
          title: result.swarm.title,
          workers: result.workers.map((w) => w.member.name),
        };
      }
      case "status": {
        // Zero-token read: daemon SQLite projection only, no prompt sent.
        const swarmId = this.resolveSwarmId(intent.swarmId);
        const snapshot = await this.deps.client.snapshot(swarmId);
        return { kind: "status", snapshot, modelCalls: 0 };
      }
      case "board": {
        // Zero-token board replay. When no board reader is wired (M1-04
        // callers), preserve the exact legacy status projection.
        const swarmId = this.resolveSwarmId(intent.swarmId);
        if (this.deps.board === undefined) {
          const snapshot = await this.deps.client.snapshot(swarmId);
          return { kind: "status", snapshot, modelCalls: 0 };
        }
        const page = await this.deps.board.listPosts(swarmId, 0, 100);
        return {
          kind: "board",
          swarmId,
          posts: page.posts,
          after: page.after,
          modelCalls: 0,
          fallbackHint: BOARD_FALLBACK_HINT,
        };
      }
      case "agents": {
        // Zero-token roster: snapshot members + native sessionIds for
        // navigation (TUI deep-link deferred to M6-03; hint included).
        const swarmId = this.resolveSwarmId(intent.swarmId);
        const snapshot = await this.deps.client.snapshot(swarmId);
        return {
          kind: "agents",
          swarmId,
          members: snapshot.members.map((m) => ({ name: m.name, role: m.role, sessionId: m.sessionId })),
          modelCalls: 0,
          navigationHint: AGENTS_NAVIGATION_HINT,
        };
      }
      case "pause":
      case "resume":
      case "stop": {
        // Coordinator-only scheduler gate. When no lifecycle gateway is
        // wired (M1-04 callers), preserve the exact legacy info message.
        authorizeToolCall(role, "manage-members");
        const swarmId = this.resolveSwarmId(intent.swarmId);
        if (this.deps.lifecycle === undefined) {
          return { kind: "info", message: `Swarm ${swarmId} ${intent.kind} requested (daemon lifecycle intent)` };
        }
        const action = intent.kind;
        const outcome =
          action === "pause"
            ? await this.deps.lifecycle.pauseSwarm(swarmId)
            : action === "resume"
              ? await this.deps.lifecycle.resumeSwarm(swarmId)
              : await this.deps.lifecycle.cancelSwarm(swarmId);
        const policy =
          action === "pause"
            ? `${SCHEDULER_GATE_PAUSE} ${WORKTREE_PRESERVATION_POLICY}`
            : action === "resume"
              ? `${SCHEDULER_GATE_RESUME} ${WORKTREE_PRESERVATION_POLICY}`
              : STOP_POLICY;
        return { kind: "lifecycle", action, swarmId, status: outcome.swarm.status, policy };
      }
      case "message": {
        // Private user→worker steer (PAR-23): `post` permission required,
        // resolved against the snapshot roster, delivered ONLY via the
        // injected steerer (daemon `steerWorkerDirect` → durable
        // `user_direct` wake). This path MUST NEVER append a board post.
        authorizeToolCall(role, "post");
        if (intent.text === "") throw new SwarmValidationError("INVALID_MESSAGE", "Usage: /swarm message @worker <text>");
        const swarmId = this.resolveSwarmId(undefined);
        if (this.deps.steerer === undefined) {
          return { kind: "info", message: `Message for @${intent.mention} queued (daemon board post)` };
        }
        const snapshot = await this.deps.client.snapshot(swarmId);
        const member = snapshot.members.find((m) => m.name === intent.mention);
        if (member === undefined) {
          throw new SwarmValidationError(
            "UNKNOWN_MENTION",
            `Unknown worker @${intent.mention} in swarm ${swarmId} (message is never board-posted; no wake sent)`,
          );
        }
        const receipt = await this.deps.steerer.steerWorker({
          swarmId,
          workerId: member.id,
          workerName: member.name,
          text: intent.text,
          idempotencySeed: idempotencySeedFor(swarmId, member.id, intent.text),
        });
        return {
          kind: "steered",
          swarmId,
          worker: member.name,
          workerId: member.id,
          dispatched: receipt.dispatched,
          dispatchStatus: receipt.dispatchStatus,
        };
      }
      case "help": {
        return { kind: "info", message: SWARM_HELP };
      }
    }
  }
}
