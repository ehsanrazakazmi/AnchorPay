// The transfer workflow (docs/state-machine.md, DECISIONS D-05/D-06).
//
//   confirm -> INITIATED -> lock rate -> FX_LOCKED -> (payment.authorized) -> COMPLIANCE_SCREENING
//     pass  -> consume lock -> capture -> PAYMENT_COLLECTED -> payout -> PAYOUT_DISPATCHED -> COMPLETED
//     flag  -> ON_HOLD -> (review approved) -> capture ... | (lock expired meanwhile) -> AWAITING_RECONFIRM
//     block -> FAILED (hold released, nothing charged)
//
// Rules that make it crash-safe:
//  - State changes happen only in DB transactions (transition()); calls to other services happen outside them.
//  - Every call to another service is idempotent per transfer, so repeating a step is always safe.
//  - Progress markers (collect_requested_at, payment_captured_at, payout_requested_at, refund_requested_at) let the
//    recovery job resume a transfer at exactly the step it stopped at.
import {
  AppError, buildEvent, enqueueEvent, withTransaction, type AfterCommit, type AuthContext, type EventEnvelope, type Logger,
  type Pool, type PoolClient, type Redis,
} from '@anchorpay/service-kit';
import type { Ports, Quote } from '../ports.ts';
import { IdempotentRequest } from './idempotency.ts';
import {
  getTransfer, history, insertTransfer, lockTransfer, patch, receiveAmount, SERVICE, sendAmount, totalCharge, transition,
  type Actor, type Status, type Trace, type TransferRow,
} from './transfers.ts';
import { summarise, toApi, unknownRecipient, type RecipientSummary } from './views.ts';

export interface WorkflowDeps {
  pool: Pool;
  redis: Redis;
  ports: Ports;
  log: Logger;
}

export interface CreateBody {
  quoteId: string;
  recipientId: string;
  purpose: string;
  returnUrl?: string;
}

const SYSTEM: Actor = { type: 'system', id: 'transfer-service' };
const COLLECTABLE: Status[] = ['COMPLIANCE_SCREENING', 'ON_HOLD', 'AWAITING_RECONFIRM'];
const LOCK_SAFETY_MS = 10_000; // don't try to use a lock that expires within 10 s

const isCode = (err: unknown, ...codes: string[]) => err instanceof AppError && codes.includes(err.code);
const clientError = (err: unknown) => err instanceof AppError && err.status >= 400 && err.status < 500;

export class Workflow {
  private readonly pool: Pool;
  private readonly redis: Redis;
  private readonly ports: Ports;
  private readonly log: Logger;
  private readonly recipientCache = new Map<string, { at: number; value: RecipientSummary }>();

  constructor(deps: WorkflowDeps) {
    this.pool = deps.pool;
    this.redis = deps.redis;
    this.ports = deps.ports;
    this.log = deps.log;
  }

  // ------------------------------------------------------------------ views
  async recipient(t: TransferRow, requestId: string): Promise<RecipientSummary> {
    const cached = this.recipientCache.get(t.recipient_id);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    try {
      const value = summarise(await this.ports.getRecipient(t.recipient_id, requestId));
      this.recipientCache.set(t.recipient_id, { at: Date.now(), value });
      return value;
    } catch (err) {
      this.log.warn({ err, transferId: t.id }, 'recipient details unavailable; showing a placeholder');
      return unknownRecipient(t);
    }
  }

  async view(t: TransferRow, requestId: string) {
    const timeline = (await history(this.pool, [t.id])).get(t.id) ?? [];
    return toApi(t, await this.recipient(t, requestId), timeline);
  }

  async views(rows: TransferRow[], requestId: string) {
    const timelines = await history(this.pool, rows.map((r) => r.id));
    return Promise.all(rows.map(async (t) => toApi(t, await this.recipient(t, requestId), timelines.get(t.id) ?? [])));
  }

