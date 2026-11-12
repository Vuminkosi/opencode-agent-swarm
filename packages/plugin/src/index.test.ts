/**
 * M0-02-FIX-01 regression tests — teardown reliability (review V-F01).
 *
 * - Teardown disposes every registration in reverse order, always clears the
 *   list (finally), aggregates failures into an AggregateError, and rethrows.
 * - Double-teardown is a no-op: second call resolves without disposing again.
 * - A failing dispose must not skip the remaining registrations.
 *
 * Uses a minimal fake plugin context: `command.transform`, `tool.transform`,
 * and `rpc.register` are exercised by setup (M6-03 added the versioned RPC
 * registration), each returning a controllable registration in call order.
 */
// @ts-ignore - bun:test types are provided by the Bun runtime (bun-types not installed); runtime import only.
import { describe, expect, test } from "bun:test";
import plugin from "./index.ts";

interface FakeRegistration {
  dispose: () => Promise<void>;
}

type SetupContext = Parameters<typeof plugin.setup>[0];

function fakeContext(registrations: FakeRegistration[]): SetupContext {
  let next = 0;
  const transform = async (): Promise<FakeRegistration> => {
    const registration = registrations[next];
    if (registration === undefined) throw new Error("unexpected transform call");
    next += 1;
    return registration;
  };
  return {
    command: { transform },
    tool: { transform },
    rpc: { register: transform },
  } as unknown as SetupContext;
}

async function setupTeardown(registrations: FakeRegistration[]) {
  const teardown = await plugin.setup(fakeContext(registrations));
  if (typeof teardown !== "function") throw new Error("setup did not return teardown");
  return teardown;
}

describe("swarm plugin teardown", () => {
  test("double-teardown is a no-op", async () => {
    const disposed: string[] = [];
    const teardown = await setupTeardown([
      { dispose: async () => void disposed.push("command") },
      { dispose: async () => void disposed.push("tool") },
      { dispose: async () => void disposed.push("rpc") },
    ]);

    await teardown();
    // Reverse order: rpc registration was pushed last, disposed first.
    expect(disposed).toEqual(["rpc", "tool", "command"]);

    await teardown();
    expect(disposed).toEqual(["rpc", "tool", "command"]);
  });

  test("a failing dispose still disposes the remainder and aggregates the error", async () => {
    const disposed: string[] = [];
    const failure = new Error("tool dispose boom");
    const teardown = await setupTeardown([
      { dispose: async () => void disposed.push("command") },
      {
        dispose: async () => {
          disposed.push("tool");
          throw failure;
        },
      },
      { dispose: async () => void disposed.push("rpc") },
    ]);

    let caught: unknown = null;
    try {
      await teardown();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([failure]);
    // Remainder still disposed despite the failure (reverse order).
    expect(disposed).toEqual(["rpc", "tool", "command"]);

    // List was cleared via finally: second teardown is a no-op, not a rethrow.
    await teardown();
    expect(disposed).toEqual(["rpc", "tool", "command"]);
  });
});
