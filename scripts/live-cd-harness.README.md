# live-cd-harness — LIVE-PROBE-02 C/D live driver (HARNESS-01)

Disposable-capable harness driving the **real** coordinator + 2-worker wake
lifecycle (M3 board-service + WakeQueue + WakeDispatcher + M1-03 adapter,
pinned OpenCode **v2.2.7**) plus the **B long-window overlap** mode — with no
subagent dispatch. Source baseline: `aece2e0` (+ live evidence A PASS,
B turns 4/4, ~$0.0563 spent, per the task contract).

Owned paths (exclusive): `scripts/live-cd-harness.ts`, this README.
Prohibited: `packages/**`, `apps/**`, other `scripts/**`, tests, manifests,
`.github/**`, `.opencode/**`, secrets, canonical repos, port `:45278`.
M0–M3 sources are **imported read-only at runtime** (dynamic import in live
mode only); this slice **never modifies** them.

## Quick contract checks (this slice — zero inference)

```sh
bun scripts/live-cd-harness.ts --help        # exit 0, prints usage
bun scripts/live-cd-harness.ts --dry-run     # exit 0, plan + guard self-checks, no network/inference/sqlite
bun scripts/live-cd-harness.ts --dry-run --mode overlap   # B-mode plan
bun scripts/live-cd-harness.ts --self-test unsafe    # exit 3, synthetic unsafe-ask abort (zero inference)
bun scripts/live-cd-harness.ts --self-test ceiling   # exit 3, synthetic ceiling-breach abort (zero inference)
bun scripts/live-cd-harness.ts --self-test abort     # exit 0, abort-propagation second-gate proof (zero inference)
bun scripts/live-cd-harness.ts --self-test cost-shape # exit 0, deep-cost + ledger-order proof (zero inference)
bun scripts/live-cd-harness.ts --self-test terminal   # exit 0, exactly-one-terminal-outcome proof rows (zero inference)
bun scripts/live-cd-harness.ts --self-test sse        # exit 0, SSE zero-wire loud-gate proof rows (true blackout trips; idle-with-drops stays quiet)
```

`--dry-run` performs **zero inference**: no server contact, no sqlite open,
no canonical-module load. It validates flags (including `--server-url`,
`--db-path`, and `--root` containment), prints the exact live plan
(verified-op table + proof list), and runs local guard self-checks
(forbidden-port refusal, loopback/non-loopback handling, tmp containment,
secret redaction, overlap-interval math). This slice executes **only** these
checks — no live run, no spend.

`--self-test unsafe|ceiling` is likewise zero-inference: it replays a
synthetic hostile `permission.asked` payload (unsafe, now including the
exec/network/env/unknown-tool gap payloads that echo the disposable root)
or synthetic usage costs through the real extractor + gate (ceiling) and
exits **3** when the guard fires, proving the abort path without a server.

`--self-test abort|cost-shape|terminal` are zero-inference assertion proofs (exit
**0** on PASS, **1** on FAIL): `abort` records a synthetic SSE abort, drops
the throw (simulating a swallowed dispatch-loop throw), and proves the
`checkAborted` second gate refuses the next submit *and* the shared
subscription cancel fired; `cost-shape` proves deep-nesting cost extraction,
unknown-shape 0-with-warning, string-`"499"` abort classification, and the
ledger close-after-final-log order; terminal proves exactly-one-terminal-outcome
counting (5 msgs / 1 terminal PASS, 2 terminals FAIL, duplicate wake 0).
The same assertions also run as dry-run self-checks.

## Live run (resumption — NOT executed in HARNESS-01)

1. Start a **disposable** OpenCode 2.2.7 server bound to loopback on a free
   port. Example (run in a tmp dir, never the canonical tree):
   ```sh
   opencode serve --port <FREE> --hostname 127.0.0.1
   ```
   Never use `:45278`. The harness refuses it even if passed explicitly, and
   refuses any non-loopback host.
