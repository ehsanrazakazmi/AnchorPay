// The Stripe TEST-mode adapter against a local fake of the few Stripe endpoints it uses (no keys, no network).
import Fastify, { type FastifyInstance } from 'fastify';
import { createLogger, createPool, stripeSignatureHeader, uuidv7, type Pool } from '@anchorpay/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPaymentService } from '../src/app.ts';
import { MockPaymentsProvider, ProviderError, StripeCardProvider } from '../src/providers.ts';
import { authorization, cad, eventsFor, expectContract, FakeRecipients, fromTransfers, TOKEN } from './helpers.ts';

const WEBHOOK_SECRET = 'whsec_test_local';
const intents = new Map<string, { id: string; status: string; amount: number; client_secret: string }>();
const requests: { method: string; url: string; idempotencyKey?: string; auth?: string; body: Record<string, string> }[] = [];
let stripe: FastifyInstance;
let stripeUrl: string;
let pool: Pool;
let app: FastifyInstance;
const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;

beforeAll(async () => {
  stripe = Fastify();
  stripe.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, b, done) => done(null, Object.fromEntries(new URLSearchParams(b as string))));
  stripe.addHook('onRequest', async (req) => {
    requests.push({ method: req.method, url: req.url, idempotencyKey: req.headers['idempotency-key'] as string, auth: req.headers.authorization, body: {} });
  });
  stripe.addHook('preHandler', async (req) => {
    requests.at(-1)!.body = (req.body ?? {}) as Record<string, string>;
  });
  const unexpected = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(400).send({ error: { code: 'payment_intent_unexpected_state', message: 'unexpected state' } });
  stripe.post('/v1/payment_intents', async (req) => {
    const id = `pi_${intents.size + 1}`;
    const pi = { id, status: 'requires_payment_method', amount: Number((req.body as Record<string, string>).amount), client_secret: `${id}_secret_abc` };
    intents.set(id, pi);
    return pi;
  });
  stripe.get('/v1/payment_intents/:id', async (req) => intents.get((req.params as { id: string }).id));
  stripe.post('/v1/payment_intents/:id/capture', async (req, reply) => {
    const pi = intents.get((req.params as { id: string }).id)!;
    if (pi.amount === 1313) return reply.code(402).send({ error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'declined' } });
    if (pi.status !== 'requires_capture') return unexpected(reply);
    pi.status = 'succeeded';
    return pi;
  });
  stripe.post('/v1/payment_intents/:id/cancel', async (req, reply) => {
    const pi = intents.get((req.params as { id: string }).id)!;
    if (pi.status === 'canceled') return unexpected(reply);
    pi.status = 'canceled';
    return pi;
  });
  stripe.post('/v1/refunds', async () => ({ id: 're_1', status: 'pending' }));
  stripeUrl = await stripe.listen({ port: 0, host: '127.0.0.1' });

  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  pool = createPool('payments', 'stripe-test');
  const card = new StripeCardProvider({ apiUrl: stripeUrl, secretKey: 'sk_test_local', publishableKey: 'pk_test_local' });
  const built = buildPaymentService({ pool, log: createLogger('stripe-test'), providers: { card, bank_debit: new MockPaymentsProvider('http://127.0.0.1:9', 'x') }, recipients: new FakeRecipients() });
  app = built.service.app;
  await app.ready();
});

afterAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = previousSecret ?? '';
  await app.close();
  await stripe.close();
  await pool.end();
});

function stripeEvent(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: `evt_${uuidv7()}`, type, data: { object } });
  return app.inject({ method: 'POST', url: '/webhooks/stripe', payload: body,
    headers: { 'x-internal-token': TOKEN(), 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, body) } });
}

