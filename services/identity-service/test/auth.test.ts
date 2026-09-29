import { decodeJwt, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidEvent, sessionKeys } from '@anchorpay/service-kit';
import { loadPublicKey } from '../src/domain/tokens.ts';
import { asUser, buildTestService, expectContract, registration, signUp, STRONG_PASSWORD, viaGateway, type TestService } from './helpers.ts';

let t: TestService;
beforeAll(() => {
  t = buildTestService();
});
afterAll(() => t.close());

const post = (url: string, payload: unknown, headers: Record<string, string> = viaGateway()) =>
  t.app.inject({ method: 'POST', url, headers, payload: payload as object });

describe('registration', () => {
  it('creates a customer, encrypts PII, emits user.registered and sends verifications', async () => {
    const reg = registration();
    const user = expectContract('registerUser', await post('/v1/users', reg), 201);
    expect(user).toMatchObject({ email: reg.email, fullName: 'Ayesha Khan', role: 'customer', status: 'active', emailVerified: false, phoneVerified: false });
    expect(user.address).toEqual(reg.address);

    const raw = await t.deps.pool.query('SELECT * FROM core.users WHERE id = $1', [user.id]);
    const stored = JSON.stringify(raw.rows[0]);
    for (const secret of [reg.email, 'Ayesha', reg.phone.slice(2), '1995-04-12', STRONG_PASSWORD, 'Queen']) {
      expect(stored, `plaintext "${secret}" in the database`).not.toContain(secret);
    }
    expect(raw.rows[0].password_hash).toMatch(/^\$2[aby]\$/);

    const outbox = await t.deps.pool.query("SELECT payload FROM core.outbox WHERE topic = 'user.registered' AND message_key = $1", [user.id]);
    expect(outbox.rowCount).toBe(1);
    assertValidEvent(outbox.rows[0].payload);
    expect(JSON.stringify(outbox.rows[0].payload)).not.toContain(reg.email);

    expect(t.messenger.lastEmail(reg.email, 'verify-email')?.text).toMatch(/verify-email\?token=/);
    expect(t.messenger.lastCode(reg.phone)).toMatch(/^\d{6}$/);
    const audit = await t.reporting.query("SELECT action FROM audit.audit_log WHERE entity_id = $1", [user.id]);
    expect(audit.rows.map((r) => r.action)).toContain('user.registered');
  });

  it('rejects duplicate email and phone (case-insensitive email)', async () => {
    const reg = registration();
    await post('/v1/users', reg);
    const dupEmail = await post('/v1/users', { ...registration(), email: reg.email.toUpperCase() });
    expect(expectContract('registerUser', dupEmail, 409).code).toBe('ALREADY_EXISTS');
    const dupPhone = await post('/v1/users', { ...registration(), phone: reg.phone });
    expect(dupPhone.json().detail).toMatch(/phone/);
  });

  it('rejects weak passwords and minors with field errors', async () => {
    const weak = expectContract('registerUser', await post('/v1/users', registration({ password: 'password1234' })), 400);
    expect(weak.errors).toEqual([{ field: 'password', message: expect.stringMatching(/too common/) }]);
    const minor = await post('/v1/users', registration({ dateOfBirth: `${new Date().getUTCFullYear() - 16}-01-01` }));
    expect(minor.json().errors[0]).toMatchObject({ field: 'dateOfBirth' });
    const repeated = await post('/v1/users', registration({ password: 'aaaaaaaaaaaaaaaa' }));
    expect(repeated.json().errors[0].message).toMatch(/repeated/);
  });
});

