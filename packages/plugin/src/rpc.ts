/**
 * M6-03 versioned client↔server RPC (`@opencode-swarm/plugin/rpc`).
 *
 * Portable contract. Typechecks against the installed `@opencode/plugin`
 * 2.2.7 published types WITHOUT the optional peers:
 * - `Rpc.define` portable definition (`@opencode/plugin`, re-exported from
 *   `@opencode/schema/rpc`: `PortableDefinition { id, methods, events }`
 *   with JSON-schema values only — see
 *   `node_modules/.bun/@opencode+schema@2.2.7/.../dist/rpc.d.ts:43-49`).
 *   Verified at runtime: `Rpc.define` is identity plus a reserved
 *   `rpc.*` error-name guard.
 * - Server transport `ctx.rpc.register(definition, handlers)` returns
 *   `Promise<RpcRegistration>` (`Registration { dispose }`), so the
 *   registration joins the standard teardown chain in `./index.ts`
 *   (`dist/promise/rpc.d.ts:12-21`).
 * - Handler context `{ signal, error }` (`RpcCallContext`,
 *   `dist/promise/rpc.d.ts:5-8`): handlers return `context.error(...)`
 *   values, they never throw version/transport failures.
 * - TUI calls use `ctx.client.rpc(definition): RpcClient<D>` typed per
 *   method (`@opencode/client/dist/promise/rpc.d.ts:26-28`,
 *   `client.d.ts:354`).
 *
 * Zero model inference by construction: handlers serve the static health
 * payload plus version-checked reads through an injected structural reader.
 * No `session.prompt`, no `experimental.generate`, no daemon secret handling
 * in this slice.
 *
 * [PROBE] Daemon-backed reads (`boardSnapshot`/`boardPosts`) return the
 * typed `daemon_unwired` handler error until the M6-01 transport lane
 * injects a reader (one-line: pass a `SwarmDaemonClient`-shaped reader to
 * `createSwarmRpcHandlers`). The terminal board (`bunx opencode-swarm board`,
 * M6-02) remains the supported fallback; see SWARM_BOARD_CAPABILITIES.
 */
import { Rpc } from "@opencode/plugin";

export const SWARM_RPC_ID = "swarm" as const;

/** Wire schema versions carried on every RPC payload (M1-04/M1-01 lineage). */
export const SWARM_RPC_SCHEMA_VERSION = "0.0.1" as const;
export const SWARM_RPC_PROTOCOL_VERSION = "swarm/0" as const;

/** Method names exposed by this contract — no other names are registered. */
export const SWARM_RPC_METHODS = ["health", "boardSnapshot", "boardPosts"] as const;
export type SwarmRpcMethodName = (typeof SWARM_RPC_METHODS)[number];

const VERSIONED_ERRORS = {
  stale_schema: {
    type: "object",
    properties: {
      expected: { type: "string" },
      received: { type: "string" },
    },
    required: ["expected", "received"],
    additionalProperties: false,
  },
  daemon_unwired: {
    type: "object",
    properties: {
      method: { type: "string" },
      fallback: { type: "string" },
    },
    required: ["method", "fallback"],
    additionalProperties: false,
  },
  invalid_swarm_id: {
    type: "object",
    properties: {
      received: { type: "string" },
    },
    required: ["received"],
    additionalProperties: false,
  },
  invalid_pagination: {
    type: "object",
    properties: {
      received: { type: "string" },
    },
    required: ["received"],
    additionalProperties: false,
  },
} as const;

export const SwarmRpc = Rpc.define({
  id: SWARM_RPC_ID,
  methods: {
    health: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          status: { type: "string" },
          schemaVersion: { type: "string" },
          protocolVersion: { type: "string" },
        },
        required: ["status", "schemaVersion", "protocolVersion"],
        additionalProperties: false,
      },
    },
    boardSnapshot: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          schemaVersion: { type: "string" },
        },
        required: ["swarmId", "schemaVersion"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          swarm: { type: "object" },
          members: { type: "array" },
          tasks: { type: "array" },
          schemaVersion: { type: "string" },
          protocolVersion: { type: "string" },
        },
        required: ["swarm", "members", "tasks", "schemaVersion", "protocolVersion"],
        additionalProperties: false,
      },
      errors: VERSIONED_ERRORS,
    },
    boardPosts: {
      input: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          after: { type: "number" },
          limit: { type: "number" },
          schemaVersion: { type: "string" },
        },
        required: ["swarmId", "schemaVersion"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          posts: { type: "array" },
          after: { type: "number" },
          schemaVersion: { type: "string" },
        },
        required: ["posts", "after", "schemaVersion"],
        additionalProperties: false,
      },
      errors: VERSIONED_ERRORS,
    },
  },
  events: {
    "board.updated": {
      schema: {
        type: "object",
        properties: {
          swarmId: { type: "string" },
          after: { type: "number" },
        },
        required: ["swarmId", "after"],
        additionalProperties: false,
      },
    },
  },
});

export type SwarmRpc = typeof SwarmRpc;

