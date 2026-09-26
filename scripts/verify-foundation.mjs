// npm run verify — Foundation acceptance check. Proves, on this machine, that:
//   environment + secrets are in place, PostgreSQL/Garnet/Kafka are reachable and correctly configured,
//   every service role is locked to its own schema, and the database enforces the state machine,
//   append-only tables and balanced ledger journals. Also runs the contract checks.
// Everything it writes happens inside transactions that are rolled back (or on the smoke-test topic).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import Redis from 'ioredis';
import pg from 'pg';
import { env, pgConfig } from './lib/env.mjs';
import { allTopicNames } from './lib/events.mjs';
import { ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const { Kafka, logLevel } = require('@confluentinc/kafka-javascript').KafkaJS;

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function expectPgError(client, sql, params, code, label) {
  await client.query('SAVEPOINT expect_error');
  try {
    await client.query(sql, params);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT expect_error');
    if (err.code !== code) throw new Error(`${label}: expected SQLSTATE ${code}, got ${err.code} (${err.message})`);
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expect_error');
  throw new Error(`${label}: statement unexpectedly succeeded`);
}

async function asRole(role, fn) {
  const client = new pg.Client(pgConfig(role));
  await client.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

// ---------------------------------------------------------------- environment
section('Environment & secrets');
await check('.env present with no placeholders', () => {
  for (const k of ['PG_MIGRATOR_PASSWORD', 'PG_CORE_PASSWORD', 'PII_ENCRYPTION_KEY', 'PII_HMAC_KEY', 'INTERNAL_SERVICE_TOKEN']) env(k);
});
await check('PII keys are 32 bytes (AES-256 / HMAC-SHA256)', () => {
  for (const k of ['PII_ENCRYPTION_KEY', 'PII_HMAC_KEY']) assert(Buffer.from(env(k), 'base64').length === 32, `${k} is not 32 bytes`);
});
await check('JWT signing keys present', () => {
  for (const k of ['JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH']) assert(existsSync(join(ROOT, env(k))), `${env(k)} missing`);
});
await check('secrets are git-ignored', () => {
  const paths = ['.env', 'secrets/jwt-private.pem', 'secrets/jwt-public.pem'];
  for (const p of paths) {
    const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: ROOT, encoding: 'utf8' });
    if (r.error || /not a git repository/i.test(r.stderr)) return 'skipped (not a git repository yet)';
    if (r.status === 128) throw new Error(`git check-ignore failed: ${r.stderr.trim()}`);
    assert(r.status === 0, `${p} is NOT ignored by git`);
  }
  return paths.join(', ');
});

// ---------------------------------------------------------------- PostgreSQL
section('PostgreSQL');
await check('connects as ap_migrator; version >= 18 (uuidv7)', async () =>
  asRole('migrator', async (c) => {
    const { rows } = await c.query("SELECT current_setting('server_version_num')::int AS v, version() AS full");
    assert(rows[0].v >= 180000, `PostgreSQL 18+ required, found ${rows[0].full}`);
    return rows[0].full.split(',')[0];
  }),
);
await check('all migrations applied', async () =>
  asRole('migrator', async (c) => {
    const files = readdirSync(join(ROOT, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, ''));
    const { rows } = await c.query('SELECT name FROM meta.schema_migrations ORDER BY run_on');
    const applied = new Set(rows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));
    assert(pending.length === 0, `pending: ${pending.join(', ')} (run npm run db:migrate)`);
    return `${files.length} migrations`;
  }),
);
await check('reference data seeded', async () =>
  asRole('migrator', async (c) => {
    const { rows } = await c.query(`SELECT
      (SELECT count(*) FROM fx.corridors WHERE enabled)::int AS corridors,
      (SELECT count(*) FROM compliance.aml_rules)::int AS rules,
      (SELECT count(*) FROM compliance.kyc_tiers)::int AS tiers,
      (SELECT count(*) FROM ledger.accounts)::int AS accounts`);
    const r = rows[0];
    assert(r.corridors >= 2 && r.rules >= 9 && r.tiers === 4 && r.accounts >= 8, JSON.stringify(r));
    return `${r.corridors} corridors, ${r.rules} AML rules, ${r.tiers} KYC tiers, ${r.accounts} ledger accounts`;
  }),
);