describe('login, lockout, tokens', () => {
  it('issues a verifiable RS256 access token and a refresh token', async () => {
    const { user, tokens } = await signUp(t);
    const { payload, protectedHeader } = await jwtVerify(tokens.accessToken, await loadPublicKey(), {
      issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE,
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload).toMatchObject({ sub: user.id, role: 'customer' });
    expect(typeof payload.sid).toBe('string');
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, refreshExpiresIn: 2592000 });
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const { reg } = await signUp(t);
    const unknown = await post('/v1/auth/login', { email: 'nobody@example.com', password: STRONG_PASSWORD });
    const wrong = await post('/v1/auth/login', { email: reg.email, password: 'Wrong-Password-123' });
    for (const res of [unknown, wrong]) expect(expectContract('login', res, 401)).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(unknown.json().title).toBe(wrong.json().title);
  });

  it('locks the account for 15 minutes after 5 failures, even for the right password', async () => {
    const { reg, user } = await signUp(t);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post('/v1/auth/login', { email: reg.email, password: 'Wrong-Password-123' })).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 423]);
    const locked = await post('/v1/auth/login', { email: reg.email, password: reg.password });
    expect(locked.statusCode).toBe(423);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    const actions = (await t.reporting.query('SELECT action FROM audit.audit_log WHERE entity_id = $1', [user.id])).rows.map((r) => r.action);
    expect(actions).toContain('user.locked_out');
  });

  it('refuses suspended accounts', async () => {
    const { reg, user } = await signUp(t);
    await t.deps.pool.query("UPDATE core.users SET status = 'suspended' WHERE id = $1", [user.id]);
    expect((await post('/v1/auth/login', { email: reg.email, password: reg.password })).statusCode).toBe(403);
  });

  it('rotates refresh tokens and treats reuse as theft (whole session revoked)', async () => {
    const { tokens } = await signUp(t);
    const r1 = expectContract('refreshToken', await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken }), 200);
    expect(r1.refreshToken).not.toBe(tokens.refreshToken);
    const sid = decodeJwt(r1.accessToken).sid as string;

    const reuse = await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(expectContract('refreshToken', reuse, 401).detail).toMatch(/already used/);
    // The newest token of that session is dead too, and the gateway will reject its access tokens.
    expect((await post('/v1/auth/refresh', { refreshToken: r1.refreshToken })).statusCode).toBe(401);
    expect(await t.deps.redis.exists(sessionKeys.revoked(sid))).toBe(1);
  });

  it('refresh reflects a role change and stops for suspended users', async () => {
    const { user, tokens } = await signUp(t);
    await t.deps.pool.query("UPDATE core.users SET role = 'agent' WHERE id = $1", [user.id]);
    const r1 = expectContract('refreshToken', await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken }), 200);
    expect(decodeJwt(r1.accessToken).role).toBe('agent');
    await t.deps.pool.query("UPDATE core.users SET status = 'suspended' WHERE id = $1", [user.id]);
    expect((await post('/v1/auth/refresh', { refreshToken: r1.refreshToken })).statusCode).toBe(401);
  });

  it('rejects garbage refresh tokens', async () => {
    expect((await post('/v1/auth/refresh', { refreshToken: 'nope' })).statusCode).toBe(401);
  });

  it('logout ends only the caller session', async () => {
    const { user, tokens, reg } = await signUp(t);
    const other = expectContract('login', await post('/v1/auth/login', { email: reg.email, password: reg.password }), 200);
    const sid = decodeJwt(tokens.accessToken).sid as string;
    const res = await post('/v1/auth/logout', { refreshToken: tokens.refreshToken }, asUser(user.id, 'customer', sid));
    expect(res.statusCode).toBe(204);
    expect((await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken })).statusCode).toBe(401);
    expect(await t.deps.redis.exists(sessionKeys.revoked(sid))).toBe(1);
    expect((await post('/v1/auth/refresh', { refreshToken: other.refreshToken })).statusCode).toBe(200);
  });

  it("logout can't be used to end someone else's session", async () => {
    const victim = await signUp(t);
    const attacker = await signUp(t);
    const sid = decodeJwt(attacker.tokens.accessToken).sid as string;
    await post('/v1/auth/logout', { refreshToken: victim.tokens.refreshToken }, asUser(attacker.user.id, 'customer', sid));
    expect((await post('/v1/auth/refresh', { refreshToken: victim.tokens.refreshToken })).statusCode).toBe(200);
  });
});

