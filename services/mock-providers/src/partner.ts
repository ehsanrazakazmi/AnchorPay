// Mock payout partner (Thunes/Flutterwave-like, DECISIONS D-47). Outcomes follow the destination account or wallet
// number, like a partner sandbox:
//   ...0000  rejected at once: invalid_account (permanent)
//   ...1111  partner_unavailable every time (payment-service retries, then the manual queue)
//   ...2222  accepted, then fails: recipient_bank_rejected
//   anything else: accepted, then completed after MOCK_PAYOUT_DELAY_MS (default 3 s)
// It also serves the daily settlement report the ledger reconciles against, and drops it as a file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, envInt, problem, sendProblem, type Logger, type Service } from '@anchorpay/service-kit';
import { hexId } from './payments.ts';
import type { MockPayout, Money, Store } from './store.ts';
import { newEventId, type Deliver } from './webhooks.ts';

interface PayoutRequest {
  reference: string;
  amount: Money;
  method: 'bank_account' | 'mobile_wallet';
  destination: { country: string; fullName: string; bankName?: string; bankCode?: string; accountNumber?: string; walletProvider?: string; walletNumber?: string };
}

const view = (p: MockPayout) => ({
  partnerPayoutId: p.partnerPayoutId, reference: p.reference, amount: p.amount, method: p.method, status: p.status,
  acceptedAt: p.acceptedAt, ...(p.completedAt ? { completedAt: p.completedAt } : {}), ...(p.failedAt ? { failedAt: p.failedAt } : {}),
  ...(p.failureCode ? { failureCode: p.failureCode } : {}),
});

export class Partner {
  private readonly store: Store;
  private readonly deliver: Deliver;
  private readonly log: Logger;
  private readonly delayMs: number;
  private readonly dataDir: string | null;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(options: { store: Store; deliver: Deliver; log: Logger; dataDir: string | null; delayMs?: number }) {
    this.store = options.store;
    this.deliver = options.deliver;
    this.log = options.log;
    this.dataDir = options.dataDir;
    this.delayMs = options.delayMs ?? envInt('MOCK_PAYOUT_DELAY_MS', 3000);
  }

  /** After a restart: finish the payouts that were still in flight. */
  resume(): void {
    for (const p of this.store.payouts.values()) if (p.status === 'accepted') this.schedule(p);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(p: MockPayout): void {
    const wait = Math.max(0, new Date(p.settlesAt ?? Date.now()).getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.settle(p);
    }, wait);
    timer.unref();
    this.timers.add(timer);
  }

  private settle(p: MockPayout): void {
    if (p.status !== 'accepted') return;
    const at = new Date().toISOString();
    const fails = p.outcome === 'fail';
    if (fails) Object.assign(p, { status: 'failed', failureCode: 'recipient_bank_rejected', failedAt: at });
    else Object.assign(p, { status: 'completed', completedAt: at });
    this.store.save();
    void this.deliver('/webhooks/payout-partner', {
      eventId: newEventId(), type: fails ? 'payout.failed' : 'payout.completed', partnerPayoutId: p.partnerPayoutId,
      reference: p.reference, ...(p.failureCode ? { failureCode: p.failureCode } : {}), occurredAt: at,
    });
  }

  create(req: PayoutRequest): { status: number; body: unknown } {
    const existing = this.store.payoutByReference(req.reference);
    if (existing) {
      // Idempotent per reference: the same answer as the first time.
      if (existing.status === 'rejected') throw new AppError('VALIDATION_ERROR', 'invalid_account', { status: 422 });
      return { status: 202, body: view(existing) };
    }
    const number = (req.destination.accountNumber ?? req.destination.walletNumber ?? '').replace(/\D/g, '');
    const ending = number.slice(-4);
    if (ending === '1111') throw new AppError('SERVICE_UNAVAILABLE', 'partner_unavailable');
    const now = new Date();
    const p: MockPayout = {
      partnerPayoutId: hexId('MP').toUpperCase().replace('MP_', 'MP-'), reference: req.reference, amount: req.amount, method: req.method,
      country: req.destination.country, destinationLast4: ending, status: ending === '0000' ? 'rejected' : 'accepted', acceptedAt: now.toISOString(),
    };
    if (p.status === 'rejected') {
      Object.assign(p, { failureCode: 'invalid_account' });
      this.store.payouts.set(p.partnerPayoutId, p);
      this.store.save();
      throw new AppError('VALIDATION_ERROR', 'invalid_account', { status: 422 });
    }
    Object.assign(p, { outcome: ending === '2222' ? 'fail' : 'complete', settlesAt: new Date(now.getTime() + this.delayMs).toISOString() });
    this.store.payouts.set(p.partnerPayoutId, p);
    this.store.save();
    void this.deliver('/webhooks/payout-partner', {
      eventId: newEventId(), type: 'payout.accepted', partnerPayoutId: p.partnerPayoutId, reference: p.reference, occurredAt: p.acceptedAt,
    });
    this.schedule(p);
    return { status: 202, body: view(p) };
  }

  /** Every payout the partner accepted on `date` (UTC) with its final status: what the ledger reconciles against. */
  settlement(date: string) {
    const items = [...this.store.payouts.values()]
      .filter((p) => p.status !== 'rejected' && p.acceptedAt.slice(0, 10) === date)
      .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))
      .map(view);
    const report = { partner: 'mock', date, generatedAt: new Date().toISOString(), items };
    if (this.dataDir) {
      // The "SFTP drop" a real partner would leave for us.
      const dir = join(this.dataDir, 'settlements');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${date}.json`), JSON.stringify(report, null, 2));
    }
    return report;
  }
}

export function registerPartnerRoutes(svc: Service, partner: Partner, requireApiKey: (h: unknown) => void, store: Store) {
  const app = svc.app;
  app.post('/partner/payouts', async (req, reply) => {
    requireApiKey(req.headers);
    const body = req.body as PayoutRequest;
    if (!body?.reference || !body.amount || !body.method || !body.destination?.country) {
      throw new AppError('VALIDATION_ERROR', 'reference, amount, method and destination are required.');
    }
    try {
      const result = partner.create(body);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      // A scripted outage is an answer, not a bug: reply 503 without logging a stack trace.
      if (err instanceof AppError && err.message === 'partner_unavailable') return sendProblem(reply, problem('SERVICE_UNAVAILABLE', req.id, 'partner_unavailable'));
      throw err;
    }
  });

  app.get('/partner/payouts/:partnerPayoutId', async (req) => {
    requireApiKey(req.headers);
    const p = store.payouts.get((req.params as { partnerPayoutId: string }).partnerPayoutId);
    if (!p) throw new AppError('NOT_FOUND', 'No such payout.');
    return view(p);
  });

  app.get('/partner/settlements', async (req) => {
    requireApiKey(req.headers);
    const { date } = req.query as { date?: string };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('VALIDATION_ERROR', 'date=YYYY-MM-DD is required.');
    return partner.settlement(date);
  });
}
