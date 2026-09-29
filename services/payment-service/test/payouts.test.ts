import { providerSignature, uuidv7 } from '@anchorpay/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asStaff, buildTestServices, cad, eventsFor, expectContract, fromTransfers, pkr, type TestServices } from './helpers.ts';

let t: TestServices;
beforeAll(async () => {
  t = await buildTestServices({ payoutDelayMs: 30 });
});
afterAll(() => t.close());

/** POST /internal/payouts for a new transfer to a wallet whose number decides the partner's answer. */
async function requestPayout(walletNumber = '+923001234567') {
  const recipient = t.recipients.add({ walletNumber });
  const body = { transferId: uuidv7(), transferReference: 'AP-ABCDEFGH', recipientId: recipient.id, amount: pkr(9626375), sendAmount: cad(50000) };
  const res = await t.app.inject({ method: 'POST', url: '/internal/payouts', headers: fromTransfers(), payload: body });
  return { body, recipient, payout: expectContract('internalCreatePayout', res, 202) };
}

const payoutRow = async (id: string) => (await t.pool.query('SELECT * FROM payments.payouts WHERE id = $1', [id])).rows[0];
const settle = async (id: string, statuses: string[]) => {
  await expect.poll(async () => (await payoutRow(id)).status, { timeout: 5000 }).toSatisfy((s: string) => statuses.includes(s));
  return payoutRow(id);
};

