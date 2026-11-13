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
