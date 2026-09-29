import { AppError, uuidv7 } from '@anchorpay/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, buildTestService, collected, customer, expectContract, lockedTransfer, postTransfer, type TestService } from './helpers.ts';

let t: TestService;
beforeAll(() => {
  t = buildTestService();
});
afterAll(() => t.close());

const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: 'GET', url, headers });

/** One customer with several transfers of different amounts. */
async function customerWithTransfers(amounts: number[]) {
  const c = await customer(t);
  const ids: string[] = [];
  for (const sendMinor of amounts) {
    const q = t.ports.addQuote({ sendMinor, fundingMethod: 'bank_debit' });
    const res = await postTransfer(t, c.headers, { quoteId: q.quoteId, recipientId: c.recipient.id, purpose: 'family_support' });
    ids.push(expectContract('createTransfer', res, 201).transfer.id);
  }
  return { ...c, ids };
}

describe('customer transfer history', () => {
  it('lists only my transfers, newest first, with filters and pages', async () => {
    const me = await customerWithTransfers([10000, 20000, 30000]);
    await customerWithTransfers([40000]); // someone else
    const all = expectContract('listTransfers', await get('/v1/transfers', me.headers), 200);
    expect(all.data.map((x: { id: string }) => x.id)).toEqual([...me.ids].reverse());
    expect(all.pageInfo).toEqual({ page: 1, pageSize: 20, total: 3 });

    const page2 = expectContract('listTransfers', await get('/v1/transfers?pageSize=2&page=2', me.headers), 200);
    expect(page2.data.map((x: { id: string }) => x.id)).toEqual([me.ids[0]]);

    const amounts = expectContract('listTransfers', await get('/v1/transfers?minAmountMinor=15000&maxAmountMinor=25000', me.headers), 200);
    expect(amounts.data.map((x: { sendAmount: { amountMinor: number } }) => x.sendAmount.amountMinor)).toEqual([20000]);

    await t.app.inject({ method: 'POST', url: `/v1/transfers/${me.ids[1]}/cancel`, headers: me.headers });
    const cancelled = expectContract('listTransfers', await get('/v1/transfers?status=CANCELLED', me.headers), 200);
    expect(cancelled.data.map((x: { id: string }) => x.id)).toEqual([me.ids[1]]);
    const two = expectContract('listTransfers', await get('/v1/transfers?status=CANCELLED&status=FX_LOCKED', me.headers), 200);
    expect(two.pageInfo.total).toBe(3);

    const today = new Date().toISOString().slice(0, 10);
    const dated = expectContract('listTransfers', await get(`/v1/transfers?from=${today}&to=${today}`, me.headers), 200);
    expect(dated.pageInfo.total).toBe(3);
    const future = expectContract('listTransfers', await get('/v1/transfers?from=2999-01-01', me.headers), 200);
    expect(future.data).toEqual([]);
  });

  it("shows my transfer, 404 for someone else's", async () => {
    const x = await lockedTransfer(t);
    const mine = expectContract('getTransfer', await get(`/v1/transfers/${x.id}`, x.headers), 200);
    expect(mine.id).toBe(x.id);
    const other = await customer(t);
    expect(expectContract('getTransfer', await get(`/v1/transfers/${x.id}`, other.headers), 404).code).toBe('NOT_FOUND');
    expect((await get(`/v1/transfers/${uuidv7()}`, x.headers)).statusCode).toBe(404);
  });

  it('keeps tracking working when identity-service is down (recipient placeholder)', async () => {
    const x = await lockedTransfer(t);
    const fresh = await customer(t);
    const q = t.ports.addQuote();
    const created = expectContract('createTransfer', await postTransfer(t, fresh.headers, { quoteId: q.quoteId, recipientId: fresh.recipient.id, purpose: 'gift' }), 201);
    t.ports.identityDown = true;
    try {
      const cached = expectContract('getTransfer', await get(`/v1/transfers/${x.id}`, x.headers), 200);
      expect(cached.recipient.fullName).toBe('Nasreen Begum'); // served from the 60 s cache
      t.workflow['recipientCache'].clear();
      const shown = expectContract('getTransfer', await get(`/v1/transfers/${created.transfer.id}`, fresh.headers), 200);
      expect(shown.recipient).toEqual({ id: fresh.recipient.id, fullName: 'Your recipient', payoutMethod: 'bank_account', destinationMasked: '' });
    } finally {
      t.ports.identityDown = false;
    }
  });

  it('needs a signed-in customer through the gateway', async () => {
    const noUser = await t.app.inject({ method: 'GET', url: '/v1/transfers', headers: { 'x-internal-token': process.env.INTERNAL_SERVICE_TOKEN! } });
    expect(noUser.statusCode).toBe(401);
    const direct = await t.app.inject({ method: 'GET', url: '/v1/transfers' });
    expect(direct.statusCode).toBe(401);
    const staff = await get('/v1/transfers', asUser(uuidv7(), 'agent'));
    expect(staff.statusCode).toBe(403);
  });

  it('requires a UUID Idempotency-Key', async () => {
    const c = await customer(t);
    const res = await t.app.inject({ method: 'POST', url: '/v1/transfers', headers: { ...c.headers, 'idempotency-key': 'not-a-uuid' },
      payload: { quoteId: uuidv7(), recipientId: c.recipient.id, purpose: 'gift' } });
    expect(expectContract('createTransfer', res, 400).code).toBe('VALIDATION_ERROR');
  });
});

