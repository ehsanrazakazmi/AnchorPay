// After a PII key rotation, updating a row must re-encrypt *every* column with the new key; a row that
// mixed key versions under one encryption_key_id would become unreadable.
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PiiCipher } from '@anchorpay/service-kit';
import { RECIPIENT_CTX } from '../src/domain/recipients.ts';
import { USER_CTX } from '../src/domain/users.ts';
import { buildTestService, expectContract, signUp, type TestService } from './helpers.ts';

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const hmac = Buffer.from(process.env.PII_HMAC_KEY!, 'base64'); // blind indexes survive key rotation
const before = new PiiCipher(new Map([['old', oldKey]]), 'old', hmac);
const after = new PiiCipher(new Map([['new', newKey], ['old', oldKey]]), 'new', hmac);
const newKeyOnly = new PiiCipher(new Map([['new', newKey]]), 'new', hmac);

const services: TestService[] = [];
afterAll(() => Promise.all(services.map((s) => s.close())));

describe('PII key rotation', () => {
  it('re-encrypts every user and recipient column with the current key on update', async () => {
    const v1 = buildTestService({ cipher: before });
    services.push(v1);
    const { user, headers, reg } = await signUp(v1);
    const recipient = expectContract('createRecipient', await v1.app.inject({
      method: 'POST', url: '/v1/recipients', headers,
      payload: { fullName: 'Nasreen Begum', phone: '+923211234567', country: 'PK', currency: 'PKR', payoutMethod: 'bank_account',
        bankAccount: { bankName: 'HBL', accountNumber: 'PK36SCBL0000001123456702' } },
    }), 201);

    // The service restarts with a new current key; the old key stays configured for reading.
    const v2 = buildTestService({ cipher: after });
    services.push(v2);
    const me = expectContract('getMe', await v2.app.inject({ method: 'GET', url: '/v1/users/me', headers }), 200);
    expect(me.email).toBe(reg.email); // old rows still readable

    expectContract('updateMe', await v2.app.inject({ method: 'PATCH', url: '/v1/users/me', headers,
      payload: { address: { line1: '5 King St', city: 'Toronto', province: 'ON', postalCode: 'M5H 1A1' } } }), 200);
    expectContract('updateRecipient', await v2.app.inject({ method: 'PATCH', url: `/v1/recipients/${recipient.id}`, headers,
      payload: { nickname: 'Ammi' } }), 200);

    const u = (await v2.deps.pool.query('SELECT * FROM core.users WHERE id = $1', [user.id])).rows[0];
    expect(u.encryption_key_id).toBe('new');
    expect(newKeyOnly.decrypt(u.email_enc, 'new', USER_CTX.email)).toBe(reg.email);
    expect(newKeyOnly.decrypt(u.phone_enc, 'new', USER_CTX.phone)).toBe(reg.phone);
    expect(newKeyOnly.decrypt(u.full_name_enc, 'new', USER_CTX.fullName)).toBe('Ayesha Khan');
    expect(newKeyOnly.decrypt(u.date_of_birth_enc, 'new', USER_CTX.dateOfBirth)).toBe('1995-04-12');
    expect(newKeyOnly.decryptJson(u.address_enc, 'new', USER_CTX.address)).toMatchObject({ city: 'Toronto' });

    const r = (await v2.deps.pool.query('SELECT * FROM core.recipients WHERE id = $1', [recipient.id])).rows[0];
    expect(r.encryption_key_id).toBe('new');
    expect(newKeyOnly.decrypt(r.full_name_enc, 'new', RECIPIENT_CTX.fullName)).toBe('Nasreen Begum');
    expect(newKeyOnly.decrypt(r.phone_enc, 'new', RECIPIENT_CTX.phone)).toBe('+923211234567');
    expect(newKeyOnly.decrypt(r.account_number_enc, 'new', RECIPIENT_CTX.accountNumber)).toBe('PK36SCBL0000001123456702');

    // Login still works: email lookups use the blind index, which doesn't depend on the encryption key.
    const login = await v2.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'x-internal-token': process.env.INTERNAL_SERVICE_TOKEN! }, payload: { email: reg.email, password: reg.password } });
    expect(login.statusCode).toBe(200);
  });
});