section('Least-privilege roles (each service sees only its own schema)');
const OWN = { core: 'core.users', compliance: 'compliance.aml_rules', fx: 'fx.corridors', payments: 'payments.payments', ledger: 'ledger.accounts', notify: 'notify.preferences' };
for (const [role, table] of Object.entries(OWN)) {
  await check(`ap_${role}: reads ${table.split('.')[0]}, denied elsewhere, no DELETE`, async () =>
    asRole(role, async (c) => {
      await c.query(`SELECT 1 FROM ${table} LIMIT 1`);
      const foreign = Object.values(OWN).find((t) => t !== table);
      await expectPgError(c, `SELECT 1 FROM ${foreign} LIMIT 1`, [], '42501', `read ${foreign}`);
      await expectPgError(c, `DELETE FROM ${table}`, [], '42501', `delete ${table}`);
      // Every service may write the audit trail; only ledger-service (admin audit search) may read it.
      if (role === 'ledger') await c.query('SELECT 1 FROM audit.audit_log LIMIT 1');
      else await expectPgError(c, 'SELECT 1 FROM audit.audit_log LIMIT 1', [], '42501', 'read audit');
    }),
  );
}
await check('ap_reporting: reads every schema, cannot write', async () =>
  asRole('reporting', async (c) => {
    for (const t of [...Object.values(OWN), 'audit.audit_log']) await c.query(`SELECT 1 FROM ${t} LIMIT 1`);
    await expectPgError(c, "INSERT INTO fx.corridors (code) VALUES ('ZZ-ZZ')", [], '42501', 'insert');
  }),
);

section('Database-enforced integrity');
await check('transfer state machine blocks invalid transitions, allows valid ones', async () =>
  asRole('core', async (c) => {
    const bytes = Buffer.from('test');
    const user = await c.query(
      `INSERT INTO core.users (email_hash, email_enc, phone_hash, phone_enc, full_name_enc, encryption_key_id, password_hash)
       VALUES ($1, $2, $3, $2, $2, 'k1', 'x') RETURNING id`,
      [Buffer.from(randomUUID()), bytes, Buffer.from(randomUUID())],
    );
    const userId = user.rows[0].id;
    const rec = await c.query(
      `INSERT INTO core.recipients (user_id, full_name_enc, encryption_key_id, country, currency, payout_method, wallet_provider, wallet_number_enc)
       VALUES ($1, $2, 'k1', 'PK', 'PKR', 'mobile_wallet', 'jazzcash', $2) RETURNING id`,
      [userId, bytes],
    );
    const tr = await c.query(
      `INSERT INTO core.transfers (reference, user_id, recipient_id, idempotency_key, corridor_code, funding_method, purpose,
                                   send_currency, send_amount_minor, fee_minor, card_surcharge_minor, total_charge_minor, receive_currency)
       VALUES ('AP-TEST0001', $1, $2, $3, 'CA-PK', 'card', 'family_support', 'CAD', 50000, 299, 1000, 51299, 'PKR') RETURNING id, version`,
      [userId, rec.rows[0].id, randomUUID()],
    );
    const id = tr.rows[0].id;
    await expectPgError(c, "UPDATE core.transfers SET status = 'COMPLETED' WHERE id = $1", [id], '23514', 'INITIATED -> COMPLETED');
    await expectPgError(c, "UPDATE core.transfers SET total_charge_minor = 1 WHERE id = $1", [id], '23514', 'wrong total charge');
    const ok = await c.query("UPDATE core.transfers SET status = 'FX_LOCKED' WHERE id = $1 RETURNING version", [id]);
    assert(ok.rows[0].version === 2, 'version was not incremented');
    await c.query(
      "INSERT INTO core.transfer_status_history (transfer_id, from_status, to_status, actor_type) VALUES ($1, 'INITIATED', 'FX_LOCKED', 'system')",
      [id],
    );
    await expectPgError(c, "UPDATE core.transfer_status_history SET reason = 'x' WHERE transfer_id = $1", [id], '42501', 'edit history');
    return 'INITIATED→COMPLETED rejected, INITIATED→FX_LOCKED ok, history immutable';
  }),
);
await check('docs/state-machine.md diagram matches the database transitions', async () =>
  asRole('migrator', async (c) => {
    const { rows } = await c.query('SELECT from_status, to_status FROM core.transfer_transitions');
    const db = new Set(rows.map((r) => `${r.from_status}->${r.to_status}`));
    const doc = new Set(
      [...readFileSync(join(ROOT, 'docs', 'state-machine.md'), 'utf8').matchAll(/^\s+([A-Z_]+) --> ([A-Z_]+):/gm)].map((m) => `${m[1]}->${m[2]}`),
    );
    const missing = [...db].filter((t) => !doc.has(t));
    const extra = [...doc].filter((t) => !db.has(t));
    assert(!missing.length && !extra.length, `not in doc: ${missing.join(', ') || '-'}; not in DB: ${extra.join(', ') || '-'}`);
    return `${db.size} transitions`;
  }),
);
await check('audit log is append-only (even for the owner)', async () =>
  asRole('migrator', async (c) => {
    await c.query("INSERT INTO audit.audit_log (service, actor_type, action, entity_type) VALUES ('verify', 'system', 'verify.run', 'foundation')");
    await expectPgError(c, 'UPDATE audit.audit_log SET action = action', [], '42501', 'update audit');
    await expectPgError(c, 'DELETE FROM audit.audit_log', [], '42501', 'delete audit');
    await expectPgError(c, 'TRUNCATE audit.audit_log', [], '42501', 'truncate audit');
  }),
);
// Posts a journal as ap_ledger and forces the deferred balance check to run now.
async function postJournal(c, entries) {
  const j = (await c.query("INSERT INTO ledger.journals (kind, description) VALUES ('adjustment', 'verify') RETURNING id")).rows[0].id;
  for (const [account, currency, direction, amount] of entries) {
    await c.query('INSERT INTO ledger.entries (journal_id, account_code, currency, direction, amount_minor) VALUES ($1, $2, $3, $4, $5)',
      [j, account, currency, direction, amount]);
  }
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
}
await check('ledger accepts a balanced journal', () =>
  asRole('ledger', async (c) => {
    await postJournal(c, [
      ['payment_clearing_cad', 'CAD', 'debit', 51299],
      ['customer_funds_cad', 'CAD', 'credit', 50000],
      ['fee_revenue_cad', 'CAD', 'credit', 1299],
    ]);
    return 'debit CAD 512.99 = credit 500.00 + 12.99';
  }),
);
await check('ledger rejects unbalanced journals and wrong-currency entries', () =>
  asRole('ledger', async (c) => {
    await c.query('SAVEPOINT unbalanced');
    await postJournal(c, [['payment_clearing_cad', 'CAD', 'debit', 51299], ['customer_funds_cad', 'CAD', 'credit', 50000]])
      .then(() => { throw new Error('unbalanced journal was accepted'); })
      .catch((err) => { if (err.code !== '23514') throw err; });
    await c.query('ROLLBACK TO SAVEPOINT unbalanced');
    const j = (await c.query("INSERT INTO ledger.journals (kind, description) VALUES ('adjustment', 'verify') RETURNING id")).rows[0].id;
    await expectPgError(c, "INSERT INTO ledger.entries (journal_id, account_code, currency, direction, amount_minor) VALUES ($1, 'customer_funds_cad', 'PKR', 'credit', 1)",
      [j], '23503', 'PKR entry on a CAD account');
  }),
);

