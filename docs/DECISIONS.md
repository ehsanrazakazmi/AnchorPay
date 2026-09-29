# Decision log

Every decision taken while freezing the Foundation, including where the source documents disagreed.
Sources: **PDF** = AnchorPay_Module_Breakdown.pdf, **Guide** = MoneyTransfer_Platform_Guide.docx,
**Timeline** = Timeline.docx, **Foundation doc** = Foundation_Timeline_Document.md, **Meeting** = kickoff call, 3 Jul 2026.

To change a decision: open a PR that edits this file and the affected contract/migration, and get sign-off from the module owners it touches.

| # | Topic | Decision |
|---|---|---|
| D-01 | Cost | Zero-cost local stack. No AWS, no paid SaaS, no service that needs a credit card. |
| D-02 | Infrastructure | PostgreSQL 18, Garnet (Redis protocol), Kafka 4 (KRaft) run natively on Windows. No Docker, no Terraform for now. |
| D-03 | Database layout | One database, one schema per service, one login role per service, no cross-schema access. |
| D-04 | Services | 8 services + web app (merged from the PDF's 20+ logical services). |
| D-05 | Transfer flow | Payment-first: rate locked on confirm, funds **authorised** (held), screened, then **captured**. |
| D-06 | State machine | Order and extra states changed (see below). |
| D-07 | Quotes | 60-second quote id; confirming locks exactly that quote for 30 minutes. |
| D-08 | Fee model | Fee is added on top: sender pays amount + fee (+ card surcharge). |
| D-09 | Corridors | Canada → Pakistan first, Canada → India second. Limits in CAD. |
| D-10 | KYC tiers | Tier limits set (table below). |
| D-11 | AML rules | Rules-only fraud scoring; both documents' velocity rules kept. |
| D-12 | Sanctions | Free official OFAC, UN and Canadian lists, fuzzy matching in PostgreSQL. |
| D-13 | FINTRAC reports | STR + international EFT report (EFTR). No US CTR, no cash report. |
| D-14 | Privacy law | PIPEDA (+ Quebec Law 25), not GDPR. 5-year retention. |
| D-15 | Money | Integer minor units + currency; rates as decimal strings. |
| D-16 | Personal data | Encrypted in the app (AES-256-GCM) + blind-index hashes. Never in events, logs or audit rows. |
| D-17 | Events | Topic per event type, dot names, transactional outbox/inbox, dead-letter topic per consumer. |
| D-18 | APIs | REST `/v1`, problem+json errors, idempotency keys, JWT RS256. |
| D-19 | Providers | Mocks by default; Stripe **test mode** optional; no Plaid. |
| D-20 | FX rates | Free daily source + simulated movement every 30 s. |
| D-21 | Notifications | Written to log files (no SMS/email cost). English first. |
| D-22 | Scope | Web app first. Mobile, agent portal, hedging etc. later. |
| D-23 | Migrations | node-pg-migrate with plain SQL files instead of Flyway/Liquibase. |
| D-24 | Timeline | The documents' timelines are ignored (owner's instruction). |
| D-25 | Node toolchain | TypeScript run directly with tsx (no build step), Fastify, Vitest; shared code in `packages/service-kit`. |
| D-26 | Contract-driven code | Services register routes by operationId; the gateway builds its routes from the spec. |
| D-27 | Gateway trust model | Gateway verifies JWTs; services accept only gateway-forwarded requests (X-Internal-Token). |
| D-28 | Sessions | Rotating refresh tokens with reuse detection; logout/password change/suspension revoke instantly. |
| D-29 | Passwords & lockout | bcrypt cost 12, common-password check, 5 failures -> 15-minute lock. |
| D-30 | Verification secrets | Email links, SMS codes and reset links go straight to the messenger, never through Kafka. |
| D-31 | Recipient destinations | Validated against a built-in list of corridors until fx-service exists. |
| D-32 | Test isolation | Tests use `anchorpay_test` (rebuilt each run) and a per-run Redis key prefix. |
| D-33 | Python toolkit | `packages/py-service-kit` mirrors the Node kit; handlers are synchronous (thread pool). |
| D-34 | fx-service rules | 60 s quotes, single-use; 30-min locks; no pricing on rates older than 60 s. |
| D-35 | Recipient destinations (done) | identity-service reads fx-service's corridors (cached 5 min, stale-if-down). |
| D-36 | Migration fix | The seed migration's Down was made data-safe (an exception to "never edit a merged migration"). |
| D-37 | Audit robustness | A malformed client address is stored as empty instead of failing the request. |
| D-38 | Transfer workflow | Transactions for state, idempotent calls outside them, progress markers, 30 s recovery job. |
| D-39 | Stand-ins | Temporary in-memory compliance + payment services with magic amounts until Steps 5–6. |
| D-40 | Transfer stats | Counts skip cancelled transfers; amounts also skip failed/refunded ones; round = CAD 100s. |
| D-41 | Rate lock expiry | Cancel / fail / ask to reconfirm depending on the step; re-quotes never change the CAD total. |
| D-42 | Cancel + idempotency | Cancel only before the transfer is cleared to charge; 24 h Idempotency-Key replay. |
| D-43 | Toolkit fixes | No JSON content-type on bodiless calls; optional request bodies; realistic shared fixtures. |
| D-44 | Card payments | Mock card processor with a hosted form and test cards by default; Stripe test mode behind the same adapter. |
| D-45 | Bank debit | Mock pre-authorised debit, authorised at once; a total ending in .13 bounces. |
| D-46 | Fee split | transfer-service sends fee + surcharge with the authorisation, so payment.captured can carry them. |
| D-47 | Payouts | Background dispatch, 3 tries with backoff, permanent vs temporary failures, manual queue for admins. |
| D-48 | Payment safety | One refund per payment, lapsed holds fail, late holds released, signatures over raw bytes. |
| D-49 | Ledger postings | Journals derived from facts, one per deterministic ref: the same books in any event order. |
| D-50 | Reports | Daily summary through the read-only reporting role; audit-log searches are themselves audited. |
| D-51 | Reconciliation | Nightly per partner and day, matched by payout id; discrepancies stay open until resolved. |
| D-52 | Step 5 plumbing | Payment stand-in removed; mock provider state in var/; Python kit gains a consumer and an HTTP client. |

