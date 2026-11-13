# Release notes — OIDC lane prep (OIDC-S08, preparation notes only)

> **Document status: IMPLEMENTED (static lane observed at `62a218f`) /
> COMMITTED (commits below) / first OIDC publish NOT YET OBSERVED —
> NOT VERIFIED / overall decision `RELEASE_CANDIDATE_BLOCKED (Option A)`,
> master-owned.**
> These are **preparation notes, not a release announcement**. Nothing here
> claims a package is shipped, released, published, deployed, or
> production-proven. Every version below is an **unpublished preparation
> target**. For the lane contract see [publishing.md](../publishing.md)
> (OIDC lane sections); for the readiness record see the
> [M8 release qualification OIDC addendum](../evidence/m8-release-qualification.md)
> (§12, linked not duplicated); for the decision see
> [release-decision](release-decision.md) (master-owned).

- **Canonical repo:** `C:\DevOps\opencode-agent-swarm`
- **Source baseline HEAD:** `62a218f1d5e5874d7896eaaacb07a06797edc313` —
  `chore: resync bun.lock to OIDC version targets`. Prior chain:
  `5a0bfb8` → `e162b1d` → `2edb0a9` → `62a218f` (all COMMITTED, verified
  `git show --stat`).

## Unpublished targets (not releases)

| Package | Target version |
|---|---|
| `@vuminkosi/protocol` | 0.1.1 |
| `@vuminkosi/runtime` | 0.1.2 |
| `@vuminkosi/verification` | 0.1.2 |
| `@vuminkosi/adapter-opencode` | 0.0.2 |
| `@vuminkosi/plugin` | 0.0.2 |
| `@vuminkosi/board-terminal` | 0.1.1 |
| `@vuminkosi/git-workspaces` | 0.1.1 |

`apps/swarmctl` (`@vuminkosi/swarmctl` 0.1.0) stays `private: true` and is
skipped by the publish loop. No release numbers beyond these targets are
claimed anywhere in this lane.

## Prerequisites before the first publish

1. **Scope ownership:** the publisher's npm account must own the
   `@vuminkosi` scope. Re-check with `npm view` against the default
   registry before the first publish (UNEXECUTED here): if a version comes
   back instead of 404, STOP — the scope is taken.
2. **Trusted publishers:** register this repo + workflow
   (`vuminkosi` / `opencode-agent-swarm` / `publish-npmjs.yml`) on
   **each** package's npmjs.com Settings page (status UNKNOWN → manual
   action required; see [publishing.md](../publishing.md) for steps).
   Packages that do not exist yet need the one-time maintainer bootstrap
   first, then the publisher attachment, then a workflow re-run.
3. **npm OIDC floor:** minting needs npm ≥ 11.5.1 at publish time; the
   workflow upgrades automatically when older (workflow source of truth:
   `.github/workflows/publish-npmjs.yml`, read directly — no flags
   invented here).

## What the first publish will prove

A first green `publish-npmjs` run proves OIDC minting worked, each
registered trusted publisher was accepted, and provenance attestation
landed against `https://registry.npmjs.org` — check the Actions log
`publish <dir>` vs `skip <dir>` lines, the attestation step, and
`npm view @vuminkosi/protocol version` returning `0.1.1` with no `.npmrc`
entry. Until that log exists, first-OIDC-workflow success stays
**NOT YET OBSERVED**. Even then, the live swarm gates (fresh-install
smoke/E2E, live inference / 402-shape / spend, live TUI mount, live idle
window) remain NOT VERIFIED and separately blocking — see
[release-blockers](release-blockers.md) and
[final-review-matrix](final-review-matrix.md).

## Gaps (NOT VERIFIED)

1. First OIDC publish: no run log in repo — NOT YET OBSERVED.
2. Trusted-publisher registration per package: UNKNOWN, treated as NOT DONE.
3. Scope ownership live confirmation: UNVERIFIED.
4. Lockfile re-audit at `62a218f`: PENDING — no DEP-REAUDIT closing
   evidence in repo.
5. No screenshots, deployment, endpoint, CLI-flag, or support-promise
   claims are made here. No secrets or credential content was read or is
   recorded.
