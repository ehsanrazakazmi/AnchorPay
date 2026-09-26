# AnchorPay

Cross-border money transfer platform: people in **Canada** send money to **Pakistan** (and India). Identity checks,
sanctions and fraud screening, live exchange rates with a 30-minute rate lock, payment collection, payout and a
full audit trail, built as microservices on a zero-cost local stack.

**Status:** Phase A (Shared Foundation) complete. Contracts, database, events and tooling are frozen and verified.
Modules 1–4 are next ([foundation-signoff.md](docs/foundation-signoff.md)).

## Quick start (Windows)
```powershell
npm install
powershell -ExecutionPolicy Bypass -File infra\local\install-devtools.ps1   # Java + Kafka + Garnet (once)
npm run setup:env -- --pg-superuser-password=<postgres password>            # .env + keys (once)
npm run infra:start
npm run db:bootstrap; npm run db:migrate; npm run kafka:topics                # (once)
npm run verify
```
Details and troubleshooting: [docs/local-setup.md](docs/local-setup.md).

## Repository layout
```
contracts/
  openapi/        public-api.yaml (gateway), internal-api.yaml (service-to-service), common.yaml
  events/         topics.yaml, JSON Schemas, examples
db/migrations/    SQL migrations (up + down)
infra/local/      installer + start/stop scripts + Kafka config for the local stack
scripts/          setup, db, kafka, contract checks, verify, API docs server
docs/             architecture, decisions, state machine, database, kafka, api, secrets, setup, sign-off
services/         backend services (Modules 1–3, + notifications)   — next phases
apps/web/         Next.js customer app + admin portal (Module 4)     — next phases
```

## Documentation
| Doc | For |
|---|---|
| [architecture.md](docs/architecture.md) | services, ports, how a transfer flows |
| [DECISIONS.md](docs/DECISIONS.md) | every decision and how conflicts in the source documents were resolved |
| [state-machine.md](docs/state-machine.md) | transfer statuses and transitions |
| [api.md](docs/api.md) | API conventions, error codes · `npm run docs:api` for Swagger UI |
| [kafka.md](docs/kafka.md) | events, outbox/inbox, retries, dead letters |
| [database.md](docs/database.md) · [database-erd.md](docs/database-erd.md) | schemas, roles, conventions, migrations, ERD |
| [secrets.md](docs/secrets.md) | where secrets live, rotation |
| [CONTRIBUTING.md](CONTRIBUTING.md) | branches, commits, PRs, reviews |
