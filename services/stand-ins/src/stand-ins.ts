// TEMPORARY stand-ins for compliance-service (Step 6) and payment-service (Step 5), DECISIONS D-39.
// They answer the same contract operations transfer-service calls and publish the same events, with
// in-memory state and scripted outcomes, so a transfer can be driven end to end today.
//
// Magic send amounts (CAD) for trying the unhappy paths:
//   13.13  card/bank payment declined (payment.failed at authorisation)
//   133.00 screening blocks the transfer
//   666.00 screening flags it for manual review (decide it with POST /v1/admin/review-cases/{id}/decision)
//   99.99  payout fails for good (payout.failed final -> refund)
//   over 10,000 limit check refuses (LIMIT_EXCEEDED)
import {
  AppError, assertValidEvent, buildEvent, createService, InternalClient, requireAuth, uuidv7, type EventEnvelope, type Logger,
  type Service,
} from '@anchorpay/service-kit';

export const MAGIC = { declined: 1313, blocked: 13300, flagged: 66600, payoutFails: 9999, limit: 1_000_000 };

export type Publish = (event: EventEnvelope<unknown>, key: string) => Promise<void>;

export interface Delays {
  authorize: number;
  refund: number;
  dispatch: number;
  complete: number;
}
export const DEFAULT_DELAYS: Delays = { authorize: 300, refund: 500, dispatch: 1000, complete: 3000 };

/** When a delayed event will happen (its timestamp field). */
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

interface Money {
  amountMinor: number;
  currency: string;
}

/** Validates the event against its contract, then publishes it after `ms` (like a provider webhook arriving later). */
function later(publish: Publish, log: Logger, ms: number, event: EventEnvelope<unknown>, key: string): void {
  assertValidEvent(event);
  setTimeout(() => {
    publish(event, key).catch((err) => log.error({ err, eventType: event.eventType }, 'stand-in could not publish event'));
  }, ms).unref();
}

// ------------------------------------------------------------------ compliance-service
interface ReviewCase {
  id: string;
  transferId: string;
  transferReference: string;
  userId: string;
  reason: string;
  rulesTriggered: string[];
  fraudScore: number;
  priority: 'low' | 'normal' | 'high';
  status: 'open' | 'in_review' | 'approved' | 'rejected';
  decidedBy?: string;
  decisionNote?: string;
  createdAt: string;
  decidedAt?: string;
}

export function buildComplianceStandIn(options: { publish: Publish; log: Logger }): Service {
  const producer = 'compliance-service';
  const svc = createService({ name: producer, logger: options.log });
  const cases = new Map<string, ReviewCase>();

  svc.handle('internalCheckLimits', async (req) => {
    const { sendAmount } = req.body as { sendAmount: Money };
    const over = sendAmount.amountMinor > MAGIC.limit;
    return { allowed: !over, ...(over ? { reasonCode: 'LIMIT_EXCEEDED' } : {}), kycTier: 2, kycStatus: 'APPROVED' };
  });

  svc.handle('internalScreenTransfer', async (req) => {
    const t = req.body as { transferId: string; transferReference: string; userId: string; sendAmount: Money };
    const screeningId = uuidv7();
    const amount = t.sendAmount.amountMinor;
    const decision = amount === MAGIC.blocked ? 'block' : amount === MAGIC.flagged ? 'flag' : 'pass';
    const rulesTriggered = decision === 'pass' ? [] : [decision === 'block' ? 'STAND_IN_BLOCK' : 'STAND_IN_REVIEW'];
    const fraudScore = decision === 'pass' ? 5 : decision === 'flag' ? 55 : 95;
    let reviewCaseId: string | undefined;
    if (decision === 'flag') {
      reviewCaseId = uuidv7();
      cases.set(reviewCaseId, {
        id: reviewCaseId, transferId: t.transferId, transferReference: t.transferReference, userId: t.userId,
        reason: 'Stand-in rule: CAD 666.00 always needs a manual review.', rulesTriggered, fraudScore, priority: 'normal', status: 'open',
        createdAt: new Date().toISOString(),
      });
    }
    later(options.publish, options.log, 0, buildEvent('compliance.screening-completed', {
      screeningId, transferId: t.transferId, userId: t.userId, decision, fraudScore, rulesTriggered, sanctionsHit: false,
      completedAt: new Date().toISOString(),
    }, { producer, correlationId: req.id }), t.transferId);
    return {
      screeningId, decision, fraudScore, rulesTriggered, sanctionsHit: false,
      ...(reviewCaseId ? { reviewCaseId } : {}), ...(decision === 'block' ? { reasonCode: 'COMPLIANCE_BLOCKED' } : {}),
    };
  });

  svc.handle('listReviewCases', async (req) => {
    const q = req.query as { status?: ReviewCase['status']; page: number; pageSize: number };
    const all = [...cases.values()].filter((c) => !q.status || c.status === q.status);
    const data = all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return { data, pageInfo: { page: q.page, pageSize: q.pageSize, total: all.length } };
  });

  svc.handle('decideReviewCase', async (req) => {
    const officer = requireAuth(req);
    const { caseId } = req.params as { caseId: string };
    const body = req.body as { decision: 'approve' | 'reject'; note: string };
    const c = cases.get(caseId);
    if (!c) throw new AppError('NOT_FOUND', 'Review case not found.');
    if (c.status === 'approved' || c.status === 'rejected') throw new AppError('INVALID_STATE_TRANSITION', 'This case is already decided.');
    Object.assign(c, {
      status: body.decision === 'approve' ? 'approved' : 'rejected', decidedBy: officer.userId, decisionNote: body.note,
      decidedAt: new Date().toISOString(),
    });
    later(options.publish, options.log, 0, buildEvent('compliance.review-decided', {
      reviewCaseId: c.id, transferId: c.transferId, decision: body.decision, decidedBy: officer.userId, decidedAt: c.decidedAt,
    }, { producer, correlationId: req.id }), c.transferId);
    return c;
  });

  return svc;
}

