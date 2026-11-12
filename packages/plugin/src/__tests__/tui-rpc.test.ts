/**
 * M6-03 TUI/RPC probe tests — native embedding + compatibility report.
 *
 * - registration: server setup registers `/swarm`, `swarm_health`, and the
 *   versioned `SwarmRpc` definition (id `swarm`); TUI setup registers the
 *   board router page, the `session.panel` slot claim, and the keymap layer.
 * - route/board fallback selection: router page only when fully wired, else
 *   the terminal fallback; capabilities table cites exact type refs.
 * - RPC versioned-schema validation: stale versions fail closed with typed
 *   `stale_schema`; unwired daemon reads fail closed with `daemon_unwired`.
 * - read-only zero-inference: handlers run with a minimal `{ signal, error }`
 *   context only — no session/prompt/generate surface exists on it — and the
 *   modules contain no inference call-sites (source-text guard).
 * - session navigation + shortcut: tabs-focus path vs router-route fallback;
 *   the board command is always reachable via palette + slash even if the
 *   host rejects the best-effort `alt+s` binding.
 *
 * No live TUI mounting (would need a plugin-config mutation): NOT VERIFIED
 * by design, recorded in the handoff.
 */
// @ts-ignore - bun:test types are provided by the Bun runtime (bun-types not installed); runtime import only.
import { describe, expect, mock, test } from "bun:test";

// The TUI entry imports `@opencode/plugin/tui`, whose `solid.js` requires
// the optional `solid-js` peer that is only present inside the TUI host (see
// tui.tsx [PROBE]). Stub the host import with the real `define` contract
// (identity: returns the definition) before loading the module under test.
mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (plugin: unknown) => plugin },
}));

// Dynamic import AFTER the host stub: static imports would load the
// unstubbed host module first.
const tui = await import("../tui.tsx");
const {
  SWARM_BOARD_COMMAND_ID,
  SWARM_BOARD_KEYBIND,
  SWARM_BOARD_PAGE,
  SWARM_BOARD_PANEL,
  SWARM_BOARD_SLASH,
  applyPostFilter,
  bindBoardRpc,
  createBoardViewState,
  markPostsRead,
  openWorkerSession,
} = tui;
import serverPlugin from "../index.ts";
import {
  SWARM_BOARD_CAPABILITIES,
  SWARM_RPC_ID,
  SWARM_RPC_PROTOCOL_VERSION,
  SWARM_RPC_SCHEMA_VERSION,
  TERMINAL_BOARD_FALLBACK,
  createSwarmRpcHandlers,
  selectBoardSurface,
} from "../rpc.ts";

type ServerSetupContext = Parameters<typeof serverPlugin.setup>[0];
type TuiSetupContext = Parameters<(typeof tui.default.setup)>[0];

interface Captured {
  readonly commands: { name: string; description: string; execute: () => Promise<void> }[];
  readonly tools: { name: string }[];
  readonly rpcDefinitions: { id: string; methods: Record<string, unknown> }[];
  readonly disposed: string[];
}

function fakeServerContext(captured: Captured): ServerSetupContext {
  const registration = (label: string) => ({ dispose: async () => void captured.disposed.push(label) });
  return {
    command: {
      transform: async (callback: (editor: {
        add: (definition: { name: string; description: string; execute: () => Promise<void> }) => void;
      }) => void) => {
        callback({ add: (definition) => void captured.commands.push(definition) });
        return registration("command");
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (definition: { name: string }) => void }) => void) => {
        callback({ add: (definition) => void captured.tools.push(definition) });
        return registration("tool");
      },
    },
    rpc: {
      register: async (definition: { id: string; methods: Record<string, unknown> }, _handlers: unknown) => {
        captured.rpcDefinitions.push(definition);
        return registration("rpc");
      },
    },
  } as unknown as ServerSetupContext;
}

interface FakeRouter {
  readonly registered: { name: string }[];
  readonly navigated: unknown[];
}
interface FakeTui {
  readonly router: FakeRouter;
  readonly slotClaims: unknown[];
  readonly layers: (() => { commands: any[]; bindings?: string[] })[];
  readonly memoryInits: { key: string; initial: unknown }[];
  readonly tabsFocusCalls: string[];
  readonly tabsFocusResult: boolean;
}

