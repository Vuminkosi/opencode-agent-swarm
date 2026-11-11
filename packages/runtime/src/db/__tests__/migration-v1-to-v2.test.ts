/**
 * M1-01 R1 remediation proof: a file DB seeded at v1 (001 only) holding
 * pre-002 NULL-era duplicate wake intents must migrate to v2 cleanly —
 * ADD COLUMN -> JS backfill -> deterministic keep-earliest cleanup ->
 * UNIQUE index — with version 2 recorded and repeatable reopens.
 *
 * The old 002 layout (index before backfill) ROLLBACKed on NULL-era
 * duplicates, never recorded version 2, and failed every reopen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SwarmStore, computeDeliveryKey } from "../store.js";

const created: string[] = [];
const stores: SwarmStore[] = [];

function dbPath(tag: string): string {
  const p = join(tmpdir(), `swarm-m101-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  created.push(p);
  return p;
}

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const p of created.splice(0)) {
    try {
      unlinkSync(p);
      unlinkSync(`${p}-wal`);
      unlinkSync(`${p}-shm`);
      unlinkSync(`${p}-journal`);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function migrationSql(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
    "utf8",
  );
}

/**
 * Seed a v1-only DB: apply 001, record version 1, insert a swarm + member
 * + TWO duplicate wake intents (same member/generation/reason, NULL
 * post_sequence/task_id, same payload_hash). Legal under 001 because
 * SQLite treats NULLs as distinct in the composite UNIQUE.
 */
function seedV1WithDuplicates(path: string): { swarmId: string; memberId: string } {
  const db = new Database(path, { create: true });
  db.exec(migrationSql("001_initial.sql"));
  db.exec("PRAGMA foreign_keys = ON;");
  const now1 = "2026-01-01T00:00:00.000Z";
  const now2 = "2026-01-02T00:00:00.000Z";
  db.query<[], [number, string]>(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(1, now1);
  db.query<[], [string, string, string, string, string, string, string, string]>(
    `INSERT INTO swarms (id, title, coordinator_session_id, project_root, mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("sw1", "seed", "ses-c", "C:/repo", "parity", "planning", now1, now1);
  db.query<[], [string, string, string, string, string, string, string, string, string, string, string]>(
    `INSERT INTO members (id, swarm_id, name, role, native_agent_id, session_id,
       model_provider_id, model_id, public_state, internal_state, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("m1", "sw1", "w1", "coder", "build", "s1", "p", "m", "working", "working", now1);
  const wake =
    `INSERT INTO wake_intents (id, swarm_id, member_id, member_generation, reason,
       post_sequence, task_id, payload_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.query<[], [string, string, string, number, string, null, null, string, string, number, string, string]>(wake).run(
    "w-early", "sw1", "m1", 1, "assigned_task", null, null, "task-body-hash", "queued", 0, now1, now1,
  );
  db.query<[], [string, string, string, number, string, null, null, string, string, number, string, string]>(wake).run(
    "w-late", "sw1", "m1", 1, "assigned_task", null, null, "task-body-hash", "queued", 0, now2, now2,
  );
  db.close();
  return { swarmId: "sw1", memberId: "m1" };
}

function tableInfo(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((c) => c.name);
}

describe("v1 (NULL-era duplicates) -> v2 migration", () => {
  test("migrates cleanly: earliest kept, keys backfilled, index + version recorded", () => {
    const path = dbPath("v1v2");
    const { memberId } = seedV1WithDuplicates(path);

    const store = new SwarmStore(path);
    stores.push(store);

    // Version 2 recorded; nothing pending.
    expect(store.runMigrations()).toEqual([]);

    // Deterministic keep-earliest: w-early survives, w-late removed.
    const wakes = store.listWakes("sw1", "queued");
    expect(wakes.map((w) => w.id)).toEqual(["w-early"]);
    const survivor = wakes[0];
    if (survivor === undefined) throw new Error("expected survivor");

    // Backfilled key matches the store's canonical computation.
    const expected = computeDeliveryKey({
      memberId,
      memberGeneration: 1,
      reason: "assigned_task",
      postSequence: null,
      taskId: null,
      payloadHash: "task-body-hash",
    });
    const raw = new Database(path, { readwrite: true });
    const row = raw
      .query<{ delivery_key: string | null }, [string]>("SELECT delivery_key FROM wake_intents WHERE id = ?")
      .get("w-early");
    raw.close();
    expect(row?.delivery_key).toBe(expected);

    // UNIQUE index exists.
    const probe = new Database(path, { readwrite: true });
    const idx = probe
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_wake_delivery_key'",
      )
      .all();
    probe.close();
    expect(idx).toHaveLength(1);
    void survivor;
  });

  test("migration is repeatable across close/reopen", () => {
    const path = dbPath("v1v2-reopen");
    seedV1WithDuplicates(path);
    const first = new SwarmStore(path);
    stores.push(first);
    expect(first.runMigrations()).toEqual([]);
    first.close();
    stores.splice(0);

    const second = new SwarmStore(path);
    stores.push(second);
    expect(second.runMigrations()).toEqual([]);
    expect(second.listWakes("sw1", "queued").map((w) => w.id)).toEqual(["w-early"]);
    expect(second.getSwarm("sw1").id).toBe("sw1");
  });

  test("fresh DB gets the v2 column + index with no data loss", () => {
    const path = dbPath("fresh-v2");
    const store = new SwarmStore(path);
    stores.push(store);
    const probe = new Database(path, { readwrite: true });
    try {
      expect(tableInfo(probe, "wake_intents")).toContain("delivery_key");
      const idx = probe
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_wake_delivery_key'",
        )
        .all();
      expect(idx).toHaveLength(1);
    } finally {
      probe.close();
    }
  });

  test("post-migration duplicate delivery_key dedupes instead of throwing", () => {
    const path = dbPath("v1v2-dedupe");
    seedV1WithDuplicates(path);
    const store = new SwarmStore(path);
    stores.push(store);
    const res = store.createWakeIntent("sw1", {
      memberId: "m1",
      memberGeneration: 1,
      reason: "assigned_task",
      payloadHash: "task-body-hash",
    });
    expect(res.deduped).toBe(true);
    expect(res.intent.id).toBe("w-early");
  });

  test("distinct payload after migration stays distinct", () => {
    const path = dbPath("v1v2-distinct");
    seedV1WithDuplicates(path);
    const store = new SwarmStore(path);
    stores.push(store);
    const res = store.createWakeIntent("sw1", {
      memberId: "m1",
      memberGeneration: 1,
      reason: "assigned_task",
      payloadHash: "other-task-hash",
    });
    expect(res.deduped).toBe(false);
    expect(store.listWakes("sw1", "queued")).toHaveLength(2);
  });
});
