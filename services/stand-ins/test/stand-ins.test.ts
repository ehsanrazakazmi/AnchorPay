import { assertValidEvent, createLogger, uuidv7, type EventEnvelope } from '@anchorpay/service-kit';
import { assertMatchesContract } from '@anchorpay/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildComplianceStandIn, MAGIC } from '../src/stand-ins.ts';

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
const compliance = buildComplianceStandIn({ publish, log });

beforeAll(async () => {
  await compliance.app.ready();
});
afterAll(async () => {
  await compliance.app.close();
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const eventsFor = (transferId: string) => published.filter((e) => (e.data as { transferId: string }).transferId === transferId).map((e) => e.eventType);

async function call(svc: typeof compliance, operationId: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = fromTransfers, status = 200) {
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
