import { AppError, requireAuth, type Logger, type Service } from '@anchorpay/service-kit';
import { refundToApi, toApi as paymentToApi, type Payments } from './domain/payments.ts';
import { toApi as payoutToApi, toInternal, type PayoutRow, type Payouts } from './domain/payouts.ts';
import type { Money } from './providers.ts';
import type { Webhooks } from './webhooks.ts';

export function registerRoutes(svc: Service, deps: { payments: Payments; payouts: Payouts; webhooks: Webhooks; log: Logger }): void {
  const { payments, payouts, webhooks, log } = deps;
  const paymentId = (req: { params: unknown }) => (req.params as { paymentId: string }).paymentId;
  const payoutId = (req: { params: unknown }) => (req.params as { payoutId: string }).payoutId;
  /** Starts the first attempt right away instead of waiting for the dispatcher's next tick. */
  const kick = (id: string, rid: string) => {
    setImmediate(() => payouts.attempt(id, rid).catch((err) => log.error({ err, payoutId: id }, 'payout attempt failed to run')));
  };

  // ------------------------------------------------------------------ internal (transfer-service, ledger-service)
  svc.handle('internalAuthorizePayment', async (req, reply) => {
    const result = await payments.authorize(req.body as Parameters<Payments['authorize']>[0], req.id);
    return reply.code(201).send(result);
  });

  svc.handle('internalCapturePayment', async (req) => payments.capture(paymentId(req), req.id));
  svc.handle('internalVoidPayment', async (req) => payments.void(paymentId(req), req.id));

  svc.handle('internalRefundPayment', async (req, reply) => {
    // Idempotency-Key is required by the contract; the database allows one refund per payment, so a repeated
    // request (same key or not) always gets the refund that already exists.
    const refund = await payments.refund(paymentId(req), req.body as { amount: Money; reason: string }, req.id);
    return reply.code(202).send(refund);
  });

  svc.handle('internalCreatePayout', async (req, reply) => {
    const payout = await payouts.create(req.body as Parameters<Payouts['create']>[0], req.id);
    if (payout.status === 'pending' && payout.attempts === 0) kick(payout.id, req.id);
    return reply.code(202).send(toInternal(payout));
  });

  svc.handle('internalGetPayout', async (req) => {
    const p = await payouts.get(payoutId(req));
    if (!p) throw new AppError('NOT_FOUND', 'Payout not found.');
    return toInternal(p);
  });

  // ------------------------------------------------------------------ admin: the payout queue
  svc.handle('adminListPayouts', async (req) => payouts.list(req.query as { status?: PayoutRow['status']; page: number; pageSize: number }));

  svc.handle('adminRetryPayout', async (req, reply) => {
    const p = await payouts.adminRetry(requireAuth(req), payoutId(req), req.id);
    kick(p.id, req.id);
    return reply.code(202).send(payoutToApi(p));
  });

  svc.handle('adminFailPayout', async (req) => {
    const { note } = req.body as { note: string };
    return payoutToApi(await payouts.adminFail(requireAuth(req), payoutId(req), note, req.id));
  });

  // ------------------------------------------------------------------ provider webhooks (no JWT: signed)
  svc.handle('mockCardWebhook', async (req) => webhooks.mockCard(req));
  svc.handle('payoutPartnerWebhook', async (req) => webhooks.payoutPartner(req));
  svc.handle('stripeWebhook', async (req) => webhooks.stripe(req));
}

export { paymentToApi, refundToApi };
