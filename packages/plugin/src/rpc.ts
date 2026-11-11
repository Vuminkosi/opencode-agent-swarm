/**
 * M0-02 RPC entry (`@opencode-swarm/plugin/rpc`).
 *
 * Versioned client↔server message schema stub. Typechecks against the
 * installed `@opencode/plugin` 2.2.7 `Rpc.define` portable-definition types
 * (JSON-schema values only — no Effect codecs, keeping this entry
 * dependency-free).
 *
 * [PROBE] NOT VERIFIED: RPC method names, transport wiring
 * (`ctx.rpc.register` handlers ↔ TUI `client` calls), and event payloads are
 * not asserted until probed against the pinned release. The M0-02 server
 * path does not depend on RPC: `swarm_health` is served locally by the tool
 * in `./index.ts`.
 */
import { Rpc } from "@opencode/plugin";

export const SWARM_RPC_ID = "swarm" as const;

/** Wire schema versions carried on every RPC payload (M1-01 owns canonical). */
export const SWARM_RPC_SCHEMA_VERSION = "0.0.1" as const;
export const SWARM_RPC_PROTOCOL_VERSION = "swarm/0" as const;

export const SwarmRpc = Rpc.define({
  id: SWARM_RPC_ID,
  methods: {
    health: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: {} },
    },
  },
  events: {},
});

export type SwarmRpc = typeof SwarmRpc;
