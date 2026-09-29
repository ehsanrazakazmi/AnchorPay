import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidIban } from '../src/domain/validation.ts';
import { asService, asUser, buildTestService, expectContract, signUp, uniquePhone, viaGateway, type TestService } from './helpers.ts';

let t: TestService;
beforeAll(() => {
  t = buildTestService();
});
afterAll(() => t.close());

const IBAN = 'PK36SCBL0000001123456702'; // the IBAN registry's example Pakistani IBAN
const bankRecipient = (overrides: Record<string, unknown> = {}) => ({
  nickname: 'Ammi', fullName: 'Nasreen Begum', country: 'PK', currency: 'PKR', relationship: 'parent', payoutMethod: 'bank_account',
  bankAccount: { bankName: 'Standard Chartered', bankCode: 'SCBLPKKX', accountNumber: 'pk36 scbl 0000 0011 2345 6702' },
  ...overrides,
});
const walletRecipient = { fullName: 'Bilal Ahmed', country: 'PK', currency: 'PKR', payoutMethod: 'mobile_wallet',
  mobileWallet: { provider: 'jazzcash', walletNumber: '+923001234567' } };

describe('profile', () => {
  it('returns the signed-in user', async () => {
    const { user, headers } = await signUp(t);
    const me = expectContract('getMe', await t.app.inject({ method: 'GET', url: '/v1/users/me', headers }), 200);
    expect(me).toEqual(user);
  });

  it('updates address, and a new phone number must be verified again', async () => {
    const { headers } = await signUp(t);
    const phone = uniquePhone();
    const res = await t.app.inject({
      method: 'PATCH', url: '/v1/users/me', headers,
      payload: { phone, address: { line1: '1 Rideau St', city: 'Ottawa', province: 'ON', postalCode: 'K1N 8S7' } },
    });
    const me = expectContract('updateMe', res, 200);
    expect(me).toMatchObject({ phone, phoneVerified: false, address: { city: 'Ottawa' } });
    expect(t.messenger.lastCode(phone)).toMatch(/^\d{6}$/);
  });

  it("rejects another account's phone number", async () => {
    const a = await signUp(t);
    const b = await signUp(t);
    const res = await t.app.inject({ method: 'PATCH', url: '/v1/users/me', headers: b.headers, payload: { phone: a.reg.phone } });
    expect(expectContract('updateMe', res, 409).code).toBe('ALREADY_EXISTS');
  });

  it('changes the password and signs out the other sessions only', async () => {
    const { reg, tokens, user } = await signUp(t);
    const other = (await t.app.inject({ method: 'POST', url: '/v1/auth/login', headers: viaGateway(), payload: { email: reg.email, password: reg.password } })).json();
    const sid = decodeJwt(tokens.accessToken).sid as string;
    const headers = asUser(user.id, 'customer', sid);
    const wrong = await t.app.inject({ method: 'POST', url: '/v1/users/me/change-password', headers, payload: { currentPassword: 'Not-The-Password-1', newPassword: 'Another-Strong-One-7' } });
    expect(expectContract('changePassword', wrong, 400).errors[0].field).toBe('currentPassword');
    const same = await t.app.inject({ method: 'POST', url: '/v1/users/me/change-password', headers, payload: { currentPassword: reg.password, newPassword: reg.password } });
    expect(same.statusCode).toBe(400);
    const ok = await t.app.inject({ method: 'POST', url: '/v1/users/me/change-password', headers, payload: { currentPassword: reg.password, newPassword: 'Another-Strong-One-7' } });
    expect(ok.statusCode).toBe(204);
    const refresh = (token: string) => t.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: viaGateway(), payload: { refreshToken: token } });
    expect((await refresh(other.refreshToken)).statusCode).toBe(401);
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(200);
  });
});

