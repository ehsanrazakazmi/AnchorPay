// TEMPORARY stand-in for compliance-service (Step 6), DECISIONS D-39. It answers the same contract operations
// transfer-service calls and publishes the same events, with in-memory state and scripted outcomes, so a transfer
// can be driven end to end today. (The payment stand-in was removed in Step 5: payment-service is real now.)
//
// Magic send amounts (CAD) for trying the unhappy paths:
//   133.00 screening blocks the transfer
//   666.00 screening flags it for manual review (decide it with POST /v1/admin/review-cases/{id}/decision)
//   over 10,000 limit check refuses (LIMIT_EXCEEDED)
import {
  AppError, assertValidEvent, buildEvent, createService, requireAuth, uuidv7, type EventEnvelope, type Logger, type Service,
} from '@anchorpay/service-kit';

export const MAGIC = { blocked: 13300, flagged: 66600, limit: 1_000_000 };

export type Publish = (event: EventEnvelope<unknown>, key: string) => Promise<void>;

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