function fakeTuiContext(fake: FakeTui): TuiSetupContext {
  return {
    ui: {
      router: {
        register: (page: { name: string }) => {
          fake.router.registered.push(page);
          return () => {};
        },
        navigate: (destination: unknown) => void fake.router.navigated.push(destination),
        current: () => ({ type: "home" }) as const,
      },
      panel: {
        open: () => true,
        close: () => {},
        current: () => undefined,
      },
      slot: (claim: unknown) => {
        fake.slotClaims.push(claim);
        return () => {};
      },
      tabs: {
        enabled: () => true,
        list: () => [],
        open: () => true,
        focus: (sessionID: string) => {
          fake.tabsFocusCalls.push(sessionID);
          return fake.tabsFocusResult;
        },
        move: () => false,
        close: () => false,
      },
    },
    keymap: {
      layer: (factory: () => { commands: any[]; bindings?: string[] }) => void fake.layers.push(factory),
      dispatch: () => {},
      shortcuts: () => [],
      commands: () => [],
      pending: () => [],
      active: () => [],
      mode: { current: () => "base", push: () => () => {} },
    },
    storage: {
      store: (key: string, options: { initial: unknown }) => [options.initial, async () => {}],
      memory: (key: string, options: { initial: unknown }) => {
        fake.memoryInits.push({ key, initial: options.initial });
        return [options.initial, async () => {}];
      },
    },
  } as unknown as TuiSetupContext;
}

function fakeErrorFactory(calls: { type: string; message: string }[]) {
  return (type: string, message: string, _data?: unknown) => {
    calls.push({ type, message });
    return { __handlerError: true, type, message };
  };
}

describe("M6-03 server registration", () => {
  test("setup registers /swarm, swarm_health, and the versioned SwarmRpc definition", async () => {
    const captured: Captured = { commands: [], tools: [], rpcDefinitions: [], disposed: [] };
    const teardown = await serverPlugin.setup(fakeServerContext(captured));
    expect(captured.commands.map((c) => c.name)).toEqual(["swarm"]);
    expect(captured.commands[0]?.description).toContain("/swarm help");
    expect(typeof captured.commands[0]?.execute).toBe("function");
    expect(captured.tools.map((t) => t.name)).toEqual(["swarm_health"]);
    expect(captured.rpcDefinitions.map((d) => d.id)).toEqual([SWARM_RPC_ID]);
    const methods = Object.keys(captured.rpcDefinitions[0]?.methods ?? {});
    expect(methods.sort()).toEqual(["boardPosts", "boardSnapshot", "health"]);

    // Teardown disposes every registration in reverse order (rpc last in).
    expect(typeof teardown).toBe("function");
    await teardown?.();
    expect(captured.disposed).toEqual(["rpc", "tool", "command"]);
  });
});

describe("M6-03 TUI native slots", () => {
  function setUpTui(tabsFocusResult: boolean): { fake: FakeTui; cleanup: unknown } {
    const fake: FakeTui = {
      router: { registered: [], navigated: [] },
      slotClaims: [],
      layers: [],
      memoryInits: [],
      tabsFocusCalls: [],
      tabsFocusResult,
    };
    const cleanup = (tui.default.setup as (ctx: TuiSetupContext) => unknown)(
      fakeTuiContext(fake),
    );
    return { fake, cleanup };
  }

  test("setup registers the board router page and the session.panel slot claim", () => {
    const { fake, cleanup } = setUpTui(true);
    expect(fake.router.registered.map((p) => p.name)).toEqual([SWARM_BOARD_PAGE]);
    expect(fake.slotClaims.length).toBe(1);
    expect(fake.slotClaims[0]).toMatchObject({ append: "session.panel" });
    expect(typeof cleanup).toBe("function");
  });

  test("keymap layer exposes the board command with palette + slash equivalents for the best-effort Alt+S bind", () => {
    const { fake } = setUpTui(true);
    expect(fake.layers.length).toBe(1);
    const layer = fake.layers[0]?.();
    expect(layer?.bindings).toEqual([SWARM_BOARD_COMMAND_ID]);
    const command = layer?.commands[0];
    expect(command.id).toBe(SWARM_BOARD_COMMAND_ID);
    expect(command.bind).toBe(SWARM_BOARD_KEYBIND);
    expect(command.palette).toBe(true);
    expect(command.slash).toEqual({ name: SWARM_BOARD_SLASH });
    // Running the command navigates to the verified plugin route.
    command.run();
    expect(fake.router.navigated).toEqual([{ type: "plugin", name: SWARM_BOARD_PAGE }]);
  });

  test("board view-state store initializes read markers, filter, and follow", () => {
    const { fake } = setUpTui(true);
    expect(fake.memoryInits.map((m) => m.key)).toEqual(["swarm-board"]);
    expect(fake.memoryInits[0]?.initial).toEqual({ readAfter: 0, kindFilter: undefined, follow: true });
  });
});

