// Payment provider adapters (DECISIONS D-19, D-44, D-45). The domain code only sees PaymentProvider; which
// company sits behind it is configuration: CARD_PAYMENT_PROVIDER = mock | stripe, BANK_DEBIT_PROVIDER = mock.
import { env, envOptional } from '@anchorpay/service-kit';

export interface Money {
  amountMinor: number;
  currency: string;
}

export type PaymentAction =
  | { type: 'none' }
  | { type: 'mock_card'; authorizeUrl: string }
  | { type: 'stripe_card'; clientSecret: string; publishableKey: string };

export interface ProviderPayment {
  providerPaymentId: string;
  status: 'requires_action' | 'authorized' | 'declined';
  action: PaymentAction;
  failureCode?: string;
  cardBrand?: string;
  cardLast4?: string;
  authorizationExpiresAt?: string;
}

/** declined = the provider said no (don't retry); unavailable = try again later. */
export class ProviderError extends Error {
  readonly kind: 'declined' | 'unavailable';
  readonly code: string;

  constructor(kind: 'declined' | 'unavailable', code: string, message?: string) {
    super(message ?? code);
    this.kind = kind;
    this.code = code;
  }
}

export interface PaymentProvider {
  readonly name: 'mock' | 'stripe';
  authorize(input: { paymentId: string; transferId: string; method: 'card' | 'bank_debit'; amount: Money; returnUrl?: string }): Promise<ProviderPayment>;
  /** What the client must do for a payment still waiting for the customer (a replayed request). */
  action(providerPaymentId: string): Promise<PaymentAction>;
  capture(providerPaymentId: string, amount: Money): Promise<void>;
  cancel(providerPaymentId: string): Promise<void>;
  refund(providerPaymentId: string, amount: Money, idempotencyKey: string): Promise<{ providerRefundId: string; status: 'pending' | 'succeeded' }>;
}

