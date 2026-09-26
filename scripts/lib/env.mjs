import { existsSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { ROOT } from './paths.mjs';

// Loads .env once. CI provides the same variables through the environment instead.
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) dotenv.config({ path: envFile, quiet: true });

export function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '' || value === '__ASK__' || String(value).startsWith('__GENERATE')) {
    throw new Error(`Environment variable ${name} is not set. Run "npm run setup:env" first (see docs/local-setup.md).`);
  }
  return value;
}

export function pgConfig(role) {
  const prefix = role === 'superuser' ? 'PG_SUPERUSER' : `PG_${role.toUpperCase()}`;
  return {
    host: env('PGHOST', '127.0.0.1'),
    port: Number(env('PGPORT', '5433')),
    user: env(role === 'superuser' ? 'PG_SUPERUSER' : `${prefix}_USER`),
    password: env(`${prefix}_PASSWORD`),
    database: role === 'superuser' ? 'postgres' : env('PG_DATABASE', 'anchorpay'),
  };
}
