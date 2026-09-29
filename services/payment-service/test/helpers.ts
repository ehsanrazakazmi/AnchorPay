import type { LightMyRequestResponse } from 'fastify';
import { AppError, createLogger, createPool, providerSignature, uuidv7, type Pool } from '@anchorpay/service-kit';
import { assertMatchesContract } from '@anchorpay/service-kit/testing';
import { buildMockProviders } from '../../mock-providers/src/app.ts';
import { buildPaymentService } from '../src/app.ts';
import type { PayoutRecipient, RecipientDirectory } from '../src/domain/payouts.ts';
import { MockPayoutPartner } from '../src/partner.ts';
import { MockPaymentsProvider } from '../src/providers.ts';

export const TOKEN = () => process.env.INTERNAL_SERVICE_TOKEN!;
export const asService = (caller: string) => ({ 'x-internal-token': TOKEN(), 'x-calling-service': caller });
export const fromTransfers = () => asService('transfer-service');
export const asStaff = (role: 'admin' | 'agent' = 'admin', userId = uuidv7()) => ({
  'x-internal-token': TOKEN(), 'x-user-id': userId, 'x-user-role': role, 'x-session-id': 's',
});
export const cad = (amountMinor: number) => ({ amountMinor, currency: 'CAD' });
export const pkr = (amountMinor: number) => ({ amountMinor, currency: 'PKR' });

/** Recipients as identity-service would hand them to payment-service (full numbers). Wallet endings pick the partner outcome. */
export class FakeRecipients implements RecipientDirectory {
  readonly byId = new Map<string, PayoutRecipient>();
  down = false;

  add(overrides: Partial<PayoutRecipient> & { walletNumber?: string } = {}): PayoutRecipient {
    const { walletNumber, ...rest } = overrides;
    const r: PayoutRecipient = {
      id: uuidv7(), fullName: 'Nasreen Begum', country: 'PK', currency: 'PKR', payoutMethod: 'mobile_wallet',
      mobileWallet: { provider: 'jazzcash', walletNumber: walletNumber ?? '+923001234567' }, ...rest,
    };
    this.byId.set(r.id, r);
    return r;
  }

  async get(id: string) {
    if (this.down) throw new AppError('SERVICE_UNAVAILABLE', 'identity-service is unavailable');
    const r = this.byId.get(id);
    if (!r) throw new AppError('NOT_FOUND', 'Recipient not found.');
    return r;
  }
}

/**
 * payment-service wired to a real in-process mock-providers (so adapters and mock are tested together). The mock's
 * webhooks are delivered straight into payment-service, signed exactly as over HTTP.
 */
export async function buildTestServices(options: { payoutDelayMs?: number } = {}) {
  const log = createLogger('payment-test');
  const delivered: { path: string; event: Record<string, unknown>; status: number }[] = [];
  let payment: ReturnType<typeof buildPaymentService> | undefined;
  const deliver = async (path: string, event: Record<string, unknown>) => {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const res = await payment!.service.app.inject({
      method: 'POST', url: path, payload: body,
      headers: { 'x-internal-token': TOKEN(), 'content-type': 'application/json', 'x-timestamp': String(ts), 'x-signature': providerSignature(process.env.MOCK_WEBHOOK_SECRET!, ts, body) },
    });
    delivered.push({ path, event, status: res.statusCode });
  };
  const mock = buildMockProviders({ dataDir: null, deliver, payoutDelayMs: options.payoutDelayMs ?? 20, log, publicUrl: 'http://mock.test' });
  const mockUrl = await mock.service.app.listen({ port: 0, host: '127.0.0.1' });
  const provider = new MockPaymentsProvider(mockUrl, process.env.MOCK_WEBHOOK_SECRET!);
  const recipients = new FakeRecipients();
  const pool = createPool('payments', 'payment-test');
  payment = buildPaymentService({
    pool, log, providers: { card: provider, bank_debit: provider }, partner: new MockPayoutPartner(mockUrl, process.env.MOCK_WEBHOOK_SECRET!),
    recipients, payoutBackoffSeconds: [0, 0],
  });
  await payment.service.app.ready();
  return {
    app: payment.service.app,
    payments: payment.payments,
    payouts: payment.payouts,
    mock,
    mockUrl,
    recipients,
    pool,
    delivered,
    async close() {
      mock.partner.stop();
      await mock.service.app.close();
      await payment!.service.app.close();
      await pool.end();
    },
  };
}
export type TestServices = Awaited<ReturnType<typeof buildTestServices>>;

export function expectContract(operationId: string, res: LightMyRequestResponse, status: number): any {
  if (res.statusCode !== status) throw new Error(`${operationId}: expected ${status}, got ${res.statusCode}: ${res.body}`);
  const body = res.body ? res.json() : undefined;
  assertMatchesContract(operationId, status, body);
  return body;
}

/** Outbox events for one transfer, oldest first: [eventType, data]. */
export async function eventsFor(pool: Pool, transferId: string): Promise<[string, Record<string, any>][]> {
  const { rows } = await pool.query<{ topic: string; payload: { data: Record<string, any> } }>(
    'SELECT topic, payload FROM payments.outbox WHERE message_key = $1 ORDER BY created_at, id', [transferId]);
  return rows.map((r) => [r.topic, r.payload.data]);
}

/** The body transfer-service sends: D-08 example (CAD 500 by card = 512.99 total, fee 2.99, surcharge 10.00). */
export function authorization(overrides: Record<string, unknown> = {}) {
  return {
    transferId: uuidv7(), userId: uuidv7(), method: 'card', amount: cad(51299), fee: cad(299), cardSurcharge: cad(1000),
    returnUrl: 'http://127.0.0.1:3000/transfers/return', ...overrides,
  };
}
