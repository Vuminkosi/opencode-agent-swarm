# M1-05 two-module fixture
.This disposable fixture models two independent workers (worker-a, worker-b).
Each module holds deterministic pure logic (no network, no inference,
stdlib only, no cross-module imports) plus objective bun:test assertions.

Run: bun test examples/two-module-fixture
.
Ownership: module-a owns workers/worker-a only; module-b owns workers/worker-b only.