2. Configure provider credentials **for that disposable server only**.
3. Run with a hard budget (defaults shown; the $0.50 cap from the contract
   is the default `--max-cost-usd`):
   ```sh
   bun scripts/live-cd-harness.ts --server-url http://127.0.0.1:<FREE> --mode both \
     --max-turns 6 --timeout-ms 300000 --max-cost-usd 0.50
   ```
   Or best-effort spawn: replace `--server-url …` with `--spawn` (aborts
   clearly if the binary/flags are unavailable; manual start is preferred).

### What live mode proves

- **wake**: 1 mention → 1 wake → exactly one terminal execution outcome
  (`session.execution.succeeded/failed` count == 1 per admitted wake; raw
  `message.list` delta is informational only — a real turn emits multiple
  messages); duplicate `idempotencyKey` → `deduped:true`,
  zero new wakes, zero new turns, zero new terminal outcomes; mention-free post → no wakes,
  zero new wakes and zero new terminal outcomes;
  session/agent identity preserved end to end; lead quiet window shows
  `submitTurn` delta 0 (zero inference while waiting); worker
  `execution.succeeded` → lead wake admitted → lead back to `waiting`.
- **overlap (B)**: two bounded prompts (60–90 s local work, default 75 s,
  `--work-seconds`; stagger default 5 s, `--stagger-ms`), capturing the open
  overlap interval in ms, both `message.list` responses, and
  `session.usage.updated` tallies.

### Live model override (isolated harness ONLY — MODEL-INHERIT-01)

- Production (`packages/runtime/src/**`, daemon, plugin) **ignores**
  `SWARM_ALLOW_LIVE_INFERENCE`, `LIVE_MODEL`, and `LIVE_MODEL_APIKey`
  entirely: worker models resolve by precedence (explicit member override >
  native agent model via verified `GET /api/agent` > active session model
  via verified `GET /api/session/{id}` > host default) and the daemon holds
  only `{ providerID, id }` refs — the host resolves existing credentials at
  execution time. No key is ever copied into SQLite/JSONL/logs/outbox.
- In **this harness only**, live inference may pin an exact model:
  ```sh
  SWARM_ALLOW_LIVE_INFERENCE=1 LIVE_MODEL="<providerID>/<modelId>" LIVE_MODEL_APIKey="<key-for-the-isolated-server-only>" \
    bun scripts/live-cd-harness.ts --server-url http://127.0.0.1:<FREE> --mode wake
  ```
