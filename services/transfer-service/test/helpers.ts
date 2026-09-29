import { randomInt, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import {
  AppError, assertValidEvent, buildEvent, createLogger, createPool, createRedis, PiiCipher, uuidv7, withTransaction, type Pool,
} from '@anchorpay/service-kit';
import { assertMatchesContract } from '@anchorpay/service-kit/testing';
import { buildTransferService } from '../src/app.ts';
import type { FxLock, LimitCheck, Money, Ports, Quote, Recipient, Screening } from '../src/ports.ts';
import type { TransferRow } from '../src/domain/transfers.ts';
// Test fixtures only: users and recipients are identity-service's rows in the shared core schema.
import { RECIPIENT_CTX } from '../../identity-service/src/domain/recipients.ts';
import { Users } from '../../identity-service/src/domain/users.ts';

const cad = (amountMinor: number): Money => ({ amountMinor, currency: 'CAD' });

/**
 * In-memory fx-service, compliance-service, payment-service and identity-service. Each behaviour can be
 * switched per test; every call is recorded so tests can assert what the workflow asked for.
 */
export class FakePorts implements Ports {
  readonly recipients = new Map<string, Recipient>();
  readonly quotes = new Map<string, Quote>();
  readonly locks = new Map<string, FxLock>();
  readonly payments = new Map<string, { transferId: string; status: string }>();
  readonly calls: { op: string; arg?: unknown }[] = [];

  limits: LimitCheck = { allowed: true, kycTier: 2, kycStatus: 'APPROVED' };
  screening: Screening['decision'] = 'pass';
  identityDown = false;
  lockError: AppError | null = null;
  consumeError: AppError | null = null;
  authorizeError: AppError | null = null;
  captureError: AppError | null = null;
  payoutError: AppError | null = null;
  refundError: AppError | null = null;
  /** Receive amount for the next createQuote (a new rate). */
  nextRate = { offerRate: '205.0000', receivePerCad: 205 };
  /** Changes the next createQuote's fee (a pricing change since the customer confirmed). */
  nextFeeMinor: number | null = null;

  private record(op: string, arg?: unknown) {
    this.calls.push({ op, arg });
  }
  called(op: string) {
    return this.calls.filter((c) => c.op === op);
  }

  addRecipient(userId: string, overrides: Partial<Recipient> = {}): Recipient {
    const r: Recipient = {
      id: overrides.id ?? uuidv7(), userId, fullName: 'Nasreen Begum', country: 'PK', currency: 'PKR', payoutMethod: 'bank_account',
      bankAccount: { bankName: 'Standard Chartered', accountNumberMasked: '****6702' }, deletedAt: null, ...overrides,
    };
    this.recipients.set(r.id, r);
    return r;
  }

  /** The D-08 worked example: CAD 500 by card at mid 206.67 -> offer 203.5699, total 512.99, receive PKR 101,784.95. */
  addQuote(overrides: { sendMinor?: number; fundingMethod?: 'card' | 'bank_debit'; corridorCode?: string; receiveCurrency?: string } = {}): Quote {
    const sendMinor = overrides.sendMinor ?? 50000;
    const funding = overrides.fundingMethod ?? 'card';
    const fee = 299;
    const surcharge = funding === 'card' ? Math.round(sendMinor * 0.02) : 0;
    const q: Quote = {
      quoteId: uuidv7(), corridorCode: overrides.corridorCode ?? 'CA-PK', fundingMethod: funding, sendAmount: cad(sendMinor), fee: cad(fee),
      cardSurcharge: cad(surcharge), totalCharge: cad(sendMinor + fee + surcharge),
      receiveAmount: { amountMinor: Math.floor(sendMinor * 203.5699), currency: overrides.receiveCurrency ?? 'PKR' },
      midRate: '206.6700', offerRate: '203.5699', spreadPercent: '1.50', rateTimestamp: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), deliveryEstimate: 'Within minutes',
    };
    this.quotes.set(q.quoteId, q);
    return q;
  }

  async getRecipient(id: string) {
    this.record('getRecipient', id);
    if (this.identityDown) throw new AppError('SERVICE_UNAVAILABLE', 'identity-service is unavailable');
    const r = this.recipients.get(id);
    if (!r) throw new AppError('NOT_FOUND', 'Recipient not found.');
    return r;
  }
  async getQuote(id: string) {
    this.record('getQuote', id);
    const q = this.quotes.get(id);
    if (!q) throw new AppError('NOT_FOUND', 'Quote not found.');
    return q;
  }
  async createQuote(body: { corridorCode: string; sendAmount: Money; fundingMethod: string }) {
    this.record('createQuote', body);
    const base = this.addQuote({ sendMinor: body.sendAmount.amountMinor, fundingMethod: body.fundingMethod as 'card', corridorCode: body.corridorCode });
    const q: Quote = {
      ...base, offerRate: this.nextRate.offerRate,
      receiveAmount: { amountMinor: body.sendAmount.amountMinor * this.nextRate.receivePerCad, currency: 'PKR' },
      ...(this.nextFeeMinor !== null ? {
        fee: cad(this.nextFeeMinor), totalCharge: cad(base.sendAmount.amountMinor + this.nextFeeMinor + base.cardSurcharge.amountMinor),
      } : {}),
    };
    this.quotes.set(q.quoteId, q);
    return q;
  }
  async lockRate(body: { transferId: string; userId: string; quoteId: string }) {
    this.record('lockRate', body);
    if (this.lockError) throw this.lockError;
    const q = this.quotes.get(body.quoteId);
    if (!q) throw new AppError('QUOTE_EXPIRED', 'This quote has expired.');
    const now = new Date();
    const lock: FxLock = {
      lockId: uuidv7(), transferId: body.transferId, quoteId: q.quoteId, status: 'active', receiveAmount: q.receiveAmount, totalCharge: q.totalCharge,
      midRate: q.midRate, offerRate: q.offerRate, lockedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    };
    this.locks.set(lock.lockId, lock);
    return lock;
  }
  async consumeLock(lockId: string) {
    this.record('consumeLock', lockId);
    if (this.consumeError) throw this.consumeError;
    const lock = this.locks.get(lockId)!;
    lock.status = 'consumed';
    return lock;
  }
  async releaseLock(lockId: string) {
    this.record('releaseLock', lockId);
    const lock = this.locks.get(lockId)!;
    if (lock.status === 'active') lock.status = 'released';
    return lock;
  }
  async checkLimits(body: { userId: string; sendAmount: Money }) {
    this.record('checkLimits', body);
    return this.limits;
  }
  async screen(body: Record<string, unknown>) {
    this.record('screen', body);
    return {
      screeningId: uuidv7(), decision: this.screening, fraudScore: 10, rulesTriggered: [], sanctionsHit: false,
      ...(this.screening === 'flag' ? { reviewCaseId: uuidv7() } : {}),
    } satisfies Screening;
  }
  async authorizePayment(body: { transferId: string; userId: string; method: string; amount: Money; fee: Money; cardSurcharge: Money }) {
    this.record('authorizePayment', body);
    if (this.authorizeError) throw this.authorizeError;
    const paymentId = uuidv7();
    this.payments.set(paymentId, { transferId: body.transferId, status: 'authorized' });
    return { payment: { paymentId, status: 'authorized' }, paymentAction: { type: 'none' as const } };
  }
  async capturePayment(paymentId: string) {
    this.record('capturePayment', paymentId);
    if (this.captureError) throw this.captureError;
    this.payments.get(paymentId)!.status = 'captured';
    return { paymentId, status: 'captured' };
  }
  async voidPayment(paymentId: string) {
    this.record('voidPayment', paymentId);
    const p = this.payments.get(paymentId);
    if (p) p.status = 'voided';
    return { paymentId, status: 'voided' };
  }
  async refundPayment(paymentId: string, body: { amount: Money; reason: string }, idempotencyKey: string) {
    this.record('refundPayment', { paymentId, ...body, idempotencyKey });
    if (this.refundError) throw this.refundError;
    return { refundId: uuidv7(), paymentId, status: 'pending' };
  }
  async createPayout(body: { transferId: string; transferReference: string; recipientId: string; amount: Money; sendAmount: Money }) {
    this.record('createPayout', body);
    if (this.payoutError) throw this.payoutError;
    return { payoutId: uuidv7(), status: 'pending' };
  }
}

