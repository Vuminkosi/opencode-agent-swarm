# Publishing to GitHub Packages (npm registry)

How versioned packages are built, verified, and published to the GitHub
Packages npm registry (`https://npm.pkg.github.com`). Pipeline definition:
`.github/workflows/publish.yml` (inline comments are the normative reference).

## What the workflow does

1. **Trigger** — a GitHub Release marked `published`, or a manual
   `workflow_dispatch` run (Actions tab → `publish` → Run workflow).
2. **Verify job** (`ubuntu-24.04`, Bun `1.4.4`, Node `24`):
   - `bun install --frozen-lockfile`
   - `tsc --noEmit` for all four package tsconfigs
     (`packages/protocol`, `packages/runtime`, `packages/adapter-opencode`,
     `packages/plugin`).
   - Scoped `bun test` suite (same list as FINAL-POSTCOMMIT-01, no live
     inference): plugin bootstrap, protocol + runtime DB tests, daemon,
     config, adapter bridge (Tier-A), swarm-service, `/swarm` command tests,
     the two-module fixture, and `tests/e2e/`.
3. **Publish job** (runs only if verify passes) — for each of
   `packages/protocol`, `packages/runtime`, `packages/verification`,
   `packages/adapter-opencode`, `packages/plugin`, `packages/board-terminal`,
   `packages/git-workspaces`, plus `apps/swarmctl`: packages with
   `"private": true` are **skipped**; every other package is published with
   `npm publish --provenance`. Any publish failure fails the job
   (exit code propagates; no failure-swallowing fallbacks).

## Current state: all seven workspaces are public and publishable

All seven `packages/*` workspaces are public (no `"private": true`), scoped
`@vuminkosi`, with registry + provenance `publishConfig` and `files: ["src"]`.
To release a package, bump `version` in its `package.json`,
then cut a release below. `apps/swarmctl` is scope-renamed to
`@vuminkosi/swarmctl` but remains `private: true` and is skipped by the publish loop.

## Versioning

Manual version bumps per package (`version` field in each `package.json`;
workspace dependents still use `workspace:*`, which npm rewrites on
publish). No changesets tooling is installed. If release cadence grows,
adopt `changesets` (`.changeset/` + `changeset version` before tagging) —
out of scope for this task.

## How to cut a release

1. Confirm each workspace version in its `package.json` (bump only if
   releasing a new version; workspace dependents still use `workspace:*`,
   which npm rewrites on publish).
2. Commit on the active branch through the normal review/commit lane.
3. Tag the release version (e.g. `git tag v0.2.0`) and push the tag, or use
   GitHub → Releases → Draft a new release → Publish release.
4. The `publish` workflow runs; check the Actions log for `publish <dir>`
   vs `skip <dir>` lines and the provenance attestation step.
5. Consumers install with an `.npmrc` pointing the scope at GitHub Packages:
   `@vuminkosi:registry=https://npm.pkg.github.com`.

## Required repository settings

- **Workflow permissions:** the workflow declares `contents: read` globally;
  the publish job adds `packages: write` (registry upload) and
  `id-token: write` (npm `--provenance` Sigstore/OIDC attestation). Do not
  downgrade these or publishing fails. `GITHUB_TOKEN` is supplied by GitHub —
  no personal access token is stored anywhere.
- **Secret handling:** authentication uses `NODE_AUTH_TOKEN=${{
  secrets.GITHUB_TOKEN }}` as a job-level environment variable only, and the
  registry config references it literally (`${NODE_AUTH_TOKEN}` in
  `$HOME/.npmrc`), so the secret is never written to disk, never echoed, and
  never appears in logs. Do not add `set -x` / `env` dumps to this workflow.
- **Scope/owner alignment:** package scope `@vuminkosi` matches the
  repository owner (`Vuminkosi/opencode-agent-swarm`, verified via
  `git remote -v` on PUBLISH-READY-01; npm scopes are lowercase). Do not
  ship a release under a different scope — GitHub Packages links scoped
  packages to the owning account.
