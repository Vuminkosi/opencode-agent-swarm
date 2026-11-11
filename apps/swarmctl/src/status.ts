#!/usr/bin/env bun
/**
 * swarmctl status — M1-02 (contract C-DAEMON-01).
 *
 * Minimal zero-token status: pure HTTP reads against the daemon
 * (`GET /healthz` needs no bearer; the snapshot uses one only when a
 * swarm id is given). No model inference is ever triggered — status is
 * served from SQLite projections (spec §8 lead anti-polling invariant).
 *
 * Usage:
 *   bun src/status.ts [--url http://127.0.0.1:4788] [--swarm <id>] [--token <bearer>]
 *
 * The bearer token may also come from SWARM_DAEMON_TOKEN. /healthz is
 * always fetched without a token.
 */

interface Healthz {
  status: string;
  schemaVersion: number;
  protocolVersion: number;
}

function parseArgv(argv: string[]): { url: string; swarmId: string | undefined; token: string | undefined } {
  let url = process.env["SWARM_DAEMON_URL"] ?? "http://127.0.0.1:4788";
  let swarmId: string | undefined;
  let token: string | undefined = process.env["SWARM_DAEMON_TOKEN"];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--url") && next !== undefined) {
      url = next;
      i += 1;
    } else if ((arg === "--swarm" || arg === "--swarm-id") && next !== undefined) {
      swarmId = next;
      i += 1;
    } else if (arg === "--token" && next !== undefined) {
      token = next;
      i += 1;
    }
  }
  return { url: url.replace(/\/$/, ""), swarmId, token };
}

function summarizeSnapshot(snapshot: unknown): string {
  if (typeof snapshot !== "object" || snapshot === null) return "snapshot: <unparseable>";
  const record = snapshot as Record<string, unknown>;
  const swarm = record["swarm"] as Record<string, unknown> | undefined;
  const members = Array.isArray(record["members"]) ? (record["members"] as unknown[]) : [];
  const tasks = Array.isArray(record["tasks"]) ? (record["tasks"] as Record<string, unknown>[]) : [];
  const byState = new Map<string, number>();
  for (const task of tasks) {
    const state = typeof task["state"] === "string" ? task["state"] : "unknown";
    byState.set(state, (byState.get(state) ?? 0) + 1);
  }
  const tasksSummary = [...byState.entries()].map(([s, n]) => `${n} ${s}`).join(" | ") || "0 tasks";
  return [
    `swarm: ${String(swarm?.["title"] ?? "?")} [${String(swarm?.["status"] ?? "?")}] revision=${String(swarm?.["revision"] ?? "?")}`,
    `members: ${members.length}`,
    `tasks: ${tasksSummary}`,
  ].join("\n");
}

export async function fetchStatus(url: string, swarmId?: string, token?: string): Promise<{ health: Healthz; snapshotText: string }> {
  const healthRes = await fetch(`${url}/healthz`);
  if (!healthRes.ok) throw new Error(`healthz failed: HTTP ${healthRes.status}`);
  const health = (await healthRes.json()) as Healthz;
  let snapshotText = "(no --swarm given; pass --swarm <id> for a snapshot)";
  if (swarmId !== undefined) {
    if (token === undefined) throw new Error("snapshot requires --token or SWARM_DAEMON_TOKEN");
    const snapRes = await fetch(`${url}/v1/swarms/${encodeURIComponent(swarmId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!snapRes.ok) throw new Error(`snapshot failed: HTTP ${snapRes.status}`);
    snapshotText = summarizeSnapshot(await snapRes.json());
  }
  return { health, snapshotText };
}

if (import.meta.main) {
  try {
    const { url, swarmId, token } = parseArgv(process.argv.slice(2));
    const { health, snapshotText } = await fetchStatus(url, swarmId, token);
    console.log(`daemon: ${health.status} schemaVersion=${health.schemaVersion} protocolVersion=${health.protocolVersion}`);
    console.log(snapshotText);
  } catch (err) {
    console.error(`swarmctl status failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
