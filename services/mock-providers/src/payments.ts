// Mock card processor + mock bank debit (DECISIONS D-44, D-45). The API mirrors a manual-capture card processor:
// create -> (card: customer fills the hosted form) authorised -> capture | cancel -> refund.
//
// Test cards (like every card sandbox): 4000 0000 0000 0002 declined, 4000 0000 0000 9995 insufficient funds,
// any other valid card number (e.g. 4242 4242 4242 4242) is authorised. Bank debit: a total ending in .13 bounces.
import { randomBytes } from 'node:crypto';
import { AppError, envInt, type Service } from '@anchorpay/service-kit';
import { authorizePage, resultPage } from './page.ts';
import type { MockPayment, Money, Store } from './store.ts';
import { newEventId, type Deliver } from './webhooks.ts';

export const TEST_CARDS = {
  success: '4242424242424242',
  declined: '4000000000000002',
  insufficientFunds: '4000000000009995',
} as const;

export const hexId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function brand(digits: string): string {
  if (digits.startsWith('4')) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  return 'card';
}

/** Checks the card form; returns the field problems (empty when valid). */
export function validateCard(input: { cardNumber?: string; expiry?: string; cvc?: string }, now = new Date()): Record<string, string> {
  const errors: Record<string, string> = {};
  const digits = (input.cardNumber ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits) || !luhnValid(digits)) errors.cardNumber = 'Enter a valid card number.';
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(input.expiry ?? '');
  const month = Number(m?.[1]);
  const expiresEnd = m ? new Date(Date.UTC(2000 + Number(m[2]), month, 1)) : null; // first day after the expiry month
  if (!m || month < 1 || month > 12 || !expiresEnd || expiresEnd <= now) errors.expiry = 'Enter a future expiry date (MM/YY).';
  if (!/^\d{3,4}$/.test(input.cvc ?? '')) errors.cvc = 'Enter the 3 or 4 digit security code.';
  return errors;
}

const view = (p: MockPayment, publicUrl: string) => ({
  id: p.id,
  reference: p.reference,
  method: p.method,
  amount: p.amount,
  status: p.status,
  ...(p.status === 'requires_action' ? { authorizeUrl: `${publicUrl}/card/authorize/${p.id}` } : {}),
  ...(p.cardBrand ? { cardBrand: p.cardBrand, cardLast4: p.cardLast4 } : {}),
  ...(p.failureCode ? { failureCode: p.failureCode } : {}),
  ...(p.authorizationExpiresAt ? { authorizationExpiresAt: p.authorizationExpiresAt } : {}),
});

