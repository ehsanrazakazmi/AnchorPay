# AnchorPay

Cross-border money transfer platform: people in **Canada** send money to **Pakistan** (and India). Identity checks,
sanctions and fraud screening, live exchange rates with a 30-minute rate lock, payment collection, payout and a
full audit trail, built as microservices on a zero-cost local stack.

**Status:** Built so far: shared toolkits (Node + Python), **gateway**, **identity-service** (sign-up, login,
tokens, verification, profile, recipients, staff admin), **fx-service** (corridors, live rates, quotes, 30-minute rate
locks) and **transfer-service** (the transfer state machine: create, screen, capture, pay out, cancel, re-quote,
refund, crash recovery). Compliance and payments are temporary stand-ins for now. Next: payment-service, the mock
payout partner and ledger-service.

## Quick start (Windows)
```powershell
npm install
npm run py:setup                                                            # Python services (once)
powershell -ExecutionPolicy Bypass -File infra\local\install-devtools.ps1   # Java + Kafka + Garnet (once)
npm run setup:env -- --pg-superuser-password=<postgres password>            # .env + keys (once)
npm run infra:start
npm run db:bootstrap; npm run db:migrate; npm run kafka:topics                # (once)
npm run verify
npm run dev        # gateway on http://127.0.0.1:8080
npm test
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
packages/         service-kit (Node) and py-service-kit (Python): shared runtime for every service
services/         gateway, identity-service, fx-service, transfer-service (built) · stand-ins (temporary) · the others come next
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
