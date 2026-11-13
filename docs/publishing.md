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

### Token setup (one time)

1. Sign in at npmjs.com → Access Tokens → Generate New Token (granular or
   classic) with **publish permission scoped to `@vuminkosi/*`**
   (read+write for the scope; no broader permissions).
2. Add it as a repository Actions secret named **`NPM_TOKEN`**
   (GitHub → Settings → Secrets and variables → Actions → New repository
   secret). The workflow reads it only as
   `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`; it is never echoed, never
   written to disk (the `.npmrc` references `${NODE_AUTH_TOKEN}` literally),
   and no `set -x` / `env` dumps are allowed in the workflow.
3. No other secret changes: the GitHub Packages token stays only in
   `publish.yml` and is never used by this lane.

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
5. GitHub Packages publishing is unchanged: `publish.yml` still publishes
   the same package set to `https://npm.pkg.github.com` on its own trigger.
