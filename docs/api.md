# API contracts

- Public API (through the gateway): [`contracts/openapi/public-api.yaml`](../contracts/openapi/public-api.yaml)
- Internal API (service ↔ service): [`contracts/openapi/internal-api.yaml`](../contracts/openapi/internal-api.yaml)
- Shared components: [`contracts/openapi/common.yaml`](../contracts/openapi/common.yaml)
- Browse them: `npm run docs:api` → http://127.0.0.1:8090 (Swagger UI, choose the spec top right)
- Check them: `npm run contracts:lint` (OpenAPI lint + AnchorPay rules)

Frontend work builds against these contracts with mocked responses (MSW) until the services exist (PDF, Module 4 note).
**Do not invent fields**: propose a contract change instead.

## Conventions
| Topic | Rule |
|---|---|
| Versioning | `/v1`. Additive changes (new optional field/endpoint) stay in v1; anything breaking goes to `/v2`. |
| JSON | camelCase. Money = `{ "amountMinor": 50000, "currency": "CAD" }`. Rates = decimal strings. Timestamps = ISO-8601 UTC. |
| Errors | `application/problem+json` with `type, title, status, code, detail, requestId` (+ `errors[]` for validation). Clients branch on `code`. |
| Auth | `Authorization: Bearer <access token>` (RS256, 15 min). Refresh tokens rotate; logout revokes. |
| Roles | `x-roles` per operation: `customer`, `agent`, `compliance_officer`, `admin` (+ `public`, `provider` for no-JWT routes). Customers only ever see their own resources (404, not 403, for other users' ids). |
| Idempotency | `Idempotency-Key` (UUID) is **required** on `POST /v1/transfers`; same key + same body → the original response; same key + different body → 409. |
| Pagination | `page`, `pageSize` (max 100) → `{ data, pageInfo: { page, pageSize, total } }`. |
| Tracing | `X-Request-Id` on every request/response. |
| Rate limits | 429 + `Retry-After`. Login: 5 failures → 15-minute lock. |
| Ownership | `x-owner-service` on every operation (the gateway routes by it). Internal operations also list `x-callers`. |
| Webhooks | No JWT. Signature header (`Stripe-Signature` / `X-Signature` = HMAC-SHA256 of `timestamp.body`); older than 5 min is rejected; duplicate event ids are acknowledged and ignored. |

## Error codes
| Code | HTTP | When |
|---|---|---|
| VALIDATION_ERROR | 400 | Body/params fail the schema |
| UNAUTHENTICATED / INVALID_CREDENTIALS | 401 | Missing/expired token, wrong password |
| ACCOUNT_LOCKED | 423 | Too many failed logins |
| EMAIL_NOT_VERIFIED | 422 | Action needs a verified email |
| FORBIDDEN | 403 | Wrong role |
| NOT_FOUND | 404 | Doesn't exist or not yours |
| ALREADY_EXISTS / CONFLICT | 409 | Duplicate email/phone, concurrent update |
| IDEMPOTENCY_KEY_REUSED | 409 | Same key, different body |
| INVALID_STATE_TRANSITION | 409 | e.g. cancel a completed transfer |
| QUOTE_EXPIRED / RATE_LOCK_EXPIRED | 409 | Get a new quote |
| KYC_REQUIRED / LIMIT_EXCEEDED | 422 | Verify identity / amount above tier limit |
| CORRIDOR_UNAVAILABLE | 422 | Corridor disabled or amount outside min/max |
| PAYMENT_DECLINED | 422 | Card/bank declined |
| RATE_LIMITED | 429 | Slow down |
| INVALID_SIGNATURE | 400 | Webhook signature bad/old |
| INTERNAL_ERROR / SERVICE_UNAVAILABLE | 500 / 503 | Server problem; idempotent calls may be retried |

## Changing a contract
1. Edit the YAML, run `npm run contracts:lint`.
2. If you add or remove fields, update any event schema or migration that mirrors them.
3. PR reviewed by the owning service **and** every caller/consumer owner.
