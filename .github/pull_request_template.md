## What
<!-- One or two sentences. Link the task/issue. -->

## Why
<!-- The problem this solves. -->

## How it was tested
- [ ] `npm run check` passes
- [ ] `npm run verify` passes locally
- [ ] Unit / integration tests added or updated (coverage target: 80 %, 90 % for transfer, payment, AML)
- [ ] Manually tested (describe):

## Contract / schema changes
- [ ] None
- [ ] `contracts/openapi` changed — callers notified: <!-- @owner -->
- [ ] `contracts/events` changed — consumers notified: <!-- @owner -->
- [ ] New migration in `db/migrations` (never edit a merged one) — `npm run db:reset` passes, ERD regenerated (`npm run db:erd`)

## Security & compliance checklist
- [ ] No secrets, keys or real personal data in code, tests, logs or fixtures
- [ ] No PII in events, logs or audit rows (ids and masked values only)
- [ ] Input validated; authorisation checked (a customer can only reach their own data)
- [ ] Money as integer minor units; rates as decimal strings

## Screenshots (UI changes)