- **Visibility:** scoped packages publish as restricted (private) by default;
  pass `--access public` (or change package visibility in its GitHub Packages
  settings) only as a deliberate decision.
- **Provenance caveat:** [DESIGN: `--provenance` is required by DEVOPS-PUBLISH-01
  AC(3). If the GitHub Packages npm registry ever rejects the attestation,
  remove the flag and re-run; the verify job still gates every publish.]

## Compatibility

`ubuntu-24.04` runners, Bun `1.4.4` (`oven-sh/setup-bun@v2`), Node `24`
(`actions/setup-node@v6`) for npm compatibility, TypeScript `5.9.2` strict.
Action major versions are pinned (`checkout@v5`, `setup-bun@v2`,
`setup-node@v6`); refresh them via Dependabot or a docs/platform follow-up.

## Publishing to npmjs.org (public npm registry)

A second lane, `.github/workflows/publish-npmjs.yml`, mirrors `publish.yml`
(same triggers, same pins, same verify steps) but publishes to the default
public registry (`https://registry.npmjs.org`) instead of GitHub Packages.
Use it when the packages should be installable without a GitHub-Packages
`.npmrc` entry. GitHub Packages publishing (`publish.yml`) is unchanged and
keeps working independently.

### Scope-ownership prerequisite

Packages are scoped `@vuminkosi/*`. Before the first real publish, the
publisher's npm account must own the `@vuminkosi` scope (create it at
npmjs.com if needed). Scope availability was checked unauthenticated via
`npm view @vuminkosi/protocol version` and
`npm view @vuminkosi/runtime version` against the default registry
(404 = free) before the workflow was written. Re-check before the first
publish: if `npm view` returns a version instead of 404, STOP — the scope is
taken and nothing may publish under it.

### Trusted publisher setup (one time per package — REQUIRED BEFORE the workflow can succeed)

> Ordering prerequisite: the trusted publisher MUST be registered on
> npmjs.com for EACH package BEFORE the `publish-npmjs` workflow can
> succeed for that package. Without a registered publisher npm never
> receives an OIDC credential and every publish attempt for that package
> fails with `ENEEDAUTH` (`need auth — run npm adduser`, plus the
> "2FA-bypass" notice) or `403`; packages that do have a publisher still
> publish in the same run. Register first, then run the workflow — not
> the reverse (for packages that do not exist yet, bootstrap below,
> attach the publisher, then re-run the workflow).

This lane authenticates with npm **trusted publishing (OIDC)** — the
publish job's `id-token: write` permission is the sole credential and the
workflow holds no tokens or Actions secrets. Register this repo + workflow
as a trusted publisher on **each** package before the first publish:

1. Sign in at npmjs.com → open the package page → **Settings** → **Trusted
   Publisher** → **Manage Trusted Publishers**.
2. Add a GitHub Actions trusted publisher with organization/user
   `vuminkosi`, repository `opencode-agent-swarm`, and workflow file name
   `publish-npmjs.yml` (no environment restriction needed).
3. Repeat for every package the loop publishes
   (`@vuminkosi/protocol`, `@vuminkosi/runtime`, `@vuminkosi/verification`,
   `@vuminkosi/adapter-opencode`, `@vuminkosi/plugin`,
   `@vuminkosi/board-terminal`, `@vuminkosi/git-workspaces`). A package
   without a registered trusted publisher fails at publish time while the
   others still publish; attach the publisher and re-run.
4. No repository Actions secret is required for this lane, and none is
   referenced by the workflow. The GitHub Packages token stays only in
   `publish.yml` and is never used by this lane.

### One-time bootstrap if a package does not exist yet

Trusted publishers can only be attached to an existing package. If a
package has never been published to npmjs.org:

1. From a maintainer machine, `npm login` to an npm account that owns (or
   may create) the `@vuminkosi` scope.
