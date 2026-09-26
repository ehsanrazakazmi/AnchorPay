# Secrets

**Rule: no secret is ever committed to git.** `.env`, `.env.*` (except `.env.example`), `secrets/` and `*.pem`/`*.key`
are git-ignored, and `npm run verify` fails if they stop being ignored.

## Where secrets live
| Secret | Local | Production (later) |
|---|---|---|
| PostgreSQL superuser password | `.env` `PG_SUPERUSER_PASSWORD` (used only by `db:bootstrap`) | not given to services at all |
| Per-service DB passwords | `.env` `PG_*_PASSWORD` (random, generated) | AWS Secrets Manager / Vault |
| JWT signing key pair | `secrets/jwt-private.pem`, `secrets/jwt-public.pem` | KMS-backed key |
| PII encryption key + HMAC key | `.env` `PII_ENCRYPTION_KEY`, `PII_HMAC_KEY` (32 random bytes) | KMS |
| Internal service token | `.env` `INTERNAL_SERVICE_TOKEN` | mTLS between services |
| Provider keys (Stripe test, webhooks) | `.env` | Secrets Manager |

Only identity-service reads the JWT **private** key; every other service gets the public key.
Only identity-service and compliance-service need the PII keys.

## First-time setup (each engineer)
```
npm run setup:env -- --pg-superuser-password=<your local postgres password>
```
This copies `.env.example` → `.env`, fills every `__GENERATE__` value with a fresh random secret and creates the
JWT key pair. Each laptop has its own secrets; they are never shared in chat or email.

## Adding a new secret
1. Add it to `.env.example` with the value `__GENERATE__` (random) or empty (provided by a person), plus a comment.
2. Read it through `env('NAME')` (Node) / settings (Python), which fails loudly if it is missing or still a placeholder.
3. Mention it in the PR description so teammates re-run `npm run setup:env -- --force` or add it by hand.

## Rotation
- DB passwords: edit `.env`, run `npm run db:bootstrap` (it re-syncs role passwords), restart services.
- PII keys: add a new key with a new `PII_ENCRYPTION_KEY_ID`; new rows use it, old rows keep their key id and are
  re-encrypted by a background job. Never delete an old key while rows still reference it.
- JWT keys: publish the new public key first, then switch signing; old tokens expire within 15 minutes.
- Anything that may have leaked: rotate immediately and note it in the audit log.