- Rules (fail-closed): inert unless `SWARM_ALLOW_LIVE_INFERENCE=1`;
  `LIVE_MODEL` must be exactly `providerID/modelId` (strict charset) and is
  applied via the verified `POST /api/session/{id}/model` op (history
  retained by backend); `LIVE_MODEL_APIKey` is presence-gated only — its
  value is never read into a harness string, log, ledger, DB row, or header
  (no verified 2.2.7 key passthrough exists; the key stays in the disposable
  server's own environment). Any missing/malformed combo aborts (exit 3)
  before any spend — never a silent ambient-model fallback. `--dry-run`
  proves the gate/parse/fail-closed shape with zero inference
  (`live-model override gate + exact-ref + fail-closed` self-check).

### Verified-ops discipline

All OpenCode calls flow through the canonical adapter (`sessions.ts`,
`events.ts`, `harness.ts`) and use **only** the verified 2.2.7 surface:
`session.create/get`, `session.prompt` (**queue-only** — `steer` is rejected
by the adapter), `session.interrupt`, inbox/message/context reads,
`agent.list`, `event.subscribe`, `experimental.session.wait`. Server
liveness is confirmed via `agent.list`, never an unverified endpoint.
`externalId` is adapter-internal: in-band prompt `metadata` + text header,
never an API argument.

### Budget + abort policy (fail-closed)

- `--max-turns` (default 6): every `submitTurn` is counted; exceeding aborts.
- `--timeout-ms` (default 300000): single `AbortSignal.timeout` governs all
  waits/subscriptions; sleeps (spawn boot, stagger, quiet window) are bounded
  by it and resolve early on abort.
- `--max-cost-usd` (default 0.50): **enforced, not advisory**. Cost is
  deep-scanned (depth ≤ 4, cycle-safe, plus a case-insensitive
  `cost_usd`/`total_cost` fallback) from every `session.usage.updated`
  payload and tallied after each event; the ceiling is re-checked before
  every `submitTurn`. A breach aborts (exit 3) **before** any further
  submit — the run can never spend past the cap. Any **402** aborts
  immediately with **zero retries** (the dispatcher already maps 402 to
  quota-blocked/permanent); 401/403 and 429 abort without burning budget.
- **Cost-model assumption (documented residual, SEC-F1/SEC-F5):** live cost
  figures come from the 2.2.7 `session.usage.updated` stream for the
  contributor model in use (Muse-class contributor via the pinned 2.2.7
  adapter); no independent rate table is bundled, so the tally is in the
  backend's reported units against `--max-cost-usd`. Two structural lags are
  accepted and bounded: (a) SSE delivery delay — at most ~1 extra turn can be
  admitted before a usage event lands, bounded by `--max-turns` (default 6);
  (b) in-flight non-cancellability — `submitTurn` is queue-admission with no
  signal parameter in 2.2.7, so an in-flight admission cannot be recalled;
  the pre-submit gate is the enforcement point and the 402 zero-retry gate is
  the quota backstop. Payloads with no recognizable cost keys tally **0**
  and warn per-event (`unknown shape`); they never inflate the tally and
  never mask a breach — a 0 tally with nonzero `usage-events` is visible in
  the final summary (`unknown-cost-shapes=`) and the overlap proof detail.
- **Unsafe abort**: a `permission.asked` event is fail-closed classified —
  read-only tools pass to the path check, root-confined write tools pass
  only when every path token sits inside the disposable root, and
  exec/shell/network/env/secret/unknown tools, `process.env`/key-material
  markers, `..` escapes, and `~` homes are unsafe **even when the payload
  echoes the disposable root**. A firing guard interrupts the session via
  `OpenCodeHarness.interrupt` and aborts the run **synchronously** (exit 3).
  The throw is recorded in shared abort state, the SSE subscriptions are
  cancelled, and every later `submitTurn`/`getSession` re-polls that state
  first (second gate) — a swallowed dispatch-loop throw still refuses spend.
  The disposable server should additionally run in require-approval mode so
  unapproved tools never execute server-side; the harness gate is the
  fail-closed backstop, not the only control.
- Transport-abort shapes (`499` numeric or `"499"`, `WAIT_ABORTED`,
  `AbortError`/`TimeoutError`, global-deadline expiry) are aborts (exit 3),
  never proof failures.
- Exit codes: `0` all proofs PASS · `1` FAIL · `2` usage error (unknown flags
  included; repeat flags resolve first-wins) · `3`
  budget/quota/auth/unsafe/timeout/499/WAIT_ABORTED abort (safe to rerun; tmp
  state only). A `--spawn`ed disposable server is killed in the `finally`
  block, with a `taskkill /F /T` force-kill fallback when `kill()` leaves it
  alive (logged as `force-kill fallback attempted`).

## Redaction + containment notes

- Every log/ledger line passes through `redact()`: URL userinfo, `sk-*`,
  `sk-ant-*`, AWS `AKIA*`, PEM private-key blocks, JWT-shaped tokens,
  `gh*_`, `xox*`, `Bearer` tokens, `api-key`/`authorization` and generic
  `token|secret|password` assignments → `<redacted>`. Redaction is enforced
  at the ledger sink too, so a direct `ledger.write` can never leak a secret.
  Session ids are elided to `<id>` in console lines; full ids live only in
  the disposable ledger annex. `proofs.json` and `agents-annex.json` are
  redacted **before** writing (SEC-F3) — proof details may echo model text.
- Ledger lifecycle (F01): the ledger is closed **only after** the final
  summary line, on every exit path, via `closeLedgerAfterFinalLog` (the
  single `close()` site). Abort/failure paths log their abort line first,
  then close; the success path writes redacted `proofs.json`, logs the
  `done:` summary, then closes. No write-after-close is possible and the
  final line is never lost (previously it could mask a PASS).
- All writes (repo dir, `swarm.db`, `harness-ledger.jsonl`, `proofs.json`,
  `agents-annex.json`) stay under
  `%TEMP%/opencode/live-cd-harness/run-<ts>-<pid>/` (overridable with
  `--root`, still tmp-enforced and validated in `--dry-run` as well as live).
  Canonical trees are refused by shape
  (`packages/`, `apps/`, `opencode-agent-swarm`). Every artifact path is
  asserted inside the disposable root immediately before write.
- Loopback policy: `127.0.0.1` or `localhost` only; an explicit `::1`
  literal is refused (use `127.0.0.1`). TOCTOU note: the hostname is
  validated at parse time but resolved at connect time, so hostile-DNS
  environments must pass the `127.0.0.1` literal; the free-port probe always
  binds `127.0.0.1` explicitly.
- Unsafe-scope classification is fail-closed layered: read-only tools pass
  to the path check; root-confined write tools pass only when every
  path-like token sits inside the disposable root; exec/shell/network/env/
  secret/unknown tools, `process.env`/key-material markers, `..` escapes,
  and `~` homes are unsafe even when the payload echoes the root; with no
  path token, the root/repo substring fallback applies (absence of both is
  unsafe). The disposable server should additionally run in
  require-approval mode; the harness gate is the backstop, not the only
  control.
- Deadline forwarding (SEC-F4): the global `AbortSignal.timeout` governs
  `experimental.session.wait` and (via a linked controller) all
  `event.subscribe` streams; sleeps (spawn boot, stagger, quiet window)
  resolve early on abort. `submitTurn` is queue-admission with no signal
  parameter in 2.2.7, so it cannot take the deadline — the pre-submit
  abort/cost/turn gates are the enforcement point instead.

## Typecheck (this slice)

Standalone, hermetic (canonical modules load only via dynamic import at
live runtime, so static `tsc` never resolves them):

```sh
bunx tsc --noEmit --strict --skipLibCheck --target es2022 --lib es2022,dom \
  --module esnext --moduleResolution bundler scripts/live-cd-harness.ts
```

The file is intentionally Bun-native (no `node:` imports) with two
module-local runtime ambients (`Bun`, `process`), so this standalone check
is hermetic: zero new dependencies, canonical modules load only via dynamic
`import()` at live runtime and are never statically resolved.

## Known limitations (HARNESS-01 slice)

- Live mode is **implemented, NOT VERIFIED** here: no disposable server was
  started, no inference executed, no spend incurred in this slice.
- `SwarmStore.listWakes` (canonical accessor) backs the unrelated-post
  store cross-check, filtered by member across the pending/admitted/
  observed_running/dispatched states; when the accessor is absent the proof
  records `via=fallback-wakeIds` in `proofs.json` instead of passing
  silently, so a missing accessor is visible in live evidence.
- Usage/cost fields depend on what the 2.2.7 `session.usage.updated`
  payload exposes; the harness deep-scans each event, warns on unknown
  shapes (tally 0, never inflated), and aborts on 402 regardless — see the
  cost-model assumption above. SEC-F5 (broader rate-table/metering work) is
  explicitly deferred: documented here, not implemented in this slice.
- `--spawn` uses best-effort `opencode serve` flags; manual disposable-server
  start is the primary documented path until the live slice pins them.