export function buildTestService() {
  const ports = new FakePorts();
  const infra = { pool: createPool('core', 'transfer-test'), redis: createRedis(), log: createLogger('transfer-test'), ports };
  const { service, workflow } = buildTransferService(infra);
  const reporting = createPool('reporting', 'transfer-test'); // read-only view for asserting audit rows
  const cipher = PiiCipher.fromEnv();
  return {
    cipher,
    users: new Users(cipher),
    app: service.app,
    pool: infra.pool,
    reporting,
    redis: infra.redis,
    workflow,
    ports,
    async close() {
      await service.app.close();
      await infra.pool.end();
      await reporting.end();
      infra.redis.disconnect();
    },
  };
}
export type TestService = ReturnType<typeof buildTestService>;

export const TOKEN = () => process.env.INTERNAL_SERVICE_TOKEN!;
export const asUser = (userId: string, role = 'customer') => ({
  'x-internal-token': TOKEN(), 'x-user-id': userId, 'x-user-role': role, 'x-session-id': 'test-session',
});
export const asService = (caller: string) => ({ 'x-internal-token': TOKEN(), 'x-calling-service': caller });

/** Asserts the status and that the body matches the contract for that operation + status. */
export function expectContract(operationId: string, res: LightMyRequestResponse, status: number): any {
  if (res.statusCode !== status) throw new Error(`${operationId}: expected ${status}, got ${res.statusCode}: ${res.body}`);
  const body = res.body ? res.json() : undefined;
  assertMatchesContract(operationId, status, body);
  return body;
}

