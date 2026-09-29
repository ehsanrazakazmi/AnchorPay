// Sending the money to the recipient through the payout partner (DECISIONS D-47).
// A payout is created pending and dispatched in the background: up to PAYOUT_MAX_ATTEMPTS (3) tries with backoff for
// temporary problems, then the manual queue (manual_review) where an admin retries or fails it. Permanent problems
// (invalid account, bank rejected) fail it at once. Full account numbers are fetched per attempt and never stored.
import {
  AppError, buildEvent, enqueueEvent, env, envInt, InternalClient, UUID, withTransaction, writeAudit, type AuthContext, type Logger, type Pool,
  type Queryable,
} from '@anchorpay/service-kit';
import { SERVICE } from '../deps.ts';
import { PartnerError, PERMANENT, reasonCode, type PayoutPartner, type PayoutRequest, type ReasonCode } from '../partner.ts';
import type { Money } from '../providers.ts';

export interface PayoutRow {
  id: string;
  transfer_id: string;
  partner: 'mock';
  partner_payout_id: string | null;
  method: 'bank_account' | 'mobile_wallet';
  destination_country: string;
  amount_minor: number;
  currency: string;
  status: 'pending' | 'dispatched' | 'completed' | 'failed' | 'manual_review';
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  dispatched_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  created_at: Date;
  recipient_id: string;
  transfer_reference: string;
  send_amount_minor: number;
  send_currency: string;
}

/** The recipient as identity-service gives it to payment-service (full numbers included). */
export interface PayoutRecipient {
  id: string;
  fullName: string;
  country: string;
  currency: string;
  payoutMethod: 'bank_account' | 'mobile_wallet';
  bankAccount?: { bankName?: string; bankCode?: string; accountNumber?: string };
  mobileWallet?: { provider?: string; walletNumber?: string };
}

export interface RecipientDirectory {
  get(recipientId: string, requestId: string): Promise<PayoutRecipient>;
}

export function httpRecipients(): RecipientDirectory {
  const client = new InternalClient(SERVICE);
  return {
    async get(id, requestId) {
      return (await client.call<PayoutRecipient>('identity-service', 'GET', `/internal/identity/recipients/${id}`, { requestId, retries: 2 })).body;
    },
  };
}

export type PartnerEvent = { eventId: string; type: 'payout.accepted' | 'payout.completed' | 'payout.failed'; partnerPayoutId: string; reference: string; failureCode?: string; occurredAt: string };

const money = (amountMinor: number, currency: string): Money => ({ amountMinor: Number(amountMinor), currency: currency.trim() });
const LEASE_SECONDS = 120; // an attempt in flight owns the payout this long (a crash makes it due again afterwards)

export function toApi(p: PayoutRow) {
  return {
    id: p.id, transferId: p.transfer_id, partner: p.partner, method: p.method, amount: money(p.amount_minor, p.currency), status: p.status,
    attempts: p.attempts, createdAt: p.created_at.toISOString(),
    ...(p.partner_payout_id ? { partnerPayoutId: p.partner_payout_id } : {}),
    ...(p.last_error ? { lastError: p.last_error } : {}),
    ...(p.status === 'pending' && p.next_attempt_at ? { nextAttemptAt: p.next_attempt_at.toISOString() } : {}),
    ...(p.dispatched_at ? { dispatchedAt: p.dispatched_at.toISOString() } : {}),
    ...(p.completed_at ? { completedAt: p.completed_at.toISOString() } : {}),
  };
}

export function toInternal(p: PayoutRow) {
  return {
    payoutId: p.id, transferId: p.transfer_id, partner: p.partner, method: p.method, amount: money(p.amount_minor, p.currency), status: p.status,
    attempts: p.attempts, ...(p.partner_payout_id ? { partnerPayoutId: p.partner_payout_id } : {}), ...(p.last_error ? { lastError: p.last_error } : {}),
  };
}

/** What may be stored about an attempt: no account or wallet numbers, only their last 4 characters. */
function redact(req: PayoutRequest) {
  const last4 = (v?: string) => (v ? `****${v.replace(/\s/g, '').slice(-4)}` : undefined);
  const d = req.destination;
  return {
    reference: req.reference, amount: req.amount, method: req.method,
    destination: { country: d.country, bankName: d.bankName, bankCode: d.bankCode, account: last4(d.accountNumber), walletProvider: d.walletProvider, wallet: last4(d.walletNumber) },
  };
}

