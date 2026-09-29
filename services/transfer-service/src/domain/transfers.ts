import { randomInt } from 'node:crypto';
import {
  buildEvent, enqueueEvent, writeAudit, type Queryable,
} from '@anchorpay/service-kit';
import type { Money } from '../ports.ts';

export const SERVICE = 'transfer-service';

export type Status =
  | 'INITIATED' | 'FX_LOCKED' | 'COMPLIANCE_SCREENING' | 'ON_HOLD' | 'AWAITING_RECONFIRM' | 'PAYMENT_COLLECTED'
  | 'PAYOUT_DISPATCHED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';

export const FINAL: Status[] = ['COMPLETED', 'CANCELLED', 'REFUNDED'];

export interface TransferRow {
  id: string;
  reference: string;
  user_id: string;
  recipient_id: string;
  idempotency_key: string;
  status: Status;
  corridor_code: string;
  funding_method: 'card' | 'bank_debit';
  purpose: string;
  send_currency: string;
  send_amount_minor: number;
  fee_minor: number;
  card_surcharge_minor: number;
  total_charge_minor: number;
  receive_currency: string;
  receive_amount_minor: number | null;
  mid_rate: string | null;
  offer_rate: string | null;
  fx_lock_id: string | null;
  rate_locked_at: Date | null;
  rate_lock_expires_at: Date | null;
  payment_id: string | null;
  payout_id: string | null;
  compliance_decision: 'pass' | 'flag' | 'block' | null;
  failure_code: string | null;
  failure_reason: string | null;
  cancel_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  quote_id: string | null;
  delivery_estimate: string | null;
  screening_id: string | null;
  review_case_id: string | null;
  payment_captured_at: Date | null;
  payout_requested_at: Date | null;
  refund_requested_at: Date | null;
  collect_requested_at: Date | null;
  payout_method: 'bank_account' | 'mobile_wallet' | null;
}

export interface HistoryRow {
  transfer_id: string;
  from_status: Status | null;
  to_status: Status;
  created_at: Date;
}

export interface Actor {
  type: 'user' | 'staff' | 'service' | 'system' | 'vendor';
  id?: string | null;
}

export interface Trace {
  correlationId: string;
  causationId?: string | null;
}

// Columns a workflow step may set; anything else is a programming error (and an injection risk).
const SETTABLE = new Set([
  'fx_lock_id', 'receive_amount_minor', 'mid_rate', 'offer_rate', 'rate_locked_at', 'rate_lock_expires_at', 'payment_id', 'payout_id',
  'compliance_decision', 'failure_code', 'failure_reason', 'cancel_reason', 'screening_id', 'review_case_id', 'payment_captured_at',
  'payout_requested_at', 'refund_requested_at', 'quote_id', 'collect_requested_at',
]);

export class ConcurrentUpdateError extends Error {}

const money = (amountMinor: number, currency: string): Money => ({ amountMinor, currency: currency.trim() });
export const sendAmount = (t: TransferRow) => money(t.send_amount_minor, t.send_currency);
export const totalCharge = (t: TransferRow) => money(t.total_charge_minor, t.send_currency);
export const receiveAmount = (t: TransferRow) => (t.receive_amount_minor === null ? null : money(t.receive_amount_minor, t.receive_currency));

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // no 0/1/I/L/O/U: easy to read out over the phone
export const newReference = () => `AP-${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

export async function lockTransfer(q: Queryable, id: string): Promise<TransferRow | null> {
  const { rows } = await q.query<TransferRow>('SELECT * FROM core.transfers WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ?? null;
}

export async function getTransfer(q: Queryable, id: string): Promise<TransferRow | null> {
  const { rows } = await q.query<TransferRow>('SELECT * FROM core.transfers WHERE id = $1', [id]);
  return rows[0] ?? null;
}

function setClause(set: Record<string, unknown>, firstParam: number): { sql: string[]; values: unknown[] } {
  const keys = Object.keys(set);
  for (const k of keys) if (!SETTABLE.has(k)) throw new Error(`Column ${k} is not settable by the workflow`);
  return { sql: keys.map((k, i) => `${k} = $${firstParam + i}`), values: keys.map((k) => set[k]) };
}

/** Updates progress columns without a status change (caller holds the row lock). */
export async function patch(q: Queryable, t: TransferRow, set: Record<string, unknown>): Promise<TransferRow> {
  const { sql, values } = setClause(set, 2);
  const { rows } = await q.query<TransferRow>(`UPDATE core.transfers SET ${sql.join(', ')} WHERE id = $1 RETURNING *`, [t.id, ...values]);
  return rows[0]!;
}

async function statusEvent(q: Queryable, t: TransferRow, from: Status | null, reasonCode: string | null, trace: Trace): Promise<void> {
  const event = buildEvent('transfer.status-changed', {
    transferId: t.id, reference: t.reference, userId: t.user_id, fromStatus: from, toStatus: t.status,
    changedAt: t.updated_at.toISOString(), reasonCode, sendAmount: sendAmount(t), receiveAmount: receiveAmount(t),
  }, { producer: SERVICE, correlationId: trace.correlationId, causationId: trace.causationId ?? null });
  await enqueueEvent(q, 'core', event, t.id);
}

async function record(q: Queryable, t: TransferRow, from: Status | null, actor: Actor, reason: string | null, trace: Trace): Promise<void> {
  await q.query(
    `INSERT INTO core.transfer_status_history (transfer_id, from_status, to_status, actor_type, actor_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [t.id, from, t.status, actor.type, actor.id ?? null, reason, { correlationId: trace.correlationId }],
  );
  await writeAudit(q, {
    service: SERVICE, actorType: actor.type, actorId: actor.id ?? null, action: 'transfer.status_changed', entityType: 'transfer',
    entityId: t.id, before: from ? { status: from } : null, after: { status: t.status, reason }, requestId: trace.correlationId,
  });
  await statusEvent(q, t, from, reason, trace);
}

