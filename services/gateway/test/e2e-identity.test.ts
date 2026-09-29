// End to end over real HTTP: client -> gateway -> identity-service -> PostgreSQL / Garnet.
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, createRedis } from '@anchorpay/service-kit';
import { assertMatchesContract } from '@anchorpay/service-kit/testing';
import { buildTestService, registration, type TestService } from '../../identity-service/test/helpers.ts';
import { buildGateway } from '../src/app.ts';

let identity: TestService;
let gateway: FastifyInstance;
let identityUrl = '';
let base = '';
const redis = createRedis();

async function call(operationId: string, method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  assertMatchesContract(operationId, res.status, body);
  return { status: res.status, body, headers: res.headers };
}

beforeAll(async () => {
  identity = buildTestService();
  await identity.app.listen({ port: 0, host: '127.0.0.1' });
  identityUrl = `http://127.0.0.1:${(identity.app.server.address() as AddressInfo).port}`;
  gateway = await buildGateway({ redis, log: createLogger('e2e'), upstreams: { 'identity-service': identityUrl } });
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await gateway.close();
  await identity.close();
  redis.disconnect();
});

describe('a customer journey through the gateway', () => {
  it('sign up, log in, verify, save a recipient, refresh, log out', async () => {
    const reg = registration();
    const created = await call('registerUser', 'POST', '/v1/users', { body: reg });
    expect(created.status).toBe(201);
    expect(created.headers.get('x-request-id')).toMatch(/^req_/);

    const login = await call('login', 'POST', '/v1/auth/login', { body: { email: reg.email, password: reg.password } });
    expect(login.status).toBe(200);
    const access = login.body.accessToken as string;

    const me = await call('getMe', 'GET', '/v1/users/me', { token: access });
    expect(me.body).toMatchObject({ id: created.body.id, email: reg.email, phoneVerified: false });

    const verified = await call('verifyPhone', 'POST', '/v1/auth/verify-phone', { token: access, body: { code: identity.messenger.lastCode(reg.phone) } });
    expect(verified.status).toBe(204);

    const recipient = await call('createRecipient', 'POST', '/v1/recipients', {
      token: access,
      body: { fullName: 'Bilal Ahmed', country: 'PK', currency: 'PKR', payoutMethod: 'mobile_wallet', mobileWallet: { provider: 'easypaisa', walletNumber: '+923451234567' } },
    });
    expect(recipient.status).toBe(201);
    const list = await call('listRecipients', 'GET', '/v1/recipients', { token: access });
    expect(list.body.data).toHaveLength(1);

    const admin = await call('adminListUsers', 'GET', '/v1/admin/users', { token: access });
    expect(admin.status).toBe(403); // stopped at the gateway

    const refreshed = await call('refreshToken', 'POST', '/v1/auth/refresh', { body: { refreshToken: login.body.refreshToken } });
    expect(refreshed.status).toBe(200);

    const logout = await call('logout', 'POST', '/v1/auth/logout', { token: refreshed.body.accessToken, body: { refreshToken: refreshed.body.refreshToken } });
    expect(logout.status).toBe(204);
    // Both the old and the new access token die with the session, well before their 15-minute expiry.
    for (const token of [access, refreshed.body.accessToken]) {
      const after = await call('getMe', 'GET', '/v1/users/me', { token });
      expect(after.status).toBe(401);
    }
  });

  it('identity-service refuses requests that bypass the gateway', async () => {
    const res = await fetch(`${identityUrl}/v1/users/me`, { headers: { 'x-user-id': '0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b', 'x-user-role': 'admin' } });
    expect(res.status).toBe(401);
  });
});
