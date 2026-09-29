// State of the mock providers, kept in memory and written to a JSON file after every change, so a restart doesn't
// lose payments or payouts (the partner's settlement report needs yesterday's payouts). Tests run without a file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface MockRefund {
  refundId: string;
  idempotencyKey: string;
  amount: Money;
  status: 'succeeded';
  createdAt: string;
}

export interface MockPayment {
  id: string;
  reference: string; // our payment id
  method: 'card' | 'bank_debit';
  amount: Money;
  status: 'requires_action' | 'authorized' | 'declined' | 'captured' | 'canceled' | 'refunded';
  returnUrl?: string;
  cardBrand?: string;
  cardLast4?: string;
  failureCode?: 'card_declined' | 'insufficient_funds' | 'bank_debit_returned';
  authorizationExpiresAt?: string;
  refunds: MockRefund[];
  createdAt: string;
}

export interface MockPayout {
  partnerPayoutId: string;
  reference: string; // our payout id
  amount: Money;
  method: 'bank_account' | 'mobile_wallet';
  country: string;
  destinationLast4: string;
  status: 'rejected' | 'accepted' | 'completed' | 'failed';
  failureCode?: string;
  acceptedAt: string;
  completedAt?: string;
  failedAt?: string;
  /** When the partner will finish it (so a restart can resume). */
  settlesAt?: string;
  outcome?: 'complete' | 'fail';
}

interface State {
  payments: Record<string, MockPayment>;
  payouts: Record<string, MockPayout>;
}

export class Store {
  readonly payments = new Map<string, MockPayment>();
  readonly payouts = new Map<string, MockPayout>();
  private readonly file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, 'state.json') : null;
    if (this.file && existsSync(this.file)) {
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as State;
      for (const p of Object.values(state.payments ?? {})) this.payments.set(p.id, p);
      for (const p of Object.values(state.payouts ?? {})) this.payouts.set(p.partnerPayoutId, p);
    }
  }

  paymentByReference(reference: string): MockPayment | undefined {
    return [...this.payments.values()].find((p) => p.reference === reference);
  }

  payoutByReference(reference: string): MockPayout | undefined {
    return [...this.payouts.values()].find((p) => p.reference === reference);
  }

  /** Atomic write (temp file + rename): a crash never leaves half a file. */
  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const state: State = { payments: Object.fromEntries(this.payments), payouts: Object.fromEntries(this.payouts) };
    writeFileSync(`${this.file}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
