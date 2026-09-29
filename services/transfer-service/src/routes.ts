import { AppError, requireAuth, type Pool, type Service } from '@anchorpay/service-kit';
import { getTransfer, type Status, type TransferRow } from './domain/transfers.ts';
import { toInternal } from './domain/views.ts';
import type { CreateBody, Workflow } from './domain/workflow.ts';

interface Filters {
  status?: Status[];
  from?: string;
  to?: string;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  reference?: string;
  userId?: string;
  page: number;
  pageSize: number;
}

/** Newest-first page of transfers matching the filters (dates are whole days, UTC, inclusive). */
async function search(pool: Pool, f: Filters): Promise<{ rows: TransferRow[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replace('?', `$${values.length}`));
  };
  if (f.userId) add('user_id = ?', f.userId);
  if (f.reference) add('reference = ?', f.reference);
  if (f.status?.length) add('status = ANY(?)', f.status);
  if (f.from) add("created_at >= (?::date)::timestamp AT TIME ZONE 'UTC'", f.from);
  if (f.to) add("created_at < (?::date + 1)::timestamp AT TIME ZONE 'UTC'", f.to);
  if (f.minAmountMinor !== undefined) add('send_amount_minor >= ?', f.minAmountMinor);
  if (f.maxAmountMinor !== undefined) add('send_amount_minor <= ?', f.maxAmountMinor);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.transfers ${filter}`, values)).rows[0]!.n;
  const { rows } = await pool.query<TransferRow>(
    `SELECT * FROM core.transfers ${filter} ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, f.pageSize, (f.page - 1) * f.pageSize],
  );
  return { rows, total };
}

export function registerRoutes(svc: Service, pool: Pool, workflow: Workflow): void {
  const notFound = () => new AppError('NOT_FOUND', 'Transfer not found.');
  const params = (req: { params: unknown }) => req.params as { transferId: string };

  // ------------------------------------------------------------------ customer
  svc.handle('createTransfer', async (req, reply) => {
    const auth = requireAuth(req);
    const key = req.headers['idempotency-key'] as string;
    const result = await workflow.create(auth, req.body as CreateBody, key, req.id);
    return reply.code(result.status).send(result.body);
  });

  svc.handle('listTransfers', async (req) => {
    const q = req.query as Filters;
    const { rows, total } = await search(pool, { ...q, reference: undefined, userId: requireAuth(req).userId });
    return { data: await workflow.views(rows, req.id), pageInfo: { page: q.page, pageSize: q.pageSize, total } };
  });

  svc.handle('getTransfer', async (req) => {
    const t = await getTransfer(pool, params(req).transferId);
    if (!t || t.user_id !== requireAuth(req).userId) throw notFound();
    return workflow.view(t, req.id);
  });

  svc.handle('cancelTransfer', async (req) => {
    const body = (req.body ?? {}) as { reason?: string };
    return workflow.cancel(requireAuth(req), params(req).transferId, body.reason, req.id);
  });

  svc.handle('requoteTransfer', async (req) => workflow.requote(requireAuth(req), params(req).transferId, req.id));

  svc.handle('reconfirmTransfer', async (req) => {
    const { quoteId } = req.body as { quoteId: string };
    return workflow.reconfirm(requireAuth(req), params(req).transferId, quoteId, req.id);
  });

  // ------------------------------------------------------------------ staff (read-only; the gateway checks the role)
  svc.handle('adminSearchTransfers', async (req) => {
    const q = req.query as Filters;
    const { rows, total } = await search(pool, { ...q, minAmountMinor: undefined, maxAmountMinor: undefined });
    return { data: await workflow.views(rows, req.id), pageInfo: { page: q.page, pageSize: q.pageSize, total } };
  });

  svc.handle('adminGetTransfer', async (req) => {
    const t = await getTransfer(pool, params(req).transferId);
    if (!t) throw notFound();
    return workflow.view(t, req.id);
  });

  // ------------------------------------------------------------------ internal
  svc.handle('internalGetTransfer', async (req) => {
    const t = await getTransfer(pool, params(req).transferId);
    if (!t) throw notFound();
    return toInternal(t);
  });

  svc.handle('internalTransferStats', async (req) => {
    const { userId, recipientId } = req.query as { userId: string; recipientId?: string };
    return transferStats(pool, userId, recipientId);
  });
}

/**
 * A sender's recent activity for compliance's velocity and structuring rules (DECISIONS D-40).
 * Counts include every attempt that wasn't cancelled; amounts only include money that moved or may still move
 * (a declined card or a refunded transfer doesn't use up the customer's limits).
 */
export async function transferStats(pool: Pool, userId: string, recipientId?: string) {
  const { rows } = await pool.query<{ c1h: number; c24h: number; a24h: string; a30d: string }>(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int  AS c1h,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS c24h,
            COALESCE(sum(send_amount_minor) FILTER (WHERE created_at > now() - interval '24 hours' AND status NOT IN ('FAILED', 'REFUNDED')), 0) AS a24h,
            COALESCE(sum(send_amount_minor) FILTER (WHERE status NOT IN ('FAILED', 'REFUNDED')), 0) AS a30d
       FROM core.transfers
      WHERE user_id = $1 AND status <> 'CANCELLED' AND send_currency = 'CAD' AND created_at > now() - interval '30 days'`,
    [userId],
  );
  // Structuring: the same round amount (whole CAD 100s) sent again and again within 7 days.
  const { rows: repeats } = await pool.query<{ n: number }>(
    `WITH latest AS (
       SELECT id, send_amount_minor FROM core.transfers
        WHERE user_id = $1 AND status <> 'CANCELLED' ORDER BY created_at DESC, id DESC LIMIT 1)
     SELECT count(t.id)::int AS n
       FROM latest l
       JOIN core.transfers t ON t.user_id = $1 AND t.id <> l.id AND t.send_amount_minor = l.send_amount_minor
      WHERE l.send_amount_minor % 10000 = 0 AND t.status <> 'CANCELLED' AND t.created_at > now() - interval '7 days'`,
    [userId],
  );
  const s = rows[0]!;
  const stats: Record<string, unknown> = {
    countLast1h: s.c1h,
    countLast24h: s.c24h,
    amountLast24h: { amountMinor: Number(s.a24h), currency: 'CAD' },
    amountLast30d: { amountMinor: Number(s.a30d), currency: 'CAD' },
    recentRoundAmountRepeats: repeats[0]?.n ?? 0,
  };
  if (recipientId) {
    // The transfer being screened is already stored, so "seen before" means at least one other transfer.
    const { rows: seen } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.transfers WHERE user_id = $1 AND recipient_id = $2 AND status <> 'CANCELLED'",
      [userId, recipientId],
    );
    stats.recipientSeenBefore = seen[0]!.n >= 2;
  }
  return stats;
}
