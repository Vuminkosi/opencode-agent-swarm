/**
 * Daemon configuration — M1-02 (contract C-DAEMON-01).
 *
 * `swarm.config.json` is our own validated file (spec §17), NOT an
 * OpenCode-provided config surface. schemaVersion must equal the protocol
 * SCHEMA_VERSION; receivers reject unknown versions rather than
 * best-effort parse.
 *
 * Defaults: loopback-only bind 127.0.0.1:4788. A non-loopback listen
 * address without an explicitly configured bearer token is refused at
 * startup (spec §5: never expose the daemon without authenticated config).
 *
 * Evidence: [DESIGN] (spec §§5, 17 M1-02).
 */
import { z } from "zod";
import { SCHEMA_VERSION } from "@opencode-swarm/protocol";

export const PROTOCOL_VERSION = 1 as const;

export const DaemonConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runtime: z.object({
    listen: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(4788),
    databasePath: z.string().min(1),
  }),
  mode: z.enum(["parity", "safe-coding"]).optional(),
  auth: z.object({ token: z.string().min(16).optional() }).optional(),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

export interface ResolvedDaemonConfig {
  readonly listen: string;
  readonly port: number;
  readonly databasePath: string;
  readonly token: string;
  readonly mode: "parity" | "safe-coding";
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized.startsWith("127.")) {
    const parts = normalized.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return true;
  }
  return false;
}

function resolveToken(parsed: DaemonConfig): string {
  const token = parsed.auth?.token ?? process.env["SWARM_DAEMON_TOKEN"];
  if (token === undefined || token.length < 16) {
    throw new Error(
      "Daemon bearer token missing: set auth.token in swarm.config.json or SWARM_DAEMON_TOKEN (min 16 chars).",
    );
  }
  return token;
}

/** Parse + validate raw JSON (unknown strip is fine; we only read known fields). */
export function parseDaemonConfig(raw: unknown): ResolvedDaemonConfig {
  const parsed = DaemonConfigSchema.parse(raw);
  if (!isLoopbackHost(parsed.runtime.listen) && (parsed.auth?.token ?? process.env["SWARM_DAEMON_TOKEN"]) === undefined) {
    throw new Error(
      `Refusing non-loopback listen "${parsed.runtime.listen}" without an explicit bearer token (spec §5).`,
    );
  }
  return {
    listen: parsed.runtime.listen,
    port: parsed.runtime.port,
    databasePath: parsed.runtime.databasePath,
    token: resolveToken(parsed),
    mode: parsed.mode ?? "parity",
  };
}

export async function loadDaemonConfig(configPath: string): Promise<ResolvedDaemonConfig> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(`Daemon config not found: ${configPath}`);
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    throw new Error(`Daemon config is not valid JSON: ${configPath}`);
  }
  return parseDaemonConfig(raw);
}