describe('recipients', () => {
  it('saves a bank recipient with the account number encrypted and masked', async () => {
    const { headers, user } = await signUp(t);
    const res = await t.app.inject({ method: 'POST', url: '/v1/recipients', headers, payload: bankRecipient() });
    const r = expectContract('createRecipient', res, 201);
    expect(r).toMatchObject({ fullName: 'Nasreen Begum', payoutMethod: 'bank_account', bankAccount: { bankName: 'Standard Chartered', accountNumberMasked: '•••• 6702' } });
    expect(JSON.stringify(r)).not.toContain('1123456702');
    const raw = await t.deps.pool.query('SELECT * FROM core.recipients WHERE id = $1 AND user_id = $2', [r.id, user.id]);
    expect(JSON.stringify(raw.rows[0])).not.toMatch(/Nasreen|1123456702/);
  });

  it('saves a JazzCash wallet recipient', async () => {
    const { headers } = await signUp(t);
    const r = expectContract('createRecipient', await t.app.inject({ method: 'POST', url: '/v1/recipients', headers, payload: walletRecipient }), 201);
    expect(r.mobileWallet).toEqual({ provider: 'jazzcash', walletNumberMasked: '+92 3•• ••• 4567' });
  });

  it('validates IBANs, wallet numbers and supported destinations', async () => {
    const { headers } = await signUp(t);
    const create = (payload: unknown) => t.app.inject({ method: 'POST', url: '/v1/recipients', headers, payload: payload as object });
    const badIban = await create(bankRecipient({ bankAccount: { bankName: 'X', accountNumber: 'PK36SCBL0000001123456703' } }));
    expect(expectContract('createRecipient', badIban, 400).errors[0].field).toBe('bankAccount.accountNumber');
    const badWallet = await create({ ...walletRecipient, mobileWallet: { provider: 'jazzcash', walletNumber: '+921234567890' } });
    expect(badWallet.statusCode).toBe(400);
    const indiaWallet = await create({ ...walletRecipient, country: 'IN', currency: 'INR' });
    expect(expectContract('createRecipient', indiaWallet, 422).code).toBe('CORRIDOR_UNAVAILABLE');
    const wrongCurrency = await create(bankRecipient({ currency: 'INR' }));
    expect(wrongCurrency.json().code).toBe('CORRIDOR_UNAVAILABLE');
    const missingDetails = await create({ ...bankRecipient(), bankAccount: undefined });
    expect(missingDetails.statusCode).toBe(400);
    expect(isValidIban(IBAN)).toBe(true);
  });

  it('lists, reads, updates and soft-deletes; never shows another user’s recipients', async () => {
    const owner = await signUp(t);
    const stranger = await signUp(t);
    const r = (await t.app.inject({ method: 'POST', url: '/v1/recipients', headers: owner.headers, payload: bankRecipient() })).json();

    const list = expectContract('listRecipients', await t.app.inject({ method: 'GET', url: '/v1/recipients', headers: owner.headers }), 200);
    expect(list.data.map((x: { id: string }) => x.id)).toEqual([r.id]);
    const strangerList = await t.app.inject({ method: 'GET', url: '/v1/recipients', headers: stranger.headers });
    expect(strangerList.json().data).toEqual([]);
    const peek = await t.app.inject({ method: 'GET', url: `/v1/recipients/${r.id}`, headers: stranger.headers });
    expect(expectContract('getRecipient', peek, 404).code).toBe('NOT_FOUND');

    const upd = await t.app.inject({ method: 'PATCH', url: `/v1/recipients/${r.id}`, headers: owner.headers, payload: { nickname: 'Mum', phone: '+923211234567' } });
    expect(expectContract('updateRecipient', upd, 200)).toMatchObject({ nickname: 'Mum', phone: '+923211234567', bankAccount: { accountNumberMasked: '•••• 6702' } });
    const strangerEdit = await t.app.inject({ method: 'PATCH', url: `/v1/recipients/${r.id}`, headers: stranger.headers, payload: { nickname: 'x' } });
    expect(strangerEdit.statusCode).toBe(404);

    expect((await t.app.inject({ method: 'DELETE', url: `/v1/recipients/${r.id}`, headers: stranger.headers })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/v1/recipients/${r.id}`, headers: owner.headers })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/v1/recipients/${r.id}`, headers: owner.headers })).statusCode).toBe(404);
    const stillInDb = await t.deps.pool.query('SELECT deleted_at FROM core.recipients WHERE id = $1', [r.id]);
    expect(stillInDb.rows[0].deleted_at).not.toBeNull(); // past transfers keep their recipient
  });
});

