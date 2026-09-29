// Collecting the sender's money: authorise (hold) -> capture (charge) | void (release) -> refund (DECISIONS D-05, D-44..D-48).
// State changes and their events share one transaction (outbox); calls to the provider happen outside it. Every
// operation is idempotent: replaying capture/void/refund returns the current state instead of acting twice.
import {
  AppError, buildEvent, enqueueEvent, withTransaction, writeAudit, type Logger, type Pool, type Queryable,
} from '@anchorpay/service-kit';
import { SERVICE } from '../deps.ts';
import { ProviderError, type Money, type PaymentAction, type ProviderPayment, type Providers } from '../providers.ts';

export interface PaymentRow {
  id: string;
  transfer_id: string;
  user_id: string;
  method: 'card' | 'bank_debit';
  provider: 'mock' | 'stripe';
  provider_payment_id: string | null;
  amount_minor: number;
  currency: string;
  fee_minor: number;
  card_surcharge_minor: number;
  status: 'requires_action' | 'authorized' | 'captured' | 'voided' | 'failed' | 'refunded' | 'partially_refunded';
  card_brand: string | null;
  card_last4: string | null;
  failure_code: string | null;
  failure_message: string | null;
  authorized_at: Date | null;
  captured_at: Date | null;
  voided_at: Date | null;
  authorization_expires_at: Date | null;
  created_at: Date;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  transfer_id: string;
  amount_minor: number;
  currency: string;
  provider_refund_id: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  reason: string;
  created_at: Date;
}

/** A provider's webhook, reduced to what the domain needs (mock card processor or Stripe). */
export type ProviderEvent =
  | { kind: 'authorized'; provider: 'mock' | 'stripe'; providerPaymentId: string; cardBrand?: string; cardLast4?: string; authorizationExpiresAt?: string }
  | { kind: 'declined'; provider: 'mock' | 'stripe'; providerPaymentId: string; failureCode: string }
  | { kind: 'refund_updated'; provider: 'mock' | 'stripe'; providerRefundId: string; status: 'succeeded' | 'failed' };

type AfterCommit = (() => Promise<void>) | null;

const FAILURE_CODES = new Set(['card_declined', 'insufficient_funds', 'authorization_expired', 'bank_debit_returned', 'provider_error']);
const DEFAULT_HOLD_MS = 7 * 24 * 3600_000; // card holds last about 7 days
const money = (amountMinor: number, currency: string): Money => ({ amountMinor: Number(amountMinor), currency: currency.trim() });

/** payment.failed only allows these codes; anything else a provider says is a decline of that method. */
function failureCode(code: string, method: 'card' | 'bank_debit'): string {
  if (FAILURE_CODES.has(code)) return code;
  return method === 'card' ? 'card_declined' : 'bank_debit_returned';
}

export function toApi(p: PaymentRow) {
  return {
    paymentId: p.id,
    transferId: p.transfer_id,
    method: p.method,
    provider: p.provider,
    amount: money(p.amount_minor, p.currency),
    status: p.status,
    ...(p.card_brand ? { cardBrand: p.card_brand } : {}),
    ...(p.card_last4 ? { cardLast4: p.card_last4 } : {}),
    ...(p.failure_code ? { failureCode: p.failure_code } : {}),
    ...(p.authorization_expires_at ? { authorizationExpiresAt: p.authorization_expires_at.toISOString() } : {}),
  };
}

export function refundToApi(r: RefundRow) {
  return { refundId: r.id, paymentId: r.payment_id, transferId: r.transfer_id, amount: money(r.amount_minor, r.currency), status: r.status };
}

async function event(q: Queryable, type: string, p: PaymentRow, data: Record<string, unknown>, correlationId: string) {
  await enqueueEvent(q, 'payments', buildEvent(type, { paymentId: p.id, transferId: p.transfer_id, ...data }, { producer: SERVICE, correlationId }), p.transfer_id);
}

async function audit(q: Queryable, action: string, p: PaymentRow, requestId: string, after: Record<string, unknown>) {
  await writeAudit(q, {
    service: SERVICE, actorType: 'service', actorId: SERVICE, action, entityType: 'payment', entityId: p.id, before: null, after, requestId,
  });
}