/**
 * A customer row plus a recipient row (the transfer table's foreign keys) and the matching fake recipient.
 * Both services own the core schema and tests share one database, so the rows are written exactly the way
 * identity-service writes them (real ciphertext): its admin screens must be able to read every row.
 */
export async function customer(t: TestService, recipient: Partial<Recipient> = {}) {
  const user = await t.users.insert(t.pool, {
    email: `transfer.${randomUUID().slice(0, 8)}@example.com`, phone: `+1416${String(randomInt(1_000_000, 9_999_999))}`,
    fullName: 'Ayesha Khan', dateOfBirth: '1995-04-12', country: 'CA', passwordHash: 'not-a-login-account',
  });
  const userId = user.id;
  const r = t.ports.addRecipient(userId, recipient);
  const c = t.cipher;
  const wallet = r.payoutMethod === 'mobile_wallet';
  await t.pool.query(
    `INSERT INTO core.recipients (id, user_id, full_name_enc, encryption_key_id, country, currency, payout_method, bank_name,
                                  account_number_enc, account_last4, wallet_provider, wallet_number_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [r.id, userId, c.encrypt(r.fullName, RECIPIENT_CTX.fullName), c.keyId, r.country, r.currency, r.payoutMethod,
      wallet ? null : r.bankAccount?.bankName ?? 'Bank', wallet ? null : c.encrypt('PK36SCBL0000001123456702', RECIPIENT_CTX.accountNumber),
      wallet ? null : '6702', wallet ? r.mobileWallet?.provider ?? 'jazzcash' : null, wallet ? c.encrypt('+923001234567', RECIPIENT_CTX.walletNumber) : null],
  );
  return { userId, recipient: r, headers: asUser(userId) };
}

/** POST /v1/transfers; returns the raw response. */
export function postTransfer(t: TestService, headers: Record<string, string>, body: Record<string, unknown>, key: string = randomUUID()) {
  return t.app.inject({ method: 'POST', url: '/v1/transfers', headers: { ...headers, 'idempotency-key': key }, payload: body });
}

/** Creates a transfer that is FX_LOCKED with a payment authorisation started. */
export async function lockedTransfer(t: TestService, quote: { sendMinor?: number; fundingMethod?: 'card' | 'bank_debit' } = {}) {
  const c = await customer(t);
  const q = t.ports.addQuote(quote);
  const res = await postTransfer(t, c.headers, { quoteId: q.quoteId, recipientId: c.recipient.id, purpose: 'family_support' });
  const body = expectContract('createTransfer', res, 201);
  return { ...c, quote: q, transfer: body.transfer, paymentAction: body.paymentAction, id: body.transfer.id as string };
}

export async function row(t: TestService, id: string): Promise<TransferRow> {
  return (await t.pool.query<TransferRow>('SELECT * FROM core.transfers WHERE id = $1', [id])).rows[0]!;
}

/** Delivers an event the way the Kafka consumer does: handler inside the inbox transaction, follow-up after commit. */
export async function deliver(t: TestService, eventType: string, producer: string, data: Record<string, unknown>) {
  const event = buildEvent(eventType, data, { producer, correlationId: `test-${eventType}` });
  assertValidEvent(event); // the tests may only send events the contract allows
  const followUp = await withTransaction(t.pool, async (client) => {
    await client.query('INSERT INTO core.inbox (consumer, event_id, topic) VALUES ($1, $2, $3)', ['transfer-service', event.eventId, eventType]);
    return t.workflow.onEvent(event as never, client);
  });
  if (typeof followUp === 'function') await followUp();
  return event;
}

const now = () => new Date().toISOString();
export const events = {
  authorized: (t: TestService, id: string, paymentId: string, amount: Money) => deliver(t, 'payment.authorized', 'payment-service', {
    paymentId, transferId: id, method: 'card', amount, authorizedAt: now(), authorizationExpiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
  }),
  paymentFailed: (t: TestService, id: string, paymentId: string, stage: 'authorization' | 'capture' = 'authorization') =>
    deliver(t, 'payment.failed', 'payment-service', { paymentId, transferId: id, stage, failureCode: 'card_declined', failedAt: now() }),
  refunded: (t: TestService, id: string, paymentId: string, amount: Money) =>
    deliver(t, 'payment.refunded', 'payment-service', { refundId: uuidv7(), paymentId, transferId: id, amount, refundedAt: now() }),
  dispatched: (t: TestService, id: string, payoutId: string, amount: Money, sendAmount: Money) => deliver(t, 'payout.dispatched', 'payment-service', {
    payoutId, transferId: id, partner: 'mock-partner', method: 'bank_account', amount, sendAmount, dispatchedAt: now(),
  }),
  completed: (t: TestService, id: string, payoutId: string) =>
    deliver(t, 'payout.completed', 'payment-service', { payoutId, transferId: id, partnerPayoutId: 'MP-1', completedAt: now() }),
  payoutFailed: (t: TestService, id: string, payoutId: string, final: boolean) => deliver(t, 'payout.failed', 'payment-service', {
    payoutId, transferId: id, attempts: 3, reasonCode: 'recipient_bank_rejected', final, failedAt: now(),
  }),
  reviewed: (t: TestService, id: string, decision: 'approve' | 'reject') => deliver(t, 'compliance.review-decided', 'compliance-service', {
    reviewCaseId: uuidv7(), transferId: id, decision, decidedBy: uuidv7(), decidedAt: now(),
  }),
  lockExpired: (t: TestService, id: string, lockId: string) =>
    deliver(t, 'fx.lock-expired', 'fx-service', { lockId, transferId: id, expiredAt: now() }),
};

/** Runs one transfer from FX_LOCKED to PAYMENT_COLLECTED with the default (pass) screening. */
export async function collected(t: TestService, quote: { sendMinor?: number } = {}) {
  const x = await lockedTransfer(t, quote);
  const r = await row(t, x.id);
  await events.authorized(t, x.id, r.payment_id!, x.transfer.totalCharge);
  return { ...x, row: await row(t, x.id) };
}

export type { Pool };