// ------------------------------------------------------------------ payment-service
interface PaymentRecord {
  paymentId: string;
  transferId: string;
  method: 'card' | 'bank_debit';
  provider: 'mock';
  amount: Money;
  status: 'authorized' | 'captured' | 'voided' | 'failed' | 'refunded';
  fee: Money;
  cardSurcharge: Money;
  failureCode?: string;
  authorizationExpiresAt: string;
}

interface PayoutRecord {
  payoutId: string;
  transferId: string;
  partner: string;
  partnerPayoutId: string;
  method: 'bank_account' | 'mobile_wallet';
  amount: Money;
  status: 'pending' | 'dispatched' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
}

/** Reads the fields the stand-in needs from other services (payment-service is an allowed caller of both). */
export interface Lookups {
  transfer(transferId: string, requestId: string): Promise<{ sendAmount: Money; fee: Money; cardSurcharge: Money }>;
  payoutMethod(recipientId: string, requestId: string): Promise<'bank_account' | 'mobile_wallet'>;
}

export function httpLookups(): Lookups {
  const client = new InternalClient('payment-service');
  return {
    async transfer(id, requestId) {
      return (await client.call<{ sendAmount: Money; fee: Money; cardSurcharge: Money }>('transfer-service', 'GET', `/internal/transfers/${id}`,
        { requestId, retries: 2 })).body;
    },
    async payoutMethod(id, requestId) {
      return (await client.call<{ payoutMethod: 'bank_account' | 'mobile_wallet' }>('identity-service', 'GET',
        `/internal/identity/recipients/${id}`, { requestId, retries: 2 })).body.payoutMethod;
    },
  };
}

