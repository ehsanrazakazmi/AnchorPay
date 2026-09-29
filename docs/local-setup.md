# Local setup (Windows)

Everything runs on your laptop for **free**: no cloud account, no Docker, no admin rights needed after PostgreSQL.
Total RAM for the infrastructure: ~350 MB (Kafka ~250 MB, Garnet ~50 MB, PostgreSQL ~50 MB).

## 1. Install once
| Tool | Version | How |
|---|---|---|
| Node.js | 24+ | https://nodejs.org (LTS installer) |
| Python | 3.12+ | https://python.org (tick "Add to PATH") — for the Python services (fx, compliance, ledger) |
| Git | any recent | https://git-scm.com |
| .NET SDK | 8+ | https://dotnet.microsoft.com/download — only used to install Garnet |
| PostgreSQL | **18** | https://www.postgresql.org/download/windows (EDB installer). Tick *Command Line Tools*. Remember the `postgres` password. If another PostgreSQL already uses 5432, let 18 take **5433** (our default). |

Then the portable Kafka + Java + Garnet bundle (downloads ~180 MB, verifies checksums, installs into one folder):

```powershell
powershell -ExecutionPolicy Bypass -File infra\local\install-devtools.ps1
# default folder: C:\Users\<you>\devtools  (use -Dir to change; no spaces allowed)
```

## 2. Configure the project
```powershell
npm install
npm run py:setup          # .venv with the Python services + test tools (git-ignored, like node_modules)
npm run setup:env -- --pg-superuser-password=<your postgres password>
```
Open `.env` and check `PGPORT` (5433) and `DEVTOOLS_DIR` (the folder from step 1, with forward slashes).

## 3. Create the database and topics
```powershell
npm run infra:start      # Garnet + Kafka (PostgreSQL runs as a Windows service)
npm run db:bootstrap     # roles + database (asks nothing; uses .env)
npm run db:migrate       # schemas, tables, seed data
npm run kafka:topics     # all event + dead-letter topics
npm run verify           # must end with "Foundation verified"
```

## Daily use
| Command | What it does |
|---|---|
| `npm run infra:start` / `infra:stop` / `infra:status` | start / stop / check Garnet + Kafka (they don't auto-start with Windows) |
| `npm run dev` | start every built service (gateway on http://127.0.0.1:8080). Node services restart on code changes; restart Python ones yourself. `npm run dev -- fx-service` for one |
| `npm test` / `npm run test:coverage` | all Node (Vitest) and Python (pytest) tests, using the separate `anchorpay_test` database |
| `npm run test:node` / `npm run test:py` | only one of the two suites |
| `npm run lint:py` | Python lint (ruff) |
| `npm run typecheck` | TypeScript type check of every service |
| `npm run staff:create -- --email=... --phone=+1... --name="..." --role=admin` | create a staff account; prints a one-time temporary password |
| `logs/mailbox.log` | every SMS and email the services "send" (verification codes, reset links), one JSON line each |
| `npm run verify` | full health + integrity check of your environment |
| `npm run check` | lint API contracts + validate event schemas (what CI runs first) |
| `npm run docs:api` | Swagger UI for the contracts on http://127.0.0.1:8090 |
| `npm run db:migrate` / `db:rollback` / `db:reset` | migrations (see [database.md](database.md)) |
| `npm run db:erd` | regenerate the ER diagram |

## Ports
| Port | What |
|---|---|
| 5433 | PostgreSQL 18 |
| 6379 | Garnet (Redis protocol) |
| 9092 / 9093 | Kafka broker / controller |
| 8080 | gateway · 3000 web · 4001–4004 Node services · 5001–5003 Python services · 4900 mocks · 8090 API docs |

Everything listens on **127.0.0.1 only**, so nothing is reachable from the network.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `Connect to ipv6#[::1]:9092 failed` | Use `127.0.0.1` (not `localhost`) in `KAFKA_BROKERS`. Kafka advertises 127.0.0.1. |
| `The input line is too long` from a Kafka `.bat` | Windows command-line limit. Our scripts call `java -cp libs\*` directly; don't use Kafka's `.bat` launchers. |
| `'wmic' is not recognized` | Kafka's stop script needs wmic (gone in Windows 11). Use `npm run infra:stop`. |
| Kafka won't start after a crash | Stop everything with `npm run infra:stop` and start again; it recovers its logs on start (can take ~30 s). |
| Kafka crashed while deleting old data | Retention/compaction are disabled for this reason. Never delete topics on Windows. |
| `password authentication failed for user "postgres"` | Wrong `PG_SUPERUSER_PASSWORD` in `.env`. |
| `permission denied for schema …` in a service | Working as designed: a service may only use its own schema ([database.md](database.md)). |
| Disk filling up | `DEVTOOLS_DIR/data/kafka-app-logs` holds Kafka's own logs (rotated hourly); safe to delete while Kafka is stopped. |
| Reset everything | `npm run db:reset` (schema), or stop infra and delete `DEVTOOLS_DIR/data/kafka` then re-run the installer (Kafka). |