describe('staff search', () => {
  it('finds any transfer by reference, user and status; customers are refused', async () => {
    const a = await customerWithTransfers([11100, 22200]);
    const agent = asUser(uuidv7(), 'agent');
    const reference = expectContract('adminGetTransfer', await get(`/v1/admin/transfers/${a.ids[0]}`, agent), 200).reference;

    const byRef = expectContract('adminSearchTransfers', await get(`/v1/admin/transfers?reference=${reference}`, agent), 200);
    expect(byRef.data.map((x: { id: string }) => x.id)).toEqual([a.ids[0]]);
    const byUser = expectContract('adminSearchTransfers', await get(`/v1/admin/transfers?userId=${a.userId}&status=FX_LOCKED`, asUser(uuidv7(), 'compliance_officer')), 200);
    expect(byUser.pageInfo.total).toBe(2);

    expect(expectContract('adminSearchTransfers', await get('/v1/admin/transfers', a.headers), 403).code).toBe('FORBIDDEN');
    expect(expectContract('adminGetTransfer', await get(`/v1/admin/transfers/${uuidv7()}`, agent), 404).code).toBe('NOT_FOUND');
  });
});

describe('internal API', () => {
  it('returns the internal view to allowed services only', async () => {
    const x = await collected(t);
    const body = expectContract('internalGetTransfer', await get(`/internal/transfers/${x.id}`, asService('payment-service')), 200);
    expect(body).toMatchObject({ id: x.id, status: 'PAYMENT_COLLECTED', userId: x.userId, paymentId: x.row.payment_id, fxLockId: x.row.fx_lock_id });
    expect((await get(`/internal/transfers/${x.id}`, asService('fx-service'))).statusCode).toBe(403);
    expect((await get(`/internal/transfers/${uuidv7()}`, asService('ledger-service'))).statusCode).toBe(404);
  });

  it('reports velocity and structuring stats for compliance', async () => {
    // CAD 500 three times (round), one CAD 123.45, one cancelled CAD 900, one that fails on payment.
    const c = await customerWithTransfers([50000, 12345, 50000, 90000, 50000]);
    await t.app.inject({ method: 'POST', url: `/v1/transfers/${c.ids[3]}/cancel`, headers: c.headers });
    t.ports.authorizeError = new AppError('SERVICE_UNAVAILABLE', 'down');
    const q = t.ports.addQuote({ sendMinor: 70000, fundingMethod: 'bank_debit' });
    await postTransfer(t, c.headers, { quoteId: q.quoteId, recipientId: c.recipient.id, purpose: 'gift' });
    t.ports.authorizeError = null;
    // The latest non-cancelled transfer is CAD 700 (failed): not a repeat of anything.
    const url = (extra = '') => `/internal/transfers/stats?userId=${c.userId}${extra}`;
    const stats = expectContract('internalTransferStats', await get(url(`&recipientId=${c.recipient.id}`), asService('compliance-service')), 200);
    expect(stats).toEqual({
      countLast1h: 5, countLast24h: 5,
      amountLast24h: { amountMinor: 50000 * 3 + 12345, currency: 'CAD' }, amountLast30d: { amountMinor: 50000 * 3 + 12345, currency: 'CAD' },
      recentRoundAmountRepeats: 0, recipientSeenBefore: true,
    });

    const q2 = t.ports.addQuote({ sendMinor: 50000, fundingMethod: 'bank_debit' });
    await postTransfer(t, c.headers, { quoteId: q2.quoteId, recipientId: c.recipient.id, purpose: 'gift' });
    const again = expectContract('internalTransferStats', await get(url(), asService('compliance-service')), 200);
    expect(again.recentRoundAmountRepeats).toBe(3);
    expect(again).not.toHaveProperty('recipientSeenBefore');

    const newcomer = await customer(t);
    const none = expectContract('internalTransferStats',
      await get(`/internal/transfers/stats?userId=${newcomer.userId}&recipientId=${newcomer.recipient.id}`, asService('compliance-service')), 200);
    expect(none).toMatchObject({ countLast24h: 0, amountLast30d: { amountMinor: 0 }, recentRoundAmountRepeats: 0, recipientSeenBefore: false });
    expect((await get(url(), asService('payment-service'))).statusCode).toBe(403);
  });
});