describe('admin', () => {
  it('finds users by exact email and filters by role', async () => {
    const target = await signUp(t);
    const admin = await signUp(t);
    const adminHeaders = asUser(admin.user.id, 'admin');
    const res = await t.app.inject({ method: 'GET', url: `/v1/admin/users?email=${encodeURIComponent(target.reg.email.toUpperCase())}`, headers: adminHeaders });
    const body = expectContract('adminListUsers', res, 200);
    expect(body.data.map((u: { id: string }) => u.id)).toEqual([target.user.id]);
    expect(body.pageInfo).toEqual({ page: 1, pageSize: 20, total: 1 });
    const customers = await t.app.inject({ method: 'GET', url: '/v1/admin/users?role=customer&pageSize=2', headers: adminHeaders });
    expect(customers.json().data).toHaveLength(2);
    const denied = await t.app.inject({ method: 'GET', url: '/v1/admin/users', headers: target.headers });
    expect(denied.statusCode).toBe(403);
  });

  it('suspends a user (sessions end), refuses self-changes, and closing emits user.closed', async () => {
    const target = await signUp(t);
    const admin = await signUp(t);
    const adminHeaders = asUser(admin.user.id, 'admin');
    const url = `/v1/admin/users/${target.user.id}`;
    const suspended = expectContract('adminUpdateUser', await t.app.inject({ method: 'PATCH', url, headers: adminHeaders, payload: { status: 'suspended', note: 'fraud check' } }), 200);
    expect(suspended.status).toBe('suspended');
    const refresh = await t.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: viaGateway(), payload: { refreshToken: target.tokens.refreshToken } });
    expect(refresh.statusCode).toBe(401);

    const self = await t.app.inject({ method: 'PATCH', url: `/v1/admin/users/${admin.user.id}`, headers: adminHeaders, payload: { role: 'customer' } });
    expect(self.statusCode).toBe(403);

    await t.app.inject({ method: 'PATCH', url, headers: adminHeaders, payload: { status: 'closed' } });
    const events = await t.deps.pool.query("SELECT payload FROM core.outbox WHERE topic = 'user.closed' AND message_key = $1", [target.user.id]);
    expect(events.rows[0].payload.data).toMatchObject({ userId: target.user.id, reason: 'customer_request' });
    const reopen = await t.app.inject({ method: 'PATCH', url, headers: adminHeaders, payload: { status: 'active' } });
    expect(reopen.json().code).toBe('INVALID_STATE_TRANSITION');
    const audit = await t.reporting.query("SELECT before, after FROM audit.audit_log WHERE entity_id = $1 AND action = 'user.admin_updated' ORDER BY id", [target.user.id]);
    expect(audit.rows[0]).toMatchObject({ before: { status: 'active' }, after: { status: 'suspended', note: 'fraud check' } });
  });

  it('agents may search but not edit', async () => {
    const target = await signUp(t);
    const agent = asUser((await signUp(t)).user.id, 'agent');
    expect((await t.app.inject({ method: 'GET', url: '/v1/admin/users', headers: agent })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'PATCH', url: `/v1/admin/users/${target.user.id}`, headers: agent, payload: { status: 'suspended' } })).statusCode).toBe(403);
  });
});

describe('internal API', () => {
  it('gives compliance and notification services the decrypted user', async () => {
    const { user } = await signUp(t);
    for (const caller of ['compliance-service', 'notification-service']) {
      const res = await t.app.inject({ method: 'GET', url: `/internal/identity/users/${user.id}`, headers: asService(caller) });
      expect(expectContract('internalGetUser', res, 200)).toMatchObject({ id: user.id, email: user.email, fullName: 'Ayesha Khan' });
    }
    const denied = await t.app.inject({ method: 'GET', url: `/internal/identity/users/${user.id}`, headers: asService('fx-service') });
    expect(denied.statusCode).toBe(403);
    const missing = await t.app.inject({ method: 'GET', url: '/internal/identity/users/0199a1b2-7c3d-7e4f-8a9b-000000000000', headers: asService('compliance-service') });
    expect(missing.statusCode).toBe(404);
  });

  it('returns full payout numbers to payment-service only', async () => {
    const { headers } = await signUp(t);
    const bank = (await t.app.inject({ method: 'POST', url: '/v1/recipients', headers, payload: bankRecipient() })).json();
    const wallet = (await t.app.inject({ method: 'POST', url: '/v1/recipients', headers, payload: walletRecipient })).json();
    const get = (id: string, caller: string) => t.app.inject({ method: 'GET', url: `/internal/identity/recipients/${id}`, headers: asService(caller) });

    const forPayment = expectContract('internalGetRecipient', await get(bank.id, 'payment-service'), 200);
    expect(forPayment.bankAccount.accountNumber).toBe(IBAN);
    expect(expectContract('internalGetRecipient', await get(wallet.id, 'payment-service'), 200).mobileWallet.walletNumber).toBe('+923001234567');
    expect(forPayment.deletedAt).toBeNull();
    await t.app.inject({ method: 'DELETE', url: `/v1/recipients/${bank.id}`, headers });
    const deleted = expectContract('internalGetRecipient', await get(bank.id, 'transfer-service'), 200);
    expect(deleted.deletedAt).toMatch(/^\d{4}-/); // still readable (past transfers), but flagged
    const forCompliance = expectContract('internalGetRecipient', await get(bank.id, 'compliance-service'), 200);
    expect(forCompliance.fullName).toBe('Nasreen Begum');
    expect(forCompliance.bankAccount.accountNumber).toBeUndefined();
    expect((await get(bank.id, 'fx-service')).statusCode).toBe(403);
  });
});
