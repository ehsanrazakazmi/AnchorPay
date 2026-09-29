import pg from 'pg';
import { env, envInt } from './env.ts';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.PoolClient, 'query'>;

// int8 (bigint) columns hold money in minor units; values stay far below 2^53, so plain numbers are safe.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type ServiceRole = 'core' | 'compliance' | 'fx' | 'payments' | 'ledger' | 'notify' | 'reporting';

/** Connection pool for one service's least-privilege role (docs/database.md). */
export function createPool(role: ServiceRole, applicationName: string): Pool {
  const prefix = `PG_${role.toUpperCase()}`;
  return new pg.Pool({
    host: env('PGHOST', '127.0.0.1'),
    port: envInt('PGPORT', 5433),
    database: env('PG_DATABASE', 'anchorpay'),
    user: env(`${prefix}_USER`),
    password: env(`${prefix}_PASSWORD`),
    max: envInt('PG_POOL_MAX', 10),
    application_name: applicationName,
  });
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface PgError {
  code?: string;
  constraint?: string;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgError;
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

/** Allow-list check for schema names interpolated into SQL (they can't be bind parameters). */
export function assertSchemaName(schema: string): string {
  if (!['core', 'compliance', 'fx', 'payments', 'ledger', 'notify'].includes(schema)) throw new Error(`Unknown schema "${schema}"`);
  return schema;
}
