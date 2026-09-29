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
lookup of fx-service's corridors.** Pakistani IBANs are checked (24 characters, mod-97); wallet numbers must be Pakistani
mobile numbers. Payout details are immutable (create a new recipient instead); deleting is a soft delete so past
transfers keep their recipient. Full account/wallet numbers are only returned to payment-service.

### D-32 Test isolation
`npm test` rebuilds the `anchorpay_test` database from the migrations (every down, then every up) and uses a random Redis
key prefix per run, so tests never touch dev data. Kafka tests use `test.*` topics. Coverage target 80 % (enforced in
CI), currently about 95 % of lines.
