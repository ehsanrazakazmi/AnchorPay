import { randomUUID } from 'node:crypto';
import { AppError, uuidv7 } from '@anchorpay/service-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestService, collected, customer, events, expectContract, lockedTransfer, postTransfer, row, type TestService,
} from './helpers.ts';

let t: TestService;
beforeAll(() => {
  t = buildTestService();
});
afterAll(() => t.close());
beforeEach(() => {
  // Every test starts from well-behaved dependencies.
  Object.assign(t.ports, {
    limits: { allowed: true, kycTier: 2, kycStatus: 'APPROVED' }, screening: 'pass', identityDown: false, lockError: null, consumeError: null,
    authorizeError: null, captureError: null, payoutError: null, refundError: null, nextFeeMinor: null,
  });
  t.ports.calls.length = 0;
});

const view = async (id: string, headers: Record<string, string>) =>
  expectContract('getTransfer', await t.app.inject({ method: 'GET', url: `/v1/transfers/${id}`, headers }), 200);

async function statusEvents(id: string) {
  const { rows } = await t.pool.query<{ payload: { data: { fromStatus: string | null; toStatus: string } } }>(
    "SELECT payload FROM core.outbox WHERE topic = 'transfer.status-changed' AND message_key = $1 ORDER BY created_at, id", [id],
  );
  return rows.map((r) => `${r.payload.data.fromStatus ?? '-'}>${r.payload.data.toStatus}`);
}