export class Payouts {
  private readonly pool: Pool;
  private readonly partner: PayoutPartner;
  private readonly recipients: RecipientDirectory;
  private readonly log: Logger;
  private readonly backoffSeconds: number[];
  private readonly maxAttempts: number;

  constructor(deps: { pool: Pool; partner: PayoutPartner; recipients: RecipientDirectory; log: Logger; backoffSeconds?: number[]; maxAttempts?: number }) {
    this.pool = deps.pool;
    this.partner = deps.partner;
    this.recipients = deps.recipients;
    this.log = deps.log;
    this.backoffSeconds = deps.backoffSeconds ?? env('PAYOUT_RETRY_BACKOFF_SECONDS', '10,60').split(',').map(Number);
    this.maxAttempts = deps.maxAttempts ?? envInt('PAYOUT_MAX_ATTEMPTS', 3);
  }

  private async lock(q: Queryable, id: string): Promise<PayoutRow | null> {
    const { rows } = await q.query<PayoutRow>('SELECT * FROM payments.payouts WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  private async update(q: Queryable, id: string, set: Record<string, unknown>): Promise<PayoutRow> {
    const keys = Object.keys(set);
    const { rows } = await q.query<PayoutRow>(
      `UPDATE payments.payouts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => set[k])]);
    return rows[0]!;
  }

  private async event(q: Queryable, type: string, p: PayoutRow, data: Record<string, unknown>, correlationId: string) {
    await enqueueEvent(q, 'payments', buildEvent(type, { payoutId: p.id, transferId: p.transfer_id, ...data }, { producer: SERVICE, correlationId }), p.transfer_id);
  }

  // ------------------------------------------------------------------ create (transfer-service)
  async create(body: { transferId: string; transferReference: string; recipientId: string; amount: Money; sendAmount: Money }, rid: string) {
    const existing = await this.pool.query<PayoutRow>('SELECT * FROM payments.payouts WHERE transfer_id = $1', [body.transferId]);
    if (existing.rows[0]) return existing.rows[0]; // idempotent per transfer
    const recipient = await this.recipients.get(body.recipientId, rid).catch((err) => {
      throw err instanceof AppError && err.status === 404 ? new AppError('CONFLICT', 'The recipient no longer exists.') : err;
    });
    if (recipient.currency !== body.amount.currency) throw new AppError('CONFLICT', `The recipient is paid in ${recipient.currency}, not ${body.amount.currency}.`);
    try {
      const { rows } = await this.pool.query<PayoutRow>(
        `INSERT INTO payments.payouts (transfer_id, partner, method, destination_country, amount_minor, currency, max_attempts, next_attempt_at,
                                       recipient_id, transfer_reference, send_amount_minor, send_currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11) RETURNING *`,
        [body.transferId, this.partner.name, recipient.payoutMethod, recipient.country, body.amount.amountMinor, body.amount.currency, this.maxAttempts,
          body.recipientId, body.transferReference, body.sendAmount.amountMinor, body.sendAmount.currency],
      );
      return rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      return (await this.pool.query<PayoutRow>('SELECT * FROM payments.payouts WHERE transfer_id = $1', [body.transferId])).rows[0]!;
    }
  }

  // ------------------------------------------------------------------ dispatch (background)
  /** Sends every payout that is due; returns how many attempts were made. */
  async dispatchDue(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM payments.payouts WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY next_attempt_at NULLS FIRST LIMIT 20`);
    let attempted = 0;
    for (const { id } of rows) if (await this.attempt(id)) attempted++;
    return attempted;
  }

  /** One attempt: claim (lease) -> call the partner -> record the outcome. False if someone else has it. */
  async attempt(id: string, rid = `job:payout-dispatch`): Promise<boolean> {
    const claimed = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<PayoutRow>(
        `SELECT * FROM payments.payouts WHERE id = $1 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          FOR UPDATE SKIP LOCKED`, [id]);
      if (!rows[0]) return null;
      return this.update(c, id, { attempts: rows[0].attempts + 1, next_attempt_at: new Date(Date.now() + LEASE_SECONDS * 1000) });
    });
    if (!claimed) return false;

