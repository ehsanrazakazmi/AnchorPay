import { AppError, buildEvent, enqueueEvent, requireAuth, withTransaction, type Service } from '@anchorpay/service-kit';
import type { Recipients } from '../domain/recipients.ts';
import { auditView, type UserRow } from '../domain/users.ts';
import { audit, SERVICE, type Deps } from '../deps.ts';

export function registerAdminRoutes(svc: Service, deps: Deps): void {
  const { pool, users, tokens } = deps;

  svc.handle('adminListUsers', async (req) => {
    const q = req.query as { email?: string; phone?: string; role?: string; status?: string; page: number; pageSize: number };
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (q.email) add('email_hash = ?', users.emailHash(q.email));
    if (q.phone) add('phone_hash = ?', users.phoneHash(q.phone));
    if (q.role) add('role = ?', q.role);
    if (q.status) add('status = ?', q.status);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.users ${filter}`, values)).rows[0]!.n;
    const { rows } = await pool.query<UserRow>(
      `SELECT * FROM core.users ${filter} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { data: rows.map((r) => users.toApi(r)), pageInfo: { page: q.page, pageSize: q.pageSize, total } };
  });

  svc.handle('adminUpdateUser', async (req) => {
    const auth = requireAuth(req);
    const { userId } = req.params as { userId: string };
    const body = req.body as { role?: UserRow['role']; status?: 'active' | 'suspended' | 'closed'; note?: string };
    if (userId === auth.userId) throw new AppError('FORBIDDEN', "Admins can't change their own role or status.");
    const { row, before } = await withTransaction(pool, async (client) => {
      const existing = await users.byId(client, userId, true);
      if (!existing) throw new AppError('NOT_FOUND', 'User not found.');
      if (existing.status === 'closed') throw new AppError('INVALID_STATE_TRANSITION', 'Closed accounts cannot be changed.');
      const { rows } = await client.query<UserRow>(
        `UPDATE core.users SET role = COALESCE($2, role), status = COALESCE($3, status),
                closed_at = CASE WHEN $3 = 'closed' THEN now() ELSE closed_at END
          WHERE id = $1 RETURNING *`,
        [userId, body.role ?? null, body.status ?? null],
      );
      const updated = rows[0]!;
      await audit(client, req, 'user.admin_updated', { type: 'user', id: userId }, {
        before: auditView(existing), after: { ...auditView(updated), note: body.note ?? null },
      });
      if (updated.status === 'closed') {
        const event = buildEvent('user.closed', { userId, closedAt: updated.closed_at!.toISOString(), reason: 'customer_request' },
          { producer: SERVICE, correlationId: req.id });
        await enqueueEvent(client, 'core', event, userId);
      }
      return { row: updated, before: existing };
    });
    if (row.status !== 'active' || row.role !== before.role) await tokens.revokeAllSessions(userId);
    return users.toApi(row);
  });
}

export function registerInternalRoutes(svc: Service, deps: Deps, recipients: Recipients): void {
  const { pool, users } = deps;

  svc.handle('internalGetUser', async (req) => {
    const { userId } = req.params as { userId: string };
    const user = await users.byId(pool, userId);
    if (!user) throw new AppError('NOT_FOUND', 'User not found.');
    return users.toApi(user);
  });

  svc.handle('internalGetRecipient', async (req) => {
    const { recipientId } = req.params as { recipientId: string };
    const row = await recipients.byId(pool, recipientId);
    if (!row) throw new AppError('NOT_FOUND', 'Recipient not found.');
    // Full payout numbers go only to the service that sends the payout.
    return recipients.toInternal(row, req.caller === 'payment-service');
  });
}
