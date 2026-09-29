import { assertValidEvent, createLogger, uuidv7, type EventEnvelope } from '@anchorpay/service-kit';
import { assertMatchesContract } from '@anchorpay/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildComplianceStandIn, buildPaymentStandIn, MAGIC, type Lookups } from '../src/stand-ins.ts';

const TOKEN = () => process.env.INTERNAL_SERVICE_TOKEN!;
const fromTransfers = { 'x-internal-token': TOKEN(), 'x-calling-service': 'transfer-service' };
const officer = uuidv7();
const asOfficer = { 'x-internal-token': TOKEN(), 'x-user-id': officer, 'x-user-role': 'compliance_officer', 'x-session-id': 's' };
const cad = (amountMinor: number) => ({ amountMinor, currency: 'CAD' });

const published: EventEnvelope<unknown>[] = [];
const publish = async (event: EventEnvelope<unknown>) => {
  assertValidEvent(event);
  published.push(event);
};
const log = createLogger('stand-ins-test');
const sendAmounts = new Map<string, number>();
const lookups: Lookups = {
  async transfer(id) {
    return { sendAmount: cad(sendAmounts.get(id) ?? 50000), fee: cad(299), cardSurcharge: cad(1000) };
  },
  async payoutMethod() {
    return 'mobile_wallet';
  },
};
const compliance = buildComplianceStandIn({ publish, log });
const payments = buildPaymentStandIn({ publish, log, lookups, delays: { authorize: 0, refund: 0, dispatch: 0, complete: 0 } });