---

### D-01 Zero cost
The owner cannot spend money on this build. Every paid item in the PDF/Guide has a free replacement:

| Documents say | We use | Swap back later by |
|---|---|---|
| AWS EKS / RDS / ElastiCache / MSK / S3 | Local PostgreSQL / Garnet / Kafka / local folders | Config only (connection strings) |
| AWS Secrets Manager | `.env` (git-ignored) + `secrets/` | Same variable names, different loader |
| AWS API Gateway / Kong, WAF, Shield | Our own Node gateway: JWT, rate limiting, security headers | Put a managed gateway in front |
| Jumio / Onfido | Mock KYC vendor (approve / reject / needs review) | New provider adapter |
| ComplyAdvantage / Refinitiv | Free OFAC SDN, UN Consolidated, Canadian Consolidated lists | New screening adapter |
| Thunes / Flutterwave | Mock payout partner with realistic delays and failures | New payout adapter |
| Stripe / Plaid | Mock card + mock bank debit; Stripe **test mode** optional (free, no card) | `CARD_PAYMENT_PROVIDER=stripe` with live keys |
| Twilio / SendGrid | Messages written to `logs/` | `SMS_PROVIDER` / `EMAIL_PROVIDER` |
| Open Exchange Rates (paid for 30 s polling) | open.er-api.com (free, daily) + simulated jitter | `FX_RATE_SOURCE` |
| Datadog / Sentry / PagerDuty | Structured logs + `/health` | Add exporters |
| GitHub Actions | Free tier (2,000 min/month private, unlimited public) | — |

### D-02 Local infrastructure on Windows
No WSL or Docker on the dev laptop, so everything is a portable install in `C:\Users\<you>\devtools` (see [local-setup.md](local-setup.md)).
- **Garnet** (Microsoft, open source) instead of Redis: Redis has no official Windows build; Garnet speaks the Redis protocol, so services use normal Redis clients and can switch to real Redis with no code change.
- **Kafka**: single node, KRaft mode, bound to 127.0.0.1. Windows workarounds: time-based log deletion and compaction are off (they can crash Kafka on Windows), and topics are never deleted. The stock stop script needs `wmic` (removed from Windows 11), so `stop-infra.ps1` replaces it.
- **Terraform** skipped: there is no cloud to provision. The PDF's IaC tasks return when a cloud account exists.

### D-03 One schema per service
The PDF says "no module creates its own tables without the lead's sign-off" and the Guide asks for per-service DB users with least privilege. So:
- Schemas `core`, `compliance`, `fx`, `payments`, `ledger`, `notify`, `audit`, each written only by its owner role (`ap_core`, …).
- No foreign keys or grants across schemas. Services share data through APIs and events. This keeps the "each module can be built and deployed independently" promise of the PDF.
- Services never get DELETE. Personal data is removed by anonymising; history tables are append-only (enforced by triggers).
- PostgreSQL **18** is required (native `uuidv7()` ids: time-ordered, index friendly).

### D-04 Services
The PDF lists ~20 logical services; running 20 processes on one laptop is not practical, so related ones are merged. Module ownership is unchanged.