describe('verification', () => {
  it('verifies email with a single-use link', async () => {
    const { reg, user, headers } = await signUp(t);
    const token = t.messenger.lastToken(reg.email, 'verify-email');
    expect((await post('/v1/auth/verify-email', { token })).statusCode).toBe(204);
    expect(expectContract('verifyEmail', await post('/v1/auth/verify-email', { token }), 404).code).toBe('NOT_FOUND');
    const me = await t.app.inject({ method: 'GET', url: '/v1/users/me', headers });
    expect(me.json()).toMatchObject({ id: user.id, emailVerified: true });
  });

  it('verifies the phone code, counts wrong attempts, locks after 5', async () => {
    const { reg, headers } = await signUp(t);
    const code = t.messenger.lastCode(reg.phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await post('/v1/auth/verify-phone', { code: wrong }, headers);
    expect(expectContract('verifyPhone', bad, 400).errors).toEqual([{ field: 'code', message: 'is incorrect' }]);
    expect((await post('/v1/auth/verify-phone', { code }, headers)).statusCode).toBe(204);

    const second = await signUp(t);
    const code2 = t.messenger.lastCode(second.reg.phone);
    const wrong2 = code2 === '000000' ? '111111' : '000000';
    const results: number[] = [];
    for (let i = 0; i < 5; i++) results.push((await post('/v1/auth/verify-phone', { code: wrong2 }, second.headers)).statusCode);
    expect(results).toEqual([400, 400, 400, 400, 429]);
    // Even the right code is refused once locked: the user must request a new one.
    expect((await post('/v1/auth/verify-phone', { code: code2 }, second.headers)).statusCode).toBe(429);
  });

  it('limits resends to one per minute and skips verified channels', async () => {
    const { reg, headers } = await signUp(t);
    expect((await post('/v1/auth/resend-verification', { channel: 'phone' }, headers)).statusCode).toBe(204);
    const again = await post('/v1/auth/resend-verification', { channel: 'phone' }, headers);
    expect(expectContract('resendVerification', again, 429).code).toBe('RATE_LIMITED');
    expect(again.headers['retry-after']).toBe('60');
    await post('/v1/auth/verify-email', { token: t.messenger.lastToken(reg.email, 'verify-email') });
    const before = t.messenger.emails.length;
    expect((await post('/v1/auth/resend-verification', { channel: 'email' }, headers)).statusCode).toBe(204);
    expect(t.messenger.emails.length).toBe(before);
  });
});

describe('password reset', () => {
  it('resets with a single-use link, ends every session and emails a notice', async () => {
    const { reg, tokens } = await signUp(t);
    expect((await post('/v1/auth/forgot-password', { email: reg.email })).statusCode).toBe(204);
    const token = t.messenger.lastToken(reg.email, 'reset-password');

    const weak = await post('/v1/auth/reset-password', { token, newPassword: 'password1234' });
    expect(expectContract('resetPassword', weak, 400).errors[0].field).toBe('newPassword'); // link still usable
    const newPassword = 'Brand-New-Password-42';
    expect((await post('/v1/auth/reset-password', { token, newPassword })).statusCode).toBe(204);
    expect((await post('/v1/auth/reset-password', { token, newPassword })).statusCode).toBe(404); // single use
    // A second request within a minute is silently rate-limited (still 204, no new email).
    const count = t.messenger.emails.length;
    expect((await post('/v1/auth/forgot-password', { email: reg.email })).statusCode).toBe(204);
    expect(t.messenger.emails.filter((m) => m.template === 'reset-password').length).toBe(
      t.messenger.emails.slice(0, count).filter((m) => m.template === 'reset-password').length,
    );

    expect((await post('/v1/auth/refresh', { refreshToken: tokens.refreshToken })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: reg.email, password: reg.password })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: reg.email, password: newPassword })).statusCode).toBe(200);
    expect(t.messenger.lastEmail(reg.email, 'password-changed')).toBeDefined();
  });

  it("doesn't reveal whether an email is registered", async () => {
    const before = t.messenger.emails.length;
    expect((await post('/v1/auth/forgot-password', { email: 'ghost@example.com' })).statusCode).toBe(204);
    expect(t.messenger.emails.length).toBe(before);
  });
});