beforeAll(async () => {
  await Promise.all([compliance.app.ready(), payments.app.ready()]);
});
afterAll(async () => {
  await Promise.all([compliance.app.close(), payments.app.close()]);
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const eventsFor = (transferId: string) => published.filter((e) => (e.data as { transferId: string }).transferId === transferId).map((e) => e.eventType);

async function call(svc: typeof payments, operationId: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = fromTransfers, status = 200) {
  const res = await svc.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  if (res.statusCode !== status) throw new Error(`${operationId}: expected ${status}, got ${res.statusCode}: ${res.body}`);
  assertMatchesContract(operationId, status, res.json());
  return res.json();
}

const screening = (sendMinor: number) => ({
  transferId: uuidv7(), transferReference: 'AP-ABCDEFGH', userId: uuidv7(), recipientId: uuidv7(), corridorCode: 'CA-PK',
  sendAmount: cad(sendMinor), receiveAmount: { amountMinor: sendMinor * 200, currency: 'PKR' }, fundingMethod: 'card', purpose: 'gift',
});

describe('compliance stand-in', () => {
  it('passes, blocks and flags by the magic amounts', async () => {
    const pass = await call(compliance, 'internalScreenTransfer', 'POST', '/internal/compliance/screenings', screening(50000));
    expect(pass.decision).toBe('pass');
    const block = await call(compliance, 'internalScreenTransfer', 'POST', '/internal/compliance/screenings', screening(MAGIC.blocked));
    expect(block).toMatchObject({ decision: 'block', reasonCode: 'COMPLIANCE_BLOCKED' });
    const flagged = screening(MAGIC.flagged);
    const flag = await call(compliance, 'internalScreenTransfer', 'POST', '/internal/compliance/screenings', flagged);
    expect(flag).toMatchObject({ decision: 'flag', reviewCaseId: expect.any(String) });
    await settle();
    expect(eventsFor(flagged.transferId)).toEqual(['compliance.screening-completed']);

    const open = await call(compliance, 'listReviewCases', 'GET', '/v1/admin/review-cases?status=open', undefined, asOfficer);
    expect(open.data.map((c: { id: string }) => c.id)).toContain(flag.reviewCaseId);
    const decided = await call(compliance, 'decideReviewCase', 'POST', `/v1/admin/review-cases/${flag.reviewCaseId}/decision`,
      { decision: 'approve', note: 'Checked the source of funds.' }, asOfficer);
    expect(decided).toMatchObject({ status: 'approved', decidedBy: officer });
    await settle();
    expect(eventsFor(flagged.transferId)).toEqual(['compliance.screening-completed', 'compliance.review-decided']);
    const twice = await compliance.app.inject({ method: 'POST', url: `/v1/admin/review-cases/${flag.reviewCaseId}/decision`, headers: asOfficer,
      payload: { decision: 'reject', note: 'Changed my mind here.' } });
    expect(twice.statusCode).toBe(409);
    const missing = await compliance.app.inject({ method: 'POST', url: `/v1/admin/review-cases/${uuidv7()}/decision`, headers: asOfficer,
      payload: { decision: 'reject', note: 'No such case exists.' } });
    expect(missing.statusCode).toBe(404);
  });

  it('allows normal amounts and refuses very large ones', async () => {
    const ok = await call(compliance, 'internalCheckLimits', 'POST', '/internal/compliance/limit-checks', { userId: uuidv7(), sendAmount: cad(50000) });
    expect(ok).toMatchObject({ allowed: true, kycTier: 2, kycStatus: 'APPROVED' });
    const big = await call(compliance, 'internalCheckLimits', 'POST', '/internal/compliance/limit-checks', { userId: uuidv7(), sendAmount: cad(MAGIC.limit + 1) });
    expect(big).toMatchObject({ allowed: false, reasonCode: 'LIMIT_EXCEEDED' });
  });
});

describe('payment stand-in', () => {
  const authorize = (transferId: string) => call(payments, 'internalAuthorizePayment', 'POST', '/internal/payments/authorizations',
    { transferId, userId: uuidv7(), method: 'card', amount: cad(51299) }, fromTransfers, 201);

  it('authorises, captures, pays out and completes', async () => {
    const transferId = uuidv7();
    const auth = await authorize(transferId);
    expect(auth).toMatchObject({ payment: { status: 'authorized', provider: 'mock' }, paymentAction: { type: 'none' } });
    expect((await authorize(transferId)).payment.paymentId).toBe(auth.payment.paymentId); // idempotent per transfer
    const paymentId = auth.payment.paymentId;
    const captured = await call(payments, 'internalCapturePayment', 'POST', `/internal/payments/${paymentId}/capture`);
    expect(captured.status).toBe('captured');
    expect((await call(payments, 'internalCapturePayment', 'POST', `/internal/payments/${paymentId}/capture`)).status).toBe('captured');
    const voided = await payments.app.inject({ method: 'POST', url: `/internal/payments/${paymentId}/void`, headers: fromTransfers });
    expect(voided.statusCode).toBe(409);

    const payout = await call(payments, 'internalCreatePayout', 'POST', '/internal/payouts', {
      transferId, transferReference: 'AP-ABCDEFGH', recipientId: uuidv7(), amount: { amountMinor: 10178495, currency: 'PKR' }, sendAmount: cad(50000),
    }, fromTransfers, 202);
    expect(payout).toMatchObject({ method: 'mobile_wallet', status: 'pending' });
    await settle();
    expect(eventsFor(transferId)).toEqual(['payment.authorized', 'payment.captured', 'payout.dispatched', 'payout.completed']);
    const fetched = await call(payments, 'internalGetPayout', 'GET', `/internal/payouts/${payout.payoutId}`, undefined,
      { 'x-internal-token': TOKEN(), 'x-calling-service': 'ledger-service' });
    expect(fetched.status).toBe('completed');
  });

  it('declines CAD 13.13, voids holds, and refunds once per key', async () => {
    const declined = uuidv7();
    sendAmounts.set(declined, MAGIC.declined);
    await authorize(declined);
    await settle();
    expect(eventsFor(declined)).toEqual(['payment.failed']);

    const held = await authorize(uuidv7());
    const voided = await call(payments, 'internalVoidPayment', 'POST', `/internal/payments/${held.payment.paymentId}/void`);
    expect(voided.status).toBe('voided');
    const late = await payments.app.inject({ method: 'POST', url: `/internal/payments/${held.payment.paymentId}/capture`, headers: fromTransfers });
    expect(late.statusCode).toBe(409);

    const transferId = uuidv7();
    const p = (await authorize(transferId)).payment.paymentId;
    const early = await payments.app.inject({ method: 'POST', url: `/internal/payments/${p}/refunds`, headers: { ...fromTransfers, 'idempotency-key': transferId },
      payload: { amount: cad(51299), reason: 'PAYOUT_FAILED' } });
    expect(early.statusCode).toBe(409);
    await call(payments, 'internalCapturePayment', 'POST', `/internal/payments/${p}/capture`);
    const refund = () => call(payments, 'internalRefundPayment', 'POST', `/internal/payments/${p}/refunds`, { amount: cad(51299), reason: 'PAYOUT_FAILED' },
      { ...fromTransfers, 'idempotency-key': transferId }, 202);
    const first = await refund();
    expect((await refund()).refundId).toBe(first.refundId);
    await settle();
    expect(eventsFor(transferId).filter((e) => e === 'payment.refunded')).toHaveLength(1);
    expect((await payments.app.inject({ method: 'POST', url: `/internal/payments/${uuidv7()}/capture`, headers: fromTransfers })).statusCode).toBe(404);
  });

  it('fails the CAD 99.99 payout for good', async () => {
    const transferId = uuidv7();
    await call(payments, 'internalCreatePayout', 'POST', '/internal/payouts', {
      transferId, transferReference: 'AP-ABCDEFGH', recipientId: uuidv7(), amount: { amountMinor: 2000000, currency: 'PKR' }, sendAmount: cad(MAGIC.payoutFails),
    }, fromTransfers, 202);
    await settle();
    const failed = published.find((e) => e.eventType === 'payout.failed' && (e.data as { transferId: string }).transferId === transferId);
    expect(failed?.data).toMatchObject({ final: true, reasonCode: 'recipient_bank_rejected' });
    expect((await payments.app.inject({ method: 'GET', url: `/internal/payouts/${uuidv7()}`, headers: fromTransfers })).statusCode).toBe(404);
  });
});