// ---------------------------------------------------------------- Redis (Garnet)
section('Redis protocol (Garnet)');
await check('SET/GET with TTL, SET NX, INCR', async () => {
  const redis = new Redis(env('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
  await redis.connect();
  try {
    const key = `verify:${randomUUID()}`;
    assert((await redis.set(key, 'locked', 'EX', 30)) === 'OK', 'SET failed');
    assert((await redis.get(key)) === 'locked', 'GET mismatch');
    const ttl = await redis.ttl(key);
    assert(ttl > 0 && ttl <= 30, `unexpected TTL ${ttl}`);
    assert((await redis.set(key, 'second', 'EX', 30, 'NX')) === null, 'SET NX overwrote an existing key (idempotency keys would break)');
    assert((await redis.incr(`${key}:n`)) === 1, 'INCR failed');
    await redis.del(key, `${key}:n`);
    return `${env('REDIS_URL')} (rate locks, idempotency keys, sessions)`;
  } finally {
    redis.disconnect();
  }
});

// ---------------------------------------------------------------- Kafka
section('Kafka');
const kafka = new Kafka({ kafkaJS: { brokers: env('KAFKA_BROKERS').split(','), clientId: 'anchorpay-verify', logLevel: logLevel.NOTHING } });
await check('all catalogue topics exist', async () => {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = allTopicNames().filter((t) => !existing.has(t));
    assert(missing.length === 0, `missing: ${missing.join(', ')} (run npm run kafka:topics)`);
    return `${allTopicNames().length} topics`;
  } finally {
    await admin.disconnect();
  }
});
await check('produce + consume round trip (infra.smoke-test)', async () => {
  const topic = 'infra.smoke-test';
  const marker = randomUUID();
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({ topic, messages: [{ key: marker, value: JSON.stringify({ marker }) }] });
  await producer.disconnect();

  const consumer = kafka.consumer({ kafkaJS: { groupId: `verify-${marker}`, fromBeginning: true } });
  await consumer.connect();
  await consumer.subscribe({ topic });
  const started = Date.now();
  const found = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    consumer.run({
      eachMessage: async ({ message }) => {
        if (message.key?.toString() === marker) {
          clearTimeout(timer);
          resolve(true);
        }
      },
    });
  });
  await consumer.disconnect();
  assert(found, 'message not received within 20s');
  return `${Date.now() - started} ms`;
});

// ---------------------------------------------------------------- contracts
section('Contracts');
for (const [name, script] of [['event schemas + examples', 'scripts/events/validate.mjs'], ['API ownership/roles/callers', 'scripts/contracts/check.mjs']]) {
  await check(name, () => {
    const r = spawnSync(process.execPath, [join(ROOT, script)], { cwd: ROOT, encoding: 'utf8' });
    assert(r.status === 0, (r.stderr || r.stdout).trim());
    return r.stdout.trim();
  });
}

console.log(failures === 0 ? '\nFoundation verified: everything is ready.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
