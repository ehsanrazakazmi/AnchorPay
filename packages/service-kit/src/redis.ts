import { Redis } from 'ioredis';
import { env } from './env.ts';

/** Redis-protocol client (Garnet locally). Every key gets REDIS_KEY_PREFIX so tests never touch dev data. */
export function createRedis(): Redis {
  return new Redis(env('REDIS_URL'), {
    keyPrefix: env('REDIS_KEY_PREFIX', 'ap:'),
    maxRetriesPerRequest: 2,
    connectTimeout: 3000,
  });
}

export type { Redis };
