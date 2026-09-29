// Inbound provider webhooks (docs/api.md): verify the signature over the exact bytes, store the event once
// (unique provider event id: duplicates are acknowledged and ignored), apply it in the same transaction.
// Events with a bad signature are never stored, so nobody can "reserve" a real event id with a forged one.
import { env, envOptional, verifyProviderSignature, verifyStripeSignature, withTransaction, type Logger, type Pool, type Queryable } from '@anchorpay/service-kit';
import type { FastifyRequest } from 'fastify';
import type { Payments, ProviderEvent } from './domain/payments.ts';
import type { PartnerEvent, Payouts } from './domain/payouts.ts';

type Outcome = { applied: boolean; note?: string; afterCommit?: (() => Promise<void>) | null };

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

export class Webhooks {
  private readonly pool: Pool;
  private readonly payments: Payments;
  private readonly payouts: Payouts;
  private readonly log: Logger;

  constructor(deps: { pool: Pool; payments: Payments; payouts: Payouts; log: Logger }) {
    this.pool = deps.pool;
    this.payments = deps.payments;
    this.payouts = deps.payouts;
    this.log = deps.log;
  }

  private async record(provider: string, eventId: string, eventType: string, payload: unknown, apply: (c: Queryable) => Promise<Outcome>) {
    const followUp = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO payments.webhook_events (provider, provider_event_id, event_type, signature_valid, payload)
         VALUES ($1, $2, $3, true, $4) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
        [provider, eventId, eventType, payload]);
      if (!rows[0]) return null; // seen before: acknowledge, do nothing
      const outcome = await apply(c);
      await c.query('UPDATE payments.webhook_events SET processed_at = now(), processing_error = $2 WHERE id = $1',
        [rows[0].id, outcome.applied ? null : outcome.note ?? 'ignored']);
      if (!outcome.applied) this.log.info({ provider, eventId, eventType, note: outcome.note }, 'webhook event changed nothing');
      return outcome.afterCommit ?? null;
    });
    if (followUp) await followUp();
    return { received: true as const };
  }

  mockCard(req: FastifyRequest) {
    verifyProviderSignature({ secret: env('MOCK_WEBHOOK_SECRET'), rawBody: req.rawBody, timestamp: header(req, 'x-timestamp'), signature: header(req, 'x-signature') });
    const e = req.body as { eventId: string; type: 'card.authorized' | 'card.declined'; paymentIntentId: string; cardBrand?: string; cardLast4?: string;
      failureCode?: string; authorizationExpiresAt?: string };
    const ev: ProviderEvent = e.type === 'card.authorized'
      ? { kind: 'authorized', provider: 'mock', providerPaymentId: e.paymentIntentId, ...(e.cardBrand ? { cardBrand: e.cardBrand } : {}),
        ...(e.cardLast4 ? { cardLast4: e.cardLast4 } : {}), ...(e.authorizationExpiresAt ? { authorizationExpiresAt: e.authorizationExpiresAt } : {}) }
      : { kind: 'declined', provider: 'mock', providerPaymentId: e.paymentIntentId, failureCode: e.failureCode ?? 'card_declined' };
    return this.record('mock-card', e.eventId, e.type, e, (c) => this.payments.onProviderEvent(c, ev, req.id));
  }

  payoutPartner(req: FastifyRequest) {
    verifyProviderSignature({ secret: env('MOCK_WEBHOOK_SECRET'), rawBody: req.rawBody, timestamp: header(req, 'x-timestamp'), signature: header(req, 'x-signature') });
    const e = req.body as PartnerEvent;
    return this.record('payout-partner', e.eventId, e.type, e, (c) => this.payouts.onPartnerEvent(c, e, req.id));
  }

  /** Stripe TEST mode: the events a manual-capture card flow produces; anything else is stored and ignored. */
  stripe(req: FastifyRequest) {
    verifyStripeSignature({ secret: envOptional('STRIPE_WEBHOOK_SECRET') ?? '', rawBody: req.rawBody, header: header(req, 'stripe-signature') });
    const e = req.body as { id: string; type: string; data?: { object?: Record<string, any> } };
    const o = e.data?.object ?? {};
    let ev: ProviderEvent | null = null;
    if (e.type === 'payment_intent.amount_capturable_updated') ev = { kind: 'authorized', provider: 'stripe', providerPaymentId: String(o.id) };
    if (e.type === 'payment_intent.payment_failed') {
      ev = { kind: 'declined', provider: 'stripe', providerPaymentId: String(o.id), failureCode: o.last_payment_error?.decline_code ?? o.last_payment_error?.code ?? 'card_declined' };
    }
    if ((e.type === 'refund.updated' || e.type === 'charge.refund.updated') && (o.status === 'succeeded' || o.status === 'failed')) {
      ev = { kind: 'refund_updated', provider: 'stripe', providerRefundId: String(o.id), status: o.status };
    }
    return this.record('stripe', String(e.id), e.type, e, async (c) => (ev ? this.payments.onProviderEvent(c, ev, req.id) : { applied: false, note: 'event type not used' }));
  }
}
