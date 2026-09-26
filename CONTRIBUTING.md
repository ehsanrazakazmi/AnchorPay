# Contributing

## Branches
| Branch | Purpose |
|---|---|
| `main` | Always releasable. Protected: no direct pushes, PR + review + green CI required. |
| `feature/<module>-<short-name>` | New work, e.g. `feature/m1-transfer-state-machine`, `feature/m3-fx-rate-lock` |
| `fix/<module>-<short-name>` | Bug fixes |
| `contract/<short-name>` | Changes to `contracts/` or `db/migrations/` (need more reviewers, see below) |
| `release/<version>` | Cut from `main` when preparing a release; only fixes go in |
| `hotfix/<short-name>` | Urgent fix branched from the release tag, merged back to `main` |

Module prefixes: `m1` core engine, `m2` compliance, `m3` FX & payments, `m4` frontend & notifications, `foundation`.

## Commits
[Conventional Commits](https://www.conventionalcommits.org): `feat(transfer): enforce idempotency keys`,
`fix(fx): round offer rate down`, `docs: …`, `test: …`, `chore: …`. Signed commits are required on `main`.

## Pull requests
1. Keep PRs small (< ~400 changed lines where possible). One concern per PR.
2. Run before pushing: `npm run check` and `npm run verify`; plus the module's own tests once they exist.
3. Fill in the PR template (what, why, how tested, contract changes, screenshots for UI).
4. Reviews:
   - Normal change: **1 approval** from another engineer.
   - `contracts/` or `db/migrations/` change: approval from the **lead** + every module owner whose service calls/consumes it.
   - Security-sensitive (auth, crypto, PII, payments): the lead reviews.
5. Squash-merge. Delete the branch after merging.

## Coverage targets (PDF §8)
Minimum 80 % unit-test coverage per service; transfer-service, payment-service and the AML engine 90 %.
CI will enforce this once each service exists.

## Setting up GitHub protection (lead, once the repository is on GitHub)
Settings → Branches → Add rule for `main`:
- Require a pull request before merging · 1 approval · dismiss stale approvals · require review from Code Owners
- Require status checks: `contracts`, `database`
- Require signed commits · Require linear history · Do not allow bypassing
Settings → Code security: enable Dependabot alerts + secret scanning.

Keep the repository **private**. GitHub Actions is free for 2,000 minutes/month on private repos, which is plenty:
each CI run takes ~3–4 minutes and can't cost money without a payment method on the account.