export function registerPaymentRoutes(svc: Service, options: { store: Store; deliver: Deliver; publicUrl: string; requireApiKey: (h: unknown) => void }) {
  const { store, deliver, publicUrl } = options;
  const app = svc.app;
  const holdMs = envInt('MOCK_CARD_HOLD_HOURS', 168) * 3600_000; // card holds last about 7 days
  const find = (id: string) => {
    const p = store.payments.get(id);
    if (!p) throw new AppError('NOT_FOUND', 'No such payment.');
    return p;
  };
  const conflict = (p: MockPayment, action: string) => new AppError('CONFLICT', `A ${p.status} payment can't be ${action}.`);

  // ---------------------------------------------------------------- processor API (called by payment-service)
  app.post('/payments', async (req, reply) => {
    options.requireApiKey(req.headers);
    const body = req.body as { reference: string; method: 'card' | 'bank_debit'; amount: Money; returnUrl?: string };
    if (!body?.reference || !['card', 'bank_debit'].includes(body.method) || !Number.isInteger(body.amount?.amountMinor)) {
      throw new AppError('VALIDATION_ERROR', 'reference, method and amount are required.');
    }
    const existing = store.paymentByReference(body.reference);
    if (existing) return reply.code(200).send(view(existing, publicUrl)); // idempotent per reference
    const now = new Date();
    const p: MockPayment = {
      id: hexId(body.method === 'card' ? 'mpi' : 'mbd'), reference: body.reference, method: body.method, amount: body.amount,
      status: 'requires_action', refunds: [], createdAt: now.toISOString(), ...(body.returnUrl ? { returnUrl: body.returnUrl } : {}),
    };
    if (body.method === 'bank_debit') {
      // Pre-authorised debit: no customer step. A total ending in .13 bounces (for trying the unhappy path).
      if (body.amount.amountMinor % 100 === 13) Object.assign(p, { status: 'declined', failureCode: 'bank_debit_returned' });
      else Object.assign(p, { status: 'authorized', authorizationExpiresAt: new Date(now.getTime() + holdMs).toISOString() });
    }
    store.payments.set(p.id, p);
    store.save();
    return reply.code(201).send(view(p, publicUrl));
  });

  app.get('/payments/:id', async (req) => {
    options.requireApiKey(req.headers);
    return view(find((req.params as { id: string }).id), publicUrl);
  });

  app.post('/payments/:id/capture', async (req) => {
    options.requireApiKey(req.headers);
    const p = find((req.params as { id: string }).id);
    if (p.status === 'captured') return view(p, publicUrl);
    if (p.status !== 'authorized') throw conflict(p, 'captured');
    if (p.authorizationExpiresAt && new Date(p.authorizationExpiresAt) <= new Date()) {
      throw new AppError('PAYMENT_DECLINED', 'authorization_expired');
    }
    p.status = 'captured';
    store.save();
    return view(p, publicUrl);
  });

  app.post('/payments/:id/cancel', async (req) => {
    options.requireApiKey(req.headers);
    const p = find((req.params as { id: string }).id);
    if (p.status === 'captured' || p.status === 'refunded') throw conflict(p, 'cancelled');
    if (p.status === 'requires_action' || p.status === 'authorized') {
      p.status = 'canceled';
      store.save();
    }
    return view(p, publicUrl);
  });

  app.post('/payments/:id/refunds', async (req, reply) => {
    options.requireApiKey(req.headers);
    const p = find((req.params as { id: string }).id);
    const body = req.body as { amount: Money; idempotencyKey: string };
    const earlier = p.refunds.find((r) => r.idempotencyKey === body.idempotencyKey);
    if (earlier) return reply.code(200).send(earlier);
    if (p.status !== 'captured') throw conflict(p, 'refunded');
    if (body.amount.amountMinor > p.amount.amountMinor) throw new AppError('VALIDATION_ERROR', 'Refund is larger than the payment.');
    const refund = { refundId: hexId('mre'), idempotencyKey: body.idempotencyKey, amount: body.amount, status: 'succeeded' as const, createdAt: new Date().toISOString() };
    p.refunds.push(refund);
    p.status = 'refunded';
    store.save();
    return reply.code(201).send(refund);
  });

  // ---------------------------------------------------------------- hosted card form (the customer's browser)
  app.get('/card/authorize/:id', async (req, reply) => {
    const p = store.payments.get((req.params as { id: string }).id);
    if (!p || p.method !== 'card') return reply.code(404).type('text/html').send(resultPage('Payment not found', 'This payment link is not valid.'));
    if (p.status !== 'requires_action') {
      return reply.type('text/html').send(resultPage('Already done', `This payment is ${p.status}. You can close this page.`, p.returnUrl));
    }
    return reply.type('text/html').send(authorizePage(p, {}));
  });

  app.post('/card/authorize/:id', async (req, reply) => {
    const p = store.payments.get((req.params as { id: string }).id);
    const wantsJson = String(req.headers['content-type'] ?? '').includes('application/json');
    if (!p || p.method !== 'card') throw new AppError('NOT_FOUND', 'No such payment.');
    if (p.status !== 'requires_action') {
      if (wantsJson) return reply.code(409).send({ status: p.status });
      return reply.type('text/html').send(resultPage('Already done', `This payment is ${p.status}.`, p.returnUrl));
    }
    const input = (req.body ?? {}) as { cardNumber?: string; expiry?: string; cvc?: string };
    const errors = validateCard(input);
    if (Object.keys(errors).length) {
      if (wantsJson) return reply.code(400).send({ errors });
      return reply.code(400).type('text/html').send(authorizePage(p, errors));
    }
    const digits = input.cardNumber!.replace(/[\s-]/g, '');
    const failure = digits === TEST_CARDS.declined ? 'card_declined' : digits === TEST_CARDS.insufficientFunds ? 'insufficient_funds' : null;
    Object.assign(p, { cardBrand: brand(digits), cardLast4: digits.slice(-4) });
    if (failure) Object.assign(p, { status: 'declined', failureCode: failure });
    else Object.assign(p, { status: 'authorized', authorizationExpiresAt: new Date(Date.now() + holdMs).toISOString() });
    store.save();

    void deliver('/webhooks/mock-card', {
      eventId: newEventId(), type: failure ? 'card.declined' : 'card.authorized', paymentIntentId: p.id, reference: p.reference,
      cardBrand: p.cardBrand, cardLast4: p.cardLast4, ...(failure ? { failureCode: failure } : { authorizationExpiresAt: p.authorizationExpiresAt }),
      occurredAt: new Date().toISOString(),
    });

    const outcome = failure ? 'declined' : 'authorized';
    const redirectUrl = p.returnUrl ? `${p.returnUrl}${p.returnUrl.includes('?') ? '&' : '?'}payment=${outcome}` : undefined;
    if (wantsJson) return reply.send({ status: p.status, ...(redirectUrl ? { redirectUrl } : {}) });
    if (redirectUrl) return reply.code(303).header('location', redirectUrl).send();
    return reply.type('text/html').send(resultPage(failure ? 'Payment declined' : 'Payment authorised',
      failure ? 'Your card was declined. You were not charged.' : 'The amount is on hold. You can close this page.'));
  });
}