2. `cd` into the package directory and run `npm publish --registry
   https://registry.npmjs.org` (add `--access public` for the first
   publish of a scoped package if it should be public).
3. Attach this repo + workflow as a trusted publisher on the new package
   page (see above) — all later publishes come from the workflow.
4. Re-run the `publish-npmjs` workflow (or cut the release again) so the
   registry copy is produced by CI with provenance.

### How to trigger

Same as the GitHub Packages lane: publish a GitHub Release (Release
`published` event), or run it manually (Actions tab → `publish-npmjs` →
Run workflow). There is deliberately **no `push` trigger**. The `verify`
job (frozen install, `tsc --noEmit` x4, scoped `bun test` suite) gates the
`publish` job; the publish job runs only if verify passes.

### How to verify

1. Check the Actions log for `publish <dir>` vs `skip <dir>` lines
   (packages with `"private": true` are skipped with a logged reason).
2. Confirm the provenance attestation step ran (`--provenance`).
3. Confirm the target registry in the log is `https://registry.npmjs.org`
   (the per-command `--registry` flag overrides the GPR
   `publishConfig.registry` in manifests; manifests are not edited).
4. Install from the public registry with no special `.npmrc`:
   `npm view @vuminkosi/protocol version` should now return the version.
   Consumers need **no `.npmrc` entry** for the default registry — plain
   `npm install @vuminkosi/<pkg>` resolves via `https://registry.npmjs.org`.
   Scope-mapping conflict note: if a consumer's global (or project) `.npmrc`
   maps the whole scope elsewhere (e.g.
   `@vuminkosi:registry=https://npm.pkg.github.com` left over from the
   GitHub Packages lane), that line **shadows** npmjs.org for every
   `@vuminkosi/*` install — remove it or override it with
   `@vuminkosi:registry=https://registry.npmjs.org` when consuming from
   npmjs.org.
5. GitHub Packages publishing is unchanged: `publish.yml` still publishes
   the same package set to `https://npm.pkg.github.com` on its own trigger.
6. Provenance fallback: if the npmjs.org registry ever rejects the
   `--provenance` attestation, remove the flag from the publish command and
   re-run — the verify job still gates every publish.

## OIDC lane status at HEAD `62a218f` (addendum — OIDC-S08, read-only docs update)

> **Document status for this section only: IMPLEMENTED (static manifests and
> workflow observed at `62a218f`) / COMMITTED (commits below) / first
> OIDC publish NOT YET OBSERVED — NOT VERIFIED / overall swarm readiness
> still BLOCKED (live inference, live TUI mount, platform gates unresolved).**
> This section records what the OIDC lane proves today and what it honestly
> leaves open. Nothing here describes a package as shipped, released,
> published, deployed, or production-proven: every version below is an
> **unpublished preparation target**, and the release decision stays
> `RELEASE_CANDIDATE_BLOCKED (Option A)` — see
> [release-decision](release/release-decision.md).

Three things must not be confused:

1. **Package readiness (static, IMPLEMENTED at `62a218f`).** Manifests and
   workflow text are in place and committed. This is proven by inspection,
   not by a publish run.
2. **First-OIDC-workflow success (NOT YET OBSERVED — NOT VERIFIED).** No
   `publish-npmjs` run log exists in the repo at this HEAD, so no package
   has yet been shown to publish through OIDC trusted publishing.
3. **Overall swarm readiness (still BLOCKED).** Live inference, live TUI
   mount, and platform gates remain NOT VERIFIED per the
   [M8 release qualification](evidence/m8-release-qualification.md) live
   gates (G9/G10/G11/G12-live). OIDC package readiness changes none of them.

### Version targets at this HEAD (unpublished preparation targets, not releases)

Set by `e162b1d` (`chore(release): bump all publishables to unpublished
OIDC targets`), locked by `62a218f` (`chore: resync bun.lock to OIDC
version targets`, 1 file, 9 insertions / 9 deletions — version-number
alignment only). Observed in each `package.json` at HEAD (read-only
inspection; manifests not edited by this docs task):

