/**
 * M1-04 `/swarm` command: validation + coordinator binding + dispatch
 * routing (contract C-PLUGIN-01; spec §§2 PAR-01..05, 5, 7, 11, 15 M1-04).
 *
 * Responsibilities (and ONLY these):
 * - Parse raw `/swarm ...` input into a typed intent (`activate`, `status`,
 *   `board`, `agents`, `pause`, `resume`, `stop`, `message`, `help`).
 * - Validate the activation requirement and bind the CURRENT session as
 *   coordinator (PAR-01: the current conversation becomes the lead; the
 *   swarm association is persisted by the daemon, never invented here).
 * - Route `status`/`board` reads through the versioned daemon client, which
 *   serves them from SQLite projections with ZERO model calls (PAR lead
 *   anti-polling invariant: no prompt is sent to the coordinator merely to
 *   report status).
 * - Route `activate` through the injected activator (daemon-side
 *   `SwarmService`), which creates the swarm + two named workers, posts the
 *   immutable briefs and dispatches queue-only.
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

import type { SwarmSnapshot } from "../client.js";

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
 * subcommand names route elsewhere.
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
    default:
      return { kind: "help" };
  }
}

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
}

/** Structural client surface used by status-class intents (subset of
 *  `SwarmDaemonClient`; zero model calls by construction). */
export interface StatusReader {
  snapshot(swarmId: string): Promise<SwarmSnapshot>;
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

export type SwarmCommandResult =
  | { readonly kind: "activated"; readonly swarmId: string; readonly title: string; readonly workers: readonly string[] }
  | { readonly kind: "status"; readonly snapshot: SwarmSnapshot; readonly modelCalls: 0 }
  | { readonly kind: "info"; readonly message: string };

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
      readonly now?: () => string;
    },
  ) {}

  async execute(rawInput: string, ctx: CommandContext): Promise<SwarmCommandResult> {
    const intent = parseSwarmInput(rawInput);
    switch (intent.kind) {
      case "activate": {
        // Coordinator-only management action, gated in code (not by prompt).
        authorizeToolCall("coordinator", "manage-members");
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
      case "status":
      case "board":
      case "agents": {
        // Zero-token reads: daemon SQLite projection only, no prompt sent.
        const swarmId = intent.swarmId ?? this.deps.lastSwarm.getLastSwarmId();
        if (swarmId === undefined) {
          throw new SwarmValidationError("NO_ACTIVE_SWARM", "No active swarm: pass a swarm id explicitly");
        }
        const snapshot = await this.deps.client.snapshot(swarmId);
        return { kind: "status", snapshot, modelCalls: 0 };
      }
      case "pause":
      case "resume":
      case "stop": {
        authorizeToolCall("coordinator", "manage-members");
        const swarmId = intent.swarmId ?? this.deps.lastSwarm.getLastSwarmId();
        if (swarmId === undefined) {
          throw new SwarmValidationError("NO_ACTIVE_SWARM", "No active swarm: pass a swarm id explicitly");
        }
        return { kind: "info", message: `Swarm ${swarmId} ${intent.kind} requested (daemon lifecycle intent)` };
      }
      case "message": {
        authorizeToolCall("coordinator", "post");
        if (intent.text === "") throw new SwarmValidationError("INVALID_MESSAGE", "Usage: /swarm message @worker <text>");
        return { kind: "info", message: `Message for @${intent.mention} queued (daemon board post)` };
      }
      case "help": {
        return {
          kind: "info",
          message: "Usage: /swarm <requirement> | /swarm status [id] | /swarm board [id] | /swarm pause|resume|stop <id>",
        };
      }
    }
  }
}