describe('payouts', () => {
  it('dispatches in the background and completes when the partner confirms', async () => {
    const { body, payout } = await requestPayout();
    expect(payout).toMatchObject({ transferId: body.transferId, partner: 'mock', method: 'mobile_wallet', amount: pkr(9626375), attempts: 0 });
    const done = await settle(payout.payoutId, ['completed']);
    expect(done).toMatchObject({ attempts: 1, destination_country: 'PK' });
    expect(done.partner_payout_id).toMatch(/^MP-/);
    const events = await eventsFor(t.pool, body.transferId);
    expect(events.map(([type]) => type)).toEqual(['payout.dispatched', 'payout.completed']);
    expect(events[0]![1]).toMatchObject({ payoutId: payout.payoutId, partner: 'mock', amount: pkr(9626375), sendAmount: cad(50000), method: 'mobile_wallet' });

    const again = await t.app.inject({ method: 'POST', url: '/internal/payouts', headers: fromTransfers(), payload: body });
    expect(expectContract('internalCreatePayout', again, 202).payoutId).toBe(payout.payoutId); // idempotent per transfer
    const fetched = expectContract('internalGetPayout', await t.app.inject({ method: 'GET', url: `/internal/payouts/${payout.payoutId}`, headers: asService('ledger-service') }), 200);
    expect(fetched.status).toBe('completed');
  });

  it('stores what was sent without the account number', async () => {
    const { payout } = await requestPayout('+923009876543');
    await settle(payout.payoutId, ['completed']);
    const { rows } = await t.pool.query('SELECT request_redacted FROM payments.payout_attempts WHERE payout_id = $1', [payout.payoutId]);
    expect(JSON.stringify(rows)).not.toContain('9876543');
    expect(rows[0].request_redacted.destination.wallet).toBe('****6543');
  });

  it('fails for good on an invalid account', async () => {
    const { body, payout } = await requestPayout('+923000000000');
    const failed = await settle(payout.payoutId, ['failed']);
    expect(failed.attempts).toBe(1);
    expect(await eventsFor(t.pool, body.transferId)).toEqual([
      ['payout.failed', expect.objectContaining({ final: true, reasonCode: 'invalid_account', attempts: 1 })],
    ]);
  });

  it('fails for good when the bank rejects it after acceptance', async () => {
    const { body, payout } = await requestPayout('+923002222222');
    await settle(payout.payoutId, ['failed']);
    expect((await eventsFor(t.pool, body.transferId)).map(([type, d]) => `${type}${d.final === undefined ? '' : `:${d.final}:${d.reasonCode}`}`))
      .toEqual(['payout.dispatched', 'payout.failed:true:recipient_bank_rejected']);
  });

  it('retries a partner outage, then parks it in the manual queue for an admin', async () => {
    const { body, payout } = await requestPayout('+923001111111');
    await expect.poll(async () => {
      await t.payouts.dispatchDue(); // the background dispatcher's job (retries have no delay in tests)
      return (await payoutRow(payout.payoutId)).status;
    }, { timeout: 5000 }).toBe('manual_review');
    const parked = await payoutRow(payout.payoutId);
    expect(parked.attempts).toBe(3);
    expect(await eventsFor(t.pool, body.transferId)).toEqual([
      ['payout.failed', expect.objectContaining({ final: false, reasonCode: 'partner_unavailable', attempts: 3 })],
    ]);

    const queue = expectContract('adminListPayouts', await t.app.inject({ method: 'GET', url: '/v1/admin/payouts?status=manual_review', headers: asStaff('agent') }), 200);
    expect(queue.data.map((p: { id: string }) => p.id)).toContain(payout.payoutId);

    const retried = await t.app.inject({ method: 'POST', url: `/v1/admin/payouts/${payout.payoutId}/retry`, headers: asStaff('agent') });
    expect(expectContract('adminRetryPayout', retried, 202).status).toBe('pending');
    await settle(payout.payoutId, ['manual_review']);
    expect((await payoutRow(payout.payoutId)).attempts).toBe(4);

    const agentFail = await t.app.inject({ method: 'POST', url: `/v1/admin/payouts/${payout.payoutId}/fail`, headers: asStaff('agent'), payload: { note: 'Partner is down for days.' } });
    expect(agentFail.statusCode).toBe(403);
    const admin = uuidv7();
    const failed = await t.app.inject({ method: 'POST', url: `/v1/admin/payouts/${payout.payoutId}/fail`, headers: asStaff('admin', admin), payload: { note: 'Partner is down for days.' } });
    expect(expectContract('adminFailPayout', failed, 200).status).toBe('failed');
    expect((await eventsFor(t.pool, body.transferId)).at(-1)).toEqual(['payout.failed', expect.objectContaining({ final: true, reasonCode: 'other' })]);
    const again = await t.app.inject({ method: 'POST', url: `/v1/admin/payouts/${payout.payoutId}/retry`, headers: asStaff('admin') });
    expect(expectContract('adminRetryPayout', again, 409).code).toBe('CONFLICT');
  });

  it('keeps retrying while identity-service is unavailable', async () => {
    t.recipients.down = true;
    const recipient = t.recipients.add();
    t.recipients.down = false;
    const body = { transferId: uuidv7(), transferReference: 'AP-ABCDEFGH', recipientId: recipient.id, amount: pkr(100000), sendAmount: cad(500) };
    const res = await t.app.inject({ method: 'POST', url: '/internal/payouts', headers: fromTransfers(), payload: body });
    const payout = expectContract('internalCreatePayout', res, 202);
    t.recipients.down = true;
    try {
      await t.payouts.attempt(payout.payoutId);
    } finally {
      t.recipients.down = false;
    }
    await t.pool.query('UPDATE payments.payouts SET next_attempt_at = now() WHERE id = $1', [payout.payoutId]);
    await t.payouts.dispatchDue();
    await settle(payout.payoutId, ['dispatched', 'completed']);
  });

  it('refuses unknown recipients, a wrong currency, unknown payouts and other callers', async () => {
    const unknown = await t.app.inject({ method: 'POST', url: '/internal/payouts', headers: fromTransfers(),
      payload: { transferId: uuidv7(), transferReference: 'AP-ABCDEFGH', recipientId: uuidv7(), amount: pkr(100), sendAmount: cad(1) } });
    expect(expectContract('internalCreatePayout', unknown, 409).code).toBe('CONFLICT');
    const r = t.recipients.add();
    const currency = await t.app.inject({ method: 'POST', url: '/internal/payouts', headers: fromTransfers(),
      payload: { transferId: uuidv7(), transferReference: 'AP-ABCDEFGH', recipientId: r.id, amount: { amountMinor: 100, currency: 'INR' }, sendAmount: cad(1) } });
    expect(currency.statusCode).toBe(409);
    expect((await t.app.inject({ method: 'GET', url: `/internal/payouts/${uuidv7()}`, headers: fromTransfers() })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/internal/payouts/${uuidv7()}`, headers: asService('fx-service') })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: `/v1/admin/payouts/${uuidv7()}/retry`, headers: asStaff() })).statusCode).toBe(404);
    const customer = await t.app.inject({ method: 'GET', url: '/v1/admin/payouts', headers: { ...asStaff(), 'x-user-role': 'customer' } });
    expect(customer.statusCode).toBe(403);
  });

  it('acknowledges partner events for payouts it does not know', async () => {
    const body = JSON.stringify({ eventId: `evt_${uuidv7()}`, type: 'payout.completed', partnerPayoutId: 'MP-NOPE', reference: 'not-a-uuid', occurredAt: new Date().toISOString() });
    const ts = Math.floor(Date.now() / 1000);
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/payout-partner', payload: body, headers: {
      'x-internal-token': process.env.INTERNAL_SERVICE_TOKEN!, 'content-type': 'application/json', 'x-timestamp': String(ts),
      'x-signature': providerSignature(process.env.MOCK_WEBHOOK_SECRET!, ts, body) } });
    expect(expectContract('payoutPartnerWebhook', res, 200)).toEqual({ received: true });
  });
});
