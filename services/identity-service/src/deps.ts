import type { FastifyRequest } from 'fastify';
import { writeAudit, type Logger, type Messenger, type PiiCipher, type Pool, type Queryable, type Redis } from '@anchorpay/service-kit';
import type { TokenService } from './domain/tokens.ts';
import type { Users } from './domain/users.ts';
import type { Verification } from './domain/verification.ts';

export const SERVICE = 'identity-service';

export interface Deps {
  pool: Pool;
  redis: Redis;
  cipher: PiiCipher;
  messenger: Messenger;
  log: Logger;
  tokens: TokenService;
  users: Users;
  verification: Verification;
}

/** Audit row for the current request (actor = the signed-in user, or "system" for anonymous calls). */
export function audit(
  q: Queryable,
  req: FastifyRequest,
  action: string,
  entity: { type: string; id: string },
  change: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {},
  actorId?: string,
): Promise<void> {
  const staff = req.auth && req.auth.role !== 'customer';
  return writeAudit(q, {
    service: SERVICE,
    actorType: req.auth ? (staff ? 'staff' : 'user') : actorId ? 'user' : 'system',
    actorId: req.auth?.userId ?? actorId ?? null,
    action,
    entityType: entity.type,
    entityId: entity.id,
    before: change.before ?? null,
    after: change.after ?? null,
    requestId: req.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  });
}

/** Sends a message without failing the request; the user can always ask for a resend. */
export async function bestEffort(log: Logger, what: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (err) {
    log.error({ err }, `${what} failed`);
  }
}