  // ------------------------------------------------------------------ create
  async create(auth: AuthContext, body: CreateBody, idempotencyKey: string, requestId: string): Promise<{ status: number; body: unknown }> {
    const idem = new IdempotentRequest(this.redis, auth.userId, idempotencyKey, body);
    const replay = await idem.begin();
    if (replay) return replay;
    let created = false;
    try {
      const result = await this.createTransfer(auth, body, idempotencyKey, requestId, () => {
        created = true;
      });
      await idem.succeed(201, result);
      return { status: 201, body: result };
    } catch (err) {
      // Once the row exists the key is spent (the database's unique key would refuse a second insert anyway).
      if (created) await idem.fail(err instanceof AppError ? err : new AppError('INTERNAL_ERROR'));
      else await idem.abandon();
      throw err;
    }
  }

  private async createTransfer(auth: AuthContext, body: CreateBody, idempotencyKey: string, rid: string, markCreated: () => void) {
    const actor: Actor = { type: 'user', id: auth.userId };
    const trace: Trace = { correlationId: rid };

    const quote = await this.ports.getQuote(body.quoteId, rid).catch((err) => {
      throw isCode(err, 'NOT_FOUND') ? new AppError('QUOTE_EXPIRED', 'This quote has expired. Get a new quote.') : err;
    });
    const recipient = await this.ports.getRecipient(body.recipientId, rid).catch((err) => {
      throw isCode(err, 'NOT_FOUND') ? new AppError('NOT_FOUND', 'Recipient not found.') : err;
    });
    if (recipient.userId !== auth.userId || recipient.deletedAt) throw new AppError('NOT_FOUND', 'Recipient not found.');
    const receiveCountry = quote.corridorCode.split('-')[1];
    if (recipient.country !== receiveCountry || recipient.currency !== quote.receiveAmount.currency) {
      throw new AppError('CORRIDOR_UNAVAILABLE', `This recipient is in ${recipient.country}; the quote is for ${quote.corridorCode}.`);
    }
    const limits = await this.ports.checkLimits({ userId: auth.userId, sendAmount: quote.sendAmount }, rid);
    if (!limits.allowed) {
      throw limits.reasonCode === 'KYC_REQUIRED'
        ? new AppError('KYC_REQUIRED', 'Verify your identity before sending money.')
        : new AppError('LIMIT_EXCEEDED', 'This amount is above your current sending limit. Verify more details to raise it.');
    }

    let t = await withTransaction(this.pool, (c) => insertTransfer(c, {
      userId: auth.userId, recipientId: recipient.id, idempotencyKey, corridorCode: quote.corridorCode,
      fundingMethod: quote.fundingMethod, purpose: body.purpose, send: quote.sendAmount, feeMinor: quote.fee.amountMinor,
      surchargeMinor: quote.cardSurcharge.amountMinor, totalMinor: quote.totalCharge.amountMinor,
      receiveCurrency: quote.receiveAmount.currency, quoteId: quote.quoteId, deliveryEstimate: quote.deliveryEstimate,
      payoutMethod: recipient.payoutMethod,
    }, actor, trace).catch((err) => {
      if ((err as { constraint?: string }).constraint === 'transfers_idempotency') {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for another transfer.');
      }
      throw err;
    }));
    markCreated();

    // 1. Lock exactly the quoted rate for 30 minutes.
    let lock;
    try {
      lock = await this.ports.lockRate({ transferId: t.id, userId: auth.userId, quoteId: quote.quoteId }, rid);
    } catch (err) {
      const code = isCode(err, 'QUOTE_EXPIRED') ? 'QUOTE_EXPIRED' : 'RATE_LOCK_FAILED';
      await this.stop(t.id, 'FAILED', code, trace, actor);
      throw isCode(err, 'QUOTE_EXPIRED') ? err : new AppError('SERVICE_UNAVAILABLE', "We couldn't lock the exchange rate. Please try again.");
    }
    t = await withTransaction(this.pool, async (c) => {
      const row = (await lockTransfer(c, t.id))!;
      const locked = await transition(c, row, 'FX_LOCKED', actor, trace, {
        set: {
          fx_lock_id: lock.lockId, receive_amount_minor: lock.receiveAmount.amountMinor, mid_rate: lock.midRate, offer_rate: lock.offerRate,
          rate_locked_at: new Date(lock.lockedAt), rate_lock_expires_at: new Date(lock.expiresAt),
        },
      });
      await enqueueEvent(c, 'core', buildEvent('transfer.created', {
        transferId: locked.id, reference: locked.reference, userId: locked.user_id, recipientId: locked.recipient_id,
        corridorCode: locked.corridor_code, fundingMethod: locked.funding_method, sendAmount: sendAmount(locked), fee: quote.fee,
        cardSurcharge: quote.cardSurcharge, totalCharge: totalCharge(locked), receiveAmount: receiveAmount(locked)!,
        midRate: lock.midRate, offerRate: lock.offerRate, rateLockExpiresAt: lock.expiresAt,
      }, { producer: SERVICE, correlationId: rid }), locked.id);
      return locked;
    });

    // 2. Hold the money (authorise, don't charge). payment.authorized moves the transfer on.
    let authorization;
    try {
      authorization = await this.ports.authorizePayment({
        transferId: t.id, userId: auth.userId, method: t.funding_method, amount: totalCharge(t),
        ...(body.returnUrl ? { returnUrl: body.returnUrl } : {}),
      }, rid);
    } catch (err) {
      await this.stop(t.id, 'FAILED', isCode(err, 'PAYMENT_DECLINED') ? 'PAYMENT_DECLINED' : 'PAYMENT_UNAVAILABLE', trace, actor);
      throw clientError(err) ? err : new AppError('SERVICE_UNAVAILABLE', "We couldn't reach the payment provider. You were not charged.");
    }
    t = await withTransaction(this.pool, async (c) => {
      const row = (await lockTransfer(c, t.id))!;
      return row.payment_id ? row : patch(c, row, { payment_id: authorization.payment.paymentId });
    });
    return { transfer: await this.view(t, rid), paymentAction: authorization.paymentAction };
  }