export class Payments {
  private readonly pool: Pool;
  private readonly providers: Providers;
  private readonly log: Logger;

  constructor(deps: { pool: Pool; providers: Providers; log: Logger }) {
    this.pool = deps.pool;
    this.providers = deps.providers;
    this.log = deps.log;
  }

  private async lock(q: Queryable, id: string): Promise<PaymentRow> {
    const { rows } = await q.query<PaymentRow>('SELECT * FROM payments.payments WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Payment not found.');
    return rows[0];
  }

  private async update(q: Queryable, id: string, set: Record<string, unknown>): Promise<PaymentRow> {
    const keys = Object.keys(set);
    const { rows } = await q.query<PaymentRow>(
      `UPDATE payments.payments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => set[k])],
    );
    return rows[0]!;
  }

  // ------------------------------------------------------------------ authorise
  async authorize(body: {
    transferId: string; userId: string; method: 'card' | 'bank_debit'; amount: Money; fee: Money; cardSurcharge: Money; returnUrl?: string;
  }, rid: string): Promise<{ payment: ReturnType<typeof toApi>; paymentAction: PaymentAction }> {
    for (const part of [body.fee, body.cardSurcharge]) {
      if (part.currency !== body.amount.currency) throw new AppError('VALIDATION_ERROR', 'fee and cardSurcharge must be in the payment currency.');
    }
    if (body.fee.amountMinor + body.cardSurcharge.amountMinor >= body.amount.amountMinor) {
      throw new AppError('VALIDATION_ERROR', 'fee + cardSurcharge must be less than the amount.');
    }
    const provider = this.providers[body.method];
    // Idempotent per transfer: a repeated call returns the same payment (and what the client still has to do).
    const { rows: existing } = await this.pool.query<PaymentRow>('SELECT * FROM payments.payments WHERE transfer_id = $1', [body.transferId]);
    if (existing[0]) return this.replay(existing[0]);
    let row: PaymentRow;
    try {
      const { rows } = await this.pool.query<PaymentRow>(
        `INSERT INTO payments.payments (transfer_id, user_id, method, provider, amount_minor, currency, fee_minor, card_surcharge_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [body.transferId, body.userId, body.method, provider.name, body.amount.amountMinor, body.amount.currency, body.fee.amountMinor,
          body.cardSurcharge.amountMinor],
      );
      row = rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        const again = await this.pool.query<PaymentRow>('SELECT * FROM payments.payments WHERE transfer_id = $1', [body.transferId]);
        return this.replay(again.rows[0]!);
      }
      throw err;
    }

    let result: ProviderPayment;
    try {
      result = await provider.authorize({
        paymentId: row.id, transferId: body.transferId, method: body.method, amount: body.amount, ...(body.returnUrl ? { returnUrl: body.returnUrl } : {}),
      });
    } catch (err) {
      const unavailable = !(err instanceof ProviderError) || err.kind === 'unavailable';
      await this.pool.query("UPDATE payments.payments SET status = 'failed', failure_code = 'provider_error', failure_message = $2 WHERE id = $1",
        [row.id, (err as Error).message.slice(0, 500)]);
      this.log.warn({ err, paymentId: row.id }, 'payment provider refused or failed the authorisation');
      throw unavailable
        ? new AppError('SERVICE_UNAVAILABLE', "We couldn't reach the payment provider. You were not charged.")
        : new AppError('CONFLICT', 'The payment provider refused this payment.');
    }