/**
 * The one way to change a transfer's status: optimistic version check, the database trigger rejects invalid
 * transitions, and history + audit + transfer.status-changed are written in the same transaction.
 */
export async function transition(
  q: Queryable, t: TransferRow, to: Status, actor: Actor, trace: Trace,
  options: { reason?: string | null; set?: Record<string, unknown> } = {},
): Promise<TransferRow> {
  const { sql, values } = setClause(options.set ?? {}, 4);
  const { rows } = await q.query<TransferRow>(
    `UPDATE core.transfers SET status = $2${sql.length ? `, ${sql.join(', ')}` : ''} WHERE id = $1 AND version = $3 RETURNING *`,
    [t.id, to, t.version, ...values],
  );
  const updated = rows[0];
  if (!updated) throw new ConcurrentUpdateError(`transfer ${t.id} changed concurrently`);
  await record(q, updated, t.status, actor, options.reason ?? null, trace);
  return updated;
}

export interface NewTransfer {
  userId: string;
  recipientId: string;
  idempotencyKey: string;
  corridorCode: string;
  fundingMethod: 'card' | 'bank_debit';
  purpose: string;
  send: Money;
  feeMinor: number;
  surchargeMinor: number;
  totalMinor: number;
  receiveCurrency: string;
  quoteId: string;
  deliveryEstimate: string;
  payoutMethod: 'bank_account' | 'mobile_wallet';
}

export async function insertTransfer(q: Queryable, n: NewTransfer, actor: Actor, trace: Trace): Promise<TransferRow> {
  for (let attempt = 0; ; attempt++) {
    try {
      await q.query('SAVEPOINT new_reference');
      const { rows } = await q.query<TransferRow>(
        `INSERT INTO core.transfers (reference, user_id, recipient_id, idempotency_key, corridor_code, funding_method, purpose,
                                     send_currency, send_amount_minor, fee_minor, card_surcharge_minor, total_charge_minor,
                                     receive_currency, quote_id, delivery_estimate, payout_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [newReference(), n.userId, n.recipientId, n.idempotencyKey, n.corridorCode, n.fundingMethod, n.purpose, n.send.currency,
          n.send.amountMinor, n.feeMinor, n.surchargeMinor, n.totalMinor, n.receiveCurrency, n.quoteId, n.deliveryEstimate, n.payoutMethod],
      );
      await q.query('RELEASE SAVEPOINT new_reference');
      await record(q, rows[0]!, null, actor, null, trace);
      return rows[0]!;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'transfers_reference_key' && attempt < 5) {
        await q.query('ROLLBACK TO SAVEPOINT new_reference'); // 1 in ~6.5e11 chance: pick another reference
        continue;
      }
      throw err;
    }
  }
}

export async function history(q: Queryable, ids: string[]): Promise<Map<string, HistoryRow[]>> {
  const byTransfer = new Map<string, HistoryRow[]>();
  if (ids.length === 0) return byTransfer;
  const { rows } = await q.query<HistoryRow>(
    'SELECT transfer_id, from_status, to_status, created_at FROM core.transfer_status_history WHERE transfer_id = ANY($1) ORDER BY id',
    [ids],
  );
  for (const r of rows) byTransfer.set(r.transfer_id, [...(byTransfer.get(r.transfer_id) ?? []), r]);
  return byTransfer;
}