  // ------------------------------------------------------------------ steps
  /** Ends a transfer (FAILED or CANCELLED) and undoes what can be undone. Safe to call more than once. */
  async stop(id: string, to: 'FAILED' | 'CANCELLED', code: string, trace: Trace, actor: Actor = SYSTEM): Promise<void> {
    const stopped = await withTransaction(this.pool, (c) => this.stopIn(c, id, to, code, trace, actor));
    if (stopped) await this.cleanup(stopped, trace);
  }

  private async stopIn(c: PoolClient, id: string, to: 'FAILED' | 'CANCELLED', code: string, trace: Trace, actor: Actor): Promise<TransferRow | null> {
    const row = await lockTransfer(c, id);
    if (!row || ['COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'].includes(row.status)) return null;
    return transition(c, row, to, actor, trace, {
      reason: code.toLowerCase(),
      set: to === 'FAILED' ? { failure_code: code } : { cancel_reason: code.toLowerCase() },
    });
  }

  /** Release the rate lock and the payment hold if nothing was charged; start a refund if it was. */
  private async cleanup(t: TransferRow, trace: Trace): Promise<void> {
    const rid = trace.correlationId;
    if (t.payment_captured_at) {
      if (t.status === 'FAILED') await this.requestRefund(t.id, trace);
      return;
    }
    const quietly = async (what: string, call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (err) {
        this.log.warn({ err, transferId: t.id }, `${what} failed during cleanup`);
      }
    };
    if (t.payment_id) await quietly('void payment', () => this.ports.voidPayment(t.payment_id!, rid));
    if (t.fx_lock_id) await quietly('release rate lock', () => this.ports.releaseLock(t.fx_lock_id!, rid));
  }

