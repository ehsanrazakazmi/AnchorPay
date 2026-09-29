// Creates a staff account (admin / compliance_officer / agent) with a random password, printed once.
//   npm run create-staff -w @anchorpay/identity-service -- --email=a@b.com --phone=+14165550100 --name="Jane Doe" --role=admin
import { randomBytes } from 'node:crypto';
import { withTransaction, writeAudit } from '@anchorpay/service-kit';
import { defaultInfrastructure } from '../app.ts';
import { hashPassword } from '../domain/passwords.ts';
import { Users, type UserRow } from '../domain/users.ts';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  }),
) as Record<string, string | undefined>;

const role = args.role as UserRow['role'] | undefined;
if (!args.email || !args.phone || !args.name || !role || !['admin', 'compliance_officer', 'agent'].includes(role)) {
  console.error('Usage: create-staff -- --email=... --phone=+1... --name="Full Name" --role=admin|compliance_officer|agent');
  process.exit(1);
}

const infra = defaultInfrastructure();
const users = new Users(infra.cipher);
const password = randomBytes(12).toString('base64url');
try {
  const row = await withTransaction(infra.pool, async (client) => {
    const created = await users.insert(client, {
      email: args.email!, phone: args.phone!, fullName: args.name!, dateOfBirth: '1990-01-01', country: 'CA',
      passwordHash: await hashPassword(password), role,
    });
    await client.query('UPDATE core.users SET email_verified_at = now(), phone_verified_at = now() WHERE id = $1', [created.id]);
    await writeAudit(client, {
      service: 'identity-service', actorType: 'system', action: 'user.staff_created', entityType: 'user', entityId: created.id,
      after: { role },
    });
    return created;
  });
  console.log(`Created ${role} ${row.id}\nTemporary password (shown once, change it after first login): ${password}`);
} catch (err) {
  console.error(`Could not create staff user: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await infra.pool.end();
  infra.redis.disconnect();
}