describe('creating a transfer', () => {
  it('locks the quoted rate, holds the payment and publishes transfer.created (D-08 worked example)', async () => {
    const x = await lockedTransfer(t);
    expect(x.transfer).toMatchObject({
      status: 'FX_LOCKED', corridorCode: 'CA-PK', fundingMethod: 'card', sendAmount: { amountMinor: 50000, currency: 'CAD' },
      totalCharge: { amountMinor: 51299, currency: 'CAD' }, receiveAmount: { amountMinor: 10178495, currency: 'PKR' },
      offerRate: '203.5699000000', deliveryEstimate: 'Within minutes', allowedActions: ['authorize_payment', 'cancel'],
      recipient: { fullName: 'Nasreen Begum', payoutMethod: 'bank_account', destinationMasked: 'Standard Chartered ****6702' },
    });
    expect(x.transfer.reference).toMatch(/^AP-[2-9A-HJ-NP-TV-Z]{8}$/);
    expect(x.paymentAction).toEqual({ type: 'none' });
    expect(x.transfer.timeline.map((s: { status: string }) => s.status)).toEqual(['INITIATED', 'FX_LOCKED']);
    expect(t.ports.called('authorizePayment')[0]!.arg).toMatchObject({ transferId: x.id, amount: { amountMinor: 51299 } });

    const r = await row(t, x.id);
    expect(r.payment_id).toBeTruthy();
    expect(r.fx_lock_id).toBeTruthy();
    const { rows } = await t.pool.query("SELECT payload FROM core.outbox WHERE topic = 'transfer.created' AND message_key = $1", [x.id]);
    expect(rows[0].payload.data).toMatchObject({ transferId: x.id, totalCharge: { amountMinor: 51299 }, receiveAmount: { amountMinor: 10178495 } });
    expect(await statusEvents(x.id)).toEqual(['->INITIATED', 'INITIATED>FX_LOCKED']);
  });

  it('replays the same request and refuses the key with a different body', async () => {
    const c = await customer(t);
    const q = t.ports.addQuote();
    const key = randomUUID();
    const body = { quoteId: q.quoteId, recipientId: c.recipient.id, purpose: 'gift' };
    const first = expectContract('createTransfer', await postTransfer(t, c.headers, body, key), 201);
    const again = expectContract('createTransfer', await postTransfer(t, c.headers, { purpose: 'gift', recipientId: c.recipient.id, quoteId: q.quoteId }, key), 200);
    expect(again.transfer.id).toBe(first.transfer.id);
    const other = await postTransfer(t, c.headers, { ...body, purpose: 'education' }, key);
    expect(expectContract('createTransfer', other, 409).code).toBe('IDEMPOTENCY_KEY_REUSED');
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM core.transfers WHERE user_id = $1', [c.userId]);
    expect(rows[0].n).toBe(1);
  });

  it('rejects an expired quote and frees the key for a retry', async () => {
    const c = await customer(t);
    const key = randomUUID();
    const res = await postTransfer(t, c.headers, { quoteId: uuidv7(), recipientId: c.recipient.id, purpose: 'gift' }, key);
    expect(expectContract('createTransfer', res, 409).code).toBe('QUOTE_EXPIRED');
    const q = t.ports.addQuote();
    const retry = await postTransfer(t, c.headers, { quoteId: q.quoteId, recipientId: c.recipient.id, purpose: 'gift' }, key);
    expect(retry.statusCode).toBe(201);
  });

  it("refuses someone else's, a deleted or a wrong-country recipient", async () => {
    const a = await customer(t);
    const b = await customer(t);
    const q = t.ports.addQuote();
    const theirs = await postTransfer(t, a.headers, { quoteId: q.quoteId, recipientId: b.recipient.id, purpose: 'gift' });
    expect(expectContract('createTransfer', theirs, 404).code).toBe('NOT_FOUND');
    const gone = t.ports.addRecipient(a.userId, { deletedAt: new Date().toISOString() });
    expect((await postTransfer(t, a.headers, { quoteId: q.quoteId, recipientId: gone.id, purpose: 'gift' })).statusCode).toBe(404);
    const india = await customer(t, { country: 'IN', currency: 'INR' });
    const res = await postTransfer(t, india.headers, { quoteId: t.ports.addQuote().quoteId, recipientId: india.recipient.id, purpose: 'gift' });
    expect(expectContract('createTransfer', res, 422).code).toBe('CORRIDOR_UNAVAILABLE');
  });

  it('enforces KYC and limits before anything is locked', async () => {
    const c = await customer(t);
    for (const reasonCode of ['KYC_REQUIRED', 'LIMIT_EXCEEDED'] as const) {
      t.ports.limits = { allowed: false, reasonCode, kycTier: 0, kycStatus: 'PENDING' };
      const res = await postTransfer(t, c.headers, { quoteId: t.ports.addQuote().quoteId, recipientId: c.recipient.id, purpose: 'gift' });
      expect(expectContract('createTransfer', res, 422).code).toBe(reasonCode);
    }
    expect(t.ports.called('lockRate')).toHaveLength(0);
  });

  it('fails cleanly when the rate cannot be locked', async () => {
    const c = await customer(t);
    t.ports.lockError = new AppError('SERVICE_UNAVAILABLE', 'fx down');
    const res = await postTransfer(t, c.headers, { quoteId: t.ports.addQuote().quoteId, recipientId: c.recipient.id, purpose: 'gift' });
    expect(expectContract('createTransfer', res, 503).code).toBe('SERVICE_UNAVAILABLE');
    const { rows } = await t.pool.query('SELECT status, failure_code FROM core.transfers WHERE user_id = $1', [c.userId]);
    expect(rows).toEqual([{ status: 'FAILED', failure_code: 'RATE_LOCK_FAILED' }]);
  });

  it('fails and releases the lock when the payment provider is down', async () => {
    const c = await customer(t);
    t.ports.authorizeError = new AppError('SERVICE_UNAVAILABLE', 'payments down');
    const res = await postTransfer(t, c.headers, { quoteId: t.ports.addQuote().quoteId, recipientId: c.recipient.id, purpose: 'gift' });
    expect(res.statusCode).toBe(503);
    const { rows } = await t.pool.query('SELECT id, status, failure_code FROM core.transfers WHERE user_id = $1', [c.userId]);
    expect(rows[0]).toMatchObject({ status: 'FAILED', failure_code: 'PAYMENT_UNAVAILABLE' });
    expect(t.ports.called('releaseLock')).toHaveLength(1);
    const failed = await view(rows[0].id, c.headers);
    expect(failed.failure).toEqual({ code: 'PAYMENT_UNAVAILABLE', message: expect.stringContaining('not charged') });
  });
});

