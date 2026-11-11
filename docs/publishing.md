# Publishing to GitHub Packages (npm registry)

How versioned packages are built, verified, and published to the GitHub
Packages npm registry (`https://npm.pkg.github.com`). Pipeline definition:
`.github/workflows/publish.yml` (inline comments are the normative reference).

## What the workflow does

1. **Trigger** — a GitHub Release marked `published`, or a manual
   `workflow_dispatch` run (Actions tab → `publish` → Run workflow).
2. **Verify job** (`ubuntu-latest`, Bun `1.4.4`, Node `24`):
   - `bun install --frozen-lockfile`
   - `tsc --noEmit` for all four package tsconfigs
     (`packages/protocol`, `packages/runtime`, `packages/adapter-opencode`,
     `packages/plugin`).
   - Scoped `bun test` suite (same list as FINAL-POSTCOMMIT-01, no live
     inference): plugin bootstrap, protocol + runtime DB tests, daemon,
     config, adapter bridge (Tier-A), swarm-service, `/swarm` command tests,
     the two-module fixture, and `tests/e2e/`.
3. **Publish job** (runs only if verify passes) — for each of
   `packages/protocol`, `packages/runtime`, `packages/adapter-opencode`,
   `packages/plugin`, `apps/swarmctl`: packages with `"private": true` are
   **skipped**; every other package is published with
   `npm publish --provenance`. Any publish failure fails the job
   (exit code propagates; no failure-swallowing fallbacks).

## Current state: nothing publishes yet (by design)

All five packages are currently `"private": true`, so the publish job is a
verified no-op that logs `skip <dir>: private=true` for each one. To release
a package, flip its `"private"` to `false` (and bump `version`) in its
`package.json` — exactly the way `publishConfig`/`files` were staged here —
then cut a release below. `apps/swarmctl` is included in the publish loop
but its `package.json` was deliberately left untouched (outside this task's
ownership); edit it in a follow-up if the CLI should ship.

## Versioning

Manual version bumps per package (`version` field in each `package.json`;
workspace dependents still use `workspace:*`, which npm rewrites on
publish). No changesets tooling is installed. If release cadence grows,
adopt `changesets` (`.changeset/` + `changeset version` before tagging) —
out of scope for this task.

## How to cut a release

1. Bump `version` (and set `"private": false`) in each package to ship.
2. Commit on the active branch through the normal review/commit lane.
3. Tag the release version (e.g. `git tag v0.2.0`) and push the tag, or use
   GitHub → Releases → Draft a new release → Publish release.
4. The `publish` workflow runs; check the Actions log for `publish <dir>`
   vs `skip <dir>` lines and the provenance attestation step.
5. Consumers install with an `.npmrc` pointing the scope at GitHub Packages:
   `@opencode-swarm:registry=https://npm.pkg.github.com`.

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
- **Scope/owner alignment:** package scope `@opencode-swarm` SHOULD match the
  repository owner for GitHub Packages linking. [DESIGN: no git remote is
  configured on the canonical checkout, so owner linkage is unverified — if
  the owner differs, rename the scope and the registry line before release.]
- **Visibility:** scoped packages publish as restricted (private) by default;
  pass `--access public` (or change package visibility in its GitHub Packages
  settings) only as a deliberate decision.
- **Provenance caveat:** [DESIGN: `--provenance` is required by DEVOPS-PUBLISH-01
  AC(3). If the GitHub Packages npm registry ever rejects the attestation,
  remove the flag and re-run; the verify job still gates every publish.]

## Compatibility

`ubuntu-latest` runners, Bun `1.4.4` (`oven-sh/setup-bun@v2`), Node `24`
(`actions/setup-node@v4`) for npm compatibility, TypeScript `5.9.2` strict.
Action major versions are pinned (`checkout@v4`, `setup-bun@v2`,
`setup-node@v4`); refresh them via Dependabot or a docs/platform follow-up.
