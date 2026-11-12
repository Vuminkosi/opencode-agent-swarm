/**
 * M8-01 data-integrity S2s (Phase 4 findings F-A / F-B / F-C).
 *
 * - F-A store.ts fencing reuse: member-turn fencing tokens must be strictly
 *   monotonic per member across release/re-acquire cycles AND restarts
 *   (durable high-water; `getWakeLeaseInfo` stays null-after-release).
 * - F-B store.ts quarantine TTL: an expired quarantine marker must NEVER
 *   auto-admit the wake; it waits in the operator re-review queue until an
 *   operator clears (dispatchable) or cancels (terminal) it.
 * - F-C ingest.ts global dedupe keys: identical (source, external_event_id)
 *   in two swarms must NOT dedupe each other; same-swarm replays still do.
 *
 * Tmp DBs only. No network, no model inference, no paid calls.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmStore, WAKE_QUARANTINE_TTL_MS } from "../../packages/runtime/src/db/store.js";
import { EventIngest } from "../../packages/runtime/src/services/ingest.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function tmpDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}

function makeSwarm(store: SwarmStore, title: string): string {
  return store.createSwarm({
    title,
    coordinatorSessionId: "sess-lead",
    projectRoot: "/tmp/m8fi",
    mode: "parity",
  }).id;
}

function addMember(store: SwarmStore, swarmId: string, name: string, sessionId: string): string {
  return store.addMember(swarmId, {
    name,
    role: "coder",
    nativeAgentId: "fake-agent",
    sessionId,
    model: { providerID: "fake", id: "fake-model" },
  }).id;
}

function enqueueWake(store: SwarmStore, swarmId: string, memberId: string, n: number): string {
  return store.createWakeIntent(swarmId, {
    memberId,
    memberGeneration: 1,
    reason: "mention",
    postSequence: 100 + n,
    payloadHash: `m8-fb-ph-${n}`,
  }).intent.id;
}

describe("F-A: fencing tokens strictly monotonic across release/re-acquire + restart", () => {
  test("no token reuse across release/re-acquire and restart (null-after-release preserved)", () => {
    const dbPath = tmpDbPath("m8-fa-");
    const store = new SwarmStore(dbPath);
    try {
      const swarmId = makeSwarm(store, "m8-f-a");
      const memberId = addMember(store, swarmId, "coder-a", "sess-a");

      // Cycle 1: claim -> complete (releases the member-turn lease).
      const w1 = enqueueWake(store, swarmId, memberId, 1);
      const claim1 = store.claimWakeForDispatch(w1);
      expect(claim1.status).toBe("admitted");
      if (claim1.status !== "admitted") throw new Error("cycle 1 not admitted");
      const t1 = claim1.fencingToken;
      expect(store.getWakeLeaseInfo(memberId)?.fencingToken).toBe(t1);
      store.completeWake(w1, "succeeded", t1);
      expect(store.getWakeLeaseInfo(memberId)).toBeNull();

      // Cycle 2: next acquire must strictly exceed — never repeat t1.
      const w2 = enqueueWake(store, swarmId, memberId, 2);
      const claim2 = store.claimWakeForDispatch(w2);
      expect(claim2.status).toBe("admitted");
      if (claim2.status !== "admitted") throw new Error("cycle 2 not admitted");
      const t2 = claim2.fencingToken;
      expect(t2).toBe(t1 + 1);

      // Cycle 3: transient failure releases the lease; the next acquire
      // must still exceed every previously issued token.
      const w3 = enqueueWake(store, swarmId, memberId, 3);
      // w2 still holds the live turn: w3 defers behind it — complete w2 first.
      store.completeWake(w2, "succeeded", t2);
      const claim3 = store.claimWakeForDispatch(w3);
      expect(claim3.status).toBe("admitted");
      if (claim3.status !== "admitted") throw new Error("cycle 3 not admitted");
      const t3 = claim3.fencingToken;
      expect(t3).toBeGreaterThan(t2);
      store.failWakeTransient(w3, { fencingToken: t3 });
      expect(store.getWakeLeaseInfo(memberId)).toBeNull();
      // w3 stays admitted (retry scheduled): close it terminally so the
      // member turn is free for the next acquire cycle.
      store.completeWake(w3, "failed");

      const w4 = enqueueWake(store, swarmId, memberId, 4);
      const claim4 = store.claimWakeForDispatch(w4);
      expect(claim4.status).toBe("admitted");
      if (claim4.status !== "admitted") throw new Error("cycle 4 not admitted");
      const t4 = claim4.fencingToken;
      expect(t4).toBeGreaterThan(t3);
      store.completeWake(w4, "succeeded", t4);

      // Restart: the high-water is durable, so post-reopen tokens keep rising.
      store.close();
      const reopened = new SwarmStore(dbPath);
      try {
        const w5 = enqueueWake(reopened, swarmId, memberId, 5);
        const claim5 = reopened.claimWakeForDispatch(w5);
        expect(claim5.status).toBe("admitted");
        if (claim5.status !== "admitted") throw new Error("cycle 5 not admitted");
        expect(claim5.fencingToken).toBeGreaterThan(t4);
        expect(reopened.getWakeLeaseInfo(memberId)).not.toBeNull();
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        /* already closed for the restart leg */
      }
    }
  });
});