describe('happy path', () => {
  it('screens, captures, pays out and completes', async () => {
    const x = await lockedTransfer(t);
    const r = await row(t, x.id);
    await events.authorized(t, x.id, r.payment_id!, x.transfer.totalCharge);

    const paid = await row(t, x.id);
    expect(paid).toMatchObject({ status: 'PAYMENT_COLLECTED', compliance_decision: 'pass' });
    expect(paid.payment_captured_at).toBeInstanceOf(Date);
    expect(paid.payout_requested_at).toBeInstanceOf(Date);
    expect(t.ports.locks.get(r.fx_lock_id!)!.status).toBe('consumed');
    expect(t.ports.payments.get(r.payment_id!)!.status).toBe('captured');
    expect(t.ports.called('screen')[0]!.arg).toMatchObject({ transferId: x.id, sendAmount: { amountMinor: 50000 }, receiveAmount: { amountMinor: 10178495 } });
    expect(t.ports.called('createPayout')[0]!.arg).toMatchObject({ transferId: x.id, amount: { amountMinor: 10178495, currency: 'PKR' } });

    await events.dispatched(t, x.id, paid.payout_id!, x.transfer.receiveAmount, x.transfer.sendAmount);
    expect((await row(t, x.id)).status).toBe('PAYOUT_DISPATCHED');
    await events.completed(t, x.id, paid.payout_id!);
    const done = await view(x.id, x.headers);
    expect(done).toMatchObject({ status: 'COMPLETED', allowedActions: [], completedAt: expect.any(String) });
    expect(done.timeline.map((s: { status: string }) => s.status)).toEqual([
      'INITIATED', 'FX_LOCKED', 'COMPLIANCE_SCREENING', 'PAYMENT_COLLECTED', 'PAYOUT_DISPATCHED', 'COMPLETED',
    ]);
    expect(await statusEvents(x.id)).toHaveLength(6);
    const audit = await t.reporting.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_id = $1 AND action = 'transfer.status_changed'", [x.id]);
    expect(audit.rows[0].n).toBe(6);
  });

  it('completes even when payout.completed arrives before payout.dispatched', async () => {
    const x = await collected(t);
    await events.completed(t, x.id, x.row.payout_id!);
    const done = await row(t, x.id);
    expect(done.status).toBe('COMPLETED');
    await events.dispatched(t, x.id, x.row.payout_id!, x.transfer.receiveAmount, x.transfer.sendAmount); // late and ignored
    expect((await row(t, x.id)).status).toBe('COMPLETED');
  });

  it('ignores events for unknown transfers and duplicate deliveries of old states', async () => {
    await events.completed(t, uuidv7(), uuidv7());
    const x = await collected(t);
    await events.authorized(t, x.id, x.row.payment_id!, x.transfer.totalCharge); // late duplicate
    expect((await row(t, x.id)).status).toBe('PAYMENT_COLLECTED');
    expect(t.ports.called('capturePayment')).toHaveLength(1);
  });
});

describe('payment problems', () => {
  it('a declined card fails the transfer and releases the rate lock', async () => {
    const x = await lockedTransfer(t);
    const r = await row(t, x.id);
    await events.paymentFailed(t, x.id, r.payment_id!);
    const failed = await view(x.id, x.headers);
    expect(failed).toMatchObject({ status: 'FAILED', failure: { code: 'PAYMENT_DECLINED' } });
    expect(t.ports.locks.get(r.fx_lock_id!)!.status).toBe('released');
  });

  it('a capture refused by the provider fails the transfer without charging', async () => {
    const x = await lockedTransfer(t);
    t.ports.captureError = new AppError('PAYMENT_DECLINED', 'authorisation expired');
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    const r = await row(t, x.id);
    expect(r).toMatchObject({ status: 'FAILED', failure_code: 'CAPTURE_FAILED', payment_captured_at: null });
    expect(t.ports.called('refundPayment')).toHaveLength(0);
  });

  it('a capture outage leaves the transfer for the recovery job, which finishes it', async () => {
    const x = await lockedTransfer(t);
    t.ports.captureError = new AppError('SERVICE_UNAVAILABLE', 'payments down', { status: 503 });
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    expect(await row(t, x.id)).toMatchObject({ status: 'COMPLIANCE_SCREENING', payment_captured_at: null });
    t.ports.captureError = null;
    const later = new Date(Date.now() + 120_000);
    expect(await t.workflow.recover({ now: later, transferIds: [x.id] })).toBe(1);
    expect(await row(t, x.id)).toMatchObject({ status: 'PAYMENT_COLLECTED' });
  });

  it('the rate lock expiring before capture fails the transfer (nothing charged)', async () => {
    const x = await lockedTransfer(t);
    t.ports.consumeError = new AppError('RATE_LOCK_EXPIRED');
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    expect(await row(t, x.id)).toMatchObject({ status: 'FAILED', failure_code: 'RATE_LOCK_EXPIRED' });
    expect(t.ports.called('capturePayment')).toHaveLength(0);
    expect(t.ports.called('voidPayment')).toHaveLength(1);
  });

  it('a lock that expires before the payment is authorised cancels the transfer; a late authorisation is voided', async () => {
    const x = await lockedTransfer(t);
    const r = await row(t, x.id);
    await events.lockExpired(t, x.id, r.fx_lock_id!);
    expect(await row(t, x.id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'rate_lock_expired' });
    t.ports.calls.length = 0;
    await events.authorized(t, x.id, r.payment_id!, x.transfer.totalCharge);
    expect(t.ports.called('voidPayment').map((c) => c.arg)).toEqual([r.payment_id]);
    await events.lockExpired(t, x.id, uuidv7()); // an old lock's expiry changes nothing
  });
});

