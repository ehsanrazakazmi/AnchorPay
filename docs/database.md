# Database

PostgreSQL **18** (port 5433 locally), database `anchorpay`. Diagram: [database-erd.md](database-erd.md)
(regenerate with `npm run db:erd` after every migration).

## Schemas and roles
| Schema | Written by role | Service | Notes |
|---|---|---|---|
| `core` | `ap_core` | identity-service, transfer-service | users, recipients, transfers, status history |
| `compliance` | `ap_compliance` | compliance-service | KYC, AML rules, screenings, review cases, sanctions lists, FINTRAC reports |
| `fx` | `ap_fx` | fx-service | corridors, rate snapshots, rate locks |
| `payments` | `ap_payments` | payment-service | payments, refunds, payouts, webhook events |
| `ledger` | `ap_ledger` | ledger-service | accounts, journals, entries, reconciliation |
| `notify` | `ap_notify` | notification-service | preferences, delivery log |
| `audit` | everyone: INSERT only | all | immutable audit trail; `ap_ledger` may read (admin search) |
| `meta` | `ap_migrator` | migrations | `schema_migrations` |

- `ap_migrator` owns every object and is used **only** by `npm run db:migrate`.
- `ap_reporting` can SELECT everything and write nothing (analytics, daily report queries).
- Each service role: SELECT / INSERT / UPDATE on its own schema, **no DELETE**, nothing on other schemas.
  `npm run verify` proves this with real permission-denied checks.
- Role settings: `statement_timeout = 10s`, `idle_in_transaction_session_timeout = 60s`, `search_path = <own schema>, public`.

## Conventions
- **Names:** `snake_case`, plural table names, `<table>_<purpose>_idx` for indexes.
- **Ids:** `uuid DEFAULT uuidv7()` (time-ordered). Append-only logs use `bigint GENERATED ALWAYS AS IDENTITY`.
- **Time:** `timestamptz` everywhere, stored in UTC. `created_at` / `updated_at` (trigger-maintained).
- **Money:** `bigint` minor units + `char(3)` currency; rates `numeric(20,10)`. No floats.
- **Status fields:** `text` + `CHECK (… IN …)`, or a reference table where transitions matter (`core.transfer_transitions`).
- **Personal data:** `*_enc bytea` = AES-256-GCM ciphertext from the application, `encryption_key_id` names the key;
  `*_hash bytea` = HMAC-SHA256 blind index for lookups. Plaintext PII never reaches the database.
- **Cross-service ids** (e.g. `payments.payments.transfer_id`) are plain uuids, not foreign keys.
- **Append-only tables** (`make_append_only`): `core.transfer_status_history`, `compliance.screenings`,
  `compliance.compliance_events`, `fx.rate_snapshots`, `payments.payout_attempts`, `ledger.journals`,
  `ledger.entries`, `audit.audit_log`. UPDATE, DELETE and TRUNCATE fail even for the owner.
- **Ledger:** a deferred constraint trigger rejects any transaction that leaves a journal unbalanced in any
  currency; an entry's currency must match its account's currency (composite foreign key).
- **Messaging tables:** every producing schema has an `outbox`; every consuming schema has an `inbox` ([kafka.md](kafka.md)).

## Migrations
Plain SQL in `db/migrations/<timestamp>_<name>.sql`, each with `-- Up Migration` and `-- Down Migration`.

| Command | Does |
|---|---|
| `npm run db:bootstrap` | (superuser) create/update roles from `.env`, create the database. Safe to re-run. |
| `npm run db:migrate` | apply pending migrations in one transaction |
| `npm run db:rollback` | undo the latest migration (`-- --count=N` for more) |
| `npm run db:reset` | undo everything, then apply everything (proves every down migration works) |
| `npm run db:erd` | regenerate docs/database-erd.md |

Rules:
1. Never edit a migration that has been merged to `main` — add a new one.
2. Every migration needs a working down section; run `npm run db:reset` before opening the PR.
3. New tables need the lead's sign-off in review (PDF rule). CI runs bootstrap + migrate + reset on PostgreSQL 18.
4. Destructive changes (drop/rename column) go in two releases: stop using it, then drop it.