describe("F-B: expired quarantine never auto-admits; waits in re-review queue", () => {
  test("old quarantine -> eligible for re-review, never auto-admitted", () => {
    const dbPath = tmpDbPath("m8-fb-");
    const store = new SwarmStore(dbPath);
    try {
      const swarmId = makeSwarm(store, "m8-f-b");
      const memberId = addMember(store, swarmId, "coder-a", "sess-a");
      const wakeId = enqueueWake(store, swarmId, memberId, 1);

      store.quarantineWake(wakeId, "m8-fb-probe");
      expect(store.isWakeQuarantined(wakeId)).toBe(true);
      expect(store.isWakeQuarantineReviewDue(wakeId)).toBe(false);

      // Live marker shows up in the review queue but is not yet due.
      const liveQueue = store.listWakesNeedingQuarantineReview(swarmId);
      const liveEntry = liveQueue.find((e) => e.wakeId === wakeId);
      expect(liveEntry).toBeDefined();
      expect(liveEntry?.reviewDue).toBe(false);

      // Travel past the TTL: the marker is expired but the wake must NOT
      // become dispatchable again on its own.
      const past = new Date(Date.now() + WAKE_QUARANTINE_TTL_MS + 3_600_000).toISOString();
      expect(store.isWakeQuarantined(wakeId, past)).toBe(false);
      expect(store.isWakeQuarantineReviewDue(wakeId, past)).toBe(true);

      const claim = store.claimWakeForDispatch(wakeId, { nowIso: past });
      expect(claim.status).toBe("deferred-quarantined");
      expect(store.getWake(wakeId).state).toBe("queued");

      const eligible = store
        .listEligibleQueuedWakes(swarmId, 100, { nowMs: Date.parse(past) })
        .map((w) => w.id);
      expect(eligible).not.toContain(wakeId);

      // The expired marker is listed for operator re-review with its age.
      const review = store.listWakesNeedingQuarantineReview(swarmId, past);
      const entry = review.find((e) => e.wakeId === wakeId);
      expect(entry).toBeDefined();
      expect(entry?.reviewDue).toBe(true);
      expect(entry?.memberId).toBe(memberId);
      expect(entry?.wakeState).toBe("queued");
      expect(entry?.quarantinedForMs).toBeGreaterThanOrEqual(WAKE_QUARANTINE_TTL_MS);

      // Operator review clears the marker -> the SAME wake is dispatchable.
      store.clearWakeQuarantine(wakeId);
      expect(store.isWakeQuarantineReviewDue(wakeId, past)).toBe(false);
      expect(store.listWakesNeedingQuarantineReview(swarmId, past).find((e) => e.wakeId === wakeId)).toBeUndefined();
      const readmit = store.claimWakeForDispatch(wakeId, { nowIso: past });
      expect(readmit.status).toBe("admitted");
    } finally {
      store.close();
    }
  });
});

describe("F-C: inbox dedupe keys are scoped per swarm", () => {
  test("two swarms with identical external ids do not dedupe each other", () => {
    const dbPath = tmpDbPath("m8-fc-");
    const store = new SwarmStore(dbPath);
    try {
      const swarmA = makeSwarm(store, "m8-f-c-a");
      const swarmB = makeSwarm(store, "m8-f-c-b");
      const ingest = new EventIngest(dbPath);
      try {
        // Migration 004 applied on open; scoped table exists.
        const raw = new Database(dbPath, { readonly: true });
        try {
          const tables = raw
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((r) => r.name);
          expect(tables).toContain("inbox_dedupe_scoped");
          const versions = raw
            .query<{ version: number }, []>("SELECT version FROM schema_migrations")
            .all()
            .map((r) => r.version);
          expect(versions).toContain(4);
        } finally {
          raw.close();
        }

        // Same (source, id) in two swarms: both admitted, neither deduped.
        expect(ingest.record(swarmA, { source: "opencode", externalEventId: "evt-same" }).deduped).toBe(false);
        expect(ingest.record(swarmB, { source: "opencode", externalEventId: "evt-same" }).deduped).toBe(false);

        // Same-swarm replay still dedupes, in both swarms independently.
        expect(ingest.record(swarmA, { source: "opencode", externalEventId: "evt-same" }).deduped).toBe(true);
        expect(ingest.record(swarmB, { source: "opencode", externalEventId: "evt-same" }).deduped).toBe(true);

        // Source remains part of the key; unrelated ids are admitted.
        expect(ingest.record(swarmA, { source: "other", externalEventId: "evt-same" }).deduped).toBe(false);
        expect(ingest.record(swarmA, { source: "opencode", externalEventId: "evt-other" }).deduped).toBe(false);

        // Legacy pre-004 global rows (no swarm attribution) are still
        // honored conservatively as duplicates.
        const writer = new Database(dbPath);
        try {
          writer.exec(
            "INSERT INTO inbox_dedupe (source, external_event_id, received_at) " +
              "VALUES ('legacy-src', 'legacy-1', '2026-01-01T00:00:00.000Z')",
          );
        } finally {
          writer.close();
        }
        expect(ingest.record(swarmA, { source: "legacy-src", externalEventId: "legacy-1" }).deduped).toBe(true);
      } finally {
        ingest.close();
      }
    } finally {
      store.close();
    }
  });
});