describe("M6-03 worker-session navigation", () => {
  test("tabs.focus success navigates via tab without touching the router", () => {
    const calls: unknown[] = [];
    const ui = {
      tabs: { focus: (id: string) => true },
      router: { navigate: (destination: unknown) => void calls.push(destination) },
    } as unknown as Parameters<typeof openWorkerSession>[0];
    expect(openWorkerSession(ui, "sess-worker-1")).toBe("tab");
    expect(calls).toEqual([]);
  });

  test("tabs disabled falls back to the verified session route", () => {
    const calls: unknown[] = [];
    const ui = {
      tabs: { focus: (_id: string) => false },
      router: { navigate: (destination: unknown) => void calls.push(destination) },
    } as unknown as Parameters<typeof openWorkerSession>[0];
    expect(openWorkerSession(ui, "sess-worker-2")).toBe("route");
    expect(calls).toEqual([{ type: "session", sessionID: "sess-worker-2" }]);
  });
});

describe("M6-03 board view-state helpers", () => {
  test("read markers advance monotonically; filters select kinds", () => {
    const initial = createBoardViewState();
    expect(initial).toEqual({ readAfter: 0, kindFilter: undefined, follow: true });
    const advanced = markPostsRead(markPostsRead(initial, 4), 2);
    expect(advanced.readAfter).toBe(4);
    const posts = [
      { sequence: 1, kind: "status" },
      { sequence: 2, kind: "message" },
    ];
    expect(applyPostFilter(posts, initial)).toEqual(posts);
    expect(applyPostFilter(posts, { ...initial, kindFilter: SWARM_BOARD_PANEL })).toEqual([]);
    expect(applyPostFilter(posts, { ...initial, kindFilter: "status" })).toEqual([posts[0]]);
  });
});

