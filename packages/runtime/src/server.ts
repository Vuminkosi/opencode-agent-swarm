/**
 * Daemon entrypoint — M1-02 (contract C-DAEMON-01).
 *
 * A standalone Bun process that owns the HTTP transport ONLY. It imports
 * the M1-01 `SwarmStore` for all persistence (no separate persistence
 * lives here) and survives independently of any plugin/TUI process:
 * killing the plugin host does not touch this process, and clients
 * reconnect to the board via `?after=` sequence replay.
 *
 * Usage:
 *   bun src/server.ts --config <path-to-swarm.config.json> [--port N]
 *
 * The daemon is also importable: `startDaemon()` is used by the M1-02
 * lifecycle tests to prove plugin-exit survival and SSE reconnect.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";import { createApp } from "./app.js";
import { loadDaemonConfig, type ResolvedDaemonConfig } from "./config.js";
import { SwarmStore } from "./db/store.js";
import { BroadcastHub } from "./services/broadcast.js";
import { EventIngest } from "./services/ingest.js";
import { SwarmLifecycle } from "./services/lifecycle.js";

export interface StartDaemonOptions {
  readonly config: ResolvedDaemonConfig;
  readonly hub?: BroadcastHub;
  readonly onLog?: (message: string) => void;
}

export interface RunningDaemon {
  readonly url: string;
  readonly port: number;
  readonly hub: BroadcastHub;
  readonly close: () => void;
}

function logLine(onLog: ((message: string) => void) | undefined, message: string): void {
  (onLog ?? ((m) => console.log(m)))(message);
}

export function startDaemon(options: StartDaemonOptions): RunningDaemon {
  const { config } = options;
  try {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  } catch (err) {
    if ((err as { code?: unknown } | undefined)?.code !== "EEXIST") throw err;
  }
  // Store first: it owns schema migrations (M1-01). Lifecycle/ingest
  // handles attach afterwards to the migrated file.
  const store = new SwarmStore(config.databasePath);
  const lifecycle = new SwarmLifecycle(config.databasePath);
  const ingest = new EventIngest(config.databasePath);
  const hub = options.hub ?? new BroadcastHub();
  const app = createApp({ store, lifecycle, ingest, token: config.token, hub });

  const server = Bun.serve({
    hostname: config.listen,
    port: config.port,
    fetch: app.fetch,
    // Never leak stack traces / SQL internals to the wire; the app already
    // returns the safe `{error:{code,message}}` shape, this is the last
    // line of defence for transport-level failures.
    error: () => new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Internal daemon error" } }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  });

  const boundPort = server.port ?? config.port;
  logLine(options.onLog, `[daemon] listening on http://${config.listen}:${boundPort} db=${config.databasePath}`);

  let closed = false;
  // Graceful shutdown: stop accepting connections first, then release the
  // ingest/lifecycle/store handles in reverse acquisition order. Safe to
  // call twice (SIGINT + SIGTERM); in-flight handlers complete against
  // the still-open store because closes run after server.stop().
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      server.stop(true);
    } catch {
      /* already stopped */
    }
    try {
      ingest.close();
    } catch {
      /* ignore */
    }
    try {
      lifecycle.close();
    } catch {
      /* ignore */
    }
    try {
      store.close();
    } catch {
      /* ignore */
    }
  };

  return { url: `http://${config.listen}:${boundPort}`, port: boundPort, hub, close };
}

function parseArgv(argv: string[]): { configPath: string; portOverride: number | undefined } {
  let configPath = "swarm.config.json";
  let portOverride: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next !== undefined) configPath = next;
      i += 1;
    } else if (arg === "--port" && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next !== undefined) portOverride = Number(next);
      i += 1;
    }
  }
  return { configPath, portOverride };
}

if (import.meta.main) {
  const { configPath, portOverride } = parseArgv(Bun.argv.slice(2));
  const loaded = await loadDaemonConfig(configPath);
  let config: ResolvedDaemonConfig = loaded;
  if (portOverride !== undefined && Number.isInteger(portOverride) && portOverride >= 1 && portOverride <= 65535) {
    config = { ...loaded, port: portOverride };
  }
  const daemon = startDaemon({ config });
  const shutdown = (): void => {
    daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
