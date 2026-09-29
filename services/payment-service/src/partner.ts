// Payout partner adapter (PAYOUT_PROVIDER = mock; Thunes / Flutterwave adapters plug in here later).
import { env } from '@anchorpay/service-kit';
import type { Money } from './providers.ts';

export interface PayoutDestination {
  country: string;
  fullName: string;
  bankName?: string;
  bankCode?: string;
  accountNumber?: string;
  walletProvider?: string;
  walletNumber?: string;
}

export interface PayoutRequest {
  reference: string; // our payout id: the partner de-duplicates on it
  amount: Money;
  method: 'bank_account' | 'mobile_wallet';
  destination: PayoutDestination;
}

/** Reason codes of payout.failed (contracts/events) and whether trying again can help. */
export const PERMANENT = new Set(['invalid_account', 'recipient_bank_rejected', 'limit_exceeded']);
export type ReasonCode = 'invalid_account' | 'recipient_bank_rejected' | 'partner_unavailable' | 'limit_exceeded' | 'other';

export function reasonCode(code: string): ReasonCode {
  return (['invalid_account', 'recipient_bank_rejected', 'partner_unavailable', 'limit_exceeded'] as const).find((c) => c === code) ?? 'other';
}

export class PartnerError extends Error {
  readonly code: ReasonCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly body: unknown;

  constructor(code: ReasonCode, message: string, status: number | null, body: unknown) {
    super(message);
    this.code = code;
    this.retryable = !PERMANENT.has(code);
    this.status = status;
    this.body = body;
  }
}

export interface PayoutPartner {
  readonly name: 'mock';
  send(request: PayoutRequest): Promise<{ partnerPayoutId: string; status: number; body: unknown }>;
}

export class MockPayoutPartner implements PayoutPartner {
  readonly name = 'mock' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl = env('MOCK_PROVIDERS_URL', 'http://127.0.0.1:4900'), apiKey = env('MOCK_WEBHOOK_SECRET')) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async send(request: PayoutRequest) {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/partner/payouts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new PartnerError('partner_unavailable', `payout partner unreachable: ${(err as Error).message}`, null, null);
    }
    const text = await res.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (res.ok) return { partnerPayoutId: String(body.partnerPayoutId), status: res.status, body };
    const detail = typeof body.detail === 'string' ? body.detail : '';
    const code = res.status >= 500 ? 'partner_unavailable' : reasonCode(detail);
    throw new PartnerError(code, `payout partner answered ${res.status}${detail ? ` (${detail})` : ''}`, res.status, body);
  }
}

export function partnerFromEnv(): PayoutPartner {
  const name = env('PAYOUT_PROVIDER', 'mock');
  if (name !== 'mock') throw new Error(`PAYOUT_PROVIDER "${name}" has no adapter yet (only mock).`);
  return new MockPayoutPartner();
}