    const started = Date.now();
    let request: PayoutRequest | null = null;
    let outcome: { ok: true; partnerPayoutId: string; status: number; body: unknown } | { ok: false; error: PartnerError };
    try {
      const r = await this.recipients.get(claimed.recipient_id, rid);
      request = {
        reference: claimed.id, amount: money(claimed.amount_minor, claimed.currency), method: claimed.method,
        destination: {
          country: r.country, fullName: r.fullName,
          ...(claimed.method === 'bank_account'
            ? { bankName: r.bankAccount?.bankName, bankCode: r.bankAccount?.bankCode, accountNumber: r.bankAccount?.accountNumber }
            : { walletProvider: r.mobileWallet?.provider, walletNumber: r.mobileWallet?.walletNumber }),
        },
      };
      outcome = { ok: true, ...(await this.partner.send(request)) };
    } catch (err) {
      outcome = { ok: false, error: err instanceof PartnerError ? err : new PartnerError('other', `could not prepare the payout: ${(err as Error).message}`, null, null) };
    }

    await withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO payments.payout_attempts (payout_id, attempt_no, request_redacted, response_status, response_body, error, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [claimed.id, claimed.attempts, request ? redact(request) : { reference: claimed.id, note: 'not sent' },
          outcome.ok ? outcome.status : outcome.error.status, outcome.ok ? outcome.body : outcome.error.body ?? null,
          outcome.ok ? null : outcome.error.message.slice(0, 500), Date.now() - started],
      );
      const p = (await this.lock(c, claimed.id))!;
      if (p.status !== 'pending') return; // a partner webhook already moved it on
      if (outcome.ok) await this.dispatched(c, p, outcome.partnerPayoutId, rid);
      else await this.failedAttempt(c, p, outcome.error.code, outcome.error.message, rid);
    });
    return true;
  }

  private async dispatched(c: Queryable, p: PayoutRow, partnerPayoutId: string, rid: string): Promise<PayoutRow> {
    const at = new Date();
    const row = await this.update(c, p.id, { status: 'dispatched', partner_payout_id: partnerPayoutId, dispatched_at: at, next_attempt_at: null, last_error: null });
    await this.event(c, 'payout.dispatched', row, {
      partner: row.partner, method: row.method, amount: money(row.amount_minor, row.currency), sendAmount: money(row.send_amount_minor, row.send_currency),
      dispatchedAt: at.toISOString(),
    }, rid);
    return row;
  }

  /** A failed try: permanent -> failed (final); temporary -> retry later, or the manual queue after the last try. */
  private async failedAttempt(c: Queryable, p: PayoutRow, code: ReasonCode, message: string, rid: string): Promise<PayoutRow> {
    if (PERMANENT.has(code)) return this.fail(c, p, code, message, rid);
    if (p.attempts < p.max_attempts) {
      const wait = this.backoffSeconds[Math.min(p.attempts - 1, this.backoffSeconds.length - 1)] ?? 60;
      return this.update(c, p.id, { status: 'pending', last_error: message.slice(0, 500), next_attempt_at: new Date(Date.now() + wait * 1000) });
    }
    const row = await this.update(c, p.id, { status: 'manual_review', last_error: message.slice(0, 500), next_attempt_at: null });
    await this.event(c, 'payout.failed', row, { attempts: row.attempts, reasonCode: code, final: false, failedAt: new Date().toISOString() }, rid);
    this.log.error({ payoutId: row.id, attempts: row.attempts, reasonCode: code }, 'payout moved to the manual queue');
    return row;
  }

  private async fail(c: Queryable, p: PayoutRow, code: ReasonCode, message: string, rid: string): Promise<PayoutRow> {
    const at = new Date();
    const row = await this.update(c, p.id, { status: 'failed', last_error: message.slice(0, 500), failed_at: at, next_attempt_at: null });
    await this.event(c, 'payout.failed', row, { attempts: row.attempts, reasonCode: code, final: true, failedAt: at.toISOString() }, rid);
    return row;
  }

  // ------------------------------------------------------------------ partner webhooks
  async onPartnerEvent(c: Queryable, ev: PartnerEvent, rid: string): Promise<{ applied: boolean; note?: string }> {
    const { rows } = await c.query<PayoutRow>(
      `SELECT * FROM payments.payouts WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR partner_payout_id = $2 LIMIT 1 FOR UPDATE`,
      [UUID.test(ev.reference) ? ev.reference : null, ev.partnerPayoutId]);
    let p = rows[0];
    if (!p) return { applied: false, note: 'unknown payout' };
    if (ev.type === 'payout.accepted') {
      if (p.status !== 'pending') return { applied: false, note: `already ${p.status}` };
      await this.dispatched(c, p, ev.partnerPayoutId, rid);
      return { applied: true };
    }
    if (ev.type === 'payout.completed') {
      if (p.status === 'pending') p = await this.dispatched(c, p, ev.partnerPayoutId, rid); // the acceptance was lost
      if (p.status !== 'dispatched') return { applied: false, note: `already ${p.status}` };
      const at = new Date();
      const row = await this.update(c, p.id, { status: 'completed', completed_at: at });
      await this.event(c, 'payout.completed', row, { partnerPayoutId: ev.partnerPayoutId, completedAt: at.toISOString() }, rid);
      return { applied: true };
    }
    if (p.status !== 'dispatched' && p.status !== 'pending') return { applied: false, note: `already ${p.status}` };
    const code = reasonCode(ev.failureCode ?? 'other');
    await this.failedAttempt(c, p, code, `partner reported ${ev.failureCode ?? 'a failure'}`, rid);
    return { applied: true };
  }

  // ------------------------------------------------------------------ admin (the manual queue)
  async list(filter: { status?: PayoutRow['status']; page: number; pageSize: number }) {
    const where = filter.status ? 'WHERE status = $1' : '';
    const values = filter.status ? [filter.status] : [];
    const total = (await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments.payouts ${where}`, values)).rows[0]!.n;
    const { rows } = await this.pool.query<PayoutRow>(
      `SELECT * FROM payments.payouts ${where} ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filter.pageSize, (filter.page - 1) * filter.pageSize]);
    return { data: rows.map(toApi), pageInfo: { page: filter.page, pageSize: filter.pageSize, total } };
  }

  async get(id: string): Promise<PayoutRow | null> {
    if (!UUID.test(id)) return null;
    return (await this.pool.query<PayoutRow>('SELECT * FROM payments.payouts WHERE id = $1', [id])).rows[0] ?? null;
  }

  /** One more attempt for a payout in the manual queue. */
  async adminRetry(auth: AuthContext, id: string, rid: string): Promise<PayoutRow> {
    return withTransaction(this.pool, async (c) => {
      const p = UUID.test(id) ? await this.lock(c, id) : null;
      if (!p) throw new AppError('NOT_FOUND', 'Payout not found.');
      if (p.status !== 'manual_review') throw new AppError('CONFLICT', `Only payouts in the manual queue can be retried (this one is ${p.status}).`);
      const row = await this.update(c, id, { status: 'pending', next_attempt_at: new Date(), max_attempts: p.attempts + 1 });
      await writeAudit(c, { service: SERVICE, actorType: 'staff', actorId: auth.userId, action: 'payout.retried', entityType: 'payout', entityId: id,
        before: { status: p.status, attempts: p.attempts }, after: { status: row.status }, requestId: rid });
      return row;
    });
  }

  /** Gives up on a payout in the manual queue: payout.failed (final) makes transfer-service refund the sender. */
  async adminFail(auth: AuthContext, id: string, note: string, rid: string): Promise<PayoutRow> {
    return withTransaction(this.pool, async (c) => {
      const p = UUID.test(id) ? await this.lock(c, id) : null;
      if (!p) throw new AppError('NOT_FOUND', 'Payout not found.');
      if (p.status !== 'manual_review') throw new AppError('CONFLICT', `Only payouts in the manual queue can be failed (this one is ${p.status}).`);
      const row = await this.fail(c, p, 'other', 'failed by an admin from the manual queue', rid);
      await writeAudit(c, { service: SERVICE, actorType: 'staff', actorId: auth.userId, action: 'payout.failed_by_admin', entityType: 'payout', entityId: id,
        before: { status: p.status }, after: { status: row.status, note: note.slice(0, 2000) }, requestId: rid });
      return row;
    });
  }
}