describe("M6-03 RPC versioned-schema validation", () => {
  test("health serves the static versioned payload with zero inference surface", async () => {
    const handlers = createSwarmRpcHandlers();
    const result = (await handlers.health({}, {
      signal: new AbortController().signal,
      error: () => {
        throw new Error("health must never error");
      },
    })) as Record<string, unknown>;
    expect(result).toEqual({
      status: "ok",
      schemaVersion: SWARM_RPC_SCHEMA_VERSION,
      protocolVersion: SWARM_RPC_PROTOCOL_VERSION,
    });
  });

  test("stale schema versions fail closed with typed stale_schema (unwired reader)", async () => {
    const handlers = createSwarmRpcHandlers();
    for (const method of ["boardSnapshot", "boardPosts"] as const) {
      const calls: { type: string; message: string }[] = [];
      const context = { signal: new AbortController().signal, error: fakeErrorFactory(calls) };
      await handlers[method]({ swarmId: "s-1", schemaVersion: "9.9.9" }, context);
      expect(calls.map((c) => c.type)).toEqual(["stale_schema"]);
    }
  });

  test("empty swarmId fails closed as a distinct invalid_swarm_id violation (never stale_schema)", async () => {
    const handlers = createSwarmRpcHandlers();
    const calls: { type: string; message: string }[] = [];
    await handlers.boardSnapshot(
      { swarmId: "", schemaVersion: SWARM_RPC_SCHEMA_VERSION },
      { signal: new AbortController().signal, error: fakeErrorFactory(calls) },
    );
    expect(calls.map((c) => c.type)).toEqual(["invalid_swarm_id"]);
    expect(calls[0]?.message).toContain("swarmId");
  });

  test("malformed swarmIds fail closed as invalid_swarm_id on both reads", async () => {
    const handlers = createSwarmRpcHandlers();
    for (const method of ["boardSnapshot", "boardPosts"] as const) {
      for (const bad of ["has space", "semi;colon", "../escape", "x".repeat(129)]) {
        const calls: { type: string; message: string }[] = [];
        const context = { signal: new AbortController().signal, error: fakeErrorFactory(calls) };
        await handlers[method]({ swarmId: bad, schemaVersion: SWARM_RPC_SCHEMA_VERSION }, context);
        expect(calls.map((c) => c.type)).toEqual(["invalid_swarm_id"]);
      }
    }
  });

  test("non-finite pagination fails closed as invalid_pagination; huge limits clamp to 100", async () => {
    const seen: unknown[] = [];
    const handlers = createSwarmRpcHandlers({
      snapshot: async (swarmId: string) => ({
        swarm: { id: swarmId, title: "T", status: "active" },
        members: [],
        tasks: [],
      }),
      listPosts: async (swarmId: string, after = 0, limit = 100) => {
        seen.push([swarmId, after, limit]);
        return { posts: [], after };
      },
    });
    for (const bad of [{ after: Number.NaN }, { after: Number.POSITIVE_INFINITY }, { limit: Number.NaN }, { limit: "25" }]) {
      const calls: { type: string; message: string }[] = [];
      await handlers.boardPosts(
        { swarmId: "s-1", schemaVersion: SWARM_RPC_SCHEMA_VERSION, ...bad },
        { signal: new AbortController().signal, error: fakeErrorFactory(calls) },
      );
      expect(calls.map((c) => c.type)).toEqual(["invalid_pagination"]);
    }
    expect(seen).toEqual([]);
    const context = { signal: new AbortController().signal, error: fakeErrorFactory([]) };
    await handlers.boardPosts(
      { swarmId: "s-1", after: -5, limit: 1e9, schemaVersion: SWARM_RPC_SCHEMA_VERSION },
      context,
    );
    expect(seen).toEqual([["s-1", 0, 100]]);
  });

  test("unwired daemon reads fail closed with typed daemon_unwired", async () => {
    const handlers = createSwarmRpcHandlers();
    for (const method of ["boardSnapshot", "boardPosts"] as const) {
      const calls: { type: string; message: string }[] = [];
      const context = { signal: new AbortController().signal, error: fakeErrorFactory(calls) };
      await handlers[method]({ swarmId: "s-1", schemaVersion: SWARM_RPC_SCHEMA_VERSION }, context);
      expect(calls.map((c) => c.type)).toEqual(["daemon_unwired"]);
    }
  });

  test("wired reader serves versioned snapshot and posts-after reads", async () => {
    const seen: { snapshot: string[]; posts: unknown[] } = { snapshot: [], posts: [] };
    const handlers = createSwarmRpcHandlers({
      snapshot: async (swarmId: string) => {
        seen.snapshot.push(swarmId);
        return {
          swarm: { id: swarmId, title: "T", status: "active" },
          members: [{ id: "m-1", name: "w", role: "coder", sessionId: "sess-1" }],
          tasks: [{ id: "t-1", title: "T1", state: "open" }],
        };
      },
      listPosts: async (swarmId: string, after = 0, limit = 100) => {
        seen.posts.push([swarmId, after, limit]);
        return { posts: [{ sequence: 1 }], after: 1 };
      },
    });
    const context = {
      signal: new AbortController().signal,
      error: fakeErrorFactory([]),
    };
    const snapshot = (await handlers.boardSnapshot(
      { swarmId: "s-9", schemaVersion: SWARM_RPC_SCHEMA_VERSION },
      context,
    )) as Record<string, unknown>;
    expect(snapshot["schemaVersion"]).toBe(SWARM_RPC_SCHEMA_VERSION);
    expect((snapshot["swarm"] as { id: string }).id).toBe("s-9");
    const posts = (await handlers.boardPosts(
      { swarmId: "s-9", after: 0, limit: 25, schemaVersion: SWARM_RPC_SCHEMA_VERSION },
      context,
    )) as Record<string, unknown>;
    expect(posts["after"]).toBe(1);
    expect(seen.snapshot).toEqual(["s-9"]);
    expect(seen.posts).toEqual([["s-9", 0, 25]]);
  });
});