  /** COMPLIANCE_SCREENING: ask compliance-service, then continue, hold or stop. */
  async screen(id: string, trace: Trace): Promise<void> {
    const t = await getTransfer(this.pool, id);
    if (!t || t.status !== 'COMPLIANCE_SCREENING') return;
    if (t.collect_requested_at) return this.collect(id, trace);
    let result;
    try {
      result = await this.ports.screen({
        transferId: t.id, transferReference: t.reference, userId: t.user_id, recipientId: t.recipient_id, corridorCode: t.corridor_code,
        sendAmount: sendAmount(t), receiveAmount: receiveAmount(t), fundingMethod: t.funding_method, purpose: t.purpose,
      }, trace.correlationId);
    } catch (err) {
      this.log.warn({ err, transferId: id }, 'screening unavailable; the recovery job will retry');
      return;
    }
    const compliance: Actor = { type: 'service', id: 'compliance-service' };
    const outcome = await withTransaction(this.pool, async (c) => {
      const row = await lockTransfer(c, id);
      if (!row || row.status !== 'COMPLIANCE_SCREENING') return null;
      if (result.decision === 'pass') {
        await patch(c, row, { screening_id: result.screeningId, compliance_decision: 'pass', collect_requested_at: new Date() });
        return 'collect' as const;
      }
      if (result.decision === 'flag') {
        await transition(c, row, 'ON_HOLD', compliance, trace, {
          reason: 'flagged_for_review',
          set: { screening_id: result.screeningId, compliance_decision: 'flag', review_case_id: result.reviewCaseId ?? null },
        });
        return null;
      }
      return transition(c, row, 'FAILED', compliance, trace, {
        reason: 'compliance_blocked', set: { screening_id: result.screeningId, compliance_decision: 'block', failure_code: 'COMPLIANCE_BLOCKED' },
      });
    });
    if (outcome === 'collect') await this.collect(id, trace);
    else if (outcome) await this.cleanup(outcome, trace);
  }

  /** Cleared to charge: use the rate lock, capture the held payment, then send the payout. */
  async collect(id: string, trace: Trace): Promise<void> {
    const rid = trace.correlationId;
    const t = await getTransfer(this.pool, id);
    if (!t || !COLLECTABLE.includes(t.status) || !t.collect_requested_at) return;
    if (!t.payment_captured_at) {
      try {
        await this.ports.consumeLock(t.fx_lock_id!, rid);
      } catch (err) {
        if (isCode(err, 'RATE_LOCK_EXPIRED')) {
          await this.rateLockExpiredWhileCollecting(t, trace);
          return;
        }
        this.log.warn({ err, transferId: id }, 'rate lock unavailable; the recovery job will retry');
        return;
      }
      try {
        await this.ports.capturePayment(t.payment_id!, rid);
      } catch (err) {
        if (clientError(err)) await this.stop(id, 'FAILED', 'CAPTURE_FAILED', trace);
        else this.log.warn({ err, transferId: id }, 'capture unavailable; the recovery job will retry');
        return;
      }
      await withTransaction(this.pool, async (c) => {
        const row = await lockTransfer(c, id);
        if (row && !row.payment_captured_at) await patch(c, row, { payment_captured_at: new Date() });
      });
    }
    await withTransaction(this.pool, async (c) => {
      const row = await lockTransfer(c, id);
      if (row && COLLECTABLE.includes(row.status)) await transition(c, row, 'PAYMENT_COLLECTED', SYSTEM, trace, { reason: 'payment_captured' });
    });
    await this.requestPayout(id, trace);
  }

  private async rateLockExpiredWhileCollecting(t: TransferRow, trace: Trace): Promise<void> {
    if (t.status === 'COMPLIANCE_SCREENING') {
      await this.stop(t.id, 'FAILED', 'RATE_LOCK_EXPIRED', trace);
      return;
    }
    // ON_HOLD (approved late) or AWAITING_RECONFIRM: ask the customer to accept a new rate.
    await withTransaction(this.pool, async (c) => {
      const row = await lockTransfer(c, t.id);
      if (!row) return;
      const cleared = await patch(c, row, { collect_requested_at: null });
      if (cleared.status === 'ON_HOLD') await transition(c, cleared, 'AWAITING_RECONFIRM', SYSTEM, trace, { reason: 'rate_lock_expired' });
    });
  }