| Service | Language | Port | Contains (PDF services) | Module |
|---|---|---|---|---|
| gateway | Node.js | 8080 | API Gateway | 1 |
| identity-service | Node.js | 4001 | User Service + Auth Service + recipients | 1 |
| transfer-service | Node.js | 4002 | Transfer Service (state machine) | 1 |
| compliance-service | Python | 5001 | KYC, AML rules engine, fraud scoring, sanctions, compliance event logger, review queue, SAR/STR | 2 |
| fx-service | Python | 5002 | FX pricing + rate lock | 3 |
| payment-service | Node.js | 4003 | Payment collection + payout dispatch + webhooks | 3 |
| ledger-service | Python | 5003 | Ledger + reconciliation job + Reporting Service | 3 (reporting endpoints: 1) |
| notification-service | Node.js | 4004 | Notification service | 4 |
| mock-providers | Node.js | 4900 | Mock KYC vendor, payout partner, card/bank | shared |
| web | Next.js | 3000 | Customer app + admin/compliance portal | 4 |

- Transfer service = **Node.js**, FX service = **Python** (owner's decision; the Guide suggested Go).
- The PDF gives both Module 1 (Reporting Service) and Module 3 (Ledger, Reconciliation) the ledger. **One owner:** ledger-service. Module 1's reporting endpoints live there too.
- The admin/compliance portal had no owner (Module 2 builds only its backend). It is part of the Next.js app (Module 4), under `/admin`.

### D-05 Payment-first transfer flow
The meeting's main pain point: banks and some apps take 2–3 days and the rate moves. LEMFI was preferred because it takes the money first and locks the rate immediately. The Guide also says "never charge the sender before compliance passes and the rate is locked". Both are satisfied by **authorise-then-capture**:
1. Confirm → rate locked (30 min) → card/bank **authorised** (funds held, not charged).
2. Screening runs (≤ 500 ms). Pass → **capture** → payout. Block → release the hold (nothing was charged, nothing to refund).
3. Flagged → manual review while the hold stays in place (card holds last ~7 days).

### D-06 State machine changes
The PDF order was `INITIATED → COMPLIANCE_SCREENING → FX_LOCKED → PAYMENT_COLLECTED → …`. Changes:
- `FX_LOCKED` now comes **before** `COMPLIANCE_SCREENING` (the rate locks when the user confirms, per D-05).
- New `ON_HOLD`: flagged, waiting for a compliance officer (the PDF had a review queue but no state for it).
- New `AWAITING_RECONFIRM`: approved after the 30-minute lock expired. The CAD charge stays the same; the sender accepts the new PKR amount or cancels.
- New `CANCELLED`: stopped before capture (the Guide mentions cancelling; the PDF had no state).
- `REFUNDED` only follows `FAILED` when money was actually captured.
- The database itself rejects invalid transitions. Full diagram: [state-machine.md](state-machine.md).

### D-07 Quotes and rate lock
- `POST /v1/quotes` returns a `quoteId` that lives **60 s** in Redis. The UI refreshes it every 30 s (the PDF's "rate refresh prompt").
- `POST /v1/transfers` with a `quoteId` locks **exactly that rate** for **30 minutes** (the PDF says 30; the Guide says 30–60). Expired quote → `409 QUOTE_EXPIRED` → re-quote. This minimises the gap between what the user saw and what gets locked (meeting).

### D-08 Fee model: fee on top
The Guide's formula is *recipient = (send − fee) × rate* (fee deducted). The meeting demo (LEMFI) showed the fee **below** the amount and a **total** to pay, i.e. fee on top. We use fee on top because it's clearer to the customer:
- `totalCharge = sendAmount + fee + cardSurcharge`
- `offerRate = midRate × (1 − spread)`, **rounded down to 4 decimals**
- `receiveAmount = sendAmount × offerRate`, **rounded down** to the minor unit
- `cardSurcharge = sendAmount × surcharge %`, rounded to the nearest cent (half up)
The database enforces the total. Example: CAD 500 by card on CA-PK at mid 206.67 → offer 203.5699, fee 2.99, surcharge 10.00,
**total CAD 512.99, recipient PKR 101,784.95**. Each rounding step changes an amount by less than one minor unit.

### D-09 Corridors (seed values, editable by admins)
The meeting's main use case is Canada → Pakistan, with India shown in the demo.

| Corridor | Spread | Fixed fee | Card surcharge | Min / max per transfer | Payout methods |
|---|---|---|---|---|---|
| CA-PK (CAD→PKR) | 1.50 % | CAD 2.99 | 2.00 % | CAD 10 / 10,000 | Bank account, JazzCash, Easypaisa |
| CA-IN (CAD→INR) | 1.20 % | CAD 2.99 | 2.00 % | CAD 10 / 10,000 | Bank account |

All limits and AML thresholds are in **CAD** (the documents used USD; the send side is Canada-only).

### D-10 KYC tiers (seed values)
The PDF defines the tiers but no numbers. These are placeholders for the Compliance Officer to confirm.

| Tier | Requires | Per transfer | 24 h | 30 days |
|---|---|---|---|---|
| 0 | Account created | cannot send | – | – |
| 1 | Email + phone verified | CAD 500 | CAD 999 | CAD 1,500 |
| 2 | Photo ID + live selfie (the flow the bank used in the meeting) | CAD 3,000 | CAD 5,000 | CAD 15,000 |
| 3 | + proof of address + proof of income | CAD 10,000 | CAD 20,000 | CAD 50,000 |

Tier 1 stays under CAD 1,000 per 24 h because FINTRAC expects identity verification for international EFTs of CAD 1,000 or more. **To be confirmed by the Compliance Officer / lawyer.**

### D-11 AML rules and fraud score
- No transaction data exists, so the ML model is postponed (PDF note + meeting: it needs 1–2 million real transactions). The score is the sum of the triggered rules' weights, capped at 100.
- Routing: score < 40 passes, 40–79 is flagged, ≥ 80 is blocked. Any `block` rule blocks regardless of score.
- The two documents' velocity rules differ (PDF: > 3 per hour; Guide: > 5 per 24 h). **Both are kept**, plus the PDF's daily amount rule (> CAD 5,000 in 24 h).
- Seeded rules: `AMOUNT_OVER_TIER_LIMIT` (block), `VELOCITY_1H`, `VELOCITY_24H`, `DAILY_AMOUNT`, `HIGH_RISK_CORRIDOR`, `ROUND_AMOUNT_PATTERN` (flag), `NEW_BENEFICIARY` (+15), `SANCTIONS_MATCH` (block), `LARGE_EFT_REPORT` (report). Compliance officers tune them in the admin portal; every change is audited.

### D-12 Sanctions screening
Free official lists replace ComplyAdvantage: **OFAC SDN**, the **UN Consolidated List**, and the **Canadian Consolidated Autonomous Sanctions List** (the Guide's list omitted Canada's own list). Names are normalised and fuzzy-matched with `pg_trgm`: similarity ≥ 0.90 blocks, 0.75–0.90 goes to manual review.

### D-13 FINTRAC reports
The documents use US reports (FinCEN CTR) and the cash report (LCTR). AnchorPay handles no cash and no US customers, so the tools build:
- **STR** (suspicious transaction report): drafted when a reviewer rejects a flagged transfer or on a sanctions match.
- **EFTR** (international electronic funds transfer report): drafted for transfers of CAD 10,000+, single or combined within 24 h.
Engineering only drafts and tracks them. The **Compliance Officer reviews and files**.

### D-14 Privacy and retention
Canada → **PIPEDA** (+ Quebec Law 25), not GDPR. Transaction, KYC and audit records are kept at least **5 years** after the relationship ends (FINTRAC). Account closure anonymises the profile but keeps those records.

### D-15 Money representation
Amounts are `bigint` minor units + ISO currency (`{ amountMinor, currency }` in JSON). Rates are `numeric(20,10)` in the database and decimal **strings** in JSON. Floats are never used.

### D-16 Personal data (PII)
- Name, email, phone, date of birth, address and account/wallet numbers are encrypted by the application (AES-256-GCM, key id stored per row for rotation) before reaching PostgreSQL.
- Email and phone also get an HMAC-SHA256 **blind index** for lookups and uniqueness without plaintext.
- Events, logs and audit rows carry **ids and masked values only**. Services that need contact details call identity-service's internal API.
- KYC images go straight to the (mock) vendor. We store only its reference, as the Guide requires.

### D-17 Events
Topic per event type with dot-separated names (the PDF's style, e.g. `transfer.created`; the Guide's `transfer_approved` style is not used). Key = aggregate id for ordering. **Transactional outbox** on the producer side and an **inbox** table on the consumer side give exactly-once *effects*. Retries 1 s / 5 s / 30 s, then `dlq.<consumer>`. The screening is synchronous (the PDF says Core Engine *calls* Module 2); `compliance.screening-completed` is published for reporting. Details: [kafka.md](kafka.md).

### D-18 API conventions
REST under `/v1`, camelCase JSON, RFC 9457 `application/problem+json` errors with stable `code`s, `Idempotency-Key` required on transfer creation (Redis 24 h + DB unique constraint as a backstop). JWT **RS256**, 15-minute access tokens, 30-day **rotating** refresh tokens in Redis, 5 failed logins → 15-minute lockout. Internal calls use `X-Internal-Token`; each internal operation lists its allowed callers. The gateway builds its route table from `x-owner-service` in the OpenAPI spec (single source of truth). Details: [api.md](api.md).

### D-19 Payment providers
Canada-only senders mean Plaid (US ACH) doesn't apply. Card: mock by default, or Stripe **test mode** (manual-capture PaymentIntents). Bank debit: mock pre-authorised debit (a real Canadian PAD/Interac provider needs a business account). Card data is never stored: only provider ids, brand and last 4.

### D-20 FX rates
Polling a paid feed every 30 s would cost money. We use the free open.er-api.com daily rates with a small simulated movement (±5 bps) every 30 s, so rate-lock expiry and re-quote flows can be tested. Cached in Redis for 60 s; every snapshot is recorded in `fx.rate_snapshots`.

### D-21 Notifications
SMS and email providers are `log`: rendered messages are written to `logs/` so every template can be checked without cost. English first; templates are structured for more languages later (French matters in Canada). SMS ≤ 160 characters.

### D-22 Scope for the first build
In: the responsive web app (≥ 375 px), admin/compliance portal, everything in the PDF's four modules.
Later: mobile apps + biometrics, cash-pickup agent portal (the `agent` role exists for support staff meanwhile), FX hedging, GoCardless, Elasticsearch, data warehouse, rate alerts, status page, the ML fraud model.

### D-23 Migration tool
The PDF suggests Flyway or Liquibase. We use **node-pg-migrate** with plain `.sql` files (`-- Up Migration` / `-- Down Migration`): the files stay readable by every engineer, there's no extra tool to install, and every migration has a tested rollback (`npm run db:reset` runs all downs then all ups).

### D-24 Timeline
The owner asked to ignore the documents' timelines (26 weeks vs 62 days vs 15/18 days). Work proceeds phase by phase with sign-off between phases.

---

## Step 1-2 decisions (shared toolkit, identity-service, gateway)

### D-25 Node toolchain
TypeScript everywhere in Node services, **run directly with tsx** (dev and local "production") and type-checked with
`tsc --noEmit` (`npm run typecheck`). No build step to forget; the code uses only erasable TypeScript syntax, so it also
runs on Node's built-in type stripping. Fastify 5 (fast, JSON-Schema validation built in) and Vitest (tests against the
real local PostgreSQL/Garnet/Kafka). Shared runtime code lives in `packages/service-kit` so every service handles config,
logging, errors, PII encryption, outbox/inbox and internal calls the same way.

### D-26 The contract drives the code
A service registers a handler with `svc.handle('<operationId>', ...)`: the method, path, request validation schema, roles
and callers come from `contracts/openapi`. A service **refuses to start** if it owns an operation it doesn't implement,
and every test checks response bodies against the contract (`assertMatchesContract`). The gateway builds its route table
from the same file. Contract and code cannot drift apart silently.

### D-27 Gateway trust model
The gateway verifies the JWT (RS256, issuer, audience, expiry), checks the session isn't revoked, enforces `x-roles`,
strips any identity headers a client sends, then forwards with `X-Internal-Token`, `X-User-Id`, `X-User-Role`,
`X-Session-Id`. Services bind to 127.0.0.1 and reject any public-route request without the internal token, so the gateway
can't be bypassed. Services still enforce ownership (a customer only ever sees their own data, as 404 otherwise).
Rate limits: 120 requests/min per IP in general and 10/min for sign-up, login, refresh and reset routes (in-memory
counters; several gateways would share a Redis store). Request bodies are forwarded byte-for-byte (webhook signatures).

### D-28 Sessions and tokens
Access token: RS256 JWT, 15 minutes, claims `sub`, `role`, `sid` (session id). **No KYC tier claim**: the tier can change
at any time and belongs to compliance-service (contract description updated). Refresh token: random 256-bit value,
stored as a SHA-256 hash in Redis for 30 days and **rotated on every use**. Presenting an already-used refresh token is
treated as theft and ends the whole session. Logout, password change (other sessions), password reset (all sessions),
suspension and role changes add the session to a revocation list the gateway checks on every request, so tokens die
immediately rather than after 15 minutes.

### D-29 Passwords and lockout
bcrypt (cost 12, `bcryptjs`, no native build needed). 12-128 characters, not a common password, not a single repeated
character, must not contain the email name. Unknown email and wrong password give the same answer and take the same
time. After 5 failures the account locks for 15 minutes (423 + Retry-After), and every attempt is audited.

### D-30 Verification secrets never touch Kafka
Email-verification links (24 h), SMS codes (6 digits, 10 min, 5 attempts) and password-reset links (30 min, single use,
survives a rejected weak password) are stored only as hashes in Redis and delivered straight to the messenger (the log
mailbox `logs/mailbox.log` locally). Events stay free of personal data and secrets (D-16). Resends: 1 per minute and
5 per day per channel. Forgot-password always answers 204 so it can't reveal which emails are registered.

### D-31 Recipient destinations
identity-service can't read fx-service's corridor table (D-03), so recipients are validated against a built-in list
matching the seeded corridors (Pakistan: PKR, bank or JazzCash/Easypaisa; India: INR, bank). **Step 3 replaces it with a
lookup of fx-service's corridors** (done: D-35). Pakistani IBANs are checked (24 characters, mod-97); wallet numbers must be Pakistani
mobile numbers. Payout details are immutable (create a new recipient instead); deleting is a soft delete so past
transfers keep their recipient. Full account/wallet numbers are only returned to payment-service.

### D-32 Test isolation
`npm test` rebuilds the `anchorpay_test` database from the migrations (every down, then every up) and uses a random Redis
key prefix per run, so tests never touch dev data. Kafka tests use `test.*` topics. Coverage target 80 % (enforced in
CI), currently about 95 % of lines.

---

## Step 3 decisions (fx-service, Python toolkit)

### D-33 Python toolkit
`packages/py-service-kit` (`anchorpay_kit`) mirrors the Node kit so every service behaves the same: contract-driven
routes (`@svc.handle("<operationId>")`, JSON Schema 2020-12 validation with query coercion), gateway-only public routes,
`x-callers` on internal routes, problem+json errors, request ids, JSON logs with secrets redacted, outbox relay, audit,
Redis with the shared key prefix, and `assert_matches_contract` for tests. FastAPI is used for routing only (no Pydantic
models) because the contract already defines the schemas. Handlers are plain synchronous functions run in a thread pool:
psycopg's async mode can't use the Windows event loop, and synchronous code is simpler to reason about. Background jobs
(poller, sweeper, relay) are threads started with the service (`on_lifecycle`). Python is linted with ruff; tests use
pytest against the same isolated test database. `npm run py:setup` creates `.venv` (like node_modules, git-ignored).

### D-34 fx-service rules
- **Rates:** the free source is fetched at most once an hour; every 30 s a rate within +/-5 bps of it is published to
  Redis (60 s TTL) and recorded in `fx.rate_snapshots`. If publishing stops, the cached rate expires and **quotes are
  refused (503) rather than priced on a stale rate**. Only pairs of enabled corridors are published.
- **Quotes** live 60 s in Redis and remember the signed-in user (if any). Locking takes the quote (single use), so one
  quote can never be locked for two transfers; a quote made by one user can't be locked for another.
- **Locks** last 30 min (`FX_LOCK_TTL_SECONDS`). Locking is idempotent per transfer + quote; a re-quote releases the
  transfer's previous active lock. `consume` is idempotent; an expired lock answers 409 RATE_LOCK_EXPIRED **after**
  committing the expiry and its `fx.lock-expired` event. A sweeper expires overdue locks every 10 s.
- **Admin pricing changes** (spread, fee, surcharge, limits, enabled) are validated and audited with before/after values.

### D-35 Recipient destinations now come from fx-service
Completes D-31: identity-service reads `GET /internal/fx/corridors` (new internal operation; the `Corridor` schema moved
to `common.yaml` so both APIs share it). The list is cached 5 minutes; if fx-service is down the last good list is used,
and only if identity-service has never seen a list are new recipients refused (503). Disabling a corridor immediately
(within 5 minutes) stops new recipients for that country.

### D-36 Seed migration made rollback-safe (an exception)
Running the full test suites exposed a real bug: `20260926000800_seed_reference_data` could not be rolled back once any
rate lock, KYC profile or ledger entry referenced its rows (the Foundation only ever tested rollback on an empty
database). Its Down now deletes only unreferenced seed rows and its Up is idempotent (`ON CONFLICT DO NOTHING`), so a
rollback followed by a re-apply always works. This edits a migration that was already on `main`, against
docs/database.md rule 1. It was accepted because no environment other than developer laptops exists yet and the change
only affects rollback behaviour. From now on the rule applies without exceptions.

### D-37 Audit writes never fail a request
If the client address isn't a valid IP (the Python test client reports `testclient`), the audit row stores no IP instead
of failing the database insert, and with it the whole request. Applied to both toolkits.


### D-38 transfer-service: crash-safe workflow
Every status change is one database transaction (optimistic version check + history + audit + event). Calls to other
services are made outside transactions and are idempotent per transfer, and four progress markers
(`collect_requested_at`, `payment_captured_at`, `payout_requested_at`, `refund_requested_at`, migration
`20260929000100_transfer_workflow`) record how far a transfer got. A recovery job (every 30 s, transfers unchanged for
60 s) resumes anything left unfinished; see docs/state-machine.md. Timeouts: no payment started 5 min after the lock →
`FAILED PAYMENT_NOT_STARTED`; an unanswered new rate after 24 h → `CANCELLED reconfirm_timeout`. Events that arrive late,
twice or out of order change nothing.

### D-39 Temporary stand-ins for compliance-service and payment-service
Transfers need screening and payments, which are built in Steps 5–6. Until then `services/stand-ins` answers the same
contract operations (same ports, same auth, same events) with in-memory state and scripted outcomes. Magic send
amounts: CAD 13.13 declined, 133.00 blocked, 666.00 flagged for review, 99.99 payout fails (refund), over 10,000
refused by limits. Each stand-in turns itself off as soon as the real service exists (`services/<name>/src/server.ts`),
so nothing has to be removed later. They publish events directly (no outbox) because they have no database.

### D-40 Transfer stats for compliance
`GET /internal/transfers/stats`: counts include every transfer that was not cancelled (velocity rules look at
attempts). Amounts include only money that moved or may still move, so FAILED and REFUNDED transfers are left out and a
declined card doesn't use up the customer's limits. A "round amount" is a whole multiple of CAD 100; the repeat count
excludes the latest transfer itself. `recipientSeenBefore` means at least one earlier, non-cancelled transfer to that
recipient. The contract descriptions were updated to say this.

### D-41 Rate lock expiry and re-quotes
- Lock expires while waiting for the payment authorisation → `CANCELLED` (nothing was charged).
- Screening passes but the lock can't be used any more → `FAILED RATE_LOCK_EXPIRED`, hold released.
- A compliance officer approves after the lock expired → `AWAITING_RECONFIRM`. `requote` asks fx-service for a new quote
  for the same CAD amount and funding method; if the **total charged** would change (e.g. fees changed meanwhile) it
  answers 409 and the customer has to start a new transfer, because the CAD amount never changes after authorisation.
  `reconfirm` locks the new quote and continues to capture.

### D-42 Cancelling and idempotency
- Customers can cancel in `FX_LOCKED`, `ON_HOLD` and `AWAITING_RECONFIRM` only until the transfer is cleared to charge;
  after that a capture may already be under way, so the answer is 409.
- `POST /v1/transfers` keeps each Idempotency-Key for 24 h in Redis (same body → the original response with 200; a
  different body → 409 `IDEMPOTENCY_KEY_REUSED`). If it fails before anything was saved, the key is freed for a retry;
  once the transfer row exists, the failure is remembered, because the database's unique (user, key) would refuse a second
  transfer anyway.
- Failure messages shown to customers never reveal compliance reasons.

### D-43 Toolkit fixes found while building transfer-service
- Internal calls without a body (capture, void) no longer send `content-type: application/json`, which Fastify rejects
  when the body is empty.
- An optional `requestBody` (cancel) now accepts no body in both toolkits; a body that is sent is still validated.
- Test fixtures that share the `core` schema write real ciphertext, because other services' admin screens read every
  row of the shared test database.

---

## Step 5 decisions (payment-service, mock providers, ledger-service)

### D-44 Card payments: mock processor by default, Stripe test mode optional
`CARD_PAYMENT_PROVIDER=mock` (default) uses the card processor in `services/mock-providers`: the authorisation returns
`paymentAction: { type: "mock_card", authorizeUrl }`, the customer fills in a hosted card form (plain HTML, test mode
banner), and the processor reports the result with a signed webhook to the new public operation
`POST /webhooks/mock-card` (same `X-Signature` scheme as the payout partner). Test cards, as in every card sandbox:
`4242 4242 4242 4242` approved, `4000 0000 0000 0002` declined, `4000 0000 0000 9995` insufficient funds.
`CARD_PAYMENT_PROVIDER=stripe` uses manual-capture PaymentIntents (`stripe_card` action with the client secret) and
`/webhooks/stripe`. The adapter refuses anything but `sk_test_` keys. **It has only been tested against a local fake of
the Stripe API**, since no Stripe account is used in this build; try it with free test keys before relying on it.

### D-45 Bank debit
Canadian pre-authorised debit needs a business agreement with a bank, so the mock authorises a debit at once (no
customer step, `paymentAction: none`). To try the unhappy path, any total ending in **.13** bounces
(`bank_debit_returned`), for example CAD 50.14 + 2.99 fee = 53.13.

### D-46 The fee split travels with the payment
`payment.captured` must tell the ledger how much of the charge is fee revenue, but the authorisation request only had the
total. `internalAuthorizePayment` now also requires `fee` and `cardSurcharge` (contract change; transfer-service is the
only caller), stored on `payments.payments` (migration `20260930000100_payments_ledger_workflow`).

### D-47 Payouts
- Created `pending` and sent in the background (first attempt immediately, then a dispatcher every second). The partner
  de-duplicates on our payout id, so a repeated send after a crash is safe; an attempt holds a 2-minute lease.
- **Permanent** reasons (`invalid_account`, `recipient_bank_rejected`, `limit_exceeded`) fail the payout at once
  (`payout.failed`, `final: true`, so transfer-service refunds the sender). **Temporary** reasons (`partner_unavailable`,
  anything unexpected) retry after `PAYOUT_RETRY_BACKOFF_SECONDS` (10 s, 60 s); after `PAYOUT_MAX_ATTEMPTS` (3) the
  payout goes to the **manual queue** (`manual_review`, `payout.failed` with `final: false`).
- From the manual queue an agent or admin can **retry** (one more attempt) and an admin can **fail** it with a note
  (`final: true`, so the sender is refunded). Both are audited. Payouts in other states can't be changed by hand: a
  dispatched payout is in the partner's hands.
- Account and wallet numbers are fetched from identity-service for each attempt and never stored; `payout_attempts`
  keeps a redacted copy of each request (last 4 characters only).
- Mock partner sandbox (by the last 4 digits of the account or wallet number): `0000` invalid account, `1111` partner
  unavailable, `2222` accepted then rejected by the bank, anything else completed after `MOCK_PAYOUT_DELAY_MS` (3 s).

### D-48 Payment safety rules
- Full refunds only, at most one per payment (database unique index): a repeated refund request gets the same refund.
  A refund the processor couldn't be reached for stays `pending` and is retried by the maintenance job (every 30 s).
- A hold that lapses before capture (card holds last about 7 days) fails with `authorization_expired`
  (`payment.failed`, stage `capture`), so the transfer fails instead of trying to charge a dead authorisation.
- If the customer completes the card form after the transfer was cancelled, the new hold is released straight away.
- Webhooks are verified over the exact bytes received (the gateway forwards them unchanged); a bad or old signature is
  refused and never stored, so a forged event can't "use up" a real event id. Duplicates are acknowledged and ignored.

### D-49 Ledger postings
The ledger learns *facts* from events (`ledger.transfer_facts`: captured, payout, failed, refunded, screening) and derives
journals from them, each with a deterministic `ref` (`capture:`, `payout:`, `payout-reversal:`, `refund:`), so every
journal is posted at most once. Kafka only orders events within one topic; deriving journals from facts gives the same
books whatever order they arrive in, with no waiting or retries. Postings (all balanced per currency, enforced by the
database):

| Event | Journal |
|---|---|
| payment.captured | D payment_clearing (total) · C customer_funds (send amount) · C fee_revenue (fee + surcharge) |
| payout.dispatched | D customer_funds · C fx_position (CAD) · D fx_position · C partner_prefund (PKR / INR) |
| transfer FAILED after a payout | the payout journal reversed (the money came back to the partner pre-fund) |
| payment.refunded | D customer_funds · D fee_revenue · C payment_clearing (partial refunds: fees in proportion) |

A payout in a currency without accounts is refused and ends in `dlq.ledger-service` for an operator.

### D-50 Reports
The daily regulatory summary (`/v1/admin/reports/daily-summary`) reads `core` and `compliance` through `ap_reporting`
(read-only on every schema); transfers are counted by UTC day. "Flagged" comes from `compliance.screening-completed`
events (the reason ledger-service consumes that topic). Searching the audit log writes an audit row itself, so there is
a record of who looked at what.

### D-51 Reconciliation
Every night after `RECONCILIATION_HOUR_UTC` (02:00), ledger-service compares the payouts it recorded as dispatched on the
previous UTC day with the payout partner's settlement report for that day, matched by our payout id. Issues:
`missing_at_partner`, `missing_in_ledger` (with what payment-service knows about it), `amount_mismatch`,
`currency_mismatch`, `status_mismatch` (the partner failed it but the ledger didn't reverse it, or the other way round).
A payout the partner still has in flight counts as matched. A day is reconciled once per partner; discrepancies stay open
until an admin resolves them with a note. `npm run ledger:reconcile -- --date=YYYY-MM-DD` runs a day by hand. Known
limit: a payout dispatched seconds before midnight that the partner accepts after midnight shows up as a discrepancy on
both days.

### D-52 Step 5 plumbing
- The payment stand-in is removed (payment-service is real); the compliance stand-in stays until Step 6.
- mock-providers keeps its state in `var/mock-providers/` (git-ignored) so payments and payouts survive a restart,
  and drops each day's settlement report there as a file, as a partner would on SFTP.
- Node toolkit: `createService({ rawBody: true })` keeps the exact request body for signature checks; webhook signing
  and verification helpers. Python toolkit: `InboxConsumer` (inbox, retries, dead letters, after-commit follow-ups) and
  `InternalClient`, mirrors of the Node ones.
