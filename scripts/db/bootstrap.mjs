// One-time (and re-runnable) database setup, run as the PostgreSQL superuser:
//   - creates/updates the login roles from .env (passwords are synced on every run)
//   - creates the anchorpay database owned by ap_migrator
//   - locks the database down so only AnchorPay roles can connect
// Tables, schemas and grants are NOT created here — that is the job of migrations (npm run db:migrate).
import pg from 'pg';
import { env, pgConfig } from '../lib/env.mjs';

// Role names are fixed: migrations grant privileges to these exact names.
export const SERVICE_ROLES = {
  core: { schema: 'core', purpose: 'identity-service + transfer-service' },
  compliance: { schema: 'compliance', purpose: 'compliance-service' },
  fx: { schema: 'fx', purpose: 'fx-service' },
  payments: { schema: 'payments', purpose: 'payment-service' },
  ledger: { schema: 'ledger', purpose: 'ledger-service (ledger, reconciliation, reporting)' },
  notify: { schema: 'notify', purpose: 'notification-service' },
  reporting: { schema: null, purpose: 'read-only reporting / analytics' },
};

async function main() {
  const superCfg = pgConfig('superuser');
  const database = env('PG_DATABASE', 'anchorpay');
  const admin = new pg.Client(superCfg);
  await admin.connect();

  const roles = [
    { key: 'migrator', ...pgConfig('migrator') },
    ...Object.keys(SERVICE_ROLES).map((key) => ({ key, ...pgConfig(key) })),
  ];

  for (const role of roles) {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.user])).rowCount > 0;
    const ident = admin.escapeIdentifier(role.user);
    const pw = admin.escapeLiteral(role.password);
    await admin.query(
      exists
        ? `ALTER ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pw}`
        : `CREATE ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${pw}`,
    );
    if (role.key !== 'migrator') {
      const schema = SERVICE_ROLES[role.key].schema;
      await admin.query(`ALTER ROLE ${ident} SET statement_timeout = '10s'`);
      await admin.query(`ALTER ROLE ${ident} SET idle_in_transaction_session_timeout = '60s'`);
      await admin.query(`ALTER ROLE ${ident} SET search_path = ${schema ? `${schema}, ` : ''}public`);
    }
    console.log(`${exists ? 'updated' : 'created'} role ${role.user}`);
  }

  // The dev database plus an isolated one the test suite rebuilds on every run.
  const databases = [...new Set([database, env('PG_TEST_DATABASE', 'anchorpay_test')])];
  const migrator = admin.escapeIdentifier(pgConfig('migrator').user);
  for (const name of databases) {
    const dbIdent = admin.escapeIdentifier(name);
    const dbExists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
    if (!dbExists) {
      await admin.query(`CREATE DATABASE ${dbIdent} OWNER ${migrator} ENCODING 'UTF8' TEMPLATE template0`);
      console.log(`created database ${name}`);
    } else {
      await admin.query(`ALTER DATABASE ${dbIdent} OWNER TO ${migrator}`);
      console.log(`database ${name} already exists`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${dbIdent} FROM PUBLIC`);
    for (const role of roles) {
      await admin.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${admin.escapeIdentifier(role.user)}`);
    }
    // Inside the database: nobody but the owner may create objects in "public".
    const db = new pg.Client({ ...superCfg, database: name });
    await db.connect();
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.end();
  }
  await admin.end();

  console.log('Bootstrap complete. Next: npm run db:migrate');
}

main().catch((err) => {
  console.error(`Bootstrap failed: ${err.message}`);
  process.exit(1);
});