describe('compliance outcomes', () => {
  it('a block fails the transfer and releases the hold', async () => {
    const x = await lockedTransfer(t);
    t.ports.screening = 'block';
    const r = await row(t, x.id);
    await events.authorized(t, x.id, r.payment_id!, x.transfer.totalCharge);
    const failed = await view(x.id, x.headers);
    expect(failed).toMatchObject({ status: 'FAILED', failure: { code: 'COMPLIANCE_BLOCKED' } });
    expect(failed.failure.message).not.toMatch(/sanction/i);
    expect(t.ports.payments.get(r.payment_id!)!.status).toBe('voided');
    expect(t.ports.locks.get(r.fx_lock_id!)!.status).toBe('released');
  });

  it('a flag holds the transfer; approval collects it', async () => {
    const x = await lockedTransfer(t);
    t.ports.screening = 'flag';
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    const held = await view(x.id, x.headers);
    expect(held).toMatchObject({ status: 'ON_HOLD', allowedActions: ['cancel'] });
    expect((await row(t, x.id)).review_case_id).toBeTruthy();
    expect(t.ports.called('capturePayment')).toHaveLength(0);
    await events.reviewed(t, x.id, 'approve');
    expect(await row(t, x.id)).toMatchObject({ status: 'PAYMENT_COLLECTED', compliance_decision: 'pass' });
    const history = await t.pool.query("SELECT actor_type FROM core.transfer_status_history WHERE transfer_id = $1 AND to_status = 'PAYMENT_COLLECTED'", [x.id]);
    expect(history.rows[0].actor_type).toBe('system');
  });

  it('a rejection fails the held transfer and releases the hold', async () => {
    const x = await lockedTransfer(t);
    t.ports.screening = 'flag';
    const r = await row(t, x.id);
    await events.authorized(t, x.id, r.payment_id!, x.transfer.totalCharge);
    await events.reviewed(t, x.id, 'reject');
    expect(await row(t, x.id)).toMatchObject({ status: 'FAILED', failure_code: 'COMPLIANCE_REJECTED' });
    expect(t.ports.payments.get(r.payment_id!)!.status).toBe('voided');
    const history = await t.pool.query("SELECT actor_type FROM core.transfer_status_history WHERE transfer_id = $1 AND to_status = 'FAILED'", [x.id]);
    expect(history.rows[0].actor_type).toBe('staff');
  });

  it('approval after the lock expired asks the customer to accept a new rate (requote + reconfirm)', async () => {
    const x = await lockedTransfer(t);
    t.ports.screening = 'flag';
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    await t.pool.query("UPDATE core.transfers SET rate_lock_expires_at = now() - interval '1 minute' WHERE id = $1", [x.id]);
    await events.reviewed(t, x.id, 'approve');
    const waiting = await view(x.id, x.headers);
    expect(waiting).toMatchObject({ status: 'AWAITING_RECONFIRM', allowedActions: ['reconfirm', 'cancel'] });

    const quote = expectContract('requoteTransfer', await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/requote`, headers: x.headers }), 200);
    expect(quote).toMatchObject({ totalCharge: { amountMinor: 51299 }, receiveAmount: { amountMinor: 50000 * 205 }, offerRate: '205.0000' });

    const res = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/reconfirm`, headers: x.headers, payload: { quoteId: quote.quoteId } });
    const done = expectContract('reconfirmTransfer', res, 200);
    expect(done).toMatchObject({ status: 'PAYMENT_COLLECTED', receiveAmount: { amountMinor: 50000 * 205 }, offerRate: '205.0000000000' });
    expect((await row(t, x.id)).quote_id).toBe(quote.quoteId);
  });

  it('approval with a lock that fx-service already expired also asks for a new rate', async () => {
    const x = await lockedTransfer(t);
    t.ports.screening = 'flag';
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    t.ports.consumeError = new AppError('RATE_LOCK_EXPIRED');
    await events.reviewed(t, x.id, 'approve');
    expect(await row(t, x.id)).toMatchObject({ status: 'AWAITING_RECONFIRM', collect_requested_at: null });
  });

  it('refuses a requote when the fees changed, and reconfirm only in AWAITING_RECONFIRM', async () => {
    const x = await lockedTransfer(t);
    const early = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/reconfirm`, headers: x.headers, payload: { quoteId: uuidv7() } });
    expect(expectContract('reconfirmTransfer', early, 409).code).toBe('INVALID_STATE_TRANSITION');
    t.ports.screening = 'flag';
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    await t.pool.query("UPDATE core.transfers SET rate_lock_expires_at = now() - interval '1 minute' WHERE id = $1", [x.id]);
    await events.reviewed(t, x.id, 'approve');
    t.ports.nextFeeMinor = 499;
    const res = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/requote`, headers: x.headers });
    expect(expectContract('requoteTransfer', res, 409).code).toBe('CONFLICT');
    const expired = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/reconfirm`, headers: x.headers, payload: { quoteId: uuidv7() } });
    expect(expectContract('reconfirmTransfer', expired, 409).code).toBe('QUOTE_EXPIRED');
  });
});

describe('cancelling', () => {
  it('cancels before capture and releases the hold and the lock', async () => {
    const x = await lockedTransfer(t);
    const r = await row(t, x.id);
    const res = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/cancel`, headers: x.headers, payload: { reason: 'Wrong recipient' } });
    expect(expectContract('cancelTransfer', res, 200)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Wrong recipient', allowedActions: [] });
    expect(t.ports.payments.get(r.payment_id!)!.status).toBe('voided');
    expect(t.ports.locks.get(r.fx_lock_id!)!.status).toBe('released');
  });

  it('cancels without a body', async () => {
    const x = await lockedTransfer(t);
    const invalid = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/cancel`, headers: x.headers, payload: { reason: 'x'.repeat(501) } });
    expect(invalid.statusCode).toBe(400); // an optional body is still validated when it is sent
    const res = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/cancel`, headers: x.headers });
    expect(expectContract('cancelTransfer', res, 200).cancelReason).toBe('customer_request');
  });

  it('refuses once the money is collected, and hides other customers\' transfers', async () => {
    const x = await collected(t);
    const res = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/cancel`, headers: x.headers });
    expect(expectContract('cancelTransfer', res, 409).code).toBe('INVALID_STATE_TRANSITION');
    const other = await customer(t);
    const theirs = await t.app.inject({ method: 'POST', url: `/v1/transfers/${x.id}/cancel`, headers: other.headers });
    expect(expectContract('cancelTransfer', theirs, 404).code).toBe('NOT_FOUND');
  });
});

describe('payout problems', () => {
  it('a final payout failure refunds the sender', async () => {
    const x = await collected(t);
    await events.dispatched(t, x.id, x.row.payout_id ?? uuidv7(), x.transfer.receiveAmount, x.transfer.sendAmount);
    await events.payoutFailed(t, x.id, uuidv7(), true);
    const failed = await row(t, x.id);
    expect(failed).toMatchObject({ status: 'FAILED', failure_code: 'PAYOUT_FAILED', failure_reason: 'recipient_bank_rejected' });
    expect(failed.refund_requested_at).toBeInstanceOf(Date);
    expect(t.ports.called('refundPayment')[0]!.arg).toMatchObject({ paymentId: x.row.payment_id, idempotencyKey: x.id, amount: { amountMinor: 51299 } });
    await events.refunded(t, x.id, x.row.payment_id!, x.transfer.totalCharge);
    const refunded = await view(x.id, x.headers);
    expect(refunded).toMatchObject({ status: 'REFUNDED', failure: { code: 'PAYOUT_FAILED', message: expect.stringContaining('refunded') } });
  });

  it('a retryable payout failure only notes the problem', async () => {
    const x = await collected(t);
    await events.payoutFailed(t, x.id, uuidv7(), false);
    expect(await row(t, x.id)).toMatchObject({ status: 'PAYMENT_COLLECTED', failure_reason: 'payout_manual_review:recipient_bank_rejected' });
  });
});

describe('recovery job', () => {
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  it('resumes a payout request that failed and a refund that failed', async () => {
    t.ports.payoutError = new AppError('SERVICE_UNAVAILABLE', 'down', { status: 503 });
    const x = await collected(t);
    expect(x.row.payout_requested_at).toBeNull();
    t.ports.payoutError = null;
    await t.workflow.recover({ now: later(2), transferIds: [x.id] });
    expect((await row(t, x.id)).payout_requested_at).toBeInstanceOf(Date);

    t.ports.refundError = new AppError('SERVICE_UNAVAILABLE', 'down', { status: 503 });
    await events.payoutFailed(t, x.id, uuidv7(), true);
    expect((await row(t, x.id)).refund_requested_at).toBeNull();
    t.ports.refundError = null;
    await t.workflow.recover({ now: later(2), transferIds: [x.id] });
    expect((await row(t, x.id)).refund_requested_at).toBeInstanceOf(Date);
  });

  it('screens a transfer whose screening call failed', async () => {
    const x = await lockedTransfer(t);
    const original = t.ports.screen.bind(t.ports);
    t.ports.screen = async () => {
      throw new AppError('SERVICE_UNAVAILABLE', 'compliance down', { status: 503 });
    };
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    expect((await row(t, x.id)).status).toBe('COMPLIANCE_SCREENING');
    t.ports.screen = original;
    await t.workflow.recover({ now: later(2), transferIds: [x.id] });
    expect((await row(t, x.id)).status).toBe('PAYMENT_COLLECTED');
  });

  it('ends transfers that can no longer finish', async () => {
    const expired = await lockedTransfer(t);
    await t.pool.query("UPDATE core.transfers SET rate_lock_expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    const neverPaid = await lockedTransfer(t);
    await t.pool.query('UPDATE core.transfers SET payment_id = NULL WHERE id = $1', [neverPaid.id]);
    const stillFine = await lockedTransfer(t);

    await t.workflow.recover({ now: later(10), transferIds: [expired.id, neverPaid.id] });
    await t.workflow.recover({ now: later(2), transferIds: [stillFine.id] });
    expect(await row(t, expired.id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'rate_lock_expired' });
    expect(await row(t, neverPaid.id)).toMatchObject({ status: 'FAILED', failure_code: 'PAYMENT_NOT_STARTED' });
    expect((await row(t, stillFine.id)).status).toBe('FX_LOCKED');
  });

  it('cancels a new-rate offer nobody answered within 24 hours', async () => {
    const x = await lockedTransfer(t);
    t.ports.screening = 'flag';
    await events.authorized(t, x.id, (await row(t, x.id)).payment_id!, x.transfer.totalCharge);
    t.ports.consumeError = new AppError('RATE_LOCK_EXPIRED');
    await events.reviewed(t, x.id, 'approve');
    await t.workflow.recover({ now: later(60), transferIds: [x.id] });
    expect((await row(t, x.id)).status).toBe('AWAITING_RECONFIRM');
    await t.workflow.recover({ now: later(25 * 60), transferIds: [x.id] });
    expect(await row(t, x.id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'reconfirm_timeout' });
  });

  it('fails a transfer stuck in INITIATED (crash between insert and lock)', async () => {
    const c = await customer(t);
    const { rows } = await t.pool.query(
      `INSERT INTO core.transfers (reference, user_id, recipient_id, idempotency_key, corridor_code, funding_method, purpose, send_currency,
                                   send_amount_minor, fee_minor, total_charge_minor, receive_currency)
       VALUES ('AP-TESTSTK1', $1, $2, $3, 'CA-PK', 'bank_debit', 'gift', 'CAD', 1000, 0, 1000, 'PKR') RETURNING id`,
      [c.userId, c.recipient.id, randomUUID()],
    );
    await t.workflow.recover({ now: later(2), transferIds: [rows[0].id] });
    expect(await row(t, rows[0].id)).toMatchObject({ status: 'FAILED', failure_code: 'SETUP_INCOMPLETE' });
  });
});