async function send(url: string, init: RequestInit & { timeoutMs?: number }): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 5000) });
  } catch (err) {
    throw new ProviderError('unavailable', 'provider_error', `provider unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  if (res.status >= 500 || res.status === 429) throw new ProviderError('unavailable', 'provider_error', `provider answered ${res.status}`);
  return { status: res.status, body };
}

// ---------------------------------------------------------------- mock processor (mock-providers :4900)
export class MockPaymentsProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl = env('MOCK_PROVIDERS_URL', 'http://127.0.0.1:4900'), apiKey = env('MOCK_WEBHOOK_SECRET')) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private call(method: string, path: string, body?: unknown) {
    return send(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private static fail(res: { status: number; body: any }): never {
    // Problem details from the mock: detail carries the provider's failure code. Any 4xx is final (no retry).
    const code = typeof res.body?.detail === 'string' && /^[a-z_]+$/.test(res.body.detail) ? res.body.detail : 'provider_error';
    throw new ProviderError('declined', code, `mock provider answered ${res.status}`);
  }

  async authorize(input: { paymentId: string; method: 'card' | 'bank_debit'; amount: Money; returnUrl?: string }): Promise<ProviderPayment> {
    const res = await this.call('POST', '/payments', {
      reference: input.paymentId, method: input.method, amount: input.amount, ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    });
    if (res.status >= 400) MockPaymentsProvider.fail(res);
    const p = res.body;
    return {
      providerPaymentId: p.id,
      status: p.status === 'requires_action' ? 'requires_action' : p.status === 'authorized' ? 'authorized' : 'declined',
      action: p.status === 'requires_action' ? { type: 'mock_card', authorizeUrl: p.authorizeUrl } : { type: 'none' },
      ...(p.failureCode ? { failureCode: p.failureCode } : {}),
      ...(p.cardBrand ? { cardBrand: p.cardBrand, cardLast4: p.cardLast4 } : {}),
      ...(p.authorizationExpiresAt ? { authorizationExpiresAt: p.authorizationExpiresAt } : {}),
    };
  }

  async action(providerPaymentId: string): Promise<PaymentAction> {
    const res = await this.call('GET', `/payments/${providerPaymentId}`);
    if (res.status >= 400) MockPaymentsProvider.fail(res);
    return res.body.authorizeUrl ? { type: 'mock_card', authorizeUrl: res.body.authorizeUrl } : { type: 'none' };
  }

  async capture(providerPaymentId: string, amount: Money): Promise<void> {
    const res = await this.call('POST', `/payments/${providerPaymentId}/capture`, { amount });
    if (res.status >= 400) MockPaymentsProvider.fail(res);
  }

  async cancel(providerPaymentId: string): Promise<void> {
    const res = await this.call('POST', `/payments/${providerPaymentId}/cancel`);
    if (res.status >= 400) MockPaymentsProvider.fail(res);
  }

  async refund(providerPaymentId: string, amount: Money, idempotencyKey: string) {
    const res = await this.call('POST', `/payments/${providerPaymentId}/refunds`, { amount, idempotencyKey });
    if (res.status >= 400) MockPaymentsProvider.fail(res);
    return { providerRefundId: res.body.refundId as string, status: 'succeeded' as const };
  }
}

// ---------------------------------------------------------------- Stripe TEST mode (manual-capture PaymentIntents)
const form = (fields: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(fields).map(([k, v]): [string, string] => [k, String(v)])).toString();

export class StripeCardProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly apiUrl: string;
  private readonly secretKey: string;
  private readonly publishableKey: string;

  constructor(options: { apiUrl?: string; secretKey?: string; publishableKey?: string } = {}) {
    this.apiUrl = options.apiUrl ?? env('STRIPE_API_URL', 'https://api.stripe.com');
    this.secretKey = options.secretKey ?? env('STRIPE_SECRET_KEY');
    this.publishableKey = options.publishableKey ?? envOptional('STRIPE_PUBLISHABLE_KEY') ?? '';
    if (!this.secretKey.startsWith('sk_test_')) {
      throw new Error('STRIPE_SECRET_KEY must be a TEST key (sk_test_...): AnchorPay never uses live Stripe keys in this build.');
    }
  }

  private async call(method: string, path: string, fields?: Record<string, string | number>, idempotencyKey?: string) {
    const res = await send(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(fields ? { body: form(fields) } : {}),
    });
    if (res.status >= 400) {
      const e = res.body?.error ?? {};
      throw new ProviderError('declined', e.decline_code ?? e.code ?? 'provider_error', e.message ?? `Stripe answered ${res.status}`);
    }
    return res.body;
  }

  async authorize(input: { paymentId: string; transferId: string; amount: Money }): Promise<ProviderPayment> {
    const pi = await this.call('POST', '/v1/payment_intents', {
      amount: input.amount.amountMinor, currency: input.amount.currency.toLowerCase(), capture_method: 'manual',
      'payment_method_types[]': 'card', 'metadata[paymentId]': input.paymentId, 'metadata[transferId]': input.transferId,
    }, `authorize-${input.paymentId}`);
    return { providerPaymentId: pi.id, status: 'requires_action', action: { type: 'stripe_card', clientSecret: pi.client_secret, publishableKey: this.publishableKey } };
  }

  async action(providerPaymentId: string): Promise<PaymentAction> {
    const pi = await this.call('GET', `/v1/payment_intents/${providerPaymentId}`);
    return { type: 'stripe_card', clientSecret: pi.client_secret, publishableKey: this.publishableKey };
  }

  async capture(providerPaymentId: string, amount: Money): Promise<void> {
    try {
      await this.call('POST', `/v1/payment_intents/${providerPaymentId}/capture`, { amount_to_capture: amount.amountMinor }, `capture-${providerPaymentId}`);
    } catch (err) {
      // Captured already (a retry after a lost answer): Stripe says "unexpected state"; check before failing.
      if (err instanceof ProviderError && err.code === 'payment_intent_unexpected_state') {
        const pi = await this.call('GET', `/v1/payment_intents/${providerPaymentId}`);
        if (pi.status === 'succeeded') return;
      }
      throw err;
    }
  }

  async cancel(providerPaymentId: string): Promise<void> {
    try {
      await this.call('POST', `/v1/payment_intents/${providerPaymentId}/cancel`, {}, `cancel-${providerPaymentId}`);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'payment_intent_unexpected_state') {
        const pi = await this.call('GET', `/v1/payment_intents/${providerPaymentId}`);
        if (pi.status === 'canceled') return;
      }
      throw err;
    }
  }

  async refund(providerPaymentId: string, amount: Money, idempotencyKey: string) {
    const r = await this.call('POST', '/v1/refunds', { payment_intent: providerPaymentId, amount: amount.amountMinor }, `refund-${idempotencyKey}`);
    return { providerRefundId: r.id as string, status: r.status === 'succeeded' ? 'succeeded' as const : 'pending' as const };
  }
}

export interface Providers {
  card: PaymentProvider;
  bank_debit: PaymentProvider;
}

export function providersFromEnv(): Providers {
  const mock = new MockPaymentsProvider();
  const cardProvider = env('CARD_PAYMENT_PROVIDER', 'mock');
  if (!['mock', 'stripe'].includes(cardProvider)) throw new Error(`CARD_PAYMENT_PROVIDER must be mock or stripe, not "${cardProvider}"`);
  return { card: cardProvider === 'stripe' ? new StripeCardProvider() : mock, bank_debit: mock };
}