    row = await withTransaction(this.pool, async (c) => {
      const locked = await this.lock(c, row.id);
      const card = result.cardBrand ? { card_brand: result.cardBrand, card_last4: result.cardLast4 ?? null } : {};
      if (result.status === 'authorized') return this.markAuthorized(c, locked, result.providerPaymentId, card, result.authorizationExpiresAt, rid);
      if (result.status === 'declined') return this.markFailed(c, locked, 'authorization', result.failureCode ?? 'provider_error', rid, { provider_payment_id: result.providerPaymentId });
      return this.update(c, locked.id, { provider_payment_id: result.providerPaymentId });
    });
    return { payment: toApi(row), paymentAction: result.action };
  }

  private async replay(row: PaymentRow) {
    if (row.status === 'requires_action' && !row.provider_payment_id) {
      throw new AppError('CONFLICT', 'This payment is still being set up. Try again in a moment.');
    }
    const action = row.status === 'requires_action' ? await this.providers[row.method].action(row.provider_payment_id!) : { type: 'none' as const };
    return { payment: toApi(row), paymentAction: action };
  }

  private async markAuthorized(c: Queryable, p: PaymentRow, providerPaymentId: string, card: Record<string, unknown>, expiresAt: string | undefined, rid: string) {
    const authorizedAt = new Date();
    const expiry = expiresAt ? new Date(expiresAt) : new Date(authorizedAt.getTime() + DEFAULT_HOLD_MS);
    const row = await this.update(c, p.id, {
      status: 'authorized', provider_payment_id: providerPaymentId, authorized_at: authorizedAt, authorization_expires_at: expiry, ...card,
    });
    await event(c, 'payment.authorized', row, {
      method: row.method, amount: money(row.amount_minor, row.currency), authorizedAt: authorizedAt.toISOString(), authorizationExpiresAt: expiry.toISOString(),
    }, rid);
    return row;
  }

  private async markFailed(c: Queryable, p: PaymentRow, stage: 'authorization' | 'capture', code: string, rid: string, extra: Record<string, unknown> = {}) {
    const mapped = failureCode(code, p.method);
    const row = await this.update(c, p.id, { status: 'failed', failure_code: mapped, ...extra });
    await event(c, 'payment.failed', row, { stage, failureCode: mapped, failedAt: new Date().toISOString() }, rid);
    return row;
  }

  // ------------------------------------------------------------------ capture / void
  async capture(id: string, rid: string) {
    const p = await withTransaction(this.pool, async (c) => {
      const row = await this.lock(c, id);
      if (row.status === 'authorized' && row.authorization_expires_at && row.authorization_expires_at <= new Date()) {
        await this.markFailed(c, row, 'capture', 'authorization_expired', rid);
        return { expired: true as const, row };
      }
      return { expired: false as const, row };
    });
    if (p.expired) throw new AppError('PAYMENT_DECLINED', 'The payment authorisation expired before it could be charged.');
    const row = p.row;
    if (row.status === 'captured' || row.status === 'refunded' || row.status === 'partially_refunded') return toApi(row);
    if (row.status !== 'authorized') throw new AppError('CONFLICT', `A ${row.status} payment can't be captured.`);

    try {
      await this.providers[row.method].capture(row.provider_payment_id!, money(row.amount_minor, row.currency));
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'declined') {
        await withTransaction(this.pool, async (c) => {
          const locked = await this.lock(c, id);
          if (locked.status === 'authorized') await this.markFailed(c, locked, 'capture', err.code, rid);
        });
        throw new AppError('PAYMENT_DECLINED', 'The payment provider refused to charge the held amount.');
      }
      throw new AppError('SERVICE_UNAVAILABLE', "We couldn't reach the payment provider. Nothing was charged yet; try again.");
    }

    const captured = await withTransaction(this.pool, async (c) => {
      const locked = await this.lock(c, id);
      if (locked.status !== 'authorized') return locked; // a concurrent capture got there first
      const capturedAt = new Date();
      const updated = await this.update(c, id, { status: 'captured', captured_at: capturedAt });
      await event(c, 'payment.captured', updated, {
        method: updated.method, amount: money(updated.amount_minor, updated.currency), fee: money(updated.fee_minor, updated.currency),
        cardSurcharge: money(updated.card_surcharge_minor, updated.currency), capturedAt: capturedAt.toISOString(),
      }, rid);
      await audit(c, 'payment.captured', updated, rid, { amountMinor: Number(updated.amount_minor), currency: updated.currency.trim() });
      return updated;
    });
    return toApi(captured);
  }

  async void(id: string, rid: string) {
    const { row, cancel } = await withTransaction(this.pool, async (c) => {
      const locked = await this.lock(c, id);
      if (locked.status === 'captured' || locked.status === 'refunded' || locked.status === 'partially_refunded') {
        throw new AppError('CONFLICT', 'A captured payment must be refunded, not voided.');
      }
      if (locked.status !== 'requires_action' && locked.status !== 'authorized') return { row: locked, cancel: false };
      const voided = await this.update(c, id, { status: 'voided', voided_at: new Date() });
      await audit(c, 'payment.voided', voided, rid, { previous: locked.status });
      return { row: voided, cancel: Boolean(voided.provider_payment_id) };
    });
    if (cancel) await this.cancelQuietly(row);
    return toApi(row);
  }

  /** Releases the hold at the provider; a failure here only delays the release (the hold lapses by itself). */
  private async cancelQuietly(row: PaymentRow): Promise<void> {
    try {
      await this.providers[row.method].cancel(row.provider_payment_id!);
    } catch (err) {
      this.log.warn({ err, paymentId: row.id }, 'could not release the hold at the provider; it will lapse on its own');
    }
  }

  // ------------------------------------------------------------------ refund
  async refund(id: string, body: { amount: Money; reason: string }, rid: string) {
    const refund = await withTransaction(this.pool, async (c) => {
      const p = await this.lock(c, id);
      const { rows: earlier } = await c.query<RefundRow>("SELECT * FROM payments.refunds WHERE payment_id = $1 AND status <> 'failed'", [id]);
      if (earlier[0]) return earlier[0]; // one refund per payment: a retry gets the same one
      if (p.status !== 'captured') throw new AppError('CONFLICT', `A ${p.status} payment can't be refunded.`);
      if (body.amount.currency !== p.currency.trim() || body.amount.amountMinor > Number(p.amount_minor) || body.amount.amountMinor <= 0) {
        throw new AppError('VALIDATION_ERROR', 'The refund must be in the payment currency and no more than the amount charged.');
      }
      const { rows } = await c.query<RefundRow>(
        'INSERT INTO payments.refunds (payment_id, transfer_id, amount_minor, currency, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [id, p.transfer_id, body.amount.amountMinor, body.amount.currency, body.reason.slice(0, 200)],
      );
      await audit(c, 'payment.refund_requested', p, rid, { refundId: rows[0]!.id, amountMinor: body.amount.amountMinor, reason: body.reason.slice(0, 200) });
      return rows[0]!;
    });
    return refundToApi(refund.provider_refund_id || refund.status !== 'pending' ? refund : await this.sendRefund(refund, rid));
  }

  /** Asks the provider for the refund (idempotency key = our refund id). Leaves it pending if the provider is down. */
  async sendRefund(refund: RefundRow, rid: string): Promise<RefundRow> {
    const { rows: [p] } = await this.pool.query<PaymentRow>('SELECT * FROM payments.payments WHERE id = $1', [refund.payment_id]);
    let result: { providerRefundId: string; status: 'pending' | 'succeeded' };
    try {
      result = await this.providers[p!.method].refund(p!.provider_payment_id!, money(refund.amount_minor, refund.currency), refund.id);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'declined') {
        this.log.error({ err, refundId: refund.id }, 'the provider refused a refund: needs an operator');
        const { rows } = await this.pool.query<RefundRow>("UPDATE payments.refunds SET status = 'failed' WHERE id = $1 RETURNING *", [refund.id]);
        return rows[0]!;
      }
      this.log.warn({ err, refundId: refund.id }, 'refund not sent yet; the maintenance job retries it');
      return refund;
    }
    return withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<RefundRow>('UPDATE payments.refunds SET provider_refund_id = $2 WHERE id = $1 RETURNING *', [refund.id, result.providerRefundId]);
      return result.status === 'succeeded' ? this.refundSucceeded(c, rows[0]!, rid) : rows[0]!;
    });
  }

  private async refundSucceeded(c: Queryable, refund: RefundRow, rid: string): Promise<RefundRow> {
    if (refund.status === 'succeeded') return refund;
    const { rows } = await c.query<RefundRow>("UPDATE payments.refunds SET status = 'succeeded' WHERE id = $1 RETURNING *", [refund.id]);
    const p = await this.lock(c, refund.payment_id);
    const full = Number(refund.amount_minor) >= Number(p.amount_minor);
    const updated = await this.update(c, p.id, { status: full ? 'refunded' : 'partially_refunded' });
    await event(c, 'payment.refunded', updated, {
      refundId: refund.id, amount: money(refund.amount_minor, refund.currency), refundedAt: new Date().toISOString(),
    }, rid);
    return rows[0]!;
  }

  // ------------------------------------------------------------------ provider webhooks
  /** Applies a provider event inside the webhook's transaction; returns a follow-up to run after commit. */
  async onProviderEvent(c: Queryable, ev: ProviderEvent, rid: string): Promise<{ applied: boolean; afterCommit: AfterCommit; note?: string }> {
    if (ev.kind === 'refund_updated') {
      const { rows } = await c.query<RefundRow>(
        `SELECT r.* FROM payments.refunds r JOIN payments.payments p ON p.id = r.payment_id
          WHERE r.provider_refund_id = $1 AND p.provider = $2 FOR UPDATE OF r`, [ev.providerRefundId, ev.provider]);
      if (!rows[0]) return { applied: false, afterCommit: null, note: 'unknown refund' };
      if (ev.status === 'succeeded') await this.refundSucceeded(c, rows[0], rid);
      else if (rows[0].status === 'pending') {
        await c.query("UPDATE payments.refunds SET status = 'failed' WHERE id = $1", [rows[0].id]);
        this.log.error({ refundId: rows[0].id }, 'the provider failed a refund: needs an operator');
      }
      return { applied: true, afterCommit: null };
    }
    const { rows } = await c.query<PaymentRow>(
      'SELECT * FROM payments.payments WHERE provider = $1 AND provider_payment_id = $2 FOR UPDATE', [ev.provider, ev.providerPaymentId]);
    const p = rows[0];
    if (!p) return { applied: false, afterCommit: null, note: 'unknown payment' };
    if (ev.kind === 'authorized') {
      if (p.status === 'requires_action') {
        const card = ev.cardBrand ? { card_brand: ev.cardBrand, card_last4: ev.cardLast4 ?? null } : {};
        await this.markAuthorized(c, p, ev.providerPaymentId, card, ev.authorizationExpiresAt, rid);
        return { applied: true, afterCommit: null };
      }
      if (p.status === 'voided') {
        // The customer finished the card form after the transfer was cancelled: release the new hold straight away.
        return { applied: true, afterCommit: () => this.cancelQuietly(p) };
      }
      return { applied: false, afterCommit: null, note: `already ${p.status}` };
    }
    if (p.status !== 'requires_action') return { applied: false, afterCommit: null, note: `already ${p.status}` };
    await this.markFailed(c, p, 'authorization', ev.failureCode, rid);
    return { applied: true, afterCommit: null };
  }

  // ------------------------------------------------------------------ maintenance
  /** Holds that lapsed before capture fail (transfer-service then fails the transfer); unsent refunds are retried. */
  async maintain(now = new Date()): Promise<{ expired: number; refundsRetried: number }> {
    const expired = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<PaymentRow>(
        `SELECT * FROM payments.payments WHERE status = 'authorized' AND authorization_expires_at <= $1
          ORDER BY authorization_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`, [now]);
      for (const p of rows) await this.markFailed(c, p, 'capture', 'authorization_expired', 'job:payment-maintenance');
      return rows;
    });
    for (const p of expired) if (p.provider_payment_id) await this.cancelQuietly(p);

    const { rows: unsent } = await this.pool.query<RefundRow>(
      `SELECT * FROM payments.refunds WHERE status = 'pending' AND provider_refund_id IS NULL AND created_at < $1::timestamptz - interval '30 seconds'
        ORDER BY created_at LIMIT 50`, [now]);
    for (const r of unsent) await this.sendRefund(r, 'job:payment-maintenance');
    return { expired: expired.length, refundsRetried: unsent.length };
  }
}
