// Runs SQL migrations in db/migrations as ap_migrator.
//   up     apply all pending migrations (one transaction)
//   down   roll back the most recent migration (or --count=N)
//   reset  roll back everything, then apply everything again
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { pgConfig } from '../lib/env.mjs';
import { ROOT } from '../lib/paths.mjs';

const [, , command = 'up', ...rest] = process.argv;
const countArg = rest.find((a) => a.startsWith('--count='));

const base = {
  databaseUrl: pgConfig('migrator'),
  dir: join(ROOT, 'db', 'migrations'),
  migrationsTable: 'schema_migrations',
  migrationsSchema: 'meta',
  createMigrationsSchema: true,
  checkOrder: true,
  singleTransaction: true,
  // node-pg-migrate logs every SQL statement; keep only its per-migration headers.
  log: (msg) => {
    if (String(msg).startsWith('### MIGRATION')) console.log(String(msg).replaceAll('#', '').trim());
  },
};

async function run(direction, count) {
  const applied = await runner({ ...base, direction, count });
  if (applied.length === 0) console.log(direction === 'up' ? 'No pending migrations.' : 'Nothing to roll back.');
  else for (const m of applied) console.log(`${direction === 'up' ? 'applied' : 'rolled back'}: ${m.name}`);
}

try {
  if (command === 'up') await run('up', Infinity);
  else if (command === 'down') await run('down', countArg ? Number(countArg.split('=')[1]) : 1);
  else if (command === 'reset') {
    await run('down', Infinity);
    await run('up', Infinity);
  } else throw new Error(`Unknown command "${command}" (use up | down | reset)`);
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exit(1);
}
