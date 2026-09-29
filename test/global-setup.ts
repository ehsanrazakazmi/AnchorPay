// Runs once before the whole test suite: rebuilds the test database from the migrations
// (every Down, then every Up), so each run starts from an empty, current schema.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export default function setup(): void {
  const root = join(import.meta.dirname, '..');
  const database = process.env.PG_TEST_DATABASE ?? 'anchorpay_test';
  process.env.TEST_REDIS_KEY_PREFIX = `aptest:${randomUUID().slice(0, 8)}:`;
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'db', 'migrate.mjs'), 'reset'], {
    cwd: root,
    env: { ...process.env, PG_DATABASE: database },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Could not prepare ${database} (run "npm run db:bootstrap" once):\n${result.stderr || result.stdout}`);
  }
}