| Package | Version | `publishConfig.registry` |
|---|---|---|
| `@vuminkosi/protocol` | 0.1.1 | `https://registry.npmjs.org` |
| `@vuminkosi/runtime` | 0.1.2 | `https://registry.npmjs.org` |
| `@vuminkosi/verification` | 0.1.2 | `https://registry.npmjs.org` |
| `@vuminkosi/adapter-opencode` | 0.0.2 | `https://registry.npmjs.org` |
| `@vuminkosi/plugin` | 0.0.2 | `https://registry.npmjs.org` |
| `@vuminkosi/board-terminal` | 0.1.1 | `https://registry.npmjs.org` |
| `@vuminkosi/git-workspaces` | 0.1.1 | `https://registry.npmjs.org` |
| `apps/swarmctl` (`@vuminkosi/swarmctl`) | 0.1.0 | none — `private: true`, skipped by the loop |

Commit chain behind this table (all COMMITTED, verified `git show --stat`):

- `5a0bfb8` — `fix(release): default all publish manifests to npmjs.org`
  (7 manifests switched to the npmjs.org default registry).
- `e162b1d` — version bumps above (7 files, one version line each).
- `2edb0a9` — `docs(ci): correct npmjs lane registry comment` (stale-comment
  fix: the `publish-npmjs.yml` header now reads `publishConfig.registry`
  as `https://registry.npmjs.org`, matching the manifests; the GitHub
  Packages lane pins its own `--registry` at `publish.yml:133`, so the two
  lanes stay independent).
- `62a218f` — `bun.lock` resync to the same targets (HEAD).

### Trusted-publisher status: UNKNOWN → manual action required per package

Trusted-publisher registration cannot be observed from this repo — it lives
in per-package Settings on npmjs.com. Status is therefore **UNKNOWN, treated
as NOT DONE** until a maintainer confirms it. Before the first real publish,
for **each** of the seven packages above: npmjs.com → package page →
Settings → Trusted Publisher → Manage Trusted Publishers → add GitHub
Actions publisher with organization/user `vuminkosi`, repository
`opencode-agent-swarm`, workflow file name `publish-npmjs.yml` (no
environment restriction needed). Without a registered publisher, that
package's publish attempt fails with `ENEEDAUTH` (plus the 2FA-bypass
notice) or `403` while the other packages still publish; attach the
publisher and re-run. A package that does not exist yet needs the one-time
maintainer bootstrap first (`npm login`, `npm publish --registry
https://registry.npmjs.org` from the package directory, then attach the
publisher, then re-run the workflow) — see "One-time bootstrap" above.

### What the first publish will prove (and what to check)

When the lane first runs, the verify-evidence pointers in "How to verify"
above apply unchanged: Actions log `publish <dir>` vs `skip <dir>` lines
(`apps/swarmctl` must log `skip ... private=true`), the `--provenance`
attestation step, the `https://registry.npmjs.org` target in the log, and
`npm view @vuminkosi/protocol version` returning `0.1.1` with no `.npmrc`
entry. Until that log exists, first-OIDC-workflow success stays
**NOT YET OBSERVED**. OIDC token minting needs npm ≥ 11.5.1 at publish
time; the workflow upgrades automatically when older
(`publish-npmjs.yml` OIDC floor-guard step) — read the workflow directly
for the exact commands; no flags are invented here.

### Dependency note (S04/S05/S06/S07 + DEP-REAUDIT)

The `62a218f` lockfile resync (9+/9−) aligns `bun.lock` with the OIDC
version targets above — version-number alignment only, drafted against the
`2edb0a9` gate evidence. **Lockfile re-audit is PENDING**: no DEP-REAUDIT
closing evidence exists in the repo at this HEAD (no re-audit log found),
so dependency closure is NOT claimed here. Resumption: run the re-audit at
`62a218f` and record the log before any publish claim needs it.