describe("M6-03 route/board fallback selection", () => {
  test("native router page only when fully wired; terminal fallback otherwise", () => {
    expect(selectBoardSurface({ routerAvailable: true, snapshotWired: true })).toBe("router-page");
    expect(selectBoardSurface({ routerAvailable: true, snapshotWired: false })).toBe("terminal-fallback");
    expect(selectBoardSurface({ routerAvailable: false, snapshotWired: true })).toBe("terminal-fallback");
  });

  test("capabilities table cites exact refs and names the supported fallback", () => {
    expect(SWARM_BOARD_CAPABILITIES.length).toBeGreaterThan(0);
    for (const capability of SWARM_BOARD_CAPABILITIES) {
      expect(capability.typeRef.length).toBeGreaterThan(0);
      expect(capability.fallback.length).toBeGreaterThan(0);
    }
    const byName = new Map(SWARM_BOARD_CAPABILITIES.map((c) => [c.name, c]));
    expect(byName.get("board-route")?.status).toBe("native");
    expect(byName.get("daemon-snapshot-rpc")?.status).toBe("fallback");
    expect(byName.get("daemon-snapshot-rpc")?.fallback).toBe(TERMINAL_BOARD_FALLBACK);
  });

  test("TUI binds the versioned definition (id swarm) through client.rpc", () => {
    let bound: { id: string } | undefined;
    const fakeClient = {
      rpc: (definition: { id: string }) => {
        bound = definition;
        return { health: async () => ({}) };
      },
    } as unknown as Parameters<typeof bindBoardRpc>[0];
    const boundClient = bindBoardRpc(fakeClient) as { health: () => Promise<unknown> };
    expect(bound?.id).toBe(SWARM_RPC_ID);
    expect(typeof boundClient.health).toBe("function");
  });
});

describe("M6-03 zero-inference source guard", () => {
  test("probe modules contain no inference call-sites", async () => {
    const paths = ["../index.ts", "../rpc.ts", "../tui.tsx"];
    for (const path of paths) {
      // @ts-ignore - Bun global provided at runtime (same pattern as index.test.ts bun:test import).
      const raw = await Bun.file(new URL(path, import.meta.url)).text();
      // Doc comments name the forbidden call-sites to prohibit them; assert
      // on code only (strip block/line comments and string literals).
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1")
        .replace(/"([^"\\]|\\.)*"/g, '""')
        .replace(/'([^'\\]|\\.)*'/g, "''")
        .replace(/`([^`\\]|\\.)*`/g, "``");
      expect(code).not.toContain("session.prompt");
      expect(code).not.toContain("experimental.generate");
      expect(code).not.toContain("experimental.generate.text");
    }
    // No invented TUI members: every ui./keymap./storage./data./client./router.
    // access below is asserted by tsc against the installed 2.2.7 types; the
    // runtime fakes above tolerate only the same member names.
    // @ts-ignore - Bun global provided at runtime (same pattern as index.test.ts bun:test import).
    const tuiSource = await Bun.file(new URL("../tui.tsx", import.meta.url)).text();
    for (const member of [
      "ui.router.register",
      "ui.router.navigate",
      "ui.slot",
      "ui.tabs.focus",
      "keymap.layer",
      "storage.memory",
      "client.rpc",
    ]) {
      expect(tuiSource).toContain(member);
    }
  });
});
