// transfer-service's view of the services it calls (contracts/openapi/internal-api.yaml). The workflow only
// depends on these interfaces; HttpPorts is the real implementation, tests plug in fakes.
import { InternalClient } from '@anchorpay/service-kit';

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface Quote {
  quoteId: string;
  corridorCode: string;
  fundingMethod: 'card' | 'bank_debit';
  sendAmount: Money;
  fee: Money;
  cardSurcharge: Money;
  totalCharge: Money;
  receiveAmount: Money;
  midRate: string;
  offerRate: string;
  spreadPercent: string;
  rateTimestamp: string;
  expiresAt: string;
  deliveryEstimate: string;
}

export interface FxLock {
  lockId: string;
  transferId: string;
  quoteId: string;
  status: 'active' | 'consumed' | 'expired' | 'released';
  receiveAmount: Money;
  totalCharge: Money;
  midRate: string;
  offerRate: string;
  lockedAt: string;
  expiresAt: string;
}

export interface Recipient {
  id: string;
  userId: string;
  fullName: string;
  country: string;
  currency: string;
  payoutMethod: 'bank_account' | 'mobile_wallet';
  bankAccount?: { bankName: string; accountNumberMasked?: string };
  mobileWallet?: { provider: 'jazzcash' | 'easypaisa'; walletNumberMasked?: string };
  deletedAt?: string | null;
}

export interface LimitCheck {
  allowed: boolean;
  reasonCode?: 'KYC_REQUIRED' | 'LIMIT_EXCEEDED';
  kycTier: number;
  kycStatus: string;
}

export interface Screening {
  screeningId: string;
  decision: 'pass' | 'flag' | 'block';
  fraudScore: number;
  rulesTriggered: string[];
  sanctionsHit: boolean;
  reviewCaseId?: string;
  reasonCode?: string;
}

export interface PaymentAction {
  type: 'none' | 'stripe_card' | 'mock_card';
  [key: string]: unknown;
}

export interface Payment {
  paymentId: string;
  status: string;
}

export interface Ports {
  getRecipient(recipientId: string, requestId: string): Promise<Recipient>;
  getQuote(quoteId: string, requestId: string): Promise<Quote>;
  createQuote(body: { corridorCode: string; sendAmount: Money; fundingMethod: string }, requestId: string): Promise<Quote>;
  lockRate(body: { transferId: string; userId: string; quoteId: string }, requestId: string): Promise<FxLock>;
  consumeLock(lockId: string, requestId: string): Promise<FxLock>;
  releaseLock(lockId: string, requestId: string): Promise<FxLock>;
  checkLimits(body: { userId: string; sendAmount: Money }, requestId: string): Promise<LimitCheck>;
  screen(body: Record<string, unknown>, requestId: string): Promise<Screening>;
  authorizePayment(body: { transferId: string; userId: string; method: string; amount: Money; returnUrl?: string }, requestId: string):
    Promise<{ payment: Payment; paymentAction: PaymentAction }>;
  capturePayment(paymentId: string, requestId: string): Promise<Payment>;
  voidPayment(paymentId: string, requestId: string): Promise<Payment>;
  refundPayment(paymentId: string, body: { amount: Money; reason: string }, idempotencyKey: string, requestId: string): Promise<unknown>;
  createPayout(body: { transferId: string; transferReference: string; recipientId: string; amount: Money; sendAmount: Money },
    requestId: string): Promise<{ payoutId: string; status: string }>;
}

/** Real implementation over the internal HTTP API (timeouts per the contract: 2 s, 5 s for screening and payments). */
export class HttpPorts implements Ports {
  private readonly client = new InternalClient('transfer-service');
  private readonly baseUrls: Record<string, string>;

  constructor(baseUrls: Record<string, string> = {}) {
    this.baseUrls = baseUrls;
  }

  private async call<T>(service: string, method: string, path: string, requestId: string,
    options: { body?: unknown; timeoutMs?: number; retries?: number; headers?: Record<string, string> } = {}): Promise<T> {
    const baseUrl = this.baseUrls[service];
    const res = await this.client.call<T>(service, method, path, { requestId, ...options, ...(baseUrl ? { baseUrl } : {}) });
    return res.body;
  }

  getRecipient(id: string, rid: string) {
    return this.call<Recipient>('identity-service', 'GET', `/internal/identity/recipients/${id}`, rid, { retries: 2 });
  }
  getQuote(id: string, rid: string) {
    return this.call<Quote>('fx-service', 'GET', `/internal/fx/quotes/${id}`, rid, { retries: 2 });
  }
  createQuote(body: { corridorCode: string; sendAmount: Money; fundingMethod: string }, rid: string) {
    return this.call<Quote>('fx-service', 'POST', '/internal/fx/quotes', rid, { body });
  }
  lockRate(body: { transferId: string; userId: string; quoteId: string }, rid: string) {
    return this.call<FxLock>('fx-service', 'POST', '/internal/fx/locks', rid, { body, retries: 2 }); // idempotent per transfer + quote
  }
  consumeLock(lockId: string, rid: string) {
    return this.call<FxLock>('fx-service', 'POST', `/internal/fx/locks/${lockId}/consume`, rid, { retries: 2 });
  }
  releaseLock(lockId: string, rid: string) {
    return this.call<FxLock>('fx-service', 'POST', `/internal/fx/locks/${lockId}/release`, rid, { retries: 2 });
  }
  checkLimits(body: { userId: string; sendAmount: Money }, rid: string) {
    return this.call<LimitCheck>('compliance-service', 'POST', '/internal/compliance/limit-checks', rid, { body, retries: 2 });
  }
  screen(body: Record<string, unknown>, rid: string) {
    return this.call<Screening>('compliance-service', 'POST', '/internal/compliance/screenings', rid, { body, timeoutMs: 5000, retries: 2 });
  }
  authorizePayment(body: { transferId: string; userId: string; method: string; amount: Money; returnUrl?: string }, rid: string) {
    return this.call<{ payment: Payment; paymentAction: PaymentAction }>('payment-service', 'POST', '/internal/payments/authorizations', rid,
      { body, timeoutMs: 5000, retries: 1 });
  }
  capturePayment(paymentId: string, rid: string) {
    return this.call<Payment>('payment-service', 'POST', `/internal/payments/${paymentId}/capture`, rid, { timeoutMs: 5000, retries: 2 });
  }
  voidPayment(paymentId: string, rid: string) {
    return this.call<Payment>('payment-service', 'POST', `/internal/payments/${paymentId}/void`, rid, { timeoutMs: 5000, retries: 2 });
  }
  refundPayment(paymentId: string, body: { amount: Money; reason: string }, idempotencyKey: string, rid: string) {
    return this.call('payment-service', 'POST', `/internal/payments/${paymentId}/refunds`, rid,
      { body, timeoutMs: 5000, retries: 2, headers: { 'idempotency-key': idempotencyKey } });
  }
  createPayout(body: { transferId: string; transferReference: string; recipientId: string; amount: Money; sendAmount: Money }, rid: string) {
    return this.call<{ payoutId: string; status: string }>('payment-service', 'POST', '/internal/payouts', rid, { body, timeoutMs: 5000, retries: 2 });
  }
}
