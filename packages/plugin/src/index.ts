/**
 * M0-02 plugin bootstrap — server entry (`@opencode-swarm/plugin`).
 * M6-03: discoverable `/swarm` action + versioned RPC registration.
 *
 * Registers the `/swarm` command, a `swarm_health` tool, and the versioned
 * `SwarmRpc` portable definition, then returns a teardown that unsubscribes
 * every listener registration in reverse order.
 *
 * Invariants (spec §15 M0-02, M0-01 freeze):
 * - The plugin never stores authoritative swarm state; the daemon owns it.
 * - The `swarm_health` tool performs zero model inference: it returns a
 *   static payload shaped like the daemon `GET /healthz` contract
 *   (C-DAEMON-01: `{status,schemaVersion,protocolVersion}`) without calling
 *   `session.prompt`, `experimental.generate`, or any network endpoint.
 * - The `/swarm` command `execute` hook stays side-effect-free: the
 *   `CommandDefinition.execute` contract returns `Promise<void>` with no
 *   output channel (`dist/promise/command.d.ts:11-14`), so visible dispatch
 *   (reads with `modelCalls: 0`, lifecycle, steers) lives in the M6-01
 *   command layer (`SwarmCommand.execute` results) and the versioned RPC
 *   below — never in this hook. No LLM polling loop; no event-forwarding
 *   loop yet (M1-02 owns transport).
 * - RPC handlers (`./rpc.ts`) validate `schemaVersion` fail-closed and
 *   serve zero-inference reads; daemon-backed methods return the typed
 *   `daemon_unwired` handler error until the M6-01 transport lane injects a
 *   reader. No daemon secrets are handled here.
 * - Native agents are preserved: nothing here mutates agent permissions.
 *
 * [OC2-DOC] `Plugin.define({id, setup})`; `ctx.command.transform(...)`;
 * `ctx.tool.transform(...)`; `ctx.rpc.register(definition, handlers)`
 * (`dist/promise/rpc.d.ts:21`); setup returns teardown. Verified against the
 * pinned `@opencode/plugin` 2.2.7 published types (see disposable-probe
 * `m0-02-probe` resolution: `latest` dist-tag = 2.2.7, matching CLI 2.2.7).
 */
import { Plugin } from "@opencode/plugin";
import { SwarmRpc, createSwarmRpcHandlers } from "./rpc.js";

export const SWARM_PLUGIN_ID = "swarm" as const;

/** Mirrors the daemon `/healthz` schema version until M1-01 owns it. */
export const HEALTH_SCHEMA_VERSION = "0.0.1" as const;
/** Mirrors the daemon `/healthz` protocol version until M1-01 owns it. */
export const HEALTH_PROTOCOL_VERSION = "swarm/0" as const;

export interface SwarmHealth {
  readonly status: "ok";
  readonly schemaVersion: typeof HEALTH_SCHEMA_VERSION;
  readonly protocolVersion: typeof HEALTH_PROTOCOL_VERSION;
}

export function swarmHealth(): SwarmHealth {
  return {
    status: "ok",
    schemaVersion: HEALTH_SCHEMA_VERSION,
    protocolVersion: HEALTH_PROTOCOL_VERSION,
  };
}

export default Plugin.define({
  id: SWARM_PLUGIN_ID,
  async setup(ctx) {
    const registrations: Array<{ dispose: () => Promise<void> }> = [];

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: SWARM_PLUGIN_ID,
          description:
            "Swarm: activate workers, zero-token status/board/agents reads, scheduler gate, private steers. Native board: TUI page “Swarm Board” (Alt+S); fallback: bunx opencode-swarm board. Full reference: /swarm help.",
          execute: async () => {
            // No-op by design: the hook returns Promise<void> with no output
            // channel, so it must not trigger model inference, sessions, or
            // daemon I/O. Visible dispatch is the M6-01 command layer and the
            // versioned RPC registered below.
          },
        });
      }),
    );

    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "swarm_health",
          description:
            "Swarm daemon health stub (M0-02): returns static {status,schemaVersion,protocolVersion} without model inference.",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({
            content: [{ type: "text", text: JSON.stringify(swarmHealth()) }],
          }),
        });
      }),
    );

    // M6-03: versioned client↔server RPC. The inferred handlers are checked
    // against RpcHandlers<typeof SwarmRpc> by this register call — only the
    // verified method names (health/boardSnapshot/boardPosts) typecheck here.
    registrations.push(await ctx.rpc.register(SwarmRpc, createSwarmRpcHandlers()));

    return async () => {
      if (registrations.length === 0) return;
      try {
        const errors: unknown[] = [];
        for (const registration of [...registrations].reverse()) {
          try {
            await registration.dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "swarm plugin teardown failed");
        }
      } finally {
        registrations.length = 0;
      }
    };
  },
});
