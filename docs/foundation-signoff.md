# Phase A — Foundation sign-off

Acceptance criteria from `Foundation_Timeline_Document.md`, with where each is satisfied.
Module work starts only after every engineer has signed the table at the bottom (PDF §3).

## 1. API contracts
| Criterion | Status | Evidence |
|---|---|---|
| All endpoints documented in OpenAPI 3.0+ | ✅ | `contracts/openapi/public-api.yaml`, `internal-api.yaml` (OpenAPI 3.1) |
| Request/response schemas for all endpoints | ✅ | `components/schemas` + `common.yaml`; `npm run contracts:lint` |
| Auth/authorization requirements specified | ✅ | `security`, `x-roles`, `x-callers` on every operation; checked by `scripts/contracts/check.mjs` |
| Error codes and responses standardised | ✅ | `Problem` + `ErrorCode` in `common.yaml`; [api.md](api.md#error-codes) |
| Versioning strategy defined | ✅ | [api.md](api.md#conventions) (`/v1`, additive vs breaking) |
| Swagger UI accessible for testing | ✅ | `npm run docs:api` → http://127.0.0.1:8090 |
| All team members reviewed and approved | ⬜ | sign-off table below |

## 2. Database schema
| Criterion | Status | Evidence |
|---|---|---|
| Complete ERD | ✅ | [database-erd.md](database-erd.md) (generated from the live DB) |
| Tables, columns and data types | ✅ | `db/migrations/*.sql` (47 tables in 7 schemas) |
| Primary keys, foreign keys, indexes | ✅ | migrations; ERD marks PK/FK |
| Relationships documented | ✅ | ERD + [database.md](database.md) (cross-service ids are not FKs, by design) |
| Migration scripts written and tested | ✅ | `npm run db:migrate`; CI runs them on PostgreSQL 18 |
| Rollback strategy | ✅ | every migration has a Down section; `npm run db:reset` exercises all of them |
| Naming conventions | ✅ | [database.md](database.md#conventions) |
| Reviewed and approved | ⬜ | sign-off table below |

## 3. Kafka topics
| Criterion | Status | Evidence |
|---|---|---|
| Complete list of topics | ✅ | `contracts/events/topics.yaml` (17 event + 4 dead-letter topics) |
| Naming conventions | ✅ | dot-separated, topic = eventType ([kafka.md](kafka.md)) |
| Event schemas (JSON Schema) | ✅ | `contracts/events/schemas/` + validated examples (`npm run events:validate`) |
| Producer/consumer responsibilities | ✅ | `producer` / `consumers` per topic |
| Error handling and retry policy | ✅ | [kafka.md](kafka.md#consuming-inbox--retries--dlq) (1 s / 5 s / 30 s) |
| Dead-letter queue strategy | ✅ | `dlq.<consumer>` topics + `dlq.schema.json` |
| Reviewed and approved | ⬜ | sign-off table below |

## 4. Environment setup
| Criterion | Status | Evidence |
|---|---|---|
| Local infrastructure on every machine | ✅ / ⬜ per engineer | `infra/local/install-devtools.ps1` (replaces Docker: see DECISIONS D-02) |
| Full stack configuration | ✅ | `npm run infra:start` (Garnet + Kafka), PostgreSQL service |
| Setup guide | ✅ | [local-setup.md](local-setup.md) incl. troubleshooting |
| Database spun up locally with migrations | ✅ | `db:bootstrap` + `db:migrate` |
| Kafka spun up locally | ✅ | `infra:start` + `kafka:topics` |
| All services start locally | ➡️ | services don't exist yet; each module adds its start script |
| Sandbox APIs | ✅ | mock providers (DECISIONS D-01, D-19) |
| Environment parity documented | ✅ | DECISIONS D-01 table (local ↔ production swap) |
| Each engineer runs it | ⬜ | each engineer: `npm run verify` → "Foundation verified" |

## 5. Secrets management
| Criterion | Status | Evidence |
|---|---|---|
| Production secret store configured | ➡️ | deferred: no cloud (zero cost). Variable names match what Secrets Manager will hold |
| `.env` template without real secrets | ✅ | `.env.example` |
| `.env` git-ignored | ✅ | `.gitignore`; `npm run verify` fails if it isn't |
| Rotation strategy | ✅ | [secrets.md](secrets.md#rotation) |
| Access controls | ✅ | per-service DB roles; only identity-service has the JWT private key |
| How to add a secret | ✅ | [secrets.md](secrets.md#adding-a-new-secret) |

## 6. Branch strategy
| Criterion | Status | Evidence |
|---|---|---|
| Branch naming | ✅ | [CONTRIBUTING.md](../CONTRIBUTING.md#branches) |
| Main branch protection | ⬜ | to enable once the repo is on GitHub (steps in CONTRIBUTING.md) |
| PR template | ✅ | `.github/pull_request_template.md` |
| Code review requirements | ✅ | CONTRIBUTING.md + `.github/CODEOWNERS` |
| CI integrated with PR checks | ✅ | `.github/workflows/ci.yml` (contracts + database jobs) |
| Release + hotfix process | ✅ | CONTRIBUTING.md |

✅ done · ⬜ needs a person · ➡️ intentionally deferred (reason given)

## Sign-off
Each engineer: run `npm run verify` on your own laptop, read the contracts for the services you build or call,
and sign below (or approve the sign-off PR).

| Engineer | Module | `npm run verify` passed | Contracts reviewed | Date |
|---|---|---|---|---|
| Module 1 owner (lead) | 1 — Core Engine | ⬜ | ⬜ | |
| Module 2 owner | 2 — Compliance & Fraud | ⬜ | ⬜ | |
| Module 3 owner | 3 — FX & Payments | ⬜ | ⬜ | |
| Module 4 owner | 4 — Frontend & Notifications | ⬜ | ⬜ | |