  async requestPayout(id: string, trace: Trace): Promise<void> {
    const t = await getTransfer(this.pool, id);
    if (!t || t.status !== 'PAYMENT_COLLECTED' || t.payout_requested_at) return;
    try {
      const payout = await this.ports.createPayout({
        transferId: t.id, transferReference: t.reference, recipientId: t.recipient_id, amount: receiveAmount(t)!, sendAmount: sendAmount(t),
      }, trace.correlationId);
      await withTransaction(this.pool, async (c) => {
        const row = await lockTransfer(c, id);
        if (row && !row.payout_requested_at) await patch(c, row, { payout_id: row.payout_id ?? payout.payoutId, payout_requested_at: new Date() });
      });
    } catch (err) {
      this.log.warn({ err, transferId: id }, 'payout request failed; the recovery job will retry');
    }
  }

  async requestRefund(id: string, trace: Trace): Promise<void> {
    const t = await getTransfer(this.pool, id);
    if (!t || t.status !== 'FAILED' || !t.payment_captured_at || t.refund_requested_at) return;
    try {
      await this.ports.refundPayment(t.payment_id!, { amount: totalCharge(t), reason: t.failure_code ?? 'transfer_failed' }, t.id, trace.correlationId);
      await withTransaction(this.pool, async (c) => {
        const row = await lockTransfer(c, id);
        if (row && !row.refund_requested_at) await patch(c, row, { refund_requested_at: new Date() });
      });
    } catch (err) {
      this.log.warn({ err, transferId: id }, 'refund request failed; the recovery job will retry');
    }
  }