/** Structural daemon reader injected by the transport lane (M6-01).
 * SEC-M6-02: the injected reader MUST be caller-scoped (membership-enforcing);
 * handlers treat an unwired reader as fail-closed `daemon_unwired` and never
 * serve ambient reads. Every served read is allowlisted by swarmId above. */
export interface SwarmRpcReader {
  snapshot(swarmId: string): Promise<{
    readonly swarm: { readonly id: string; readonly title: string; readonly status: string };
    readonly members: readonly {
      readonly id: string;
      readonly name: string;
      readonly role: string;
      readonly sessionId: string;
    }[];
    readonly tasks: readonly { readonly id: string; readonly title: string; readonly state: string }[];
  }>;
  listPosts(
    swarmId: string,
    after?: number,
    limit?: number,
  ): Promise<{ readonly posts: readonly unknown[]; readonly after: number }>;
}

/**
 * Handler context shape. Intentionally loose (`(...args: any[]) => any`):
 * the exact per-method `ErrorFactory<M>` is owned by
 * `RpcHandlers<typeof SwarmRpc>` and verified at the
 * `ctx.rpc.register(SwarmRpc, handlers)` call site in `./index.ts`.
 * Handlers return `context.error(...)` values (never throw them).
 */
export interface SwarmRpcHandlerContext {
  readonly signal: AbortSignal;
  readonly error: (...args: any[]) => any;
}

function asRecord(input: unknown): { readonly [key: string]: unknown } {
  if (typeof input === "object" && input !== null) {
    return input as { readonly [key: string]: unknown };
  }
  return {};
}

function staleSchemaError(
  context: SwarmRpcHandlerContext,
  received: unknown,
): unknown {
  return context.error(
    "stale_schema",
    `Unsupported swarm RPC schema ${String(received)} (expected ${SWARM_RPC_SCHEMA_VERSION})`,
    undefined,
  );
}

function daemonUnwiredError(context: SwarmRpcHandlerContext, method: SwarmRpcMethodName): unknown {
  return context.error(
    "daemon_unwired",
    `Swarm daemon reader is not wired for ${method} in this slice (M6-01 transport); terminal fallback applies`,
    undefined,
  );
}

/**
 * F-01: empty/malformed swarmIds are a distinct contract violation
 * (`invalid_swarm_id`), NEVER `stale_schema` (which is reserved for
 * `schemaVersion` mismatch). Allowlist mirrors `SWARM_ID_PATTERN` in
 * `commands/swarm.ts` (SEC-M6-04); kept local so this portable module
 * stays dependency-free.
 */
const SWARM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function invalidSwarmIdError(context: SwarmRpcHandlerContext, received: unknown): unknown {
  return context.error(
    "invalid_swarm_id",
    `Invalid swarmId ${JSON.stringify(received)} (expected 1..128 chars matching [A-Za-z0-9_-])`,
    undefined,
  );
}

function invalidPaginationError(context: SwarmRpcHandlerContext, received: unknown): unknown {
  return context.error(
    "invalid_pagination",
    `Invalid pagination ${JSON.stringify(received)} (after/limit must be finite numbers; limit clamps to 1..100)`,
    undefined,
  );
}

/** SEC-M6-02: finite-number pagination; limit clamps to 1..100. */
function normalizePagination(
  context: SwarmRpcHandlerContext,
  rawAfter: unknown,
  rawLimit: unknown,
): { readonly after: number; readonly limit: number } | { readonly error: unknown } {
  let after = 0;
  let limit = 100;
  if (rawAfter !== undefined) {
    if (typeof rawAfter !== "number" || !Number.isFinite(rawAfter)) {
      return { error: invalidPaginationError(context, { after: rawAfter } as unknown) };
    }
    after = Math.max(0, Math.floor(rawAfter));
  }
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)) {
      return { error: invalidPaginationError(context, { limit: rawLimit } as unknown) };
    }
    limit = Math.min(100, Math.max(1, Math.floor(rawLimit)));
  }
  return { after, limit };
}

/**
 * Versioned RPC handlers. Every method first validates `schemaVersion`
 * (fail-closed `stale_schema`), then serves zero-inference reads; daemon
 * methods fail closed with `daemon_unwired` until a reader is injected.
 */
