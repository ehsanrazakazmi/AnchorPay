import {
  createLogger, createMessenger, createPool, createRedis, createService, PiiCipher, type Logger, type Messenger, type Pool, type Redis,
  type Service,
} from '@anchorpay/service-kit';
import { Recipients } from './domain/recipients.ts';
import { TokenService } from './domain/tokens.ts';
import { Users } from './domain/users.ts';
import { Verification } from './domain/verification.ts';
import { SERVICE, type Deps } from './deps.ts';
import { registerAdminRoutes, registerInternalRoutes } from './routes/admin-internal.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerProfileRoutes } from './routes/profile.ts';
import { registerRecipientRoutes } from './routes/recipients.ts';

export interface Infrastructure {
  pool: Pool;
  redis: Redis;
  messenger: Messenger;
  cipher: PiiCipher;
  log: Logger;
}

export function defaultInfrastructure(): Infrastructure {
  return {
    pool: createPool('core', SERVICE),
    redis: createRedis(),
    messenger: createMessenger(),
    cipher: PiiCipher.fromEnv(),
    log: createLogger(SERVICE),
  };
}

export function buildIdentityService(infra: Infrastructure): { service: Service; deps: Deps } {
  const deps: Deps = {
    ...infra,
    tokens: new TokenService(infra.redis),
    users: new Users(infra.cipher),
    verification: new Verification(infra.redis, infra.messenger),
  };
  const service = createService({
    name: SERVICE,
    logger: infra.log,
    health: { postgres: () => infra.pool.query('SELECT 1'), redis: () => infra.redis.ping() },
  });
  const recipients = new Recipients(infra.cipher);
  registerAuthRoutes(service, deps);
  registerProfileRoutes(service, deps);
  registerRecipientRoutes(service, deps, recipients);
  registerAdminRoutes(service, deps);
  registerInternalRoutes(service, deps, recipients);

  const missing = service.unhandled();
  if (missing.length) throw new Error(`${SERVICE} does not implement contract operations: ${missing.join(', ')}`);
  return { service, deps };
}
