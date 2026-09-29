import { AppError, requireAuth, withTransaction, type Service } from '@anchorpay/service-kit';
import type { RecipientInput, Recipients } from '../domain/recipients.ts';
import { audit, type Deps } from '../deps.ts';

const MAX_RECIPIENTS = 100;

export function registerRecipientRoutes(svc: Service, deps: Deps, recipients: Recipients): void {
  const { pool } = deps;
  const notFound = () => new AppError('NOT_FOUND', 'Recipient not found.');

  svc.handle('listRecipients', async (req) => {
    const rows = await recipients.list(pool, requireAuth(req).userId);
    return { data: rows.map((r) => recipients.toApi(r)) };
  });

  svc.handle('createRecipient', async (req, reply) => {
    const auth = requireAuth(req);
    const row = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM core.recipients WHERE user_id = $1 AND deleted_at IS NULL',
        [auth.userId],
      );
      if (rows[0]!.n >= MAX_RECIPIENTS) throw new AppError('LIMIT_EXCEEDED', `You can save up to ${MAX_RECIPIENTS} recipients.`);
      const created = await recipients.insert(client, auth.userId, req.body as RecipientInput);
      await audit(client, req, 'recipient.created', { type: 'recipient', id: created.id }, {
        after: { country: created.country, payoutMethod: created.payout_method, last4: created.account_last4 },
      });
      return created;
    });
    return reply.code(201).send(recipients.toApi(row));
  });

  svc.handle('getRecipient', async (req) => {
    const { recipientId } = req.params as { recipientId: string };
    const row = await recipients.ownedBy(pool, requireAuth(req).userId, recipientId);
    if (!row) throw notFound();
    return recipients.toApi(row);
  });

  svc.handle('updateRecipient', async (req) => {
    const auth = requireAuth(req);
    const { recipientId } = req.params as { recipientId: string };
    const body = req.body as { nickname?: string; relationship?: string; phone?: string };
    const row = await withTransaction(pool, async (client) => {
      const existing = await recipients.ownedBy(client, auth.userId, recipientId);
      if (!existing) throw notFound();
      const enc = recipients.reencrypted(existing, body.phone);
      const { rows } = await client.query(
        `UPDATE core.recipients
            SET nickname = CASE WHEN $2::boolean THEN $3 ELSE nickname END,
                relationship = COALESCE($4, relationship),
                full_name_enc = $5, phone_enc = $6, account_number_enc = $7, wallet_number_enc = $8, encryption_key_id = $9
          WHERE id = $1 RETURNING *`,
        [
          recipientId, body.nickname !== undefined, body.nickname?.trim() || null, body.relationship ?? null,
          enc.full_name_enc, enc.phone_enc, enc.account_number_enc, enc.wallet_number_enc, enc.encryption_key_id,
        ],
      );
      await audit(client, req, 'recipient.updated', { type: 'recipient', id: recipientId }, { after: { changed: Object.keys(body) } });
      return rows[0];
    });
    return recipients.toApi(row);
  });

  svc.handle('deleteRecipient', async (req, reply) => {
    const auth = requireAuth(req);
    const { recipientId } = req.params as { recipientId: string };
    await withTransaction(pool, async (client) => {
      const existing = await recipients.ownedBy(client, auth.userId, recipientId);
      if (!existing) throw notFound();
      await client.query('UPDATE core.recipients SET deleted_at = now() WHERE id = $1', [recipientId]);
      await audit(client, req, 'recipient.deleted', { type: 'recipient', id: recipientId });
    });
    return reply.code(204).send();
  });
}