  // ------------------------------------------------------------------ events
  /** Kafka consumer handler: state changes inside the inbox transaction, follow-up calls after it commits. */
  async onEvent(event: EventEnvelope, c: PoolClient): Promise<void | AfterCommit> {
    const data = event.data as Record<string, unknown>;
    const id = data.transferId as string | undefined;
    if (!id) return;
    const row = await lockTransfer(c, id);
    if (!row) {
      this.log.warn({ eventType: event.eventType, transferId: id }, 'event for an unknown transfer ignored');
      return;
    }
    const trace: Trace = { correlationId: event.correlationId, causationId: event.eventId };
    const actor: Actor = { type: 'service', id: event.producer };
    const fail = async (code: string, extra: Record<string, unknown> = {}) => {
      const failed = await transition(c, row, 'FAILED', actor, trace, { reason: code.toLowerCase(), set: { failure_code: code, ...extra } });
      return () => this.cleanup(failed, trace);
    };

    switch (event.eventType) {
      case 'payment.authorized': {
        if (row.status === 'FX_LOCKED') {
          await transition(c, row, 'COMPLIANCE_SCREENING', actor, trace, { reason: 'payment_authorized', set: { payment_id: data.paymentId } });
          return () => this.screen(id, trace);
        }
        if (row.status === 'CANCELLED' || row.status === 'FAILED') {
          // The hold arrived after the transfer stopped: release it straight away.
          return () => this.ports.voidPayment(data.paymentId as string, trace.correlationId).then(() => undefined);
        }
        return;
      }
      case 'payment.failed': {
        if (row.payment_captured_at || ['PAYMENT_COLLECTED', 'PAYOUT_DISPATCHED', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'].includes(row.status)) return;
        return fail(data.stage === 'capture' ? 'CAPTURE_FAILED' : 'PAYMENT_DECLINED');
      }
      case 'payment.refunded':
        if (row.status === 'FAILED') await transition(c, row, 'REFUNDED', actor, trace, { reason: 'refunded' });
        return;
      case 'payout.dispatched':
        if (row.status === 'PAYMENT_COLLECTED') {
          await transition(c, row, 'PAYOUT_DISPATCHED', actor, trace, { reason: 'payout_dispatched', set: { payout_id: data.payoutId } });
        }
        return;
      case 'payout.completed': {
        // Topics aren't ordered relative to each other: "completed" can arrive before "dispatched".
        const dispatched = row.status === 'PAYMENT_COLLECTED'
          ? await transition(c, row, 'PAYOUT_DISPATCHED', actor, trace, { reason: 'payout_dispatched', set: { payout_id: data.payoutId } })
          : row;
        if (dispatched.status === 'PAYOUT_DISPATCHED') await transition(c, dispatched, 'COMPLETED', actor, trace, { reason: 'delivered' });
        return;
      }
      case 'payout.failed':
        if (row.status !== 'PAYMENT_COLLECTED' && row.status !== 'PAYOUT_DISPATCHED') return;
        if (data.final) return fail('PAYOUT_FAILED', { failure_reason: String(data.reasonCode) });
        await patch(c, row, { failure_reason: `payout_manual_review:${String(data.reasonCode)}` });
        return;
      case 'compliance.review-decided': {
        if (row.status !== 'ON_HOLD') return;
        const officer: Actor = { type: 'staff', id: data.decidedBy as string };
        if (data.decision === 'reject') {
          const failed = await transition(c, row, 'FAILED', officer, trace, { reason: 'review_rejected', set: { failure_code: 'COMPLIANCE_REJECTED' } });
          return () => this.cleanup(failed, trace);
        }
        const lockStillValid = row.rate_lock_expires_at && row.rate_lock_expires_at.getTime() - Date.now() > LOCK_SAFETY_MS;
        if (lockStillValid) {
          await patch(c, row, { compliance_decision: 'pass', collect_requested_at: new Date() });
          return () => this.collect(id, trace);
        }
        const approved = await patch(c, row, { compliance_decision: 'pass' });
        await transition(c, approved, 'AWAITING_RECONFIRM', officer, trace, { reason: 'approved_after_rate_lock_expired' });
        return;
      }
      case 'fx.lock-expired': {
        if (row.status !== 'FX_LOCKED' || data.lockId !== row.fx_lock_id) return;
        const cancelled = await transition(c, row, 'CANCELLED', actor, trace, { reason: 'rate_lock_expired', set: { cancel_reason: 'rate_lock_expired' } });
        return () => this.cleanup(cancelled, trace);
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ customer actions
  private async owned(c: PoolClient, auth: AuthContext, id: string): Promise<TransferRow> {
    const row = await lockTransfer(c, id);
    if (!row || row.user_id !== auth.userId) throw new AppError('NOT_FOUND', 'Transfer not found.');
    return row;
  }

  async cancel(auth: AuthContext, id: string, reason: string | undefined, rid: string) {
    const trace: Trace = { correlationId: rid };
    const cancelled = await withTransaction(this.pool, async (c) => {
      const row = await this.owned(c, auth, id);
      const cancellable = ['FX_LOCKED', 'ON_HOLD', 'AWAITING_RECONFIRM'].includes(row.status) && !row.collect_requested_at;
      if (!cancellable) throw new AppError('INVALID_STATE_TRANSITION', `A transfer that is ${row.status.toLowerCase().replaceAll('_', ' ')} can't be cancelled.`);
      return transition(c, row, 'CANCELLED', { type: 'user', id: auth.userId }, trace, {
        reason: 'customer_request', set: { cancel_reason: reason?.trim() || 'customer_request' },
      });
    });
    await this.cleanup(cancelled, trace);
    return this.view(cancelled, rid);
  }

  private awaitingReconfirm(row: TransferRow): void {
    if (row.status !== 'AWAITING_RECONFIRM' || row.collect_requested_at) {
      throw new AppError('INVALID_STATE_TRANSITION', 'Only transfers waiting for you to accept a new rate can be re-quoted.');
    }
  }

  private assertSamePrice(t: TransferRow, q: Quote): void {
    const same = q.corridorCode === t.corridor_code && q.fundingMethod === t.funding_method
      && q.sendAmount.amountMinor === t.send_amount_minor && q.totalCharge.amountMinor === t.total_charge_minor;
    if (!same) {
      throw new AppError('CONFLICT', 'Fees or amounts changed since you confirmed. Cancel this transfer and start a new one.');
    }
  }

  async requote(auth: AuthContext, id: string, rid: string): Promise<Quote> {
    const t = await withTransaction(this.pool, (c) => this.owned(c, auth, id));
    this.awaitingReconfirm(t);
    const quote = await this.ports.createQuote({ corridorCode: t.corridor_code, sendAmount: sendAmount(t), fundingMethod: t.funding_method }, rid);
    this.assertSamePrice(t, quote);
    return quote;
  }

  async reconfirm(auth: AuthContext, id: string, quoteId: string, rid: string) {
    const trace: Trace = { correlationId: rid };
    const t = await withTransaction(this.pool, (c) => this.owned(c, auth, id));
    this.awaitingReconfirm(t);
    const quote = await this.ports.getQuote(quoteId, rid).catch((err) => {
      throw isCode(err, 'NOT_FOUND') ? new AppError('QUOTE_EXPIRED', 'This quote has expired. Ask for a new rate.') : err;
    });
    this.assertSamePrice(t, quote);
    const lock = await this.ports.lockRate({ transferId: t.id, userId: auth.userId, quoteId }, rid);
    await withTransaction(this.pool, async (c) => {
      const row = await this.owned(c, auth, id);
      this.awaitingReconfirm(row);
      await patch(c, row, {
        fx_lock_id: lock.lockId, quote_id: quoteId, receive_amount_minor: lock.receiveAmount.amountMinor, mid_rate: lock.midRate,
        offer_rate: lock.offerRate, rate_locked_at: new Date(lock.lockedAt), rate_lock_expires_at: new Date(lock.expiresAt),
        collect_requested_at: new Date(),
      });
    });
    await this.collect(id, trace);
    return this.view((await getTransfer(this.pool, id))!, rid);
  }

  // ------------------------------------------------------------------ recovery
  /** Resumes transfers that have been in a non-final state for too long (crash, missed event, dependency outage). */
  async recover(options: { staleSeconds?: number; now?: Date; transferIds?: string[] } = {}): Promise<number> {
    const at = options.now ?? new Date(); // tests move the clock forward instead of waiting
    const { rows } = await this.pool.query<TransferRow>(
      `SELECT * FROM core.transfers
        WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'REFUNDED') AND updated_at < $1::timestamptz - make_interval(secs => $2)
          AND ($3::uuid[] IS NULL OR id = ANY($3))
        ORDER BY updated_at LIMIT 100`,
      [at, options.staleSeconds ?? 60, options.transferIds ?? null],
    );
    const trace: Trace = { correlationId: 'job:transfer-recovery' };
    const now = at.getTime();
    for (const t of rows) {
      try {
        switch (t.status) {
          case 'INITIATED':
            await this.stop(t.id, 'FAILED', 'SETUP_INCOMPLETE', trace);
            break;
          case 'FX_LOCKED':
            if (t.rate_lock_expires_at && t.rate_lock_expires_at.getTime() <= now) await this.stop(t.id, 'CANCELLED', 'RATE_LOCK_EXPIRED', trace);
            else if (!t.payment_id && now - t.updated_at.getTime() > 5 * 60_000) await this.stop(t.id, 'FAILED', 'PAYMENT_NOT_STARTED', trace);
            break;
          case 'COMPLIANCE_SCREENING':
            await (t.collect_requested_at ? this.collect(t.id, trace) : this.screen(t.id, trace));
            break;
          case 'ON_HOLD':
            if (t.collect_requested_at) await this.collect(t.id, trace);
            break;
          case 'AWAITING_RECONFIRM':
            if (t.collect_requested_at) await this.collect(t.id, trace);
            else if (now - t.updated_at.getTime() > 24 * 3600_000) await this.stop(t.id, 'CANCELLED', 'RECONFIRM_TIMEOUT', trace);
            break;
          case 'PAYMENT_COLLECTED':
            await this.requestPayout(t.id, trace);
            break;
          case 'FAILED':
            await this.requestRefund(t.id, trace);
            break;
          default:
            break;
        }
      } catch (err) {
        this.log.error({ err, transferId: t.id }, 'recovery step failed');
      }
    }
    return rows.length;
  }
}