export function buildPaymentStandIn(options: { publish: Publish; log: Logger; lookups: Lookups; delays?: Delays }): Service {
  const producer = 'payment-service';
  const delays = options.delays ?? DEFAULT_DELAYS;
  const svc = createService({ name: producer, logger: options.log });
  const payments = new Map<string, PaymentRecord>();
  const byTransfer = new Map<string, string>();
  const payouts = new Map<string, PayoutRecord>();
  const payoutByTransfer = new Map<string, string>();
  const refunds = new Map<string, unknown>(); // idempotency key -> response
  const emit = (ms: number, type: string, data: Record<string, unknown>, rid: string) =>
    later(options.publish, options.log, ms, buildEvent(type, data, { producer, correlationId: rid }), data.transferId as string);
  const view = ({ fee: _fee, cardSurcharge: _surcharge, ...p }: PaymentRecord) => p;
  const payment = (req: { params: unknown }) => {
    const p = payments.get((req.params as { paymentId: string }).paymentId);
    if (!p) throw new AppError('NOT_FOUND', 'Payment not found.');
    return p;
  };

  svc.handle('internalAuthorizePayment', async (req, reply) => {
    const body = req.body as { transferId: string; method: 'card' | 'bank_debit'; amount: Money };
    const existing = byTransfer.get(body.transferId);
    if (existing) return reply.code(201).send({ payment: view(payments.get(existing)!), paymentAction: { type: 'none' } });
    const transfer = await options.lookups.transfer(body.transferId, req.id);
    const declined = transfer.sendAmount.amountMinor === MAGIC.declined;
    const p: PaymentRecord = {
      paymentId: uuidv7(), transferId: body.transferId, method: body.method, provider: 'mock', amount: body.amount,
      status: declined ? 'failed' : 'authorized', fee: transfer.fee, cardSurcharge: transfer.cardSurcharge,
      ...(declined ? { failureCode: 'card_declined' } : {}),
      authorizationExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    };
    payments.set(p.paymentId, p);
    byTransfer.set(p.transferId, p.paymentId);
    const now = at(delays.authorize);
    if (declined) {
      emit(delays.authorize, 'payment.failed', { paymentId: p.paymentId, transferId: p.transferId, stage: 'authorization', failureCode: 'card_declined', failedAt: now }, req.id);
    } else {
      emit(delays.authorize, 'payment.authorized', {
        paymentId: p.paymentId, transferId: p.transferId, method: p.method, amount: p.amount, authorizedAt: now, authorizationExpiresAt: p.authorizationExpiresAt,
      }, req.id);
    }
    return reply.code(201).send({ payment: view(p), paymentAction: { type: 'none' } });
  });

  svc.handle('internalCapturePayment', async (req) => {
    const p = payment(req);
    if (p.status === 'captured' || p.status === 'refunded') return view(p);
    if (p.status !== 'authorized') throw new AppError('CONFLICT', `A ${p.status} payment can't be captured.`);
    p.status = 'captured';
    emit(0, 'payment.captured', {
      paymentId: p.paymentId, transferId: p.transferId, method: p.method, amount: p.amount, fee: p.fee, cardSurcharge: p.cardSurcharge,
      capturedAt: new Date().toISOString(),
    }, req.id);
    return view(p);
  });

  svc.handle('internalVoidPayment', async (req) => {
    const p = payment(req);
    if (p.status === 'captured' || p.status === 'refunded') throw new AppError('CONFLICT', 'A captured payment must be refunded, not voided.');
    if (p.status === 'authorized') p.status = 'voided';
    return view(p);
  });

  svc.handle('internalRefundPayment', async (req, reply) => {
    const key = (req.headers['idempotency-key'] as string | undefined) ?? '';
    const earlier = refunds.get(key);
    if (earlier) return reply.code(202).send(earlier);
    const p = payment(req);
    if (p.status !== 'captured') throw new AppError('CONFLICT', `A ${p.status} payment can't be refunded.`);
    p.status = 'refunded';
    const refund = { refundId: uuidv7(), paymentId: p.paymentId, transferId: p.transferId, amount: (req.body as { amount: Money }).amount, status: 'pending' };
    refunds.set(key, refund);
    emit(delays.refund, 'payment.refunded', {
      refundId: refund.refundId, paymentId: p.paymentId, transferId: p.transferId, amount: refund.amount, refundedAt: at(delays.refund),
    }, req.id);
    return reply.code(202).send(refund);
  });

  svc.handle('internalCreatePayout', async (req, reply) => {
    const body = req.body as { transferId: string; recipientId: string; amount: Money; sendAmount: Money };
    const existing = payoutByTransfer.get(body.transferId);
    if (existing) return reply.code(202).send(payouts.get(existing));
    const method = await options.lookups.payoutMethod(body.recipientId, req.id);
    const po: PayoutRecord = {
      payoutId: uuidv7(), transferId: body.transferId, partner: 'mock-partner', partnerPayoutId: `MP-${uuidv7().slice(-12)}`, method,
      amount: body.amount, status: 'pending', attempts: 1,
    };
    payouts.set(po.payoutId, po);
    payoutByTransfer.set(po.transferId, po.payoutId);
    const fails = body.sendAmount.amountMinor === MAGIC.payoutFails;
    emit(delays.dispatch, 'payout.dispatched', {
      payoutId: po.payoutId, transferId: po.transferId, partner: po.partner, method, amount: po.amount, sendAmount: body.sendAmount,
      dispatchedAt: at(delays.dispatch),
    }, req.id);
    setTimeout(() => {
      po.status = fails ? 'failed' : 'completed';
      if (fails) po.lastError = 'recipient_bank_rejected';
    }, delays.complete).unref();
    if (fails) {
      emit(delays.complete, 'payout.failed', {
        payoutId: po.payoutId, transferId: po.transferId, attempts: 1, reasonCode: 'recipient_bank_rejected', final: true, failedAt: at(delays.complete),
      }, req.id);
    } else {
      emit(delays.complete, 'payout.completed', {
        payoutId: po.payoutId, transferId: po.transferId, partnerPayoutId: po.partnerPayoutId, completedAt: at(delays.complete),
      }, req.id);
    }
    return reply.code(202).send(po);
  });

  svc.handle('internalGetPayout', async (req) => {
    const po = payouts.get((req.params as { payoutId: string }).payoutId);
    if (!po) throw new AppError('NOT_FOUND', 'Payout not found.');
    return po;
  });

  return svc;
}