export function createSwarmRpcHandlers(reader?: SwarmRpcReader | undefined): {
  readonly health: (input: unknown, context: SwarmRpcHandlerContext) => Promise<unknown>;
  readonly boardSnapshot: (input: unknown, context: SwarmRpcHandlerContext) => Promise<unknown>;
  readonly boardPosts: (input: unknown, context: SwarmRpcHandlerContext) => Promise<unknown>;
} {
  return {
    health: async () => ({
      status: "ok",
      schemaVersion: SWARM_RPC_SCHEMA_VERSION,
      protocolVersion: SWARM_RPC_PROTOCOL_VERSION,
    }),
    boardSnapshot: async (input, context) => {
      const params = asRecord(input);
      if (params["schemaVersion"] !== SWARM_RPC_SCHEMA_VERSION) {
        return staleSchemaError(context, params["schemaVersion"]);
      }
      if (typeof params["swarmId"] !== "string" || !SWARM_ID_PATTERN.test(params["swarmId"])) {
        return invalidSwarmIdError(context, params["swarmId"]);
      }
      if (reader === undefined) {
        return daemonUnwiredError(context, "boardSnapshot");
      }
      const snapshot = await reader.snapshot(params["swarmId"]);
      return {
        swarm: snapshot.swarm,
        members: snapshot.members,
        tasks: snapshot.tasks,
        schemaVersion: SWARM_RPC_SCHEMA_VERSION,
        protocolVersion: SWARM_RPC_PROTOCOL_VERSION,
      };
    },
    boardPosts: async (input, context) => {
      const params = asRecord(input);
      if (params["schemaVersion"] !== SWARM_RPC_SCHEMA_VERSION) {
        return staleSchemaError(context, params["schemaVersion"]);
      }
      if (typeof params["swarmId"] !== "string" || !SWARM_ID_PATTERN.test(params["swarmId"])) {
        return invalidSwarmIdError(context, params["swarmId"]);
      }
      if (reader === undefined) {
        return daemonUnwiredError(context, "boardPosts");
      }
      const pagination = normalizePagination(context, params["after"], params["limit"]);
      if ("error" in pagination) {
        return pagination.error;
      }
      const page = await reader.listPosts(params["swarmId"], pagination.after, pagination.limit);
      return {
        posts: page.posts,
        after: page.after,
        schemaVersion: SWARM_RPC_SCHEMA_VERSION,
      };
    },
  };
}

/** Native-vs-fallback capability wiring for the board surface. */
export type BoardCapabilityStatus = "native" | "fallback";

export interface BoardCapability {
  readonly name: string;
  readonly status: BoardCapabilityStatus;
  /** Exact installed type/export/route reference, or [PROBE] finding. */
  readonly typeRef: string;
  /** Supported equivalent when native is unavailable. */
  readonly fallback: string;
}

export const TERMINAL_BOARD_FALLBACK = "bunx opencode-swarm board --swarm <id>" as const;

export const SWARM_BOARD_CAPABILITIES: readonly BoardCapability[] = [
  {
    name: "board-route",
    status: "native",
    typeRef: "@opencode/plugin/tui dist/tui/context.d.ts UI.router.register(page: Page)/navigate(destination: Destination) with Route { type: 'plugin', name }",
    fallback: TERMINAL_BOARD_FALLBACK,
  },
  {
    name: "detail-panes",
    status: "native",
    typeRef: "@opencode/plugin/tui dist/tui/context.d.ts SlotMap 'session.panel' + UI.panel.open(name): boolean; claim via UI.slot({ append: 'session.panel' })",
    fallback: TERMINAL_BOARD_FALLBACK,
  },
  {
    name: "worker-session-navigation",
    status: "native",
    typeRef: "@opencode/plugin/tui dist/tui/context.d.ts UI.tabs.focus(sessionID): boolean / UI.tabs.open(sessionID): boolean, else Route { type: 'session', sessionID }",
    fallback: "Open the worker conversation via its native sessionId in the OpenCode session navigator",
  },
  {
    name: "board-shortcut",
    status: "native",
    typeRef: "@opencode/plugin/tui dist/tui/context.d.ts KeymapCommand { id, bind: string, palette, slash } + Keymap.layer/bindings; 'alt+s' is best-effort (OpenTUI owns binding-parse, host-dependent) with palette + slash equivalents",
    fallback: "/swarm board (slash) or the 'Swarm board' palette command",
  },
  {
    name: "read-markers-filters-follow",
    status: "native",
    typeRef: "@opencode/plugin/tui dist/tui/context.d.ts Storage.memory(key, { initial }): live-synced ephemeral board view-state (readAfter/kindFilter/follow)",
    fallback: "Terminal board flags/paging (M6-02)",
  },
  {
    name: "board-render",
    status: "fallback",
    typeRef: "[PROBE] solid-js/@opentui peers are optional and NOT installed in packages/plugin; tui.tsx registers verified slots/routes with a deferred render (no JSX may be compiled here)",
    fallback: TERMINAL_BOARD_FALLBACK,
  },
  {
    name: "daemon-snapshot-rpc",
    status: "fallback",
    typeRef: "[PROBE] transport verified (ctx.rpc.register + client.rpc(definition)); daemon reader injection owned by the M6-01 transport lane — handlers return typed daemon_unwired until then",
    fallback: TERMINAL_BOARD_FALLBACK,
  },
] as const;

export type BoardSurface = "router-page" | "terminal-fallback";

/** Select the board surface: native router page only when every input is wired, else the terminal fallback. */
export function selectBoardSurface(input: {
  readonly routerAvailable: boolean;
  readonly snapshotWired: boolean;
}): BoardSurface {
  if (input.routerAvailable && input.snapshotWired) return "router-page";
  return "terminal-fallback";
}
