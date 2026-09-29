import { isIP } from 'node:net';
import type { Queryable } from './db.ts';

export interface AuditEntry {
  service: string;
  actorType: 'user' | 'staff' | 'service' | 'system' | 'vendor';
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Ids, statuses and masked values only — never decrypted personal data (DECISIONS D-16). */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Appends to the immutable audit trail. Call inside the transaction that made the change. */
export async function writeAudit(client: Queryable, e: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit.audit_log (service, actor_type, actor_id, action, entity_type, entity_id, before, after, request_id, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [e.service, e.actorType, e.actorId ?? null, e.action, e.entityType, e.entityId ?? null, e.before ?? null, e.after ?? null,
      // A malformed address must never make the audit write (and so the request) fail.
      e.requestId ?? null, e.ip && isIP(e.ip) ? e.ip : null, e.userAgent?.slice(0, 300) ?? null],
  );
}
