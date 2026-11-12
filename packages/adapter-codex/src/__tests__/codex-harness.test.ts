/**
 * M7-02 contract tests — fail-closed stub + no OpenCode default regression.
 *
 * Run (from packages/adapter-codex): `bun src/__tests__/codex-harness.test.ts`
 * or `bun test src/__tests__/codex-harness.test.ts`.
 * Zero new dependencies: no test-framework or node: imports (same convention
 * as packages/adapter-opencode/src/__tests__/bridge.test.ts). Failures throw
 * (nonzero exit); every row below is deterministic and network-free.
 *
 * Rows:
 *  F1 fail-closed: every CodingHarness method rejects with
 *     CodexNotImplementedError carrying code CODEX_NOT_IMPLEMENTED.
 *  F2 zero fake turns: a failed submitTurn yields no receipt object and no
 *     transport side effect is observable (no child process, no network —
 *     the stub holds no transport reference at all).
 *  R1 no OpenCode default regression: this package's discriminator is
 *     exactly "codex" (never "opencode"), and it exports no OpenCodeHarness /
 *     default-harness symbol that could shadow the OpenCode default.
 */

import { CodexHarness, CodexNotImplementedError, CODEX_NOT_IMPLEMENTED } from "../codex-harness.js";
import * as stubModule from "../codex-harness.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function assertFailsClosed(label: string, fn: () => Promise<unknown>): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert(err instanceof CodexNotImplementedError, `${label} must reject with CodexNotImplementedError`);
  assert(
    (err as CodexNotImplementedError).code === CODEX_NOT_IMPLEMENTED,
    `${label} error code must be ${CODEX_NOT_IMPLEMENTED}`,
  );
  assert(
    typeof (err as CodexNotImplementedError).missing === "string" &&
      (err as CodexNotImplementedError).missing.length > 0,
    `${label} error must name the missing capability`,
  );
}

// F1: every method fails closed (constructing performs no I/O — if the
// constructor threw or spawned anything, this line would fail first).
const harness = new CodexHarness();
const aborter = new AbortController();

await assertFailsClosed("createSession", () => harness.createSession("t", "C:\\tmp"));
await assertFailsClosed("getSession", () => harness.getSession("sess-1"));
await assertFailsClosed("switchAgent", () => harness.switchAgent("sess-1", "agent-1"));
await assertFailsClosed("switchModel", () =>
  harness.switchModel("sess-1", { providerID: "openai", id: "gpt-5" }),
);
await assertFailsClosed("submitTurn", () =>
  harness.submitTurn({
    sessionId: "sess-1",
    text: "hello",
    delivery: "queue",
    externalId: "wake-1",
    reason: "mention",
  }),
);
await assertFailsClosed("interrupt", () => harness.interrupt("sess-1"));
await assertFailsClosed("wait", () => harness.wait("sess-1", aborter.signal));
await assertFailsClosed("applyPermissionRules", () =>
  harness.applyPermissionRules("sess-1", [{ scope: "sess-1", action: "deny" }]),
);
await assertFailsClosed("listAgents", () => harness.listAgents());

// F2: zero fake turns — failed submitTurn produces no receipt and the stub
// holds no transport/process handle to observe.
let receipt: unknown;
try {
  receipt = await harness.submitTurn({
    sessionId: "sess-1",
    text: "hello",
    delivery: "queue",
    externalId: "wake-1",
    reason: "mention",
  });
} catch {
  receipt = undefined;
}
assert(receipt === undefined, "failed submitTurn must yield no admission receipt");
assert(
  !("transport" in harness) && !("proc" in harness) && !("fetchImpl" in harness),
  "stub must hold no transport/process/fetch handle",
);

// R1: no OpenCode default regression — discriminator is "codex" only, and no
// default/opencode symbol leaks from this package.
assert(harness.backend === "codex", 'backend discriminator must be exactly "codex"');
assert(
  !("OpenCodeHarness" in stubModule) &&
    !("default" in stubModule) &&
    !("backend" in stubModule && (stubModule as Record<string, unknown>).backend === "opencode"),
  "adapter-codex must export no OpenCode/default-harness symbol",
);

console.log("M7-02 codex-harness contract tests: PASS (9 fail-closed rows + zero-fake-turn + default-regression)");
