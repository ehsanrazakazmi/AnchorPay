import { createLogger, providerSignature, uuidv7 } from '@anchorpay/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPaymentService } from '../src/app.ts';
import { MockPaymentsProvider } from '../src/providers.ts';
import { authorization, buildTestServices, cad, eventsFor, expectContract, fromTransfers, TOKEN, type TestServices } from './helpers.ts';

let t: TestServices;
beforeAll(async () => {
  t = await buildTestServices();
});
afterAll(() => t.close());

const authorize = (body: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/internal/payments/authorizations', headers: fromTransfers(), payload: body });
const post = (url: string, payload?: Record<string, unknown>, headers: Record<string, string> = fromTransfers()) =>
  t.app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
const row = async (id: string) => (await t.pool.query('SELECT * FROM payments.payments WHERE id = $1', [id])).rows[0];

/** The customer fills in the mock card form (JSON variant of the HTML form post). */
async function fillCardForm(authorizeUrl: string, cardNumber = '4242 4242 4242 4242') {
  const path = new URL(authorizeUrl).pathname;
  const res = await fetch(`${t.mockUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardNumber, expiry: '12/39', cvc: '123' }),
  });
  await expect.poll(() => t.delivered.length, { timeout: 5000 }).toBeGreaterThan(0);
  return res.json();
}

async function authorizedCard(overrides: Record<string, unknown> = {}) {
  const body = authorization(overrides);
  const res = expectContract('internalAuthorizePayment', await authorize(body), 201);
  const before = t.delivered.length;
  await fillCardForm(res.paymentAction.authorizeUrl);
  await expect.poll(() => t.delivered.length, { timeout: 5000 }).toBeGreaterThan(before);
  return { body, paymentId: res.payment.paymentId as string };
}

describe('card authorisation (mock processor)', () => {
  it('holds the funds after the customer completes the card form', async () => {
    const body = authorization();
    const res = expectContract('internalAuthorizePayment', await authorize(body), 201);
    expect(res.payment).toMatchObject({ status: 'requires_action', provider: 'mock', method: 'card', amount: cad(51299) });
    expect(res.paymentAction).toEqual({ type: 'mock_card', authorizeUrl: expect.stringMatching(/^http:\/\/mock\.test\/card\/authorize\/mpi_/) });

    const replay = expectContract('internalAuthorizePayment', await authorize(body), 201);
    expect(replay.payment.paymentId).toBe(res.payment.paymentId);
    expect(replay.paymentAction).toEqual(res.paymentAction);

    const before = t.delivered.length;
    expect(await fillCardForm(res.paymentAction.authorizeUrl)).toMatchObject({ status: 'authorized', redirectUrl: `${body.returnUrl}?payment=authorized` });
    await expect.poll(() => t.delivered.length).toBeGreaterThan(before);
    expect(t.delivered.at(-1)).toMatchObject({ path: '/webhooks/mock-card', status: 200 });

    const p = await row(res.payment.paymentId);
    expect(p).toMatchObject({ status: 'authorized', card_brand: 'visa', card_last4: '4242' });
    expect(p.authorization_expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    const events = await eventsFor(t.pool, body.transferId);
    expect(events).toEqual([['payment.authorized', expect.objectContaining({ paymentId: p.id, amount: cad(51299), method: 'card' })]]);
  });

  it('a declined card fails the payment and says why', async () => {
    const body = authorization();
    const res = expectContract('internalAuthorizePayment', await authorize(body), 201);
    await fillCardForm(res.paymentAction.authorizeUrl, '4000 0000 0000 9995');
    await expect.poll(async () => (await row(res.payment.paymentId)).status).toBe('failed');
    expect((await row(res.payment.paymentId)).failure_code).toBe('insufficient_funds');
    expect(await eventsFor(t.pool, body.transferId)).toEqual([
      ['payment.failed', expect.objectContaining({ stage: 'authorization', failureCode: 'insufficient_funds' })],
    ]);
  });

  it('rejects a fee split that does not fit the amount', async () => {
    const res = await authorize(authorization({ fee: cad(51299) }));
    expect(expectContract('internalAuthorizePayment', res, 400).code).toBe('VALIDATION_ERROR');
    const other = await authorize(authorization({ cardSurcharge: { amountMinor: 1, currency: 'USD' } }));
    expect(other.statusCode).toBe(400);
  });

  it('answers 503 and fails the payment when the processor is unreachable', async () => {
    const dead = new MockPaymentsProvider('http://127.0.0.1:9', 'x');
    const svc = buildPaymentService({ pool: t.pool, log: createLogger('payment-test'), providers: { card: dead, bank_debit: dead }, recipients: t.recipients });
    const body = authorization();
    const res = await svc.service.app.inject({ method: 'POST', url: '/internal/payments/authorizations', headers: fromTransfers(), payload: body });
    expect(res.statusCode).toBe(503);
    const { rows } = await t.pool.query('SELECT status, failure_code FROM payments.payments WHERE transfer_id = $1', [body.transferId]);
    expect(rows[0]).toEqual({ status: 'failed', failure_code: 'provider_error' });
    await svc.service.app.close();
  });
});

describe('bank debit (mock pre-authorised debit)', () => {
  it('is authorised at once; a total ending in .13 bounces', async () => {
    const ok = authorization({ method: 'bank_debit', amount: cad(50299), cardSurcharge: cad(0) });
    const res = expectContract('internalAuthorizePayment', await authorize(ok), 201);
    expect(res).toMatchObject({ payment: { status: 'authorized' }, paymentAction: { type: 'none' } });
    expect((await eventsFor(t.pool, ok.transferId)).map(([type]) => type)).toEqual(['payment.authorized']);

    const bounced = authorization({ method: 'bank_debit', amount: cad(5313), cardSurcharge: cad(0) });
    const failed = expectContract('internalAuthorizePayment', await authorize(bounced), 201);
    expect(failed.payment).toMatchObject({ status: 'failed', failureCode: 'bank_debit_returned' });
    expect(await eventsFor(t.pool, bounced.transferId)).toEqual([
      ['payment.failed', expect.objectContaining({ stage: 'authorization', failureCode: 'bank_debit_returned' })],
    ]);
  });
});

describe('capture, void and refund', () => {
  it('captures once, with the fee split for the ledger', async () => {
    const { body, paymentId } = await authorizedCard();
    const captured = expectContract('internalCapturePayment', await post(`/internal/payments/${paymentId}/capture`), 200);
    expect(captured.status).toBe('captured');
    expectContract('internalCapturePayment', await post(`/internal/payments/${paymentId}/capture`), 200); // replay
    const events = await eventsFor(t.pool, body.transferId);
    expect(events.filter(([type]) => type === 'payment.captured')).toEqual([
      ['payment.captured', expect.objectContaining({ amount: cad(51299), fee: cad(299), cardSurcharge: cad(1000), method: 'card' })],
    ]);
    const voided = await post(`/internal/payments/${paymentId}/void`);
    expect(expectContract('internalVoidPayment', voided, 409).code).toBe('CONFLICT');
  });

  it("can't capture a payment the customer hasn't authorised, or an unknown one", async () => {
    const res = expectContract('internalAuthorizePayment', await authorize(authorization()), 201);
    const early = await post(`/internal/payments/${res.payment.paymentId}/capture`);
    expect(expectContract('internalCapturePayment', early, 409).code).toBe('CONFLICT');
    expect((await post(`/internal/payments/${uuidv7()}/capture`)).statusCode).toBe(404);
  });

  it('an expired hold is declined at capture (and reported)', async () => {
    const { body, paymentId } = await authorizedCard();
    await t.pool.query("UPDATE payments.payments SET authorization_expires_at = now() - interval '1 minute' WHERE id = $1", [paymentId]);
    const res = await post(`/internal/payments/${paymentId}/capture`);
    expect(expectContract('internalCapturePayment', res, 422).code).toBe('PAYMENT_DECLINED');
    expect((await eventsFor(t.pool, body.transferId)).at(-1)).toEqual(['payment.failed', expect.objectContaining({ stage: 'capture', failureCode: 'authorization_expired' })]);
  });

  it('voids a hold (idempotent) and releases it at the processor', async () => {
    const { paymentId } = await authorizedCard();
    const voided = expectContract('internalVoidPayment', await post(`/internal/payments/${paymentId}/void`), 200);
    expect(voided.status).toBe('voided');
    expectContract('internalVoidPayment', await post(`/internal/payments/${paymentId}/void`), 200);
    const providerId = (await row(paymentId)).provider_payment_id;
    expect(t.mock.store.payments.get(providerId)!.status).toBe('canceled');
  });

  it('releases a hold that arrives after the payment was voided', async () => {
    const res = expectContract('internalAuthorizePayment', await authorize(authorization()), 201);
    await post(`/internal/payments/${res.payment.paymentId}/void`);
    const providerId = (await row(res.payment.paymentId)).provider_payment_id;
    await fillCardForm(res.paymentAction.authorizeUrl);
    await expect.poll(() => t.mock.store.payments.get(providerId)!.status).toBe('canceled');
    expect((await row(res.payment.paymentId)).status).toBe('voided');
  });

  it('refunds a captured payment once', async () => {
    const { body, paymentId } = await authorizedCard();
    await post(`/internal/payments/${paymentId}/capture`);
    const headers = { ...fromTransfers(), 'idempotency-key': body.transferId as string };
    const refund = () => t.app.inject({ method: 'POST', url: `/internal/payments/${paymentId}/refunds`, headers, payload: { amount: cad(51299), reason: 'PAYOUT_FAILED' } });
    const first = expectContract('internalRefundPayment', await refund(), 202);
    expect(first).toMatchObject({ paymentId, transferId: body.transferId, status: 'succeeded', amount: cad(51299) });
    expect(expectContract('internalRefundPayment', await refund(), 202).refundId).toBe(first.refundId);
    expect((await row(paymentId)).status).toBe('refunded');
    expect((await eventsFor(t.pool, body.transferId)).filter(([type]) => type === 'payment.refunded')).toHaveLength(1);
  });

  it("refuses to refund what wasn't captured, or more than was charged", async () => {
    const { paymentId } = await authorizedCard();
    const headers = { ...fromTransfers(), 'idempotency-key': uuidv7() };
    const early = await t.app.inject({ method: 'POST', url: `/internal/payments/${paymentId}/refunds`, headers, payload: { amount: cad(100), reason: 'x' } });
    expect(early.statusCode).toBe(409);
    await post(`/internal/payments/${paymentId}/capture`);
    const tooMuch = await t.app.inject({ method: 'POST', url: `/internal/payments/${paymentId}/refunds`, headers, payload: { amount: cad(99999), reason: 'x' } });
    expect(tooMuch.statusCode).toBe(400);
  });
});

describe('maintenance job', () => {
  it('fails holds that lapsed and retries refunds that never reached the processor', async () => {
    const { body, paymentId } = await authorizedCard();
    await t.pool.query("UPDATE payments.payments SET authorization_expires_at = now() - interval '1 minute' WHERE id = $1", [paymentId]);

    const captured = await authorizedCard();
    await post(`/internal/payments/${captured.paymentId}/capture`);
    const { rows: [refund] } = await t.pool.query(
      "INSERT INTO payments.refunds (payment_id, transfer_id, amount_minor, currency, reason, created_at) VALUES ($1, $2, 51299, 'CAD', 'PAYOUT_FAILED', now() - interval '1 minute') RETURNING id",
      [captured.paymentId, captured.body.transferId]);

    const result = await t.payments.maintain();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await row(paymentId)).failure_code).toBe('authorization_expired');
    expect((await eventsFor(t.pool, body.transferId)).at(-1)?.[0]).toBe('payment.failed');
    const { rows } = await t.pool.query('SELECT status, provider_refund_id FROM payments.refunds WHERE id = $1', [refund.id]);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].provider_refund_id).toMatch(/^mre_/);
  });
});

describe('webhook security', () => {
  const signed = (body: string, ts = Math.floor(Date.now() / 1000), secret = process.env.MOCK_WEBHOOK_SECRET!) => ({
    'x-internal-token': TOKEN(), 'content-type': 'application/json', 'x-timestamp': String(ts), 'x-signature': providerSignature(secret, ts, body),
  });
  const cardEvent = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    eventId: `evt_${uuidv7()}`, type: 'card.authorized', paymentIntentId: 'mpi_unknown', reference: uuidv7(), occurredAt: new Date().toISOString(), ...overrides,
  });

  it('refuses a wrong, missing or old signature and never stores those events', async () => {
    const body = cardEvent();
    const wrong = await t.app.inject({ method: 'POST', url: '/webhooks/mock-card', payload: body, headers: signed(body, undefined, 'not-the-secret') });
    expect(expectContract('mockCardWebhook', wrong, 400).code).toBe('INVALID_SIGNATURE');
    const old = await t.app.inject({ method: 'POST', url: '/webhooks/mock-card', payload: body, headers: signed(body, Math.floor(Date.now() / 1000) - 3600) });
    expect(old.statusCode).toBe(400);
    const none = await t.app.inject({ method: 'POST', url: '/webhooks/payout-partner', payload: body, headers: { 'x-internal-token': TOKEN(), 'content-type': 'application/json' } });
    expect(none.statusCode).toBe(400);
    const tampered = await t.app.inject({ method: 'POST', url: '/webhooks/mock-card', payload: body.replace('card.authorized', 'card.declined'), headers: signed(body) });
    expect(tampered.statusCode).toBe(400);
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM payments.webhook_events WHERE provider_event_id = $1", [JSON.parse(body).eventId]);
    expect(rows[0].n).toBe(0);
  });

  it('acknowledges unknown payments and duplicates without acting', async () => {
    const body = cardEvent();
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/mock-card', payload: body, headers: signed(body) });
    expect(expectContract('mockCardWebhook', res, 200)).toEqual({ received: true });
    const again = await t.app.inject({ method: 'POST', url: '/webhooks/mock-card', payload: body, headers: signed(body) });
    expect(again.statusCode).toBe(200);
    const { rows } = await t.pool.query('SELECT processing_error FROM payments.webhook_events WHERE provider_event_id = $1', [JSON.parse(body).eventId]);
    expect(rows).toEqual([{ processing_error: 'unknown payment' }]);
  });

  it('refuses Stripe webhooks while Stripe is not configured', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/stripe', payload: { id: 'evt_1', type: 'payment_intent.succeeded' },
      headers: { 'x-internal-token': TOKEN(), 'stripe-signature': 't=1,v1=abc' } });
    expect(expectContract('stripeWebhook', res, 400).code).toBe('INVALID_SIGNATURE');
  });

  it('only transfer-service may move money', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/internal/payments/authorizations', headers: { 'x-internal-token': TOKEN(), 'x-calling-service': 'fx-service' },
      payload: authorization() });
    expect(res.statusCode).toBe(403);
  });
});