describe('Stripe test mode', () => {
  it('refuses live keys', () => {
    expect(() => new StripeCardProvider({ apiUrl: stripeUrl, secretKey: 'sk_live_nope' })).toThrow(/TEST key/);
  });

  it('authorises with a manual-capture PaymentIntent, confirmed by webhook, then captures and refunds', async () => {
    const body = authorization();
    const res = expectContract('internalAuthorizePayment',
      await app.inject({ method: 'POST', url: '/internal/payments/authorizations', headers: fromTransfers(), payload: body }), 201);
    expect(res.paymentAction).toEqual({ type: 'stripe_card', clientSecret: expect.stringMatching(/_secret_/), publishableKey: 'pk_test_local' });
    expect(res.payment).toMatchObject({ provider: 'stripe', status: 'requires_action' });
    const create = requests.find((r) => r.url === '/v1/payment_intents')!;
    expect(create).toMatchObject({ auth: 'Bearer sk_test_local', idempotencyKey: `authorize-${res.payment.paymentId}` });
    expect(create.body).toMatchObject({ amount: '51299', currency: 'cad', capture_method: 'manual', 'metadata[paymentId]': res.payment.paymentId });

    const replay = expectContract('internalAuthorizePayment',
      await app.inject({ method: 'POST', url: '/internal/payments/authorizations', headers: fromTransfers(), payload: body }), 201);
    expect(replay.paymentAction.clientSecret).toBe(res.paymentAction.clientSecret); // fetched again from Stripe

    const piId = [...intents.values()].at(-1)!.id;
    intents.get(piId)!.status = 'requires_capture'; // the customer confirmed the card with Stripe Elements
    expect((await stripeEvent('payment_intent.amount_capturable_updated', { id: piId })).statusCode).toBe(200);
    expect((await eventsFor(pool, body.transferId)).map(([type]) => type)).toEqual(['payment.authorized']);

    const pid = res.payment.paymentId;
    const capture = () => app.inject({ method: 'POST', url: `/internal/payments/${pid}/capture`, headers: fromTransfers() });
    expect(expectContract('internalCapturePayment', await capture(), 200).status).toBe('captured');
    // A retried capture after a lost answer: Stripe says "unexpected state", the adapter sees it succeeded.
    await expect(new StripeCardProvider({ apiUrl: stripeUrl, secretKey: 'sk_test_local' }).capture(piId, cad(51299))).resolves.toBeUndefined();

    const refund = await app.inject({ method: 'POST', url: `/internal/payments/${pid}/refunds`, headers: { ...fromTransfers(), 'idempotency-key': body.transferId },
      payload: { amount: cad(51299), reason: 'PAYOUT_FAILED' } });
    expect(expectContract('internalRefundPayment', refund, 202).status).toBe('pending');
    await stripeEvent('refund.updated', { id: 're_1', status: 'succeeded' });
    expect((await eventsFor(pool, body.transferId)).map(([type]) => type)).toEqual(['payment.authorized', 'payment.captured', 'payment.refunded']);
  });

  it('reports declines, and cancels idempotently', async () => {
    const declined = authorization();
    const res = expectContract('internalAuthorizePayment',
      await app.inject({ method: 'POST', url: '/internal/payments/authorizations', headers: fromTransfers(), payload: declined }), 201);
    const piId = [...intents.values()].at(-1)!.id;
    await stripeEvent('payment_intent.payment_failed', { id: piId, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } });
    expect((await eventsFor(pool, declined.transferId)).at(-1)).toEqual(['payment.failed', expect.objectContaining({ failureCode: 'insufficient_funds' })]);
    expect((await stripeEvent('charge.succeeded', { id: 'ch_1' })).statusCode).toBe(200); // not used: stored and ignored

    const card = new StripeCardProvider({ apiUrl: stripeUrl, secretKey: 'sk_test_local' });
    intents.get(piId)!.status = 'requires_capture';
    await card.cancel(piId);
    await card.cancel(piId); // already cancelled: fine
    expect(intents.get(piId)!.status).toBe('canceled');
    intents.get(piId)!.amount = 1313;
    await expect(card.capture(piId, cad(1313))).rejects.toMatchObject({ kind: 'declined', code: 'insufficient_funds' });
    await expect(new StripeCardProvider({ apiUrl: 'http://127.0.0.1:9', secretKey: 'sk_test_x' }).capture('pi_x', cad(1))).rejects.toBeInstanceOf(ProviderError);
    expect(res.payment.status).toBe('requires_action');
  });

  it('rejects a webhook signed with another secret', async () => {
    const body = JSON.stringify({ id: 'evt_x', type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'pi_1' } } });
    const res = await app.inject({ method: 'POST', url: '/webhooks/stripe', payload: body,
      headers: { 'x-internal-token': TOKEN(), 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader('whsec_other', body) } });
    expect(expectContract('stripeWebhook', res, 400).code).toBe('INVALID_SIGNATURE');
  });
});
