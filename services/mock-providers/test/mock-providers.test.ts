import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createLogger } from '@anchorpay/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockProviders } from '../src/app.ts';
import { Partner } from '../src/partner.ts';
import { TEST_CARDS, validateCard } from '../src/payments.ts';
import { Store } from '../src/store.ts';
import { httpDeliverer } from '../src/webhooks.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'anchorpay-mock-'));
const delivered: { path: string; event: Record<string, any> }[] = [];
const mock = buildMockProviders({
  dataDir, payoutDelayMs: 10, log: createLogger('mock-test'), publicUrl: 'http://mock.test',
  deliver: async (path, event) => {
    delivered.push({ path, event });
  },
});
const app = mock.service.app;
const key = () => ({ authorization: `Bearer ${process.env.MOCK_WEBHOOK_SECRET}` });
const cad = (amountMinor: number) => ({ amountMinor, currency: 'CAD' });

beforeAll(() => app.ready());
afterAll(async () => {
  mock.partner.stop();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function cardPayment(reference = `ref-${Math.random()}`) {
  const res = await app.inject({ method: 'POST', url: '/payments', headers: key(), payload: { reference, method: 'card', amount: cad(51299), returnUrl: 'http://web.test/back' } });
  return res.json();
}

describe('card form', () => {
  it('validates card number (Luhn), expiry and CVC', () => {
    expect(validateCard({ cardNumber: '4242 4242 4242 4242', expiry: '12/39', cvc: '123' })).toEqual({});
    expect(Object.keys(validateCard({ cardNumber: '4242 4242 4242 4241', expiry: '01/20', cvc: '1' }))).toEqual(['cardNumber', 'expiry', 'cvc']);
    expect(validateCard({ cardNumber: TEST_CARDS.declined, expiry: '13/39', cvc: '1234' })).toHaveProperty('expiry');
  });

  it('shows the hosted page, re-shows it with errors, and redirects back after authorising', async () => {
    const p = await cardPayment();
    expect(p).toMatchObject({ status: 'requires_action', authorizeUrl: `http://mock.test/card/authorize/${p.id}` });
    const page = await app.inject({ method: 'GET', url: `/card/authorize/${p.id}` });
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('CAD 512.99');
    expect(page.body).toContain('TEST MODE');

    const form = (fields: Record<string, string>) => app.inject({ method: 'POST', url: `/card/authorize/${p.id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
    const bad = await form({ cardNumber: '1234', expiry: '12/39', cvc: '123' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('aria-invalid="true"');

    const ok = await form({ cardNumber: TEST_CARDS.success, expiry: '12/39', cvc: '123' });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('http://web.test/back?payment=authorized');
    expect(delivered.at(-1)).toMatchObject({ path: '/webhooks/mock-card', event: { type: 'card.authorized', reference: p.reference, cardLast4: '4242', cardBrand: 'visa' } });

    const done = await app.inject({ method: 'GET', url: `/card/authorize/${p.id}` });
    expect(done.body).toContain('authorized');
    expect((await form({ cardNumber: TEST_CARDS.success, expiry: '12/39', cvc: '123' })).body).toContain('Already done');
    expect((await app.inject({ method: 'GET', url: '/card/authorize/mpi_nope' })).statusCode).toBe(404);
  });

  it('declines the decline test card', async () => {
    const p = await cardPayment();
    const res = await app.inject({ method: 'POST', url: `/card/authorize/${p.id}`, payload: { cardNumber: TEST_CARDS.declined, expiry: '12/39', cvc: '123' } });
    expect(res.json()).toMatchObject({ status: 'declined', redirectUrl: 'http://web.test/back?payment=declined' });
    expect(delivered.at(-1)!.event).toMatchObject({ type: 'card.declined', failureCode: 'card_declined' });
  });
});

describe('processor API', () => {
  it('needs the API key and is idempotent per reference', async () => {
    const noKey = await app.inject({ method: 'POST', url: '/payments', payload: { reference: 'x', method: 'card', amount: cad(1) } });
    expect(noKey.statusCode).toBe(401);
    const first = await cardPayment('same-ref');
    expect((await cardPayment('same-ref')).id).toBe(first.id);
    const invalid = await app.inject({ method: 'POST', url: '/payments', headers: key(), payload: { reference: 'y', method: 'cash' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('captures, cancels and refunds with the right state rules', async () => {
    const debit = (await app.inject({ method: 'POST', url: '/payments', headers: key(), payload: { reference: 'debit-1', method: 'bank_debit', amount: cad(50299) } })).json();
    expect(debit.status).toBe('authorized');
    const call = (path: string, payload?: object) => app.inject({ method: 'POST', url: `/payments/${debit.id}${path}`, headers: key(), ...(payload ? { payload } : {}) });
    expect((await call('/refunds', { amount: cad(50299), idempotencyKey: 'k' })).statusCode).toBe(409);
    expect((await call('/capture', { amount: cad(50299) })).json().status).toBe('captured');
    expect((await call('/capture', { amount: cad(50299) })).statusCode).toBe(200);
    expect((await call('/cancel')).statusCode).toBe(409);
    expect((await call('/refunds', { amount: cad(99999), idempotencyKey: 'k' })).statusCode).toBe(400);
    const refund = await call('/refunds', { amount: cad(50299), idempotencyKey: 'k' });
    expect(refund.statusCode).toBe(201);
    expect((await call('/refunds', { amount: cad(50299), idempotencyKey: 'k' })).json().refundId).toBe(refund.json().refundId);

    const held = (await app.inject({ method: 'POST', url: '/payments', headers: key(), payload: { reference: 'debit-2', method: 'bank_debit', amount: cad(1000) } })).json();
    mock.store.payments.get(held.id)!.authorizationExpiresAt = new Date(Date.now() - 1000).toISOString();
    const expired = await app.inject({ method: 'POST', url: `/payments/${held.id}/capture`, headers: key(), payload: { amount: cad(1000) } });
    expect(expired.json()).toMatchObject({ code: 'PAYMENT_DECLINED', detail: 'authorization_expired' });
    expect((await app.inject({ method: 'POST', url: `/payments/${held.id}/cancel`, headers: key() })).json().status).toBe('canceled');
    expect((await app.inject({ method: 'GET', url: `/payments/${held.id}`, headers: key() })).json().status).toBe('canceled');
    expect((await app.inject({ method: 'GET', url: '/payments/nope', headers: key() })).statusCode).toBe(404);
  });
});

describe('payout partner', () => {
  const payout = (reference: string, walletNumber: string) => app.inject({ method: 'POST', url: '/partner/payouts', headers: key(), payload: {
    reference, amount: { amountMinor: 9626375, currency: 'PKR' }, method: 'mobile_wallet',
    destination: { country: 'PK', fullName: 'Nasreen Begum', walletProvider: 'jazzcash', walletNumber },
  } });

  it('follows the sandbox rules and reports the day in a settlement file', async () => {
    const ok = await payout('po-ok', '+923001234567');
    expect(ok.statusCode).toBe(202);
    expect((await payout('po-ok', '+923001234567')).json().partnerPayoutId).toBe(ok.json().partnerPayoutId);
    expect((await payout('po-invalid', '+923000000000')).statusCode).toBe(422);
    expect((await payout('po-invalid', '+923000000000')).statusCode).toBe(422); // same answer again
    expect((await payout('po-down', '+923001111111')).statusCode).toBe(503);
    await payout('po-bank', '+923002222222');
    await expect.poll(() => delivered.filter((d) => d.path === '/webhooks/payout-partner' && d.event.type !== 'payout.accepted').length).toBe(2);
    expect(delivered.filter((d) => d.event.type === 'payout.failed')[0]!.event).toMatchObject({ reference: 'po-bank', failureCode: 'recipient_bank_rejected' });

    const partnerId = ok.json().partnerPayoutId;
    expect((await app.inject({ method: 'GET', url: `/partner/payouts/${partnerId}`, headers: key() })).json().status).toBe('completed');
    const today = new Date().toISOString().slice(0, 10);
    const report = (await app.inject({ method: 'GET', url: `/partner/settlements?date=${today}`, headers: key() })).json();
    expect(report.items.map((i: { reference: string; status: string }) => `${i.reference}:${i.status}`)).toEqual(['po-ok:completed', 'po-bank:failed']);
    expect(JSON.parse(readFileSync(join(dataDir, 'settlements', `${today}.json`), 'utf8')).items).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/partner/settlements?date=yesterday', headers: key() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/partner/payouts/MP-NOPE', headers: key() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/partner/payouts', headers: key(), payload: { reference: 'x' } })).statusCode).toBe(400);
  });

  it('keeps its state across restarts and finishes payouts that were in flight', async () => {
    expect(existsSync(join(dataDir, 'state.json'))).toBe(true);
    const reloaded = new Store(dataDir);
    expect(reloaded.paymentByReference('same-ref')).toBeDefined();
    expect(reloaded.payoutByReference('po-ok')?.status).toBe('completed');

    // A payout accepted just before a "crash": the restarted partner completes it.
    const inFlight = reloaded.payoutByReference('po-ok')!;
    Object.assign(inFlight, { status: 'accepted', outcome: 'complete', settlesAt: new Date().toISOString() });
    const events: string[] = [];
    const partner = new Partner({ store: reloaded, deliver: async (_p, e) => void events.push(String(e.type)), log: createLogger('mock-test'), dataDir: null, delayMs: 0 });
    partner.resume();
    await expect.poll(() => events).toEqual(['payout.completed']);
    partner.stop();
  });
});

describe('webhook delivery', () => {
  it('signs, retries on 5xx and gives up after the last delay', async () => {
    const receiver = Fastify();
    const seen: { signature?: string; timestamp?: string }[] = [];
    let failures = 1;
    receiver.post('/hook', async (req, reply) => {
      seen.push({ signature: req.headers['x-signature'] as string, timestamp: req.headers['x-timestamp'] as string });
      return failures-- > 0 ? reply.code(503).send() : reply.send({ received: true });
    });
    receiver.post('/refuse', async (_req, reply) => reply.code(400).send());
    const url = await receiver.listen({ port: 0, host: '127.0.0.1' });
    const deliver = httpDeliverer({ baseUrl: url, secret: 's', log: createLogger('mock-test'), delaysMs: [10] });
    await deliver('/hook', { eventId: 'evt_1' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.signature).toMatch(/^[0-9a-f]{64}$/);
    failures = 5;
    await deliver('/hook', { eventId: 'evt_2' }); // gives up after one retry
    await deliver('/refuse', { eventId: 'evt_3' }); // 4xx: not retried
    await httpDeliverer({ baseUrl: 'http://127.0.0.1:9', secret: 's', log: createLogger('mock-test'), delaysMs: [] })('/x', { eventId: 'evt_4' });
    await receiver.close();
  });
});
